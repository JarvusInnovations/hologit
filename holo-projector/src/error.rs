//! Error types for holo-projector.

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error(transparent)]
    Tree(#[from] holo_tree::Error),

    #[error("config error in {path}: {message}")]
    Config { path: String, message: String },

    #[error("source '{name}' could not be resolved: {reason}")]
    SourceResolution { name: String, reason: String },

    #[error("circular dependency in {kind} ordering")]
    CircularDependency { kind: String },

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;

// Route gix errors through holo_tree::Error → Error
impl From<gix::object::find::existing::Error> for Error {
    fn from(e: gix::object::find::existing::Error) -> Self {
        Error::Tree(holo_tree::Error::from(e))
    }
}

impl From<gix::object::write::Error> for Error {
    fn from(e: gix::object::write::Error) -> Self {
        Error::Tree(holo_tree::Error::from(e))
    }
}

impl From<gix::revision::spec::parse::single::Error> for Error {
    fn from(e: gix::revision::spec::parse::single::Error) -> Self {
        Error::Tree(holo_tree::Error::from(e))
    }
}
