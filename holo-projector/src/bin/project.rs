//! Thin CLI for benchmarking and testing the holo-engine.

use anyhow::{Context, Result};
use clap::Parser;
use std::path::PathBuf;
use std::time::Instant;

#[derive(Parser)]
#[command(name = "holo-project", about = "Project a holobranch via holo-engine")]
struct Cli {
    /// Path to the git repository
    #[arg(short, long, default_value = ".")]
    repo: PathBuf,

    /// Name of the holobranch to project
    branch: String,

    /// Git ref to read workspace from
    #[arg(short = 'r', long, default_value = "HEAD")]
    r#ref: String,

    /// Print timing and tree stats
    #[arg(long)]
    stats: bool,

    /// Fetch unresolvable remote sources into refs/holo/source/... (via
    /// `git fetch`) instead of erroring on them
    #[arg(long)]
    fetch: bool,

    /// Run the full pipeline including lens execution (composite → lens →
    /// strip). Without this flag the engine is composition-only and refuses
    /// lensed sub-projections.
    #[arg(long)]
    lens: bool,

    /// Container engine CLI for lens execution (autodetects docker, then
    /// podman, when omitted)
    #[arg(long)]
    runtime: Option<String>,

    /// Re-execute lenses even when a cached result exists
    #[arg(long)]
    refresh: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let start = Instant::now();

    let repo = gix::discover(&cli.repo).context("failed to discover git repository")?;
    let t_open = start.elapsed();

    let spec = repo
        .rev_parse_single(cli.r#ref.as_str())
        .context("failed to resolve ref")?;
    let commit = spec
        .object()
        .context("failed to peel ref")?
        .try_into_commit()
        .context("ref is not a commit")?;
    let root_tree_id = commit.tree_id().context("commit has no tree")?;
    let t_resolve = start.elapsed();

    let fetcher = cli
        .fetch
        .then(|| holo_projector::GitCliFetcher::new(&repo));

    let output_hash = if cli.lens {
        use holo_projector::lens::{ContainerCli, CurlRegistry, LensEngine};
        let runtime = match &cli.runtime {
            Some(program) => ContainerCli::new(program.clone()),
            None => ContainerCli::detect().map_err(|e| anyhow::anyhow!("{e}"))?,
        };
        let registry = CurlRegistry;
        let mut engine = LensEngine::new(&runtime, &registry);
        engine.refresh = cli.refresh;
        engine.fetcher = fetcher
            .as_ref()
            .map(|f| f as &dyn holo_projector::SourceFetcher);
        holo_projector::lens::project_branch_lensed(
            &repo,
            root_tree_id.detach(),
            &cli.branch,
            &engine,
            None,
        )
        .map_err(|e| anyhow::anyhow!("{e}"))?
    } else if let Some(ref fetcher) = fetcher {
        holo_projector::project_branch_fetching(&repo, root_tree_id.detach(), &cli.branch, fetcher)
            .map_err(|e| anyhow::anyhow!("{e}"))?
    } else {
        holo_projector::project_branch(&repo, root_tree_id.detach(), &cli.branch)
            .map_err(|e| anyhow::anyhow!("{e}"))?
    };
    let t_project = start.elapsed();

    println!("{output_hash}");

    if cli.stats {
        let stats = holo_projector::stats();
        eprintln!();
        eprintln!("--- timing ---");
        eprintln!("  repo open:    {:?}", t_open);
        eprintln!("  ref resolve:  {:?}", t_resolve - t_open);
        eprintln!("  projection:   {:?}", t_project - t_resolve);
        eprintln!("  total:        {:?}", t_project);
        eprintln!();
        eprintln!("--- tree stats ---");
        eprintln!("  trees read:       {}", stats.trees_read);
        eprintln!("  trees written:    {}", stats.trees_written);
        eprintln!("  trees skipped:    {}", stats.trees_skipped_clean);
        eprintln!("  cache hits:       {}", stats.cache_hits);
        eprintln!("  cache misses:     {}", stats.cache_misses);
        eprintln!("  blobs read:       {}", stats.blobs_read);
    }

    Ok(())
}
