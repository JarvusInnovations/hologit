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

    let output_hash = holo_engine::project_branch(&repo, root_tree_id.detach(), &cli.branch)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let t_project = start.elapsed();

    println!("{output_hash}");

    if cli.stats {
        let stats = holo_engine::stats();
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
