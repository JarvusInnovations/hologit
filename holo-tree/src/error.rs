//! Error types for holo-tree operations.

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("git: {0}")]
    Git(String),

    #[error("not a tree: {0}")]
    NotATree(String),

    #[error("path component '{component}' not found in tree")]
    PathNotFound { component: String },

    #[error("glob pattern error: {0}")]
    Glob(#[from] globset::Error),

    #[error("TOML parse error in {path}: {message}")]
    Toml { path: String, message: String },
}

pub type Result<T> = std::result::Result<T, Error>;

// ── gix error conversions ──────────────────────────────────────────────────

impl From<gix::object::find::existing::Error> for Error {
    fn from(e: gix::object::find::existing::Error) -> Self {
        Error::Git(e.to_string())
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
