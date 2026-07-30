use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::{json, Map, Value};
use tempfile::tempdir;

const MODERN_PROTOCOL_VERSION: &str = "2026-07-28";

fn modern_meta(version: &str) -> Value {
    json!({
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientInfo": { "name": "codefacts-modern-test", "version": "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {}
    })
}

fn modern_params(version: &str) -> Value {
    json!({ "_meta": modern_meta(version) })
}

#[test]
fn stdio_server_supports_stateless_2026_07_28_requests() {
    let repository = tempdir().expect("temporary repository");
    fs::create_dir_all(repository.path().join("src")).expect("source directory");
    fs::write(repository.path().join("src/lib.rs"), "pub fn helper() {}\n").expect("rust fixture");
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

    let mut call_params = Map::new();
    call_params.insert("name".into(), Value::String("map".into()));
    call_params.insert("arguments".into(), json!({}));
    call_params.insert("_meta".into(), modern_meta(MODERN_PROTOCOL_VERSION));
    let requests = [
        json!({"jsonrpc":"2.0", "id":1, "method":"server/discover", "params":modern_params(MODERN_PROTOCOL_VERSION)}),
        json!({"jsonrpc":"2.0", "id":2, "method":"tools/list", "params":modern_params(MODERN_PROTOCOL_VERSION)}),
        json!({"jsonrpc":"2.0", "id":3, "method":"tools/call", "params":Value::Object(call_params)}),
        json!({"jsonrpc":"2.0", "id":4, "method":"tools/list", "params":{"_meta":{"io.modelcontextprotocol/protocolVersion":MODERN_PROTOCOL_VERSION}}}),
        json!({"jsonrpc":"2.0", "id":5, "method":"tools/list", "params":modern_params("2099-01-01")}),
        json!({"jsonrpc":"2.0", "id":6, "method":"initialize", "params":{"protocolVersion":"2024-11-05", "capabilities":{}, "clientInfo":{"name":"legacy","version":"1.0.0"}}}),
        json!({"jsonrpc":"2.0", "id":7, "method":"initialize", "params":{"_meta":modern_meta(MODERN_PROTOCOL_VERSION)}}),
    ];
    let mut input = child.stdin.take().expect("child stdin");
    for request in requests {
        writeln!(input, "{request}").expect("write JSON-RPC request");
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
    let responses = String::from_utf8(output.stdout)
        .expect("UTF-8 JSONL")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("JSON-RPC response"))
        .collect::<Vec<_>>();
    assert_eq!(responses.len(), 7);

    let discover = &responses[0]["result"];
    assert_eq!(discover["resultType"], "complete");
    assert!(discover["supportedVersions"]
        .as_array()
        .expect("supported versions")
        .iter()
        .any(|version| version == MODERN_PROTOCOL_VERSION));
    assert_eq!(
        discover["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
        "codefacts"
    );
    assert!(
        discover.get("instructions").is_none(),
        "CodeFacts must not inject agent instructions through discovery"
    );

    let listed = &responses[1]["result"];
    assert_eq!(listed["resultType"], "complete");
    assert_eq!(listed["ttlMs"], 0);
    assert_eq!(listed["cacheScope"], "private");
    assert_eq!(listed["tools"].as_array().expect("tools").len(), 5);
    assert_eq!(
        listed["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
        "codefacts"
    );

    let map = &responses[2]["result"];
    assert_eq!(map["resultType"], "complete");
    assert_eq!(map["structuredContent"]["freshness"]["status"], "fresh");
    assert_eq!(responses[3]["error"]["code"], -32602);
    assert_eq!(responses[4]["error"]["code"], -32022);
    assert!(responses[4]["error"]["data"]["supported"]
        .as_array()
        .expect("unsupported-version support list")
        .iter()
        .any(|version| version == MODERN_PROTOCOL_VERSION));
    assert_eq!(responses[5]["result"]["protocolVersion"], "2024-11-05");
    assert!(responses[5]["result"].get("resultType").is_none());
    assert_eq!(responses[6]["error"]["code"], -32601);
}
