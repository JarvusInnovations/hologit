//! Error types for holo-tree operations.
//!
//! The consumer-facing contract — the stable code table, its stability rules,
//! the panic policy, and thread-safety expectations — is specced in
//! `specs/api/errors.md`. Codes are the API; message text is not.

#[derive(thiserror::Error, Debug)]
pub enum Error {
    /// An underlying git operation failed in a way holo-tree does not
    /// classify further. The residual class — failures may migrate from here
    /// to more specific variants in minor releases.
    #[error("git: {0}")]
    Git(String),

    /// An object id that was expected to exist in the ODB does not.
    #[error("object not found: {id}")]
    ObjectNotFound { id: String },

    /// An object or path component expected to be a tree is some other kind.
    #[error("not a tree: {0}")]
    NotATree(String),

    /// A fixed path could not be fully navigated where existence is required.
    /// Operations specced to return "absent" signal it with `None`, not this.
    #[error("path component '{component}' not found in tree")]
    PathNotFound { component: String },

    /// A glob pattern failed to compile.
    #[error("glob pattern error: {0}")]
    Glob(#[from] globset::Error),

    /// A TOML blob is non-UTF-8 or failed to parse.
    #[error("TOML parse error in {path}: {message}")]
    Toml { path: String, message: String },

    /// A caller-supplied value is malformed regardless of repository state:
    /// a non-hex object id, an invalid blob filemode, an unknown merge mode,
    /// an object of the wrong kind passed by hash, an unparseable signature.
    #[error("invalid argument: {0}")]
    InvalidArgument(String),

    /// A compare-and-swap `update_ref` failed because the ref's current value
    /// is not the expected one — it moved, disappeared, or unexpectedly
    /// exists. The optimistic-concurrency signal.
    #[error("ref conflict on {refname}: {message}")]
    RefConflict { refname: String, message: String },

    /// A holo-tree internal invariant was violated. Always a holo-tree bug —
    /// exists so a violated invariant degrades to a catchable error instead
    /// of a panic that would abort an embedding host process.
    #[error("holo-tree internal invariant violated: {0}")]
    Internal(String),
}

impl Error {
    /// A stable, machine-matchable code for this error variant.
    ///
    /// Unlike the human-readable `Display` string (which embeds variable
    /// context), these codes are part of the API contract (see
    /// `specs/api/errors.md`): downstream consumers — notably the napi
    /// binding and gitsheets — match on them to map substrate failures onto
    /// their own typed errors. Codes are append-only; never rename or reuse.
    pub fn code(&self) -> &'static str {
        match self {
            Error::Git(_) => "GIT",
            Error::ObjectNotFound { .. } => "OBJECT_NOT_FOUND",
            Error::NotATree(_) => "NOT_A_TREE",
            Error::PathNotFound { .. } => "PATH_NOT_FOUND",
            Error::Glob(_) => "GLOB",
            Error::Toml { .. } => "TOML",
            Error::InvalidArgument(_) => "INVALID_ARGUMENT",
            Error::RefConflict { .. } => "REF_CONFLICT",
            Error::Internal(_) => "INTERNAL",
        }
    }

    /// Build an [`Error::Internal`] for a violated invariant.
    ///
    /// Loud in development (`debug_assert!`), a catchable `INTERNAL` error in
    /// release — per the panic policy in `specs/api/errors.md`, a violated
    /// invariant must degrade gracefully rather than panic across FFI.
    #[track_caller]
    pub(crate) fn internal(message: impl Into<String>) -> Self {
        let message = message.into();
        debug_assert!(false, "holo-tree internal invariant violated: {message}");
        Error::Internal(message)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

// ── gix error conversions ──────────────────────────────────────────────────

impl From<gix::object::find::existing::Error> for Error {
    fn from(e: gix::object::find::existing::Error) -> Self {
        match e {
            gix::object::find::existing::Error::NotFound { oid } => Error::ObjectNotFound {
                id: oid.to_string(),
            },
            other => Error::Git(other.to_string()),
        }
    }
}

impl From<gix::object::write::Error> for Error {
    fn from(e: gix::object::write::Error) -> Self {
        Error::Git(e.to_string())
    }
}

impl From<gix::revision::spec::parse::single::Error> for Error {
    fn from(e: gix::revision::spec::parse::single::Error) -> Self {
        Error::Git(e.to_string())
    }
}

impl From<gix::reference::find::existing::Error> for Error {
    fn from(e: gix::reference::find::existing::Error) -> Self {
        Error::Git(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::Error;

    #[test]
    fn codes_are_stable_per_variant() {
        assert_eq!(Error::Git("x".into()).code(), "GIT");
        assert_eq!(
            Error::ObjectNotFound { id: "x".into() }.code(),
            "OBJECT_NOT_FOUND"
        );
        assert_eq!(Error::NotATree("x".into()).code(), "NOT_A_TREE");
        assert_eq!(
            Error::PathNotFound {
                component: "x".into()
            }
            .code(),
            "PATH_NOT_FOUND"
        );
        assert_eq!(
            Error::Toml {
                path: "p".into(),
                message: "m".into()
            }
            .code(),
            "TOML"
        );
        assert_eq!(
            Error::InvalidArgument("x".into()).code(),
            "INVALID_ARGUMENT"
        );
        assert_eq!(
            Error::RefConflict {
                refname: "refs/heads/main".into(),
                message: "moved".into()
            }
            .code(),
            "REF_CONFLICT"
        );
        assert_eq!(Error::Internal("x".into()).code(), "INTERNAL");
    }

    #[test]
    fn not_found_conversion_yields_object_not_found() {
        let oid = gix::ObjectId::empty_tree(gix::hash::Kind::Sha1);
        let e: Error = gix::object::find::existing::Error::NotFound { oid }.into();
        assert_eq!(e.code(), "OBJECT_NOT_FOUND");
    }
}
