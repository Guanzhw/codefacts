use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use codefacts::lsp::LspMode;
use codefacts::service::{CodeFacts, SymbolScope};
use codefacts::types::NodeKind;
use serde_json::{json, Value};
use tempfile::tempdir;

fn assert_repository_root_identity(actual: &Value, expected: &Path) {
    let actual = actual.as_str().expect("repository root string");
    assert_eq!(
        Path::new(actual)
            .canonicalize()
            .expect("canonical returned repository root"),
        expected
            .canonicalize()
            .expect("canonical expected repository root")
    );
    #[cfg(windows)]
    assert!(
        !actual.starts_with(r"\\?\"),
        "repository root should not expose a Win32 extended-length prefix: {actual}"
    );
}

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
        json!({"jsonrpc":"2.0", "id":8, "method":"tools/call", "params":{"name":"path", "arguments":{"from":"entry", "from_file_path":"src/lib.rs", "to":"helper", "to_file_path":"src/lib.rs"}}}),
        json!({"jsonrpc":"2.0", "id":9, "method":"tools/call", "params":{"name":"search", "arguments":{"query":"helper", "kind":"function", "path_prefix":"src", "offset":0, "limit":1}}}),
        json!({"jsonrpc":"2.0", "id":10, "method":"tools/call", "params":{"name":"outline", "arguments":{"file_path":"README.md", "offset":1, "limit":1}}}),
        json!({"jsonrpc":"2.0", "id":11, "method":"tools/call", "params":{"name":"search", "arguments":{"query":"helper", "kind":"const"}}}),
        json!({"jsonrpc":"2.0", "id":12, "method":"tools/call", "params":{"name":"search", "arguments":{"query":"helper", "limit":0}}}),
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
    assert_eq!(responses.len(), 12);

    let tools = responses[1]["result"]["tools"]
        .as_array()
        .expect("tool list");
    let names = tools
        .iter()
        .map(|tool| tool["name"].as_str().expect("tool name"))
        .collect::<Vec<_>>();
    assert_eq!(names, ["map", "search", "outline", "expand", "path"]);
    let search = tools
        .iter()
        .find(|tool| tool["name"] == "search")
        .expect("search schema");
    assert!(search["inputSchema"]["properties"].get("kind").is_some());
    assert!(search["inputSchema"]["properties"]
        .get("path_prefix")
        .is_some());
    assert!(search["inputSchema"]["properties"].get("scope").is_some());
    assert!(search["inputSchema"]["properties"].get("offset").is_some());
    assert!(search["inputSchema"]["properties"].get("cursor").is_some());
    let path = tools
        .iter()
        .find(|tool| tool["name"] == "path")
        .expect("path schema");
    assert!(path["inputSchema"]["properties"]
        .get("from_file_path")
        .is_some());
    assert!(path["inputSchema"]["properties"]
        .get("to_file_path")
        .is_some());
    let outline = tools
        .iter()
        .find(|tool| tool["name"] == "outline")
        .expect("outline schema");
    assert!(outline["inputSchema"]["properties"].get("kind").is_some());
    assert!(outline["inputSchema"]["properties"].get("scope").is_some());

    assert_eq!(
        responses[2]["result"]["structuredContent"]["freshness"]["status"],
        "fresh"
    );
    let repository_root = responses[2]["result"]["structuredContent"]["freshness"]
        ["repository_root"]
        .as_str()
        .expect("repository root identity");
    assert!(!repository_root.starts_with(r"\\?\"));
    let repository = responses[2]["result"]["structuredContent"]["repository"]
        .as_str()
        .expect("repository identity");
    assert_eq!(repository, repository_root);
    assert!(responses[2]["result"]["structuredContent"]["freshness"]["generation"].is_i64());
    assert_eq!(
        responses[2]["result"]["structuredContent"]["unresolved_references"]["count"],
        0
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
    assert_eq!(responses[7]["result"]["structuredContent"]["status"], "ok");
    assert_eq!(
        responses[8]["result"]["structuredContent"]["results"][0]["name"],
        "helper"
    );
    assert_eq!(
        responses[8]["result"]["structuredContent"]["next_offset"],
        1
    );
    assert_eq!(
        responses[9]["result"]["structuredContent"]["symbols"][0]["name"],
        "Details"
    );
    assert_eq!(responses[10]["result"]["isError"], true);
    assert_eq!(responses[11]["result"]["isError"], true);
}

#[test]
fn stdio_server_indexes_and_queries_multiple_explicit_project_roots() {
    let project_a = tempdir().expect("first project");
    fs::create_dir_all(project_a.path().join("src")).expect("first source directory");
    fs::write(project_a.path().join("src/lib.rs"), "pub fn alpha() {}\n")
        .expect("first source fixture");

    let project_b = tempdir().expect("second project");
    fs::create_dir_all(project_b.path().join("src")).expect("second source directory");
    fs::write(
        project_b.path().join("src/lib.rs"),
        "pub fn beta() {}\n\npub fn entry() {\n    beta();\n}\n",
    )
    .expect("second source fixture");
    let state_dir = tempdir().expect("external dynamic state directory");

    let project_a_root = project_a.path().to_str().expect("UTF-8 first project");
    let project_b_root = project_b.path().to_str().expect("UTF-8 second project");
    let mut child = Command::new(env!("CARGO_BIN_EXE_codefacts"))
        .arg("mcp")
        .env("CODEFACTS_STATE_DIR", state_dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start rootless CodeFacts MCP server");

    let requests = [
        json!({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{}}),
        json!({"jsonrpc":"2.0", "id":2, "method":"tools/list"}),
        json!({"jsonrpc":"2.0", "id":3, "method":"tools/call", "params":{"name":"map", "arguments":{}}}),
        json!({"jsonrpc":"2.0", "id":4, "method":"tools/call", "params":{"name":"map", "arguments":{"repository_root":project_a_root}}}),
        json!({"jsonrpc":"2.0", "id":5, "method":"tools/call", "params":{"name":"map", "arguments":{"repository_root":project_b_root}}}),
        json!({"jsonrpc":"2.0", "id":6, "method":"tools/call", "params":{"name":"search", "arguments":{"repository_root":project_a_root, "query":"alpha"}}}),
        json!({"jsonrpc":"2.0", "id":7, "method":"tools/call", "params":{"name":"search", "arguments":{"repository_root":project_b_root, "query":"beta"}}}),
        json!({"jsonrpc":"2.0", "id":8, "method":"tools/call", "params":{"name":"search", "arguments":{"repository_root":project_a_root, "query":"beta"}}}),
        json!({"jsonrpc":"2.0", "id":9, "method":"tools/call", "params":{"name":"outline", "arguments":{"repository_root":project_b_root, "file_path":"src/lib.rs"}}}),
        json!({"jsonrpc":"2.0", "id":10, "method":"tools/call", "params":{"name":"expand", "arguments":{"repository_root":project_b_root, "symbol":"beta", "file_path":"src/lib.rs"}}}),
        json!({"jsonrpc":"2.0", "id":11, "method":"tools/call", "params":{"name":"path", "arguments":{"repository_root":project_b_root, "from":"entry", "to":"beta"}}}),
    ];
    let mut input = child.stdin.take().expect("MCP stdin");
    for request in requests {
        writeln!(input, "{request}").expect("write MCP request");
    }
    drop(input);

    let output = child.wait_with_output().expect("wait for MCP server");
    assert!(
        output.status.success(),
        "server stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let responses = String::from_utf8(output.stdout)
        .expect("UTF-8 JSONL")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("JSON-RPC response"))
        .collect::<Vec<_>>();
    assert_eq!(responses.len(), 11);

    let tools = responses[1]["result"]["tools"]
        .as_array()
        .expect("tool list");
    for tool in tools {
        assert!(
            tool["inputSchema"]["properties"]
                .get("repository_root")
                .is_some(),
            "{} should accept repository_root",
            tool["name"]
        );
    }
    assert_eq!(responses[2]["result"]["isError"], true);
    assert!(responses[2]["result"]["content"][0]["text"]
        .as_str()
        .expect("missing-root error text")
        .contains("repository_root"));

    assert_repository_root_identity(
        &responses[3]["result"]["structuredContent"]["freshness"]["repository_root"],
        project_a.path(),
    );
    assert_repository_root_identity(
        &responses[4]["result"]["structuredContent"]["freshness"]["repository_root"],
        project_b.path(),
    );
    assert_eq!(
        responses[5]["result"]["structuredContent"]["results"][0]["name"],
        "alpha"
    );
    assert_eq!(
        responses[6]["result"]["structuredContent"]["results"][0]["name"],
        "beta"
    );
    assert!(responses[7]["result"]["structuredContent"]["results"]
        .as_array()
        .expect("first-project result array")
        .is_empty());
    assert_eq!(
        responses[8]["result"]["structuredContent"]["symbols"]
            .as_array()
            .expect("second-project outline")
            .len(),
        2
    );
    assert_eq!(
        responses[9]["result"]["structuredContent"]["definition"]["name"],
        "beta"
    );
    assert_eq!(responses[10]["result"]["structuredContent"]["status"], "ok");
    assert_eq!(
        responses[10]["result"]["structuredContent"]["path"][0]["name"],
        "entry"
    );
    assert_eq!(
        responses[10]["result"]["structuredContent"]["path"][1]["name"],
        "beta"
    );
}

#[test]
fn pagination_cursors_are_scoped_to_the_selected_project_root() {
    let project_a = tempdir().expect("first project");
    fs::create_dir_all(project_a.path().join("src")).expect("first source directory");
    fs::write(
        project_a.path().join("src/lib.rs"),
        "pub fn needle_one() {}\npub fn needle_two() {}\n",
    )
    .expect("first source fixture");
    let facts_a = CodeFacts::open(project_a.path(), project_a.path().join("external.sqlite"))
        .expect("open first project");

    let project_b = tempdir().expect("second project");
    fs::create_dir_all(project_b.path().join("src")).expect("second source directory");
    fs::write(
        project_b.path().join("src/lib.rs"),
        "pub fn needle_three() {}\npub fn needle_four() {}\n",
    )
    .expect("second source fixture");
    let facts_b = CodeFacts::open(project_b.path(), project_b.path().join("external.sqlite"))
        .expect("open second project");

    let first_page = facts_a
        .search_with_page_scope_options(
            "needle",
            Some(NodeKind::Function),
            None,
            SymbolScope::TopLevel,
            0,
            None,
            Some(1),
        )
        .expect("first project search");
    let cursor = first_page["next_cursor"]
        .as_str()
        .expect("first project continuation cursor");

    let error = facts_b
        .search_with_page_scope_options(
            "needle",
            Some(NodeKind::Function),
            None,
            SymbolScope::TopLevel,
            0,
            Some(cursor),
            Some(1),
        )
        .expect_err("a cursor from another project must be rejected");
    assert!(error.to_string().contains("cursor does not belong"));
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
    assert_eq!(endpoint["evidence"]["extractor"], "endpoint-ast");
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
            && reference["evidence"]["extractor"] == "endpoint-ast"
            && reference["evidence"]["confidence"] == "heuristic"
    }));
}

#[test]
fn endpoint_ast_extraction_ignores_query_parameters_and_keeps_route_patterns() {
    let repository = tempdir().expect("temporary repository");
    fs::create_dir_all(repository.path().join("src")).expect("source directory");
    fs::write(
        repository.path().join("src/handlers.ts"),
        "export function getUsers() { return []; }\nexport function getItems() { return []; }\n",
    )
    .expect("handler fixture");
    fs::write(
        repository.path().join("src/routes.ts"),
        r#"
const page = searchParams.get("page");
app.get(`/api/${version}/users`, getUsers);
router.get(/^\/api\/v\d+\/items$/, getItems);
"#,
    )
    .expect("route fixture");
    let facts = CodeFacts::open(repository.path(), repository.path().join("external.sqlite"))
        .expect("open source-backed facts");

    let api_results = facts.search("api", None).expect("route search");
    let endpoints = api_results["results"]
        .as_array()
        .expect("search results")
        .iter()
        .filter(|result| result["kind"] == "endpoint")
        .collect::<Vec<_>>();
    assert_eq!(endpoints.len(), 2);
    assert!(endpoints
        .iter()
        .any(|endpoint| endpoint["name"] == "GET /api/${version}/users"));
    assert!(endpoints
        .iter()
        .any(|endpoint| endpoint["name"] == "GET /^\\/api\\/v\\d+\\/items$/"));

    let page_results = facts.search("page", None).expect("query parameter search");
    assert!(page_results["results"]
        .as_array()
        .expect("query parameter results")
        .iter()
        .all(|result| result["kind"] != "endpoint"));
}

#[test]
fn map_surfaces_and_refreshes_bounded_unresolved_reference_evidence() {
    let repository = tempdir().expect("temporary repository");
    fs::create_dir_all(repository.path().join("src")).expect("source directory");
    let mut source = String::new();
    for index in 0..21 {
        source.push_str(&format!(
            "import {{ missing_{index} }} from './missing_{index}';\n"
        ));
    }
    source.push_str("export function entry() { return 1; }\n");
    fs::write(repository.path().join("src/app.ts"), source).expect("unresolved fixture");

    let facts = CodeFacts::open(repository.path(), repository.path().join("external.sqlite"))
        .expect("open source-backed facts");
    let initial = facts.map().expect("map with unresolved references");
    let unresolved = &initial["unresolved_references"];
    assert_eq!(unresolved["count"], 21);
    assert_eq!(unresolved["samples"].as_array().expect("samples").len(), 20);
    assert_eq!(unresolved["truncated"], true);
    assert_eq!(unresolved["samples"][0]["specifier"], "./missing_0");
    assert_eq!(unresolved["samples"][0]["kind"], "import");
    assert_eq!(
        unresolved["samples"][0]["evidence"]["confidence"],
        "unresolved"
    );
    assert!(unresolved["samples"][0]["evidence"]["source_hash"].is_string());

    for index in 0..21 {
        fs::write(
            repository.path().join(format!("src/missing_{index}.ts")),
            format!("export function missing_{index}() {{ return {index}; }}\n"),
        )
        .expect("resolved import fixture");
    }
    let refreshed = facts.map().expect("map after imports resolve");
    assert_eq!(refreshed["unresolved_references"]["count"], 0);
    assert!(refreshed["unresolved_references"]["samples"]
        .as_array()
        .expect("empty samples")
        .is_empty());
}

#[test]
fn path_disambiguates_file_paths_and_never_returns_an_oversized_path() {
    let repository = tempdir().expect("temporary repository");
    fs::create_dir_all(repository.path().join("src")).expect("source directory");
    fs::write(
        repository.path().join("src/api.ts"),
        "export function handle() { return validate(); }\nexport function validate() { return true; }\n",
    )
    .expect("api fixture");
    fs::write(
        repository.path().join("src/other.ts"),
        "export function handle() { return false; }\n",
    )
    .expect("duplicate fixture");
    fs::write(
        repository.path().join("src/chain.ts"),
        "export function first() { return second(); }\nexport function second() { return third(); }\nexport function third() { return true; }\n",
    )
    .expect("path-length fixture");

    let facts = CodeFacts::open(repository.path(), repository.path().join("external.sqlite"))
        .expect("open source-backed facts");
    let ambiguous = facts
        .path("handle", "validate", None)
        .expect("ambiguous path");
    assert_eq!(ambiguous["status"], "ambiguous");
    assert_eq!(ambiguous["parameter"], "from");

    let resolved = facts
        .path_with_files(
            "handle",
            Some("src/api.ts"),
            "validate",
            Some("src/api.ts"),
            Some(10),
        )
        .expect("disambiguated path");
    assert_eq!(resolved["status"], "ok");
    assert_eq!(resolved["path"][0]["evidence"]["file_path"], "src/api.ts");
    assert_eq!(resolved["path"][1]["name"], "validate");

    let missing_file = facts
        .path_with_files(
            "handle",
            Some("src/missing.ts"),
            "validate",
            Some("src/api.ts"),
            Some(10),
        )
        .expect("missing disambiguator result");
    assert_eq!(missing_file["status"], "not_found");
    assert_eq!(missing_file["parameter"], "from");
    assert!(facts
        .path_with_files(
            "handle",
            Some("../src/api.ts"),
            "validate",
            Some("src/api.ts"),
            Some(10),
        )
        .is_err());

    let too_long = facts
        .path("first", "third", Some(1))
        .expect("bounded path result");
    assert_eq!(too_long["status"], "path_too_long");
    assert_eq!(too_long["path_length"], 3);
    assert_eq!(too_long["maximum_path_length"], 1);
    assert!(too_long.get("path").is_none());

    let bounded = facts
        .path("first", "third", Some(3))
        .expect("three-node path");
    assert_eq!(bounded["status"], "ok");
    assert_eq!(bounded["path"].as_array().expect("path").len(), 3);
}

#[test]
fn search_and_outline_filter_and_continue_without_overlap() {
    let repository = tempdir().expect("temporary repository");
    fs::create_dir_all(repository.path().join("src/api")).expect("API directory");
    fs::write(
        repository.path().join("src/api/functions.ts"),
        "export function needleOne() { return 1; }\nexport function needleTwo() { return 2; }\nexport function needleThree() { return 3; }\n",
    )
    .expect("API functions fixture");
    fs::write(
        repository.path().join("src/other.ts"),
        "export function needleOutside() { return 4; }\n",
    )
    .expect("outside function fixture");

    let facts = CodeFacts::open(repository.path(), repository.path().join("external.sqlite"))
        .expect("open source-backed facts");
    let first = facts
        .search_with_options(
            "needle",
            Some(NodeKind::Function),
            Some("src/api"),
            0,
            Some(1),
        )
        .expect("first search page");
    let second = facts
        .search_with_options(
            "needle",
            Some(NodeKind::Function),
            Some("src/api"),
            1,
            Some(1),
        )
        .expect("second search page");
    assert_eq!(first["results"].as_array().expect("first results").len(), 1);
    assert_eq!(first["next_offset"], 1);
    assert_eq!(second["next_offset"], 2);
    assert_ne!(first["results"][0]["id"], second["results"][0]["id"]);
    assert_eq!(
        first["results"][0]["evidence"]["file_path"],
        "src/api/functions.ts"
    );

    let final_page = facts
        .search_with_options(
            "needle",
            Some(NodeKind::Function),
            Some("src/api"),
            2,
            Some(1),
        )
        .expect("final search page");
    assert_eq!(final_page["next_offset"], Value::Null);
    assert_eq!(
        final_page["results"]
            .as_array()
            .expect("final results")
            .len(),
        1
    );
    assert!(facts
        .search_with_options("needle", None, Some("../src"), 0, None)
        .is_err());

    let outline_first = facts
        .outline_with_offset("src/api/functions.ts", 0, Some(1))
        .expect("first outline page");
    let outline_second = facts
        .outline_with_offset("src/api/functions.ts", 1, Some(1))
        .expect("second outline page");
    let outline_final = facts
        .outline_with_offset("src/api/functions.ts", 2, Some(1))
        .expect("final outline page");
    assert_eq!(outline_first["next_offset"], 1);
    assert_eq!(outline_second["next_offset"], 2);
    assert_eq!(outline_final["next_offset"], Value::Null);
    assert_ne!(
        outline_first["symbols"][0]["id"],
        outline_second["symbols"][0]["id"]
    );
}

#[test]
fn snapshot_cursors_prevent_mixed_page_evidence_after_a_refresh() {
    let repository = tempdir().expect("temporary repository");
    fs::create_dir_all(repository.path().join("src")).expect("source directory");
    let source = repository.path().join("src/functions.ts");
    fs::write(
        &source,
        "export function needleOne() { return 1; }\nexport function needleTwo() { return 2; }\nexport function needleThree() { return 3; }\n",
    )
    .expect("source fixture");
    let facts = CodeFacts::open(repository.path(), repository.path().join("external.sqlite"))
        .expect("open source-backed facts");

    let first = facts
        .search_with_page_options(
            "needle",
            Some(NodeKind::Function),
            Some("src"),
            0,
            None,
            Some(1),
        )
        .expect("first snapshot page");
    let cursor = first["next_cursor"]
        .as_str()
        .expect("opaque continuation cursor")
        .to_string();
    let generation = first["freshness"]["generation"]
        .as_i64()
        .expect("first generation");

    let second = facts
        .search_with_page_options(
            "needle",
            Some(NodeKind::Function),
            Some("src"),
            0,
            Some(&cursor),
            Some(1),
        )
        .expect("same-snapshot continuation");
    assert_ne!(first["results"][0]["id"], second["results"][0]["id"]);
    assert_eq!(second["freshness"]["generation"].as_i64(), Some(generation));

    fs::write(
        &source,
        "export function needleZero() { return 0; }\nexport function needleOne() { return 1; }\nexport function needleTwo() { return 2; }\nexport function needleThree() { return 3; }\n",
    )
    .expect("changed source fixture");
    let stale = facts
        .search_with_page_options(
            "needle",
            Some(NodeKind::Function),
            Some("src"),
            0,
            Some(&cursor),
            Some(1),
        )
        .expect("stale cursor response");
    assert_eq!(stale["status"], "stale_cursor");
    assert!(stale["results"]
        .as_array()
        .expect("stale results")
        .is_empty());
    assert!(
        stale["freshness"]["generation"]
            .as_i64()
            .expect("new generation")
            > generation
    );
}

#[test]
fn incremental_refresh_rebinds_one_changed_definition_without_reparsing_callers() {
    let repository = tempdir().expect("temporary repository");
    fs::create_dir_all(repository.path().join("src")).expect("source directory");
    fs::write(
        repository.path().join("src/caller.ts"),
        "export function entry() { return target(); }\n",
    )
    .expect("caller fixture");
    fs::write(
        repository.path().join("src/unchanged.ts"),
        "export function unrelated() { return 1; }\n",
    )
    .expect("unchanged fixture");
    let facts = CodeFacts::open(repository.path(), repository.path().join("external.sqlite"))
        .expect("open source-backed facts");

    let initial = facts.map().expect("initial map");
    assert_eq!(initial["freshness"]["files_indexed"], 2);
    fs::write(
        repository.path().join("src/target.ts"),
        "export function target() { return true; }\n",
    )
    .expect("new definition fixture");

    let rebound = facts.path("entry", "target", None).expect("rebound path");
    assert_eq!(rebound["status"], "ok");
    assert_eq!(rebound["freshness"]["files_indexed"], 1);
    assert_eq!(rebound["freshness"]["files_skipped"], 2);
    assert_eq!(
        rebound["freshness"]["relationships_rebound"], 1,
        "one caller edge should be rebound to the added definition"
    );

    fs::remove_file(repository.path().join("src/target.ts")).expect("delete target fixture");
    let removed = facts
        .expand("entry", Some("src/caller.ts"), None)
        .expect("refresh after target deletion");
    assert!(removed["callees"]
        .as_array()
        .expect("callees after deletion")
        .is_empty());
    assert_eq!(removed["freshness"]["files_indexed"], 0);
    assert_eq!(
        removed["freshness"]["relationships_rebound"], 1,
        "one caller edge should be invalidated when its definition is removed"
    );
}

#[test]
fn expand_keeps_distinct_call_site_evidence() {
    let repository = tempdir().expect("temporary repository");
    fs::write(
        repository.path().join("lib.rs"),
        "pub fn helper() {}\n\npub fn entry() {\n    helper();\n    helper();\n}\n",
    )
    .expect("Rust fixture");
    let facts = CodeFacts::open(repository.path(), repository.path().join("external.sqlite"))
        .expect("open source-backed facts");

    let expanded = facts
        .expand("helper", Some("lib.rs"), Some(10))
        .expect("expand helper");
    let callers = expanded["callers"].as_array().expect("caller facts");
    assert_eq!(callers.len(), 2);
    let lines = callers
        .iter()
        .map(|caller| {
            caller["evidence"]["start_line"]
                .as_u64()
                .expect("call line")
        })
        .collect::<Vec<_>>();
    assert_eq!(lines, vec![4, 5]);
}

#[test]
fn nodenext_runtime_js_imports_resolve_to_typescript_sources() {
    let repository = tempdir().expect("temporary repository");
    fs::create_dir_all(repository.path().join("src")).expect("source directory");
    fs::write(
        repository.path().join("src/main.ts"),
        "import { config } from './config.js';\nexport function boot() { return config(); }\n",
    )
    .expect("NodeNext importer fixture");
    fs::write(
        repository.path().join("src/config.ts"),
        "export function config() { return 'ok'; }\n",
    )
    .expect("TypeScript target fixture");

    let facts = CodeFacts::open(repository.path(), repository.path().join("external.sqlite"))
        .expect("open source-backed facts");
    let map = facts.map().expect("map NodeNext fixture");
    assert_eq!(map["unresolved_references"]["count"], 0);
}

#[test]
fn member_dispatch_keeps_polymorphic_candidates_out_of_static_paths() {
    let repository = tempdir().expect("temporary repository");
    fs::create_dir_all(repository.path().join("src")).expect("source directory");
    fs::write(
        repository.path().join("src/providers.ts"),
        r#"
export interface Provider { detect(): boolean; }
export class AlphaProvider implements Provider { detect() { return true; } }
export class BetaProvider implements Provider { detect() { return false; } }
export function getAvailableProviders(providers: Provider[]) {
  return providers.filter((provider) => provider.detect());
}
"#,
    )
    .expect("provider fixture");

    let facts = CodeFacts::open(repository.path(), repository.path().join("external.sqlite"))
        .expect("open source-backed facts");
    let expanded = facts
        .expand("getAvailableProviders", Some("src/providers.ts"), Some(20))
        .expect("expand provider dispatch");
    let detect_callees = expanded["callees"]
        .as_array()
        .expect("callee facts")
        .iter()
        .filter(|callee| callee["to"]["name"] == "detect")
        .collect::<Vec<_>>();
    assert!(
        detect_callees.len() >= 2,
        "expected multiple dispatch candidates, got {expanded}"
    );
    assert!(detect_callees.iter().all(|callee| {
        callee["evidence"]["confidence"] == "heuristic" && callee["resolution"] == "polymorphic"
    }));

    let target_id = detect_callees[0]["to"]["id"]
        .as_str()
        .expect("candidate id");
    let path = facts
        .path("getAvailableProviders", target_id, Some(20))
        .expect("query only confirmed static paths");
    assert_eq!(path["status"], "no_static_path");
}

#[test]
fn ambiguous_direct_calls_stay_heuristic_without_graph_fanout() {
    let repository = tempdir().expect("temporary repository");
    fs::create_dir_all(repository.path().join("src")).expect("source directory");
    fs::write(
        repository.path().join("src/caller.ts"),
        "export function entry() { return target(); }\n",
    )
    .expect("caller fixture");
    fs::write(
        repository.path().join("src/one.ts"),
        "export function target() { return 1; }\n",
    )
    .expect("first target fixture");
    fs::write(
        repository.path().join("src/two.ts"),
        "export function target() { return 2; }\n",
    )
    .expect("second target fixture");
    let facts = CodeFacts::open(repository.path(), repository.path().join("external.sqlite"))
        .expect("open source-backed facts");

    let expanded = facts
        .expand("entry", Some("src/caller.ts"), Some(20))
        .expect("expand direct call");
    let targets = expanded["callees"]
        .as_array()
        .expect("callee facts")
        .iter()
        .filter(|callee| callee["to"]["name"] == "target")
        .collect::<Vec<_>>();
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0]["evidence"]["confidence"], "heuristic");
    assert_eq!(targets[0]["resolution"], "ambiguous_name");
    let target_id = targets[0]["to"]["id"].as_str().expect("candidate id");
    let path = facts
        .path("entry", target_id, Some(20))
        .expect("confirmed path query");
    assert_eq!(path["status"], "no_static_path");
}

#[test]
fn rust_attribute_tests_appear_in_expand_related_tests() {
    let repository = tempdir().expect("temporary repository");
    fs::write(
        repository.path().join("lib.rs"),
        r#"
pub fn run_tool_call_loop() {}

mod tests {
    #[tokio::test]
    async fn exercises_loop() {
        run_tool_call_loop();
    }
}
"#,
    )
    .expect("Rust test fixture");
    let facts = CodeFacts::open(repository.path(), repository.path().join("external.sqlite"))
        .expect("open source-backed facts");

    let expanded = facts
        .expand("run_tool_call_loop", Some("lib.rs"), Some(20))
        .expect("expand production function");
    assert!(expanded["tests"]
        .as_array()
        .expect("related tests")
        .iter()
        .any(|test| test["name"] == "exercises_loop"));
}

#[test]
fn map_counts_and_discovery_scope_are_explicit() {
    let repository = tempdir().expect("temporary repository");
    fs::create_dir_all(repository.path().join("src")).expect("source directory");
    fs::write(
        repository.path().join("src/stats.ts"),
        r#"
export const sessionTop = 1;
export function summarizeSession() {
  const session = sessionTop;
  return session;
}
"#,
    )
    .expect("scope fixture");
    let facts = CodeFacts::open(repository.path(), repository.path().join("external.sqlite"))
        .expect("open source-backed facts");

    let map = facts.map().expect("map counts");
    assert_eq!(map["files_with_facts"], 1);
    assert_eq!(map["indexed_files"], 1);
    assert_eq!(map["files_indexed_this_refresh"], 1);
    assert_eq!(map["language_file_counts"]["typescript"], 1);
    assert_eq!(map["languages"]["typescript"], 1);
    assert!(
        map["language_symbol_counts"]["typescript"]
            .as_u64()
            .unwrap_or(0)
            >= 3
    );

    let top_level = facts
        .outline_with_page_scope_options(
            "src/stats.ts",
            None,
            SymbolScope::TopLevel,
            0,
            None,
            Some(20),
        )
        .expect("top-level outline");
    let all = facts
        .outline_with_page_scope_options("src/stats.ts", None, SymbolScope::All, 0, None, Some(20))
        .expect("complete outline");
    assert!(top_level["symbols"]
        .as_array()
        .expect("top-level symbols")
        .iter()
        .all(|symbol| symbol["name"] != "session"));
    assert!(all["symbols"]
        .as_array()
        .expect("all symbols")
        .iter()
        .any(|symbol| symbol["name"] == "session"));

    let search = facts
        .search_with_page_scope_options(
            "session",
            Some(NodeKind::Variable),
            None,
            SymbolScope::TopLevel,
            0,
            None,
            Some(20),
        )
        .expect("top-level variable search");
    assert!(search["results"]
        .as_array()
        .expect("top-level variable results")
        .iter()
        .all(|symbol| symbol["name"] != "session"));
}

#[test]
fn markdown_sections_hierarchy_and_local_anchor_links_are_source_backed() {
    let repository = tempdir().expect("temporary repository");
    fs::write(
        repository.path().join("README.md"),
        "# Overview\nIntro text.\n## Install\nInstall text. [Back](#overview)\n```md\n[Ignored](#overview)\n```\n# Finish\nDone.\n",
    )
    .expect("Markdown fixture");
    let facts = CodeFacts::open(repository.path(), repository.path().join("external.sqlite"))
        .expect("open source-backed facts");

    let outline = facts
        .outline("README.md", Some(20))
        .expect("Markdown outline");
    assert!(outline["symbols"]
        .as_array()
        .expect("heading facts")
        .iter()
        .any(|heading| heading["qualified_name"] == "Overview > Install"));

    let expanded = facts
        .expand("Install", Some("README.md"), Some(20))
        .expect("expand Markdown section");
    assert_eq!(expanded["section"]["start_line"], 3);
    assert_eq!(expanded["section"]["end_line"], 7);
    assert!(expanded["section"]["content"]
        .as_str()
        .expect("section content")
        .contains("Install text."));
    assert!(expanded["references"]["outbound"]
        .as_array()
        .expect("local anchor references")
        .iter()
        .any(|reference| reference["to"]["name"] == "Overview"));
}

#[test]
fn rootless_mcp_requires_a_tool_root_but_state_requires_a_default_root() {
    let rootless = Command::new(env!("CARGO_BIN_EXE_codefacts"))
        .arg("mcp")
        .output()
        .expect("run rootless codefacts");
    assert!(rootless.status.success());

    let output = Command::new(env!("CARGO_BIN_EXE_codefacts"))
        .args(["mcp", "--state", "external.sqlite"])
        .output()
        .expect("run rootless codefacts with state");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("--state requires --root"));
}
