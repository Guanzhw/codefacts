//! Minimal stdio JSON-RPC transport for the five CodeFacts MCP tools.
//!
//! The transport writes protocol messages only to stdout. Diagnostics belong on
//! stderr so an MCP client never receives corrupted JSONL.

use std::io::{self, BufRead, BufReader, BufWriter, Write};

use serde_json::{json, Map, Value};

use crate::error::{CodeFactsError, Result};
use crate::service::CodeFacts;

const PROTOCOL_VERSION: &str = "2024-11-05";

pub fn serve(facts: &CodeFacts) -> Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut output = BufWriter::new(stdout.lock());

    for line in BufReader::new(stdin.lock()).lines() {
        let line = line.map_err(CodeFactsError::Io)?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                write_json(
                    &mut output,
                    json_rpc_error(Value::Null, -32700, &error.to_string()),
                )?;
                continue;
            }
        };
        if let Some(response) = handle_request(facts, request) {
            write_json(&mut output, response)?;
        }
    }
    Ok(())
}

fn handle_request(facts: &CodeFacts, request: Value) -> Option<Value> {
    let id = request.get("id").cloned();
    let method = request.get("method").and_then(Value::as_str);
    let response = match method {
        Some("initialize") => json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "codefacts", "version": env!("CARGO_PKG_VERSION") }
        }),
        Some("tools/list") => json!({ "tools": tool_definitions() }),
        Some("tools/call") => match call_tool(facts, request.get("params")) {
            Ok(value) => tool_result(value),
            Err(error) => tool_error(&error.to_string()),
        },
        Some("notifications/initialized") => return None,
        Some(_) => return id.map(|id| json_rpc_error(id, -32601, "method not found")),
        None => return id.map(|id| json_rpc_error(id, -32600, "request has no method")),
    };
    id.map(|id| json!({ "jsonrpc": "2.0", "id": id, "result": response }))
}

fn call_tool(facts: &CodeFacts, params: Option<&Value>) -> Result<Value> {
    let params = params
        .and_then(Value::as_object)
        .ok_or_else(|| CodeFactsError::Mcp("tools/call requires object params".into()))?;
    let name = required_string(params, "name")?;
    let arguments = params
        .get("arguments")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let limit = optional_limit(&arguments)?;

    match name {
        "map" => facts.map(),
        "search" => facts.search(required_string(&arguments, "query")?, limit),
        "outline" => facts.outline(required_string(&arguments, "file_path")?, limit),
        "expand" => facts.expand(
            required_string(&arguments, "symbol")?,
            optional_string(&arguments, "file_path")?,
            limit,
        ),
        "path" => facts.path(
            required_string(&arguments, "from")?,
            required_string(&arguments, "to")?,
            limit,
        ),
        _ => Err(CodeFactsError::Mcp(format!(
            "unknown tool '{name}'; CodeFacts exposes only map, search, outline, expand, and path"
        ))),
    }
}

fn required_string<'a>(arguments: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CodeFactsError::Mcp(format!("'{key}' must be a non-empty string")))
}

fn optional_string<'a>(arguments: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value)),
        _ => Err(CodeFactsError::Mcp(format!(
            "'{key}' must be a non-empty string when present"
        ))),
    }
}

fn optional_limit(arguments: &Map<String, Value>) -> Result<Option<usize>> {
    match arguments.get("limit") {
        None => Ok(None),
        Some(value) => value
            .as_u64()
            .map(|value| Some(value as usize))
            .ok_or_else(|| {
                CodeFactsError::Mcp("'limit' must be a positive integer when present".into())
            }),
    }
}

fn tool_result(value: Value) -> Value {
    let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string());
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": value,
        "isError": false,
    })
}

fn tool_error(message: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": message }],
        "isError": true,
    })
}

fn json_rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn write_json(output: &mut impl Write, value: Value) -> Result<()> {
    serde_json::to_writer(&mut *output, &value)?;
    output.write_all(b"\n").map_err(CodeFactsError::Io)?;
    output.flush().map_err(CodeFactsError::Io)
}

fn tool_definitions() -> Vec<Value> {
    vec![
        tool("map", "Repository structure, language mix, and high-level symbol counts.", json!({ "type": "object", "additionalProperties": false })),
        tool("search", "Search indexed symbols, endpoints, and documentation headings through source-backed FTS; this is not raw grep.", schema(json!({ "query": string_schema("Identifier or words to search"), "limit": limit_schema() }), &["query"])),
        tool("outline", "List indexed symbols or documentation headings in one repository-relative file.", schema(json!({ "file_path": string_schema("Repository-relative file path"), "limit": limit_schema() }), &["file_path"])),
        tool("expand", "Return one symbol definition plus static callers, callees, references, and related tests. Use a symbol id or add file_path to disambiguate.", schema(json!({ "symbol": string_schema("Symbol name or exact symbol id"), "file_path": string_schema("Optional repository-relative disambiguator"), "limit": limit_schema() }), &["symbol"])),
        tool("path", "Find the shortest bounded static calls path between two confirmed symbols. A missing path never claims runtime unreachability.", schema(json!({ "from": string_schema("Source symbol name or exact id"), "to": string_schema("Target symbol name or exact id"), "limit": limit_schema() }), &["from", "to"])),
    ]
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({ "name": name, "description": description, "inputSchema": input_schema })
}

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false })
}

fn string_schema(description: &str) -> Value {
    json!({ "type": "string", "minLength": 1, "description": description })
}

fn limit_schema() -> Value {
    json!({ "type": "integer", "minimum": 1, "maximum": 50, "description": "Maximum items returned (default 20, capped at 50)" })
}
