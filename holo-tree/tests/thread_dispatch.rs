//! Thread-safety contract tests (specs/api/errors.md § Thread-safety
//! expectations): correctness must not depend on which thread a call lands
//! on. The consumer-owned `TreeCache` travels with the operation — unlike the
//! former `thread_local!` cache, whose warmth (or worse) silently depended on
//! thread identity (gitsheets finding #5).

mod helpers;

use helpers::Sandbox;
use holo_tree::{Context, MutableTree, TreeCache};

/// One logical operation dispatched across threads: a tree loaded (and its
/// cache populated) on thread A is mutated and written on thread B, with the
/// moved cache staying authoritative.
#[test]
fn tree_and_cache_move_across_threads() {
    let sb = Sandbox::new();
    let base = sb.write_tree(&[
        ("data/widgets/1.toml", "id = 1\n"),
        ("README.md", "hi\n"),
    ]);

    // Thread A (here): populate the consumer-owned cache.
    let cache = TreeCache::new();
    let mut tree = MutableTree::new(base);
    {
        let ctx = Context::new(&sb.repo, &cache);
        tree.ensure_children(&ctx).unwrap();
    }
    assert!(!cache.is_empty(), "loading a tree should populate the cache");

    // Thread B: the tree + cache move (Send); the repo handle is re-derived
    // per thread, as an embedding host (e.g. the napi binding) would.
    let repo_sync = sb.repo.clone().into_sync();
    let written = std::thread::spawn(move || {
        let repo = repo_sync.to_thread_local();
        let ctx = Context::new(&repo, &cache);
        tree.write_child(&ctx, "data/widgets/2.toml", "id = 2\n")
            .unwrap();
        tree.write(&ctx).unwrap()
    })
    .join()
    .expect("cross-thread dispatch must not panic");

    // The result is exactly what a single-threaded run produces.
    let expected = sb.write_tree(&[
        ("data/widgets/1.toml", "id = 1\n"),
        ("data/widgets/2.toml", "id = 2\n"),
        ("README.md", "hi\n"),
    ]);
    assert_eq!(written, expected);
}

/// The cache is keyed by content-addressed object id, so a cache populated
/// against one repository serves the same tree everywhere — proven by reading
/// a tree through a `Context` over an *empty* repository, where the only
/// possible source of the children is the travelled cache.
#[test]
fn cache_is_content_addressed_and_repo_independent() {
    let sb = Sandbox::new();
    let base = sb.write_tree(&[("a.txt", "a\n"), ("dir/b.txt", "b\n")]);

    let cache = TreeCache::new();
    {
        let ctx = Context::new(&sb.repo, &cache);
        let mut tree = MutableTree::new(base);
        tree.ensure_children(&ctx).unwrap();
        // Load the subtree too so its entries are cached.
        tree.get_subtree(&ctx, "dir")
            .unwrap()
            .unwrap()
            .ensure_children(&ctx)
            .unwrap();
    }

    // A different, empty repository: the tree object does not exist here.
    let other = Sandbox::new();
    let ctx = Context::new(&other.repo, &cache);
    let mut tree = MutableTree::new(base);
    tree.ensure_children(&ctx)
        .expect("children must come from the travelled cache");
    let children = tree.children.as_ref().unwrap();
    assert!(children.contains_key("a.txt"));
    assert!(children.contains_key("dir"));
}
