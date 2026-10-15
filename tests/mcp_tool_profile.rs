use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::tempdir;

fn run_server(profile: Option<&str>, requests: Vec<Value>) -> Vec<Value> {
    let state = tempdir().expect("external state");
    let mut command = Command::new(env!("CARGO_BIN_EXE_codefacts"));
    command
        .args(["mcp", "--lsp", "off"])
        .env("CODEFACTS_STATE_DIR", state.path());
    if let Some(profile) = profile {
        command.args(["--tools", profile]);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start MCP server");
    let mut input = child.stdin.take().expect("server stdin");
    for request in requests {
        writeln!(input, "{request}").expect("write request");
    }
    drop(input);
    let output = child.wait_with_output().expect("finish MCP server");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    String::from_utf8(output.stdout)
        .expect("UTF-8 protocol output")
        .lines()
        .map(|line| serde_json::from_str(line).expect("JSON response"))
        .collect()
}

fn request(id: usize, method: &str, mut params: Value, modern: bool) -> Value {
    if modern {
        params["_meta"] = json!({
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {}
        });
    }
    json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params})
}

#[test]
fn impact_is_source_backed_and_reports_cutoffs_in_both_protocol_eras() {
    let repository = tempdir().unwrap();
    fs::write(
        repository.path().join("fixture.go"),
        "package fixture\nfunc sink() {}\nfunc middle() { sink() }\nfunc entry() { middle() }\n",
    )
    .unwrap();
    fs::write(
        repository.path().join("fixture_test.go"),
        "package fixture\nfunc TestEntry() { entry() }\n",
    )
    .unwrap();
    for modern in [false, true] {
        for format in ["full", "compact", "markdown"] {
            let responses = run_server(
                None,
                vec![
                    request(
                        1,
                        "tools/call",
                        json!({"name":"impact","arguments":{"repository_root":repository.path(),"symbol":"sink","format":format,"max_depth":3}}),
                        modern,
                    ),
                    request(
                        2,
                        "tools/call",
                        json!({"name":"impact","arguments":{"repository_root":repository.path(),"symbol":"sink","format":"full","max_depth":1}}),
                        modern,
                    ),
                    request(
                        3,
                        "tools/call",
                        json!({"name":"impact","arguments":{"repository_root":repository.path(),"symbol":"sink","max_depth":11}}),
                        modern,
                    ),
                ],
            );
            let result = &responses[0]["result"];
            assert_eq!(result["isError"], false);
            if modern {
                assert_eq!(result["resultType"], "complete");
            }
            let text = result["content"][0]["text"].as_str().unwrap();
            assert!(text.contains("TestEntry"));
            if format == "markdown" {
                assert!(result.get("structuredContent").is_none());
                assert!(text.contains("witness_direction"));
            } else {
                let facts = &result["structuredContent"];
                assert_eq!(facts["affected"].as_array().unwrap().len(), 3);
                assert_eq!(facts["tests"][0]["symbol"]["name"], "TestEntry");
                assert_eq!(facts["traversal"]["exhausted"], true);
                assert_eq!(facts["affected"][0]["witness"]["from"]["name"], "middle");
                assert_eq!(facts["affected"][0]["witness"]["to"]["name"], "sink");
                assert_eq!(facts, &serde_json::from_str::<Value>(text).unwrap());
                if format == "compact" {
                    assert!(facts["source_hashes"]["fixture.go"].is_string());
                }
            }
            let bounded = &responses[1]["result"]["structuredContent"];
            assert_eq!(bounded["affected"].as_array().unwrap().len(), 1);
            assert_eq!(bounded["traversal"]["depth_limit_reached"], true);
            assert_eq!(bounded["truncated"], true);
            assert_eq!(responses[2]["result"]["isError"], true);
        }
    }
}

#[test]
fn profiles_control_catalog_and_calls_in_both_protocol_eras() {
    let repository = tempdir().expect("repository");
    fs::write(repository.path().join("README.md"), "# Profile fixture\n").unwrap();
    fs::write(
        repository.path().join("fixture.go"),
        "package fixture\nfunc sink() {}\nfunc entry() { sink() }\n",
    )
    .unwrap();
    let tools = [
        "explore", "impact", "map", "search", "outline", "expand", "path",
    ];
    for modern in [false, true] {
        for profile in [None, Some("default"), Some("all"), Some("explore")] {
            let expected: &[&str] = match profile {
                Some("all") => &tools,
                Some("explore") => &["explore"],
                _ => &["explore", "impact", "expand"],
            };
            let mut requests = vec![request(1, "tools/list", json!({}), modern)];
            for name in tools.iter().copied().chain(["invented"]) {
                // A rootless request makes it observable that hidden tools are
                // rejected before repository selection or argument parsing.
                requests.push(request(
                    requests.len() + 1,
                    "tools/call",
                    json!({"name":name, "arguments":{}}),
                    modern,
                ));
            }
            for name in expected {
                let mut arguments = match *name {
                    "explore" => json!({"file_path":"README.md"}),
                    "impact" | "expand" => json!({"symbol":"sink","format":"full"}),
                    "map" => json!({"format":"full"}),
                    "search" => json!({"query":"sink","format":"full"}),
                    "outline" => json!({"file_path":"fixture.go","format":"full"}),
                    "path" => json!({"from":"entry","to":"sink","format":"full"}),
                    _ => unreachable!(),
                };
                arguments["repository_root"] = json!(repository.path());
                requests.push(request(
                    requests.len() + 1,
                    "tools/call",
                    json!({"name":name,"arguments":arguments}),
                    modern,
                ));
            }
            let responses = run_server(profile, requests);
            assert_eq!(responses.len(), tools.len() + 2 + expected.len());
            let names: Vec<_> = responses[0]["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tool| tool["name"].as_str().unwrap())
                .collect();
            assert_eq!(names, expected);
            assert_eq!(responses[0]["result"]["ttlMs"], 0);
            assert_eq!(responses[0]["result"]["cacheScope"], "private");
            for tool in responses[0]["result"]["tools"].as_array().unwrap() {
                assert_eq!(tool["annotations"]["readOnlyHint"], true);
                assert_eq!(tool["annotations"]["destructiveHint"], false);
            }
            for (index, name) in tools.iter().copied().chain(["invented"]).enumerate() {
                let result = &responses[index + 1]["result"];
                assert_eq!(result["isError"], true);
                let text = result["content"][0]["text"].as_str().unwrap();
                if !expected.contains(&name) {
                    assert!(text.contains(&format!("unknown tool '{name}'")), "{text}");
                    assert!(text.ends_with(&expected.join(", ")), "{text}");
                } else {
                    assert!(text.contains("'repository_root' is required"), "{text}");
                }
                if modern {
                    assert_eq!(result["resultType"], "complete");
                }
            }
            for (name, response) in expected.iter().zip(&responses[tools.len() + 2..]) {
                let result = &response["result"];
                assert_eq!(result["isError"], false, "{name}: {result}");
                if modern {
                    assert_eq!(result["resultType"], "complete");
                }
                if *name == "explore" {
                    assert!(result.get("structuredContent").is_none());
                    assert!(result["content"][0]["text"]
                        .as_str()
                        .unwrap()
                        .contains("# Profile fixture"));
                } else {
                    let facts = &result["structuredContent"];
                    assert_eq!(facts["freshness"]["status"], "fresh");
                    assert_eq!(
                        fs::canonicalize(facts["freshness"]["repository_root"].as_str().unwrap())
                            .unwrap(),
                        repository.path().canonicalize().unwrap()
                    );
                    match *name {
                        "impact" => assert_eq!(facts["affected"][0]["symbol"]["name"], "entry"),
                        "expand" => assert_eq!(facts["callers"][0]["from"]["name"], "entry"),
                        "path" => assert_eq!(facts["status"], "ok"),
                        _ => {}
                    }
                }
            }
        }
    }
}

#[test]
fn tool_profile_argument_rejects_invalid_and_missing_values() {
    for value in [Some("exact"), Some(""), None] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_codefacts"));
        command.args(["mcp", "--tools"]);
        if let Some(value) = value {
            command.arg(value);
        }
        let output = command.output().expect("run invalid command");
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        let message = String::from_utf8_lossy(&output.stderr);
        assert!(
            message.contains(if value.is_some() {
                "--tools must be 'default', 'all' or 'explore'"
            } else {
                "--tools requires default, all or explore"
            }),
            "{message}"
        );
    }
}

#[test]
fn batch_source_reads_pass_ranges_through_both_protocol_eras() {
    let repository = tempdir().expect("repository");
    fs::create_dir(repository.path().join("src")).unwrap();
    fs::write(
        repository.path().join("src/lib.rs"),
        "// outside-before\npub fn chosen() {}\n// outside-after\n",
    )
    .unwrap();
    fs::write(
        repository.path().join("README.md"),
        "# Outside\n\nSelected documentation\n",
    )
    .unwrap();
    for modern in [false, true] {
        let responses = run_server(
            Some("explore"),
            vec![
                request(1, "tools/list", json!({}), modern),
                request(
                    2,
                    "tools/call",
                    json!({"name":"explore", "arguments":{
                        "repository_root":repository.path(), "reads":[
                            {"file_path":"src/lib.rs", "start_line":2, "end_line":2},
                            {"file_path":"README.md", "start_line":3, "end_line":3}
                        ], "max_bytes":4000
                    }}),
                    modern,
                ),
                request(
                    3,
                    "tools/call",
                    json!({"name":"explore", "arguments":{
                        "repository_root":repository.path(), "reads":[{"file_path":3}]
                    }}),
                    modern,
                ),
                request(
                    4,
                    "tools/call",
                    json!({"name":"explore", "arguments":{
                        "repository_root":repository.path(), "reads":[{"file_path":"src/lib.rs", "start_line":4294967296_u64}]
                    }}),
                    modern,
                ),
            ],
        );
        let schema = &responses[0]["result"]["tools"][0]["inputSchema"]["properties"]["reads"];
        assert_eq!(schema["maxItems"], 8);
        assert_eq!(schema["items"]["additionalProperties"], false);
        assert_eq!(responses[1]["result"]["isError"], false, "{}", responses[1]);
        let text = responses[1]["result"]["content"][0]["text"]
            .as_str()
            .unwrap();
        assert!(text.contains("pub fn chosen() {}"), "{text}");
        assert!(text.contains("Selected documentation"), "{text}");
        assert!(!text.contains("outside-before"), "{text}");
        assert!(!text.contains("outside-after"), "{text}");
        assert!(!text.contains("# Outside"), "{text}");
        for response in &responses[2..] {
            assert_eq!(response["result"]["isError"], true);
            assert!(response["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("invalid reads:"));
        }
    }
}

#[test]
fn eof_ranges_preserve_available_batch_evidence_in_both_protocol_eras() {
    let repository = tempdir().expect("repository");
    let source = "// before\npub fn chosen() {}\n// last\n";
    fs::write(repository.path().join("lib.rs"), source).unwrap();
    fs::write(repository.path().join("README.md"), "# Fixture\nEvidence\n").unwrap();
    for modern in [false, true] {
        let cases = [
            json!([
                {"file_path":"lib.rs", "start_line":4, "end_line":8},
                {"file_path":"lib.rs", "start_line":2, "end_line":8},
                {"file_path":"README.md", "start_line":2, "end_line":2}
            ]),
            json!([{"file_path":"lib.rs", "start_line":4}]),
            json!([{"file_path":"lib.rs", "start_line":3, "end_line":3}]),
            json!([{"file_path":"lib.rs", "start_line":3, "end_line":2}]),
            json!([{"file_path":"lib.rs", "start_line":0, "end_line":8}]),
            json!([{"file_path":"../outside.rs", "start_line":1, "end_line":8}]),
            json!([{"file_path":"missing.rs", "start_line":1, "end_line":8}]),
        ];
        let responses = run_server(
            Some("explore"),
            cases
                .into_iter()
                .enumerate()
                .map(|(index, reads)| {
                    request(
                        index + 1,
                        "tools/call",
                        json!({"name":"explore", "arguments":{
                            "repository_root":repository.path(), "reads":reads, "max_bytes":2000
                        }}),
                        modern,
                    )
                })
                .collect(),
        );
        let text = responses[0]["result"]["content"][0]["text"]
            .as_str()
            .unwrap();
        assert_eq!(responses[0]["result"]["isError"], false, "{text}");
        assert!(
            text.contains("start_line 4 is past EOF 3; requested range unavailable"),
            "{text}"
        );
        assert!(
            text.contains("requested end_line 8 clipped to EOF 3; available range 2-3"),
            "{text}"
        );
        assert!(text.contains("lib.rs:2-3"), "{text}");
        assert!(text.contains("2: pub fn chosen() {}\n3: // last"), "{text}");
        assert!(text.contains("2: Evidence"), "{text}");
        assert!(
            text.contains(&hex::encode(Sha256::digest(source.as_bytes()))),
            "{text}"
        );
        assert!(!text.contains("1: // before"), "{text}");
        assert!(!text.contains("4: "), "{text}");
        assert!(text.len() <= 2000, "{}", text.len());
        assert_eq!(responses[1]["result"]["isError"], true);
        assert!(responses[1]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("no readable source ranges: lib.rs: start_line 4 is past EOF 3"));
        let exact = responses[2]["result"]["content"][0]["text"]
            .as_str()
            .unwrap();
        assert_eq!(responses[2]["result"]["isError"], false, "{exact}");
        assert!(exact.contains("lib.rs:3-3"));
        assert!(exact.contains("3: // last"));
        assert!(!exact.contains("EOF notes"));
        for response in &responses[3..] {
            assert_eq!(response["result"]["isError"], true, "{response}");
        }
    }
}
