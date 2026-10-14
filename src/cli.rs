//! Direct native navigation commands using the same execution contract as MCP.

use crate::lsp::LspMode;
use crate::mcp::{self, ToolProfile};
use crate::service::CodeFactsRegistry;
use serde_json::{json, Map, Value};
use std::ffi::OsString;
use std::path::PathBuf;

const USAGE: &str = "Usage:
  codefacts mcp [--root <repository>] [--state <external-sqlite-path>] [--lsp <auto|off>]
  codefacts map [options]
  codefacts search <identifier-or-terms> [options]
  codefacts outline <file> [options]
  codefacts node <symbol-or-id> [--file <file>] [options]
  codefacts callers <symbol-or-id> [--file <file>] [options]
  codefacts callees <symbol-or-id> [--file <file>] [options]
  codefacts expand <symbol-or-id> [--file <file>] [options]
  codefacts path <from-symbol> <to-symbol> [--from-file <file>] [--to-file <file>] [options]
  codefacts explore [code-terms] [--path-prefix <path>] [--max-bytes <2000..32000>]
  codefacts explore --file <file> [--start-line <line>] [--end-line <line>]
  codefacts explore --reads '<JSON array of file_path/start_line/end_line ranges>'
  codefacts impact <symbol-or-id> [--file <file>] [--max-depth <1..10>] [--limit <1..50>]

Query options: --root <repository> (default current directory),
  --state <external-sqlite-path>, --lsp <auto|off>,
  --format <markdown|compact|full> (default markdown; explore is text-only),
  --limit <1..50>, --cursor <cursor>.
Search: --kind <kind>, --scope <top_level|all>, --detail <facts|context>,
  --context-limit <1..3>, --path-prefix <path>.
Outline: --kind <kind>, --scope <top_level|all>.
MCP exposes map, search, outline, expand, path, explore and impact.
Index state is stored outside the repository by default.";

pub fn run(arguments: impl IntoIterator<Item = OsString>) -> Result<(), String> {
    let mut args = arguments.into_iter();
    let command = args.next().unwrap_or_else(|| "--help".into());
    let command = command.to_str().ok_or("command must be valid UTF-8")?;
    if matches!(command, "--help" | "-h") {
        println!("{USAGE}");
        return Ok(());
    }
    if matches!(command, "--version" | "-V") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let tool = match command {
        "mcp" | "map" | "search" | "outline" | "expand" | "path" | "explore" | "impact" => command,
        "node" | "callers" | "callees" => "expand",
        _ => return Err(format!("unknown command '{command}'\n{USAGE}")),
    };
    let mut root = None;
    let mut state = None;
    let mut lsp = LspMode::Auto;
    let mut tools = ToolProfile::All;
    let mut fields = Map::new();
    let mut positionals = Vec::new();
    while let Some(argument) = args.next() {
        let argument = argument
            .to_str()
            .ok_or("query arguments must be valid UTF-8")?;
        if matches!(argument, "--help" | "-h") {
            println!("{USAGE}");
            return Ok(());
        }
        if !argument.starts_with('-') {
            positionals.push(argument.to_string());
            continue;
        }
        let value = args.next().ok_or_else(|| {
            if argument == "--tools" {
                "--tools requires all or explore".into()
            } else {
                format!("{argument} requires a value")
            }
        })?;
        match argument {
            "--root" => root = Some(PathBuf::from(value)),
            "--state" => state = Some(PathBuf::from(value)),
            "--lsp" => {
                lsp = LspMode::parse(&value.to_string_lossy())
                    .ok_or("--lsp must be 'auto' or 'off'")?;
            }
            "--tools" if tool == "mcp" => {
                tools = ToolProfile::parse(&value.to_string_lossy())
                    .ok_or("--tools must be 'all' or 'explore'")?;
            }
            flag if tool != "mcp" => {
                let key = match flag {
                    "--file" => "file_path".into(),
                    "--from-file" => "from_file_path".into(),
                    "--to-file" => "to_file_path".into(),
                    _ => flag.trim_start_matches("--").replace('-', "_"),
                };
                if !allowed_options(tool).contains(&key.as_str()) {
                    return Err(format!("{flag} is not supported by {command}"));
                }
                let value = value.to_str().ok_or("query option must be valid UTF-8")?;
                let value = match key.as_str() {
                    "limit" | "max_depth" | "max_bytes" | "start_line" | "end_line"
                    | "context_limit" | "offset" => Value::from(
                        value
                            .parse::<u64>()
                            .map_err(|_| format!("{flag} requires a non-negative integer"))?,
                    ),
                    "reads" => serde_json::from_str(value)
                        .map_err(|error| format!("invalid --reads JSON: {error}"))?,
                    _ => Value::from(value),
                };
                if fields.insert(key, value).is_some() {
                    return Err(format!("duplicate option '{flag}'"));
                }
            }
            _ => return Err(format!("unknown option '{argument}'")),
        }
    }
    if tool == "mcp" {
        if !positionals.is_empty() {
            return Err("mcp does not accept positional arguments".into());
        }
        if root.is_none() && state.is_some() {
            return Err("--state requires --root; dynamic project roots use independent external state files".into());
        }
        let mut projects = CodeFactsRegistry::open_with_lsp(root, state, lsp)
            .map_err(|error| error.to_string())?;
        return mcp::serve_with_tools(&mut projects, tools).map_err(|error| error.to_string());
    }
    match tool {
        "search" if !positionals.is_empty() => {
            fields.insert("query".into(), Value::from(positionals.join(" ")));
        }
        "explore" => {
            if !positionals.is_empty() {
                fields.insert("query".into(), Value::from(positionals.join(" ")));
            }
            if let Some(end) = fields.remove("end_line") {
                let file = fields
                    .remove("file_path")
                    .ok_or("--end-line requires --file")?;
                if fields.contains_key("reads") {
                    return Err("--end-line cannot be combined with --reads".into());
                }
                let mut read = json!({"file_path":file,"end_line":end});
                if let Some(start) = fields.remove("start_line") {
                    read["start_line"] = start;
                }
                fields.insert("reads".into(), json!([read]));
            }
        }
        "map" if positionals.is_empty() => {}
        "outline" if positionals.len() == 1 => {
            fields.insert("file_path".into(), Value::from(positionals[0].as_str()));
        }
        "expand" | "impact" if positionals.len() == 1 => {
            fields.insert("symbol".into(), Value::from(positionals[0].as_str()));
        }
        "path" if positionals.len() == 2 => {
            fields.insert("from".into(), Value::from(positionals[0].as_str()));
            fields.insert("to".into(), Value::from(positionals[1].as_str()));
        }
        _ => return Err(format!("invalid arguments for {command}\n{USAGE}")),
    }
    if tool == "expand" {
        fields.insert(
            "section".into(),
            Value::from(match command {
                "callers" => "callers",
                "callees" => "callees",
                _ => "all",
            }),
        );
    }
    if tool != "explore" {
        fields
            .entry("format")
            .or_insert_with(|| Value::from("markdown"));
    }
    let root = root
        .map_or_else(std::env::current_dir, Ok)
        .map_err(|error| error.to_string())?;
    let mut projects = CodeFactsRegistry::open_with_lsp(Some(root), state, lsp)
        .map_err(|error| error.to_string())?;
    let result =
        mcp::execute_tool(&mut projects, tool, fields).map_err(|error| error.to_string())?;
    println!(
        "{}",
        result["content"][0]["text"]
            .as_str()
            .expect("execution returns MCP text content")
    );
    Ok(())
}

fn allowed_options(tool: &str) -> &'static [&'static str] {
    match tool {
        "map" => &["format"],
        "search" => &[
            "format",
            "limit",
            "cursor",
            "offset",
            "kind",
            "scope",
            "detail",
            "context_limit",
            "path_prefix",
        ],
        "outline" => &["format", "limit", "cursor", "offset", "kind", "scope"],
        "expand" => &["format", "limit", "cursor", "file_path"],
        "path" => &["format", "limit", "from_file_path", "to_file_path"],
        "impact" => &["format", "limit", "max_depth", "file_path"],
        "explore" => &[
            "query",
            "path_prefix",
            "file_path",
            "start_line",
            "end_line",
            "reads",
            "max_bytes",
        ],
        _ => unreachable!("known query command"),
    }
}
