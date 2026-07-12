//! Error types for holo-projector.

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error(transparent)]
    Tree(#[from] holo_tree::Error),

    #[error("config error in {path}: {message}")]
    Config { path: String, message: String },

    #[error("source '{name}' could not be resolved: {reason}")]
    SourceResolution { name: String, reason: String },

    #[error("fetch from '{url}' failed: {reason}")]
    SourceFetch { url: String, reason: String },

    #[error("circular dependency in {kind} ordering")]
    CircularDependency { kind: String },

    #[error("sub-projection of holobranch '{branch}' requires lensing ({reason}); composition-only engines must refuse rather than skip the lens phase")]
    LensedSubprojection { branch: String, reason: String },

    #[error("lens '{lens}' config error: {message}")]
    LensConfig { lens: String, message: String },

    #[error("lens container identity could not be resolved for '{container}': {message}")]
    LensIdentity { container: String, message: String },

    #[error("lens image '{container}' cannot run on this engine: {message}")]
    LensProtocol { container: String, message: String },

    #[error("lens job {spec_hash} failed with exit code {exit_code}{}{}", phase.as_deref().map(|p| format!(" in phase {p}")).unwrap_or_default(), log.as_deref().map(|l| format!(":\n{}", l.trim_end())).unwrap_or_default())]
    LensFailed {
        spec_hash: String,
        /// The inner transform's real exit status (from the error commit's
        /// `exit-code` entry — never a wrapper constant).
        exit_code: i32,
        /// `setup` | `transform` | `commit` — which SDK phase failed.
        phase: Option<String>,
        /// The captured job log from the error commit.
        log: Option<String>,
        /// The rendered command line, when the SDK recorded one.
        command: Option<String>,
    },

    #[error("lens job {spec_hash} transport error: {message}")]
    LensTransport { spec_hash: String, message: String },

    #[error("lens job {spec_hash} exceeded its {timeout_secs}s deadline and was cancelled")]
    LensTimeout {
        spec_hash: String,
        timeout_secs: u64,
    },

    #[error("{0}")]
    Other(String),
}

impl Error {
    /// Stable, machine-matchable error code (`specs/api/projector-napi.md`).
    ///
    /// [`Error::Tree`] forwards the underlying `holo_tree::Error` code
    /// unchanged; the remaining variants add projector-level codes. Codes are
    /// append-only — consumers match on codes, never on message prose.
    pub fn code(&self) -> &'static str {
        match self {
            Error::Tree(e) => e.code(),
            Error::Config { .. } => "CONFIG",
            Error::SourceResolution { .. } => "SOURCE_RESOLUTION",
            Error::SourceFetch { .. } => "SOURCE_FETCH",
            Error::CircularDependency { .. } => "CIRCULAR_DEPENDENCY",
            Error::LensedSubprojection { .. } => "LENSED_SUBPROJECTION",
            Error::LensConfig { .. } => "LENS_CONFIG",
            Error::LensIdentity { .. } => "LENS_IDENTITY",
            Error::LensProtocol { .. } => "LENS_PROTOCOL",
            Error::LensFailed { .. } => "LENS_FAILED",
            Error::LensTransport { .. } => "LENS_TRANSPORT",
            Error::LensTimeout { .. } => "LENS_TIMEOUT",
            Error::Other(_) => "PROJECTION",
        }
    }
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
