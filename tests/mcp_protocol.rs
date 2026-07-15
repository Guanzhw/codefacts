use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};

use codefacts::lsp::LspMode;
use codefacts::service::CodeFacts;
use serde_json::{json, Value};
use tempfile::tempdir;

#[test]
fn stdio_server_exposes_only_the_five_source_backed_workflows() {
    let repository = tempdir().expect("temporary repository");
    fs::create_dir_all(repository.path().join("src")).expect("source directory");
    fs::write(
        repository.path().join("src/lib.rs"),
        "pub fn helper() {}\n\npub fn entry() {\n    helper();\n}\n",
    )
    .expect("rust fixture");
    fs::write(
        repository.path().join("README.md"),
        "# Usage\n\n## Details\n",
    )
    .expect("markdown fixture");

    let state = repository.path().join("external-state.sqlite");
    let mut child = Command::new(env!("CARGO_BIN_EXE_codefacts"))
        .args([
            "mcp",
            "--root",
            repository.path().to_str().expect("UTF-8 temp path"),
            "--state",
            state.to_str().expect("UTF-8 state path"),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start CodeFacts MCP server");

    let requests = [
        json!({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{}}),
        json!({"jsonrpc":"2.0", "id":2, "method":"tools/list"}),
        json!({"jsonrpc":"2.0", "id":3, "method":"tools/call", "params":{"name":"map", "arguments":{}}}),
        json!({"jsonrpc":"2.0", "id":4, "method":"tools/call", "params":{"name":"search", "arguments":{"query":"helper"}}}),
        json!({"jsonrpc":"2.0", "id":5, "method":"tools/call", "params":{"name":"outline", "arguments":{"file_path":"README.md"}}}),
        json!({"jsonrpc":"2.0", "id":6, "method":"tools/call", "params":{"name":"expand", "arguments":{"symbol":"helper", "file_path":"src/lib.rs"}}}),
        json!({"jsonrpc":"2.0", "id":7, "method":"tools/call", "params":{"name":"path", "arguments":{"from":"entry", "to":"helper"}}}),
    ];
    let mut input = child.stdin.take().expect("child stdin");
    for request in requests {
        writeln!(input, "{}", request).expect("write JSON-RPC request");
    }
    drop(input);

    let output = child
        .wait_with_output()
        .expect("wait for CodeFacts MCP server");
    assert!(
        output.status.success(),
        "server stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "MCP server should keep diagnostics out of a healthy run"
    );

    let responses = String::from_utf8(output.stdout)
        .expect("UTF-8 JSONL")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("JSON-RPC response"))
        .collect::<Vec<_>>();
    assert_eq!(responses.len(), 7);

    let tools = responses[1]["result"]["tools"]
        .as_array()
        .expect("tool list");
    let names = tools
        .iter()
        .map(|tool| tool["name"].as_str().expect("tool name"))
        .collect::<Vec<_>>();
    assert_eq!(names, ["map", "search", "outline", "expand", "path"]);

    assert_eq!(
        responses[2]["result"]["structuredContent"]["freshness"]["status"],
        "fresh"
    );
    assert_eq!(
        responses[3]["result"]["structuredContent"]["results"][0]["name"],
        "helper"
    );
    assert_eq!(
        responses[4]["result"]["structuredContent"]["symbols"][0]["kind"],
        "heading"
    );
    assert_eq!(responses[5]["result"]["structuredContent"]["status"], "ok");
    assert_eq!(responses[6]["result"]["structuredContent"]["status"], "ok");
    assert_eq!(
        responses[6]["result"]["structuredContent"]["path"][0]["name"],
        "entry"
    );
    assert_eq!(
        responses[6]["result"]["structuredContent"]["path"][1]["name"],
        "helper"
    );
}

#[test]
fn refresh_prunes_facts_for_deleted_or_newly_ignored_files() {
    let repository = tempdir().expect("temporary repository");
    fs::create_dir_all(repository.path().join("src")).expect("source directory");
    let source = repository.path().join("src/temporary.rs");
    fs::write(&source, "pub fn temporary() {}\n").expect("rust fixture");
    let facts = CodeFacts::open(repository.path(), repository.path().join("external.sqlite"))
        .expect("open external index");

    let indexed = facts.map().expect("initial map");
    assert_eq!(indexed["symbols"], 1);

    fs::remove_file(&source).expect("delete indexed source");
    let refreshed = facts.map().expect("refresh after deletion");
    assert_eq!(refreshed["freshness"]["status"], "fresh");
    assert_eq!(refreshed["symbols"], 0);
}

#[test]
fn lsp_is_optional_and_leaves_static_expand_facts_intact_when_disabled() {
    let repository = tempdir().expect("temporary repository");
    fs::write(
        repository.path().join("lib.rs"),
        "pub fn helper() {}\n\npub fn entry() {\n    helper();\n}\n",
    )
    .expect("rust fixture");
    let facts = CodeFacts::open_with_lsp(
        repository.path(),
        repository.path().join("external.sqlite"),
        LspMode::Off,
    )
    .expect("open external index with LSP disabled");

    let map = facts.map().expect("map without LSP probes");
    assert_eq!(map["lsp"]["mode"], "off");
    assert!(map["lsp"]["servers"]
        .as_array()
        .expect("LSP servers")
        .is_empty());

    let expanded = facts
        .expand("helper", Some("lib.rs"), None)
        .expect("static expand without LSP");
    assert_eq!(expanded["references"]["semantic"]["status"], "disabled");
    assert!(expanded["callers"]
        .as_array()
        .expect("static callers")
        .iter()
        .any(|caller| caller["from"]["name"] == "entry"));
}

#[test]
fn refresh_rebinds_static_calls_when_a_new_definition_appears() {
    let repository = tempdir().expect("temporary repository");
    fs::create_dir_all(repository.path().join("src")).expect("source directory");
    fs::write(
        repository.path().join("src/main.ts"),
        "export function processInput(value: string) { return validate(value); }\n",
    )
    .expect("initial TypeScript fixture");
    let facts = CodeFacts::open(repository.path(), repository.path().join("external.sqlite"))
        .expect("open external index");

    let initial = facts
        .path("processInput", "validate", None)
        .expect("initial path");
    assert_eq!(initial["status"], "not_found");

    fs::write(
        repository.path().join("src/utils.ts"),
        "export function validate(value: string) { return value.length > 0; }\n",
    )
    .expect("new definition fixture");
    let rebound = facts
        .path("processInput", "validate", None)
        .expect("rebound path");
    assert_eq!(rebound["status"], "ok");
    assert_eq!(rebound["path"][0]["name"], "processInput");
    assert_eq!(rebound["path"][1]["name"], "validate");
}

#[test]
fn search_and_expand_surface_source_backed_endpoint_facts() {
    let repository = tempdir().expect("temporary repository");
    fs::create_dir_all(repository.path().join("src")).expect("source directory");
    fs::write(
        repository.path().join("src/handlers.ts"),
        "export function authMiddleware() { return true; }\nexport function getUser() { return 'ok'; }\n",
    )
    .expect("handler fixture");
    fs::write(
        repository.path().join("src/routes.ts"),
        "import { authMiddleware, getUser } from './handlers';\napp.get('/users/:id', authMiddleware, getUser);\n",
    )
    .expect("endpoint fixture");
    let facts = CodeFacts::open(repository.path(), repository.path().join("external.sqlite"))
        .expect("open external index");

    let search = facts.search("users", None).expect("endpoint search");
    let endpoint = search["results"]
        .as_array()
        .expect("search results")
        .iter()
        .find(|result| result["kind"] == "endpoint")
        .expect("endpoint result");
    assert_eq!(endpoint["name"], "GET /users/:id");
    assert_eq!(endpoint["evidence"]["extractor"], "endpoint-pattern");
    assert_eq!(endpoint["evidence"]["confidence"], "heuristic");

    let expand = facts
        .expand("GET /users/:id", Some("src/routes.ts"), None)
        .expect("endpoint expand");
    assert_eq!(expand["status"], "ok");
    let outbound = expand["references"]["outbound"]
        .as_array()
        .expect("endpoint outbound references");
    assert_eq!(outbound.len(), 2);
    assert!(outbound.iter().any(|reference| {
        reference["to"]["name"] == "getUser"
            && reference["to"]["evidence"]["file_path"] == "src/handlers.ts"
    }));
    assert!(outbound.iter().any(|reference| {
        reference["to"]["name"] == "authMiddleware"
            && reference["evidence"]["extractor"] == "endpoint-pattern"
            && reference["evidence"]["confidence"] == "heuristic"
    }));
}
