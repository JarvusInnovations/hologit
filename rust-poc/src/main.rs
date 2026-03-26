mod config;
mod projection;
mod tree;

use anyhow::{Context, Result};
use clap::Parser;
use std::path::PathBuf;
use std::time::Instant;

#[derive(Parser)]
#[command(name = "holo-project", about = "Rust PoC of hologit projection")]
struct Cli {
    /// Path to the git repository (defaults to current directory)
    #[arg(short, long, default_value = ".")]
    repo: PathBuf,

    /// Name of the holobranch to project
    branch: String,

    /// Git ref to read workspace from (default: HEAD)
    #[arg(short = 'r', long, default_value = "HEAD")]
    r#ref: String,

    /// Disable lensing (lenses are not implemented in this PoC)
    #[arg(long, default_value_t = true)]
    no_lens: bool,

    /// Print detailed timing stats
    #[arg(long)]
    stats: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let start = Instant::now();

    // open repository via gitoxide — direct packfile access, no subprocess
    let repo = gix::discover(&cli.repo).context("failed to discover git repository")?;

    let t_open = start.elapsed();

    // resolve ref to a commit
    let spec = repo
        .rev_parse_single(cli.r#ref.as_str())
        .context("failed to resolve ref")?;
    let commit = spec
        .object()
        .context("failed to peel ref to object")?
        .try_into_commit()
        .context("ref does not point to a commit")?;
    let root_tree_id = commit.tree_id().context("commit has no tree")?;

    let t_resolve = start.elapsed();

    // run projection
    let output_hash =
        projection::project_branch(&repo, root_tree_id.detach(), &cli.branch)?;

    let t_project = start.elapsed();

    println!("{output_hash}");

    if cli.stats {
        let stats = tree::stats();
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
