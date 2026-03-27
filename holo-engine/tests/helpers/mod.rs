//! Test helpers: git sandbox for creating isolated test repositories.

use gix::ObjectId;

/// A temporary git repository for testing.
///
/// Creates an isolated bare repo in a temp directory. Provides helpers
/// to write blobs, build trees, create commits, and set up .holo/ configs.
/// Cleaned up automatically on drop.
pub struct Sandbox {
    pub dir: tempfile::TempDir,
    pub repo: gix::Repository,
}

impl Sandbox {
    /// Create a new empty git repository in a temp directory.
    pub fn new() -> Self {
        let dir = tempfile::tempdir().expect("failed to create temp dir");
        let repo = gix::init_bare(dir.path()).expect("failed to init bare repo");
        Sandbox { dir, repo }
    }

    /// Write a blob and return its OID.
    pub fn write_blob(&self, content: &str) -> ObjectId {
        self.repo.write_blob(content).unwrap().detach()
    }

    /// Build a tree from a list of (path, content) pairs.
    ///
    /// Paths can be nested (e.g. "dir/file.txt"). Intermediate trees
    /// are created automatically.
    pub fn write_tree(&self, files: &[(&str, &str)]) -> ObjectId {
        let mut tree = holo_engine::tree::MutableTree::empty();

        for (path, content) in files {
            let blob_hash = self.write_blob(content);
            insert_blob_at_path(&self.repo, &mut tree, path, blob_hash);
        }

        tree.write(&self.repo).unwrap()
    }

    /// Build a tree from entries that can include blobs, trees, and gitlinks.
    pub fn write_tree_with_entries(&self, entries: &[TreeEntrySpec]) -> ObjectId {
        use gix::objs::tree::{Entry, EntryMode};
        use gix::objs::Tree;

        let mut gix_entries: Vec<Entry> = entries
            .iter()
            .map(|e| Entry {
                mode: EntryMode::try_from(e.mode).unwrap(),
                filename: e.name.as_str().into(),
                oid: e.hash,
            })
            .collect();
        gix_entries.sort();
        let tree = Tree {
            entries: gix_entries,
        };
        self.repo.write_object(&tree).unwrap().detach()
    }

    /// Create a commit pointing to a tree, optionally with a parent.
    pub fn commit(&self, tree_hash: ObjectId, parent: Option<ObjectId>, msg: &str) -> ObjectId {
        use gix::objs::Commit;

        let sig = gix::actor::SignatureRef {
            name: "Test".into(),
            email: "test@test".into(),
            time: "1700000000 +0000",
        };

        let parent_ids: Vec<ObjectId> = parent.into_iter().collect();

        let commit = Commit {
            tree: tree_hash,
            parents: parent_ids.into(),
            author: sig.to_owned().expect("valid sig"),
            committer: sig.to_owned().expect("valid sig"),
            encoding: None,
            message: msg.into(),
            extra_headers: vec![],
        };

        self.repo.write_object(&commit).unwrap().detach()
    }

    /// Create a ref pointing to an object.
    pub fn set_ref(&self, name: &str, target: ObjectId) {
        self.repo
            .reference(
                name,
                target,
                gix::refs::transaction::PreviousValue::Any,
                "test",
            )
            .unwrap();
    }

    /// Build a complete holo workspace tree with config, sources, and branch mappings.
    /// Returns the root tree hash.
    pub fn write_holo_workspace(&self, spec: &WorkspaceSpec) -> ObjectId {
        let mut tree = holo_engine::tree::MutableTree::empty();

        // .holo/config.toml
        let config_toml = format!(
            "[holospace]\nname = \"{}\"\n",
            spec.name
        );
        let config_blob = self.write_blob(&config_toml);
        insert_blob_at_path(&self.repo, &mut tree, ".holo/config.toml", config_blob);

        // .holo/sources/{name}.toml
        for (name, source) in &spec.sources {
            let mut toml = String::from("[holosource]\n");
            if let Some(ref url) = source.url {
                toml.push_str(&format!("url = \"{url}\"\n"));
            }
            if let Some(ref git_ref) = source.git_ref {
                toml.push_str(&format!("ref = \"{git_ref}\"\n"));
            }
            if let Some(ref hb) = source.project_holobranch {
                toml.push_str(&format!("\n[holosource.project]\nholobranch = \"{hb}\"\n"));
            }
            let blob = self.write_blob(&toml);
            insert_blob_at_path(
                &self.repo,
                &mut tree,
                &format!(".holo/sources/{name}.toml"),
                blob,
            );
        }

        // .holo/branches/{branch}.toml (optional)
        for (branch_name, branch) in &spec.branches {
            if branch.extend.is_some() || branch.lens.is_some() {
                let mut toml = String::from("[holobranch]\n");
                if let Some(ref ext) = branch.extend {
                    toml.push_str(&format!("extend = \"{ext}\"\n"));
                }
                if let Some(lens) = branch.lens {
                    toml.push_str(&format!("lens = {lens}\n"));
                }
                let blob = self.write_blob(&toml);
                insert_blob_at_path(
                    &self.repo,
                    &mut tree,
                    &format!(".holo/branches/{branch_name}.toml"),
                    blob,
                );
            }

            // .holo/branches/{branch}/{mapping_key}.toml
            for (key, mapping) in &branch.mappings {
                let mut toml = String::from("[holomapping]\n");
                if let Some(ref hs) = mapping.holosource {
                    toml.push_str(&format!("holosource = \"{hs}\"\n"));
                }
                // files
                if mapping.files.len() == 1 {
                    toml.push_str(&format!("files = \"{}\"\n", mapping.files[0]));
                } else {
                    toml.push_str("files = [");
                    for (i, f) in mapping.files.iter().enumerate() {
                        if i > 0 {
                            toml.push_str(", ");
                        }
                        toml.push_str(&format!("\"{f}\""));
                    }
                    toml.push_str("]\n");
                }
                if let Some(ref root) = mapping.root {
                    toml.push_str(&format!("root = \"{root}\"\n"));
                }
                if let Some(ref output) = mapping.output {
                    toml.push_str(&format!("output = \"{output}\"\n"));
                }
                if !mapping.after.is_empty() {
                    let vals: Vec<String> = mapping.after.iter().map(|s| format!("\"{s}\"")).collect();
                    toml.push_str(&format!("after = [{}]\n", vals.join(", ")));
                }
                if !mapping.before.is_empty() {
                    let vals: Vec<String> = mapping.before.iter().map(|s| format!("\"{s}\"")).collect();
                    toml.push_str(&format!("before = [{}]\n", vals.join(", ")));
                }

                let blob = self.write_blob(&toml);
                insert_blob_at_path(
                    &self.repo,
                    &mut tree,
                    &format!(".holo/branches/{branch_name}/{key}.toml"),
                    blob,
                );
            }
        }

        // Gitlink entries for sources in .holo/sources/
        for (name, commit_hash) in &spec.gitlinks {
            let sources_tree = tree
                .get_or_create_subtree(&self.repo, ".holo/sources")
                .unwrap();
            sources_tree.children.as_mut().unwrap().insert(
                name.clone(),
                holo_engine::tree::Child::Commit { hash: *commit_hash },
            );
            sources_tree.dirty = true;
        }

        // Additional content files (outside .holo/)
        for (path, content) in &spec.files {
            let blob = self.write_blob(content);
            insert_blob_at_path(&self.repo, &mut tree, path, blob);
        }

        tree.write(&self.repo).unwrap()
    }
}

/// Insert a blob at a slash-separated path in a MutableTree.
fn insert_blob_at_path(
    repo: &gix::Repository,
    tree: &mut holo_engine::tree::MutableTree,
    path: &str,
    blob_hash: ObjectId,
) {
    let (dir, file) = match path.rsplit_once('/') {
        Some((d, f)) => (d, f),
        None => (".", path),
    };
    let parent = tree.get_or_create_subtree(repo, dir).unwrap();
    parent.children.as_mut().unwrap().insert(
        file.to_string(),
        holo_engine::tree::Child::Blob {
            mode: 0o100644,
            hash: blob_hash,
        },
    );
    parent.dirty = true;
}

// ── Spec types for building test workspaces ────────────────────────────────

pub struct TreeEntrySpec {
    pub name: String,
    pub mode: u32,
    pub hash: ObjectId,
}

#[derive(Default)]
pub struct WorkspaceSpec {
    pub name: String,
    pub sources: Vec<(String, SourceSpec)>,
    pub branches: Vec<(String, BranchSpec)>,
    pub gitlinks: Vec<(String, ObjectId)>,
    pub files: Vec<(String, String)>,
}

#[derive(Default)]
pub struct SourceSpec {
    pub url: Option<String>,
    pub git_ref: Option<String>,
    pub project_holobranch: Option<String>,
}

#[derive(Default)]
pub struct BranchSpec {
    pub extend: Option<String>,
    pub lens: Option<bool>,
    pub mappings: Vec<(String, MappingSpec)>,
}

pub struct MappingSpec {
    pub holosource: Option<String>,
    pub files: Vec<String>,
    pub root: Option<String>,
    pub output: Option<String>,
    pub after: Vec<String>,
    pub before: Vec<String>,
}

impl Default for MappingSpec {
    fn default() -> Self {
        MappingSpec {
            holosource: None,
            files: vec!["**".to_string()],
            root: None,
            output: None,
            after: vec![],
            before: vec![],
        }
    }
}
