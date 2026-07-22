use std::path::PathBuf;
use std::process;

use codefacts::lsp::LspMode;
use codefacts::mcp;
use codefacts::service::CodeFactsRegistry;

fn main() {
    let (root, state, lsp_mode) = match parse_arguments() {
        Ok(values) => values,
        Err(message) => {
            eprintln!("{message}");
            process::exit(2);
        }
    };
    let mut projects = match CodeFactsRegistry::open_with_lsp(root, state, lsp_mode) {
        Ok(projects) => projects,
        Err(error) => {
            eprintln!("codefacts: {error}");
            process::exit(1);
        }
    };
    if let Err(error) = mcp::serve(&mut projects) {
        eprintln!("codefacts: {error}");
        process::exit(1);
    }
}

fn parse_arguments() -> Result<(Option<PathBuf>, Option<PathBuf>, LspMode), String> {
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

    // An MCP process can be launched from a client-owned or implementation
    // working directory. It never infers that directory as a project root:
    // --root is an optional default, and a rootless server requires every
    // tool call to name its repository_root explicitly.
    let mut root = None;
    let mut state = None;
    let mut lsp_mode = LspMode::Auto;
    while let Some(argument) = args.next() {
        match argument.to_string_lossy().as_ref() {
            "--root" => {
                root = Some(PathBuf::from(args.next().ok_or("--root requires a path")?));
            }
            "--state" => {
                state = Some(PathBuf::from(args.next().ok_or("--state requires a path")?));
            }
            "--lsp" => {
                let value = args.next().ok_or("--lsp requires auto or off")?;
                let value = value.to_string_lossy();
                lsp_mode = LspMode::parse(&value)
                    .ok_or_else(|| "--lsp must be 'auto' or 'off'".to_string())?;
            }
            "--help" | "-h" => return Err(usage()),
            other => return Err(format!("unknown argument '{other}'.\n{}", usage())),
        }
    }
    if root.is_none() && state.is_some() {
        return Err(
            "--state requires --root; dynamic project roots use independent external state files"
                .into(),
        );
    }
    Ok((root, state, lsp_mode))
}

fn usage() -> String {
    "Usage: codefacts mcp [--root <default-repository>] [--state <external-sqlite-path>] [--lsp <auto|off>]"
        .into()
}
