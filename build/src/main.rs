mod codegen;
mod merge;
mod sources;
mod validate;

use clap::Parser;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "flashbang-build", about = "Merge bang sources and generate JS")]
struct Cli {
    #[arg(long)]
    kagi: Option<PathBuf>,

    #[arg(long)]
    ddg: Option<PathBuf>,

    #[arg(long)]
    custom: Option<PathBuf>,

    #[arg(long, default_value = "src/generated")]
    out: PathBuf,
}

fn main() {
    let cli = Cli::parse();

    if cli.kagi.is_none() && cli.ddg.is_none() {
        eprintln!("Error: at least one of --kagi or --ddg is required");
        std::process::exit(1);
    }

    let mut all_bangs = Vec::new();

    if let Some(path) = &cli.ddg {
        let raw = std::fs::read_to_string(path).expect("Failed to read DDG file");
        let bangs = sources::ddg::parse(&raw);
        println!("DDG: {} bangs parsed", bangs.len());
        all_bangs.push(("ddg", bangs));
    }

    if let Some(path) = &cli.kagi {
        let raw = std::fs::read_to_string(path).expect("Failed to read Kagi file");
        let bangs = sources::kagi::parse(&raw);
        println!("Kagi: {} bangs parsed", bangs.len());
        all_bangs.push(("kagi", bangs));
    }

    if let Some(path) = &cli.custom {
        let raw = std::fs::read_to_string(path).expect("Failed to read custom TOML file");
        let bangs = sources::custom::parse(&raw);
        println!("Custom: {} bangs parsed", bangs.len());
        all_bangs.push(("custom", bangs));
    }

    let merged = merge::merge(all_bangs);
    println!("Merged: {} unique bangs", merged.len());

    let valid = validate::validate(merged);
    println!("Valid: {} bangs after validation", valid.len());

    std::fs::create_dir_all(&cli.out).expect("Failed to create output directory");
    codegen::generate(&valid, &cli.out);
    println!("Generated files in {}", cli.out.display());
}
