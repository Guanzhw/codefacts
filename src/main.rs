use std::path::PathBuf;
use std::process;

use codefacts::mcp;
use codefacts::service::{default_database_path, CodeFacts};

fn main() {
    let (root, state) = match parse_arguments() {
        Ok(values) => values,
        Err(message) => {
            eprintln!("{message}");
            process::exit(2);
        }
    };
    let database_path = state.unwrap_or_else(|| default_database_path(&root));
    let facts = match CodeFacts::open(&root, &database_path) {
        Ok(facts) => facts,
        Err(error) => {
            eprintln!("codefacts: {error}");
            process::exit(1);
        }
    };
    if let Err(error) = mcp::serve(&facts) {
        eprintln!("codefacts: {error}");
        process::exit(1);
    }
}

fn parse_arguments() -> Result<(PathBuf, Option<PathBuf>), String> {
    let mut args = std::env::args_os().skip(1);
    match args.next().as_deref() {
        Some(command) if command == "mcp" => {}
        Some(command) if command == "--help" || command == "-h" => return Err(usage()),
        Some(command) => {
            return Err(format!(
                "unknown command '{}'.\n{}",
                command.to_string_lossy(),
                usage()
            ))
        }
        None => return Err(usage()),
    }

    let mut root = std::env::current_dir().map_err(|error| error.to_string())?;
    let mut state = None;
    while let Some(argument) = args.next() {
        match argument.to_string_lossy().as_ref() {
            "--root" => {
                root = PathBuf::from(args.next().ok_or("--root requires a path")?);
            }
            "--state" => {
                state = Some(PathBuf::from(args.next().ok_or("--state requires a path")?));
            }
            "--help" | "-h" => return Err(usage()),
            other => return Err(format!("unknown argument '{other}'.\n{}", usage())),
        }
    }
    Ok((root, state))
}

fn usage() -> String {
    "Usage: codefacts mcp [--root <repository>] [--state <external-sqlite-path>]".into()
}
