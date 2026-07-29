//! Minimal stdio JSON-RPC transport for the five CodeFacts MCP tools.
//!
//! The transport writes protocol messages only to stdout. Diagnostics belong on
//! stderr so an MCP client never receives corrupted JSONL.

use std::io::{self, BufRead, BufReader, BufWriter, Write};

use serde_json::{json, Map, Value};

use crate::error::{CodeFactsError, Result};
use crate::service::{CodeFactsRegistry, SymbolScope};
use crate::types::NodeKind;

const LEGACY_PROTOCOL_VERSION: &str = "2025-11-25";
const ORIGINAL_LEGACY_PROTOCOL_VERSION: &str = "2024-11-05";
const MODERN_PROTOCOL_VERSION: &str = "2026-07-28";
const PROTOCOL_VERSION_META_KEY: &str = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_META_KEY: &str = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_META_KEY: &str = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_META_KEY: &str = "io.modelcontextprotocol/serverInfo";

#[derive(Clone, Copy)]
enum ProtocolEra {
    Legacy,
    Modern,
}

enum ProtocolSelection {
    Legacy,
    Modern,
    Invalid(String),
    Unsupported(String),
}

pub fn serve(projects: &mut CodeFactsRegistry) -> Result<()> {
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
        if let Some(response) = handle_request(projects, request) {
            write_json(&mut output, response)?;
        }
    }
    Ok(())
}

fn handle_request(projects: &mut CodeFactsRegistry, request: Value) -> Option<Value> {
    let id = request.get("id").cloned();
    let method = request.get("method").and_then(Value::as_str);
    let protocol = match select_protocol(&request) {
        ProtocolSelection::Legacy => ProtocolEra::Legacy,
        ProtocolSelection::Modern => ProtocolEra::Modern,
        ProtocolSelection::Invalid(message) => {
            return id.map(|id| json_rpc_error(id, -32602, &message));
        }
        ProtocolSelection::Unsupported(requested) => {
            return id.map(|id| unsupported_protocol_version_error(id, &requested));
        }
    };
    let response = match method {
        Some("server/discover") if matches!(protocol, ProtocolEra::Modern) => discovery_result(),
        Some("initialize") if matches!(protocol, ProtocolEra::Legacy) => json!({
            "protocolVersion": legacy_protocol_version(&request),
            "capabilities": { "tools": {} },
            "serverInfo": server_info()
        }),
        Some("tools/list") => json!({ "tools": tool_definitions() }),
        Some("tools/call") => match call_tool(projects, request.get("params")) {
            Ok(value) => tool_result(value),
            Err(error) => tool_error(&error.to_string()),
        },
        Some("notifications/initialized") => return None,
        Some(_) => return id.map(|id| json_rpc_error(id, -32601, "method not found")),
        None => return id.map(|id| json_rpc_error(id, -32600, "request has no method")),
    };
    let response = match protocol {
        ProtocolEra::Legacy => response,
        ProtocolEra::Modern => complete_result(response),
    };
    id.map(|id| json!({ "jsonrpc": "2.0", "id": id, "result": response }))
}

fn select_protocol(request: &Value) -> ProtocolSelection {
    let method = request.get("method").and_then(Value::as_str);
    let meta = request
        .get("params")
        .and_then(Value::as_object)
        .and_then(|params| params.get("_meta"))
        .and_then(Value::as_object);
    let has_modern_claim = meta.is_some_and(|meta| {
        meta.contains_key(PROTOCOL_VERSION_META_KEY)
            || meta.contains_key(CLIENT_INFO_META_KEY)
            || meta.contains_key(CLIENT_CAPABILITIES_META_KEY)
    });

    if method != Some("server/discover") && !has_modern_claim {
        return ProtocolSelection::Legacy;
    }

    let Some(meta) = meta else {
        return ProtocolSelection::Invalid(
            "2026-07-28 requests require params._meta with protocolVersion and clientCapabilities"
                .into(),
        );
    };
    let Some(version) = meta.get(PROTOCOL_VERSION_META_KEY).and_then(Value::as_str) else {
        return ProtocolSelection::Invalid(format!(
            "2026-07-28 requests require params._meta.{PROTOCOL_VERSION_META_KEY}"
        ));
    };
    if version != MODERN_PROTOCOL_VERSION {
        return ProtocolSelection::Unsupported(version.to_owned());
    }
    if !meta
        .get(CLIENT_CAPABILITIES_META_KEY)
        .is_some_and(Value::is_object)
    {
        return ProtocolSelection::Invalid(format!(
            "2026-07-28 requests require object params._meta.{CLIENT_CAPABILITIES_META_KEY}"
        ));
    }
    if let Some(client_info) = meta.get(CLIENT_INFO_META_KEY) {
        let valid = client_info.as_object().is_some_and(|info| {
            info.get("name").and_then(Value::as_str).is_some()
                && info.get("version").and_then(Value::as_str).is_some()
        });
        if !valid {
            return ProtocolSelection::Invalid(format!(
                "params._meta.{CLIENT_INFO_META_KEY} must contain string name and version when present"
            ));
        }
    }
    ProtocolSelection::Modern
}

fn discovery_result() -> Value {
    json!({
        "supportedVersions": supported_protocol_versions(),
        "capabilities": { "tools": {} }
    })
}

fn legacy_protocol_version(request: &Value) -> &str {
    match request
        .get("params")
        .and_then(Value::as_object)
        .and_then(|params| params.get("protocolVersion"))
        .and_then(Value::as_str)
    {
        Some(ORIGINAL_LEGACY_PROTOCOL_VERSION) => ORIGINAL_LEGACY_PROTOCOL_VERSION,
        _ => LEGACY_PROTOCOL_VERSION,
    }
}

fn supported_protocol_versions() -> Vec<&'static str> {
    vec![
        MODERN_PROTOCOL_VERSION,
        LEGACY_PROTOCOL_VERSION,
        ORIGINAL_LEGACY_PROTOCOL_VERSION,
    ]
}

fn server_info() -> Value {
    json!({ "name": "codefacts", "version": env!("CARGO_PKG_VERSION") })
}

fn complete_result(mut result: Value) -> Value {
    let object = result
        .as_object_mut()
        .expect("all CodeFacts MCP results are JSON objects");
    object.insert("resultType".into(), Value::String("complete".into()));
    let meta = object
        .entry("_meta")
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(meta) = meta.as_object_mut() {
        meta.insert(SERVER_INFO_META_KEY.into(), server_info());
    } else {
        *meta = json!({ SERVER_INFO_META_KEY: server_info() });
    }
    result
}

fn call_tool(projects: &mut CodeFactsRegistry, params: Option<&Value>) -> Result<Value> {
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
    let repository_root = optional_string(&arguments, "repository_root")?.map(str::to_owned);

    if !matches!(name, "map" | "search" | "outline" | "expand" | "path") {
        return Err(CodeFactsError::Mcp(format!(
            "unknown tool '{name}'; CodeFacts exposes only map, search, outline, expand, and path"
        )));
    }
    let facts = projects.project(repository_root.as_deref())?;

    match name {
        "map" => facts.map(),
        "search" => facts.search_with_page_scope_options(
            required_string(&arguments, "query")?,
            optional_node_kind(&arguments)?,
            optional_string(&arguments, "path_prefix")?,
            optional_symbol_scope(&arguments)?.unwrap_or(SymbolScope::TopLevel),
            optional_offset(&arguments)?.unwrap_or(0),
            optional_string(&arguments, "cursor")?,
            limit,
        ),
        "outline" => facts.outline_with_page_scope_options(
            required_string(&arguments, "file_path")?,
            optional_node_kind(&arguments)?,
            optional_symbol_scope(&arguments)?.unwrap_or(SymbolScope::TopLevel),
            optional_offset(&arguments)?.unwrap_or(0),
            optional_string(&arguments, "cursor")?,
            limit,
        ),
        "expand" => facts.expand(
            required_string(&arguments, "symbol")?,
            optional_string(&arguments, "file_path")?,
            limit,
        ),
        "path" => facts.path_with_files(
            required_string(&arguments, "from")?,
            optional_string(&arguments, "from_file_path")?,
            required_string(&arguments, "to")?,
            optional_string(&arguments, "to_file_path")?,
            limit,
        ),
        _ => unreachable!("tool name was validated before project selection"),
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
        Some(value) => {
            let value = value.as_u64().filter(|value| *value > 0).ok_or_else(|| {
                CodeFactsError::Mcp("'limit' must be a positive integer when present".into())
            })?;
            usize::try_from(value)
                .map(Some)
                .map_err(|_| CodeFactsError::Mcp("'limit' is too large for this platform".into()))
        }
    }
}

fn optional_offset(arguments: &Map<String, Value>) -> Result<Option<usize>> {
    match arguments.get("offset") {
        None => Ok(None),
        Some(value) => {
            let value = value.as_u64().ok_or_else(|| {
                CodeFactsError::Mcp("'offset' must be a non-negative integer when present".into())
            })?;
            let offset = usize::try_from(value).map_err(|_| {
                CodeFactsError::Mcp("'offset' is too large for this platform".into())
            })?;
            if i64::try_from(offset).is_err() {
                return Err(CodeFactsError::Mcp("'offset' is too large".into()));
            }
            Ok(Some(offset))
        }
    }
}

fn optional_node_kind(arguments: &Map<String, Value>) -> Result<Option<NodeKind>> {
    let Some(kind) = optional_string(arguments, "kind")? else {
        return Ok(None);
    };
    NodeKind::from_str_loose(kind)
        .filter(|parsed| parsed.as_str() == kind)
        .map(Some)
        .ok_or_else(|| {
            CodeFactsError::Mcp(format!(
                "'kind' must be one of the supported serialized node kinds, got '{kind}'"
            ))
        })
}

fn optional_symbol_scope(arguments: &Map<String, Value>) -> Result<Option<SymbolScope>> {
    let Some(scope) = optional_string(arguments, "scope")? else {
        return Ok(None);
    };
    SymbolScope::parse(scope).map(Some).ok_or_else(|| {
        CodeFactsError::Mcp(format!(
            "'scope' must be 'top_level' or 'all', got '{scope}'"
        ))
    })
}

fn tool_result(value: Value) -> Value {
    // MCP clients that do not consume `structuredContent` still need the
    // complete serialized result in TextContent. Keep that compatibility
    // payload compact: pretty-printing repeats structural whitespace without
    // adding any source-backed fact.
    let text = serde_json::to_string(&value).unwrap_or_else(|_| value.to_string());
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

fn unsupported_protocol_version_error(id: Value, requested: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": -32022,
            "message": "Unsupported protocol version",
            "data": {
                "supported": supported_protocol_versions(),
                "requested": requested
            }
        }
    })
}

fn write_json(output: &mut impl Write, value: Value) -> Result<()> {
    serde_json::to_writer(&mut *output, &value)?;
    output.write_all(b"\n").map_err(CodeFactsError::Io)?;
    output.flush().map_err(CodeFactsError::Io)
}

fn tool_definitions() -> Vec<Value> {
    vec![
        tool("map", "Repository structure, language mix, and high-level symbol counts. Set repository_root to inspect a project other than the configured default.", schema(json!({ "repository_root": repository_root_schema() }), &[])),
        tool("search", "Search indexed symbols, endpoints, and documentation headings through source-backed FTS; optionally narrow by kind, path prefix, or scope. Set repository_root to select a project for this call. The default top_level scope excludes local variables; pass scope=all for implementation detail. Continue with next_cursor to keep all pages on one index snapshot; offset is legacy compatibility only. This is not raw grep.", schema(json!({ "query": string_schema("Identifier or words to search"), "repository_root": repository_root_schema(), "kind": kind_schema(), "path_prefix": string_schema("Optional selected-project-relative file or directory prefix"), "scope": scope_schema(), "cursor": cursor_schema(), "offset": offset_schema(), "limit": limit_schema() }), &["query"])),
        tool("outline", "List indexed symbols or documentation headings in one selected-project-relative file. Set repository_root to select a project for this call. The default top_level scope excludes local variables; pass scope=all for implementation detail. Optionally filter by kind. Continue with next_cursor to keep all pages on one index snapshot; offset is legacy compatibility only.", schema(json!({ "repository_root": repository_root_schema(), "file_path": string_schema("Selected-project-relative file path"), "kind": kind_schema(), "scope": scope_schema(), "cursor": cursor_schema(), "offset": offset_schema(), "limit": limit_schema() }), &["file_path"])),
        tool("expand", "Return one symbol definition plus static callers, callees, references, and related tests from one selected project. Set repository_root to select a project for this call. When a user-installed supported LSP is available, include separately labeled semantic reference locations. Use a symbol id or add file_path to disambiguate.", schema(json!({ "repository_root": repository_root_schema(), "symbol": string_schema("Symbol name or exact symbol id"), "file_path": string_schema("Optional selected-project-relative disambiguator"), "limit": limit_schema() }), &["symbol"])),
        tool("path", "Find the shortest bounded static calls path within one selected project. Set repository_root to select that project; static relationships are not merged across projects. Optional file paths disambiguate duplicate names. A missing path never claims runtime unreachability.", schema(json!({ "repository_root": repository_root_schema(), "from": string_schema("Source symbol name or exact id"), "from_file_path": string_schema("Optional selected-project-relative source disambiguator"), "to": string_schema("Target symbol name or exact id"), "to_file_path": string_schema("Optional selected-project-relative target disambiguator"), "limit": limit_schema() }), &["from", "to"])),
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

fn repository_root_schema() -> Value {
    string_schema("Optional project root for this call. Required when the server was started without --root; use an absolute path to avoid server-working-directory ambiguity.")
}

fn limit_schema() -> Value {
    json!({ "type": "integer", "minimum": 1, "maximum": 50, "description": "Maximum items returned (default 20, capped at 50)" })
}

fn offset_schema() -> Value {
    json!({ "type": "integer", "minimum": 0, "description": "Number of matching items to skip before this bounded page (default 0)" })
}

fn cursor_schema() -> Value {
    json!({ "type": "string", "minLength": 1, "description": "Opaque next_cursor returned by the preceding page; rejects a stale or mismatched snapshot" })
}

fn kind_schema() -> Value {
    json!({ "type": "string", "enum": ["function", "class", "method", "interface", "type_alias", "enum", "variable", "struct", "trait", "module", "property", "namespace", "constant", "heading", "endpoint"], "description": "Optional exact serialized symbol kind" })
}

fn scope_schema() -> Value {
    json!({ "type": "string", "enum": ["top_level", "all"], "description": "top_level excludes variables declared inside a function or method (default); all retains every indexed symbol" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_arguments_validate_without_silent_coercion() {
        let zero_limit = json!({ "limit": 0 });
        assert!(optional_limit(zero_limit.as_object().expect("zero limit arguments")).is_err());

        let negative_offset = json!({ "offset": -1 });
        assert!(optional_offset(
            negative_offset
                .as_object()
                .expect("negative offset arguments")
        )
        .is_err());

        let invalid_kind = json!({ "kind": "const" });
        assert!(
            optional_node_kind(invalid_kind.as_object().expect("invalid kind arguments")).is_err()
        );

        let valid_kind = json!({ "kind": "constant", "offset": 0 });
        let arguments = valid_kind.as_object().expect("valid page arguments");
        assert_eq!(
            optional_node_kind(arguments).expect("valid kind"),
            Some(NodeKind::Constant)
        );
        assert_eq!(optional_offset(arguments).expect("valid offset"), Some(0));

        let invalid_scope = json!({ "scope": "locals_only" });
        assert!(
            optional_symbol_scope(invalid_scope.as_object().expect("invalid scope arguments"))
                .is_err()
        );
        let valid_scope = json!({ "scope": "all" });
        assert_eq!(
            optional_symbol_scope(valid_scope.as_object().expect("valid scope arguments"))
                .expect("valid scope"),
            Some(SymbolScope::All)
        );
    }
}
