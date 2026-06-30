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

impl Error {
    /// A stable, machine-matchable code for this error variant.
    ///
    /// Unlike the human-readable `Display` string (which embeds variable
    /// context), these codes are part of the API contract: downstream
    /// consumers — notably the napi binding and gitsheets — match on them to
    /// map substrate failures onto their own typed errors. Keep them stable.
    pub fn code(&self) -> &'static str {
        match self {
            Error::Git(_) => "GIT",
            Error::NotATree(_) => "NOT_A_TREE",
            Error::PathNotFound { .. } => "PATH_NOT_FOUND",
            Error::Glob(_) => "GLOB",
            Error::Toml { .. } => "TOML",
        }
    }
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
