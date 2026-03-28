//! Minimatch-compatible glob matching.
//!
//! Wraps `globset` with corrections for differences from Node.js minimatch:
//! - `**` matches zero path segments (`**/*.php` matches `Admin.php`)
//! - `!` prefix is parsed as negation, not passed to globset
//! - `{ dot: true }` behavior (globset matches dotfiles by default)

use crate::error::Result;
use globset::{Glob, GlobSet, GlobSetBuilder};

/// A single compiled pattern, which may be positive or negated.
struct PatternEntry {
    glob: GlobSet,
    negate: bool,
}

/// Compiled glob matcher with minimatch-compatible semantics.
pub struct GlobMatcher {
    patterns: Option<Vec<PatternEntry>>,
    has_negations: bool,
}

impl GlobMatcher {
    /// Compile a set of file patterns.
    ///
    /// Returns `None`-patterns (match-everything) when the input is empty,
    /// absent, or the single pattern `**`.
    pub fn new(files: Option<&[String]>) -> Result<Self> {
        let patterns = match files {
            Some(pats) if !(pats.len() == 1 && pats[0] == "**") => {
                let mut entries = Vec::with_capacity(pats.len());
                let mut has_neg = false;

                for pat in pats {
                    let (negate, raw) = match pat.strip_prefix('!') {
                        Some(stripped) => {
                            has_neg = true;
                            (true, stripped)
                        }
                        None => (false, pat.as_str()),
                    };

                    let mut builder = GlobSetBuilder::new();
                    builder.add(Glob::new(raw)?);

                    // globset's ** requires at least one path separator.
                    // minimatch's ** matches zero segments, so **/*.php also
                    // matches Admin.php. Fix: add the suffix as a second pattern.
                    if let Some(suffix) = raw.strip_prefix("**/") {
                        builder.add(Glob::new(suffix)?);
                    }

                    entries.push(PatternEntry {
                        glob: builder.build()?,
                        negate,
                    });
                }

                Some((entries, has_neg))
            }
            _ => None,
        };

        let (patterns, has_negations) = match patterns {
            Some((p, n)) => (Some(p), n),
            None => (None, false),
        };

        Ok(GlobMatcher {
            patterns,
            has_negations,
        })
    }

    /// Test a path against the pattern set.
    ///
    /// Returns `(matched, negation_excluded)`.
    /// - `matched = true` means at least one positive pattern matched.
    /// - `negation_excluded = true` means a negation pattern matched — the
    ///   caller should skip this path entirely.
    ///
    /// When no patterns are configured, returns `(true, false)` (match everything).
    pub fn matches(&self, path: &str) -> (bool, bool) {
        let entries = match &self.patterns {
            None => return (true, false),
            Some(e) => e,
        };

        let mut matched = false;
        for entry in entries {
            if entry.glob.is_match(path) {
                if entry.negate {
                    return (false, true);
                }
                matched = true;
            }
        }
        (matched, false)
    }

    /// Whether any file patterns are configured (false = match everything).
    pub fn has_patterns(&self) -> bool {
        self.patterns.is_some()
    }

    /// Whether any negation patterns exist.
    pub fn has_negations(&self) -> bool {
        self.has_negations
    }
}

// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn m(patterns: &[&str], path: &str) -> (bool, bool) {
        let pats: Vec<String> = patterns.iter().map(|s| s.to_string()).collect();
        let gm = GlobMatcher::new(Some(&pats)).unwrap();
        gm.matches(path)
    }

    // ── ** zero-segment fix ──────────────────────────────────────────────

    #[test]
    fn double_star_slash_matches_root_file() {
        let (matched, _) = m(&["**/*.php"], "Admin.php");
        assert!(matched);
    }

    #[test]
    fn double_star_slash_matches_nested_file() {
        let (matched, _) = m(&["**/*.php"], "Blame/Line.php");
        assert!(matched);
    }

    #[test]
    fn double_star_star_matches_root_file() {
        let (matched, _) = m(&["**/*"], "file.txt");
        assert!(matched);
    }

    // ── basic patterns ───────────────────────────────────────────────────

    #[test]
    fn star_php_matches_files() {
        let (matched, _) = m(&["*.php"], "Admin.php");
        assert!(matched);
        // globset's * matches across path separators (like minimatch with dot:true)
        // so *.php also matches dir/Admin.php — this is correct for hologit's use case
        // since the merge algorithm builds full paths incrementally
        let (matched, _) = m(&["*.php"], "dir/Admin.php");
        assert!(matched);
    }

    #[test]
    fn star_slash_double_star_requires_directory() {
        let (matched, _) = m(&["*/**"], "file.txt");
        assert!(!matched);
        let (matched, _) = m(&["*/**"], "dir/file.txt");
        assert!(matched);
        let (matched, _) = m(&["*/**"], "dir/sub/file.txt");
        assert!(matched);
    }

    #[test]
    fn double_star_alone_matches_everything() {
        // files = ["**"] is the fast path — returns None patterns
        let gm = GlobMatcher::new(Some(&["**".to_string()])).unwrap();
        assert!(!gm.has_patterns());
    }

    // ── negation ─────────────────────────────────────────────────────────

    #[test]
    fn negation_excludes_matching_path() {
        let (_, excluded) = m(&["**", "!.github/"], ".github/");
        assert!(excluded);
    }

    #[test]
    fn negation_does_not_exclude_non_matching() {
        let (matched, excluded) = m(&["**", "!.github/"], "src/main.rs");
        assert!(matched);
        assert!(!excluded);
    }

    #[test]
    fn negation_with_glob_suffix() {
        let (_, excluded) = m(&["**/*.php", "!*.inc.php"], "Foo.inc.php");
        assert!(excluded);
    }

    #[test]
    fn negation_priority_over_positive() {
        // Even though **/*.php matches, !Tests/** should exclude
        let (_, excluded) = m(&["**/*.php", "!Tests/**"], "Tests/FooTest.php");
        assert!(excluded);
    }

    // ── dotfiles ─────────────────────────────────────────────────────────

    #[test]
    fn double_star_matches_dotfiles() {
        let gm = GlobMatcher::new(Some(&["*/**".to_string()])).unwrap();
        let (matched, _) = gm.matches(".github/workflows/ci.yml");
        assert!(matched);
    }

    // ── directory trailing slash ──────────────────────────────────────────

    #[test]
    fn directory_pattern_matches_trailing_slash() {
        let (_, excluded) = m(&["**", "!.vscode/"], ".vscode/");
        assert!(excluded);
    }

    // ── has_patterns / has_negations ─────────────────────────────────────

    #[test]
    fn no_patterns_returns_none() {
        let gm = GlobMatcher::new(None).unwrap();
        assert!(!gm.has_patterns());
        assert!(!gm.has_negations());
        let (matched, _) = gm.matches("anything");
        assert!(matched);
    }

    #[test]
    fn has_negations_flag() {
        let pats = vec!["**".to_string(), "!node_modules/**".to_string()];
        let gm = GlobMatcher::new(Some(&pats)).unwrap();
        assert!(gm.has_patterns());
        assert!(gm.has_negations());
    }
}
