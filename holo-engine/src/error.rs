//! Error types for the holo-engine.

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("git: {0}")]
    Git(String),

    #[error("config error in {path}: {message}")]
    Config { path: String, message: String },

    #[error("source '{name}' could not be resolved: {reason}")]
    SourceResolution { name: String, reason: String },

    #[error("circular dependency in {kind} ordering")]
    CircularDependency { kind: String },

    #[error("glob pattern error: {0}")]
    Glob(#[from] globset::Error),

    #[error("{0}")]
    Other(String),
}

/// Convenience alias used throughout the crate.
pub type Result<T> = std::result::Result<T, Error>;

// ── Conversions ────────────────────────────────────────────────────────────

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

impl From<gix::hash::Error> for Error {
    fn from(e: gix::hash::Error) -> Self {
        Error::Git(e.to_string())
    }
}
