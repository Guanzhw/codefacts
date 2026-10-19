use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};
use tempfile::{tempdir, TempDir};

struct Server {
    child: Child,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    _state: TempDir,
    id: u64,
    modern: bool,
}

impl Server {
    fn start(root: Option<&Path>, all_tools: bool, modern: bool) -> Self {
        let state = tempdir().unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_codefacts"));
        command
            .args(["mcp", "--lsp", "off"])
            .env("CODEFACTS_STATE_DIR", state.path());
        if let Some(root) = root {
            command.arg("--root").arg(root);
        }
        if all_tools {
            command.args(["--tools", "all"]);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("start MCP server");
        Self {
            input: child.stdin.take(),
            output: BufReader::new(child.stdout.take().unwrap()),
            child,
            _state: state,
            id: 0,
            modern,
        }
    }

    fn request(&mut self, method: &str, mut params: Value) -> Value {
        self.id += 1;
        if self.modern {
            params["_meta"] = json!({
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {}
            });
        }
        let request = json!({"jsonrpc":"2.0", "id":self.id, "method":method, "params":params});
        let input = self.input.as_mut().unwrap();
        writeln!(input, "{request}").unwrap();
        input.flush().unwrap();
        let mut line = String::new();
        assert!(
            self.output.read_line(&mut line).unwrap() > 0,
            "MCP closed stdout"
        );
        let response: Value = serde_json::from_str(&line).expect("JSON-RPC response");
        assert_eq!(response["id"], self.id);
        assert!(response.get("error").is_none(), "{response}");
        if self.modern {
            assert_eq!(response["result"]["resultType"], "complete");
        }
        response["result"].clone()
    }

    fn call(&mut self, name: &str, arguments: Value) -> Value {
        self.request("tools/call", json!({"name":name, "arguments":arguments}))
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        drop(self.input.take());
        assert!(self.child.wait().unwrap().success());
    }
}

fn fixture() -> TempDir {
    let repository = tempdir().unwrap();
    fs::create_dir(repository.path().join("src")).unwrap();
    fs::write(
        repository.path().join("src/lib.rs"),
        "pub fn sink() {}\npub fn middle() { sink(); }\npub fn alpha() {}\npub fn beta() {}\npub fn entry() { middle(); sink(); alpha(); beta(); }\npub fn top() { entry(); }\n",
    )
    .unwrap();
    fs::write(repository.path().join("README.md"), "# Nullable fixture\n").unwrap();
    repository
}

fn text(result: &Value) -> &str {
    result["content"][0]["text"].as_str().unwrap()
}

fn stable_text(result: &Value) -> String {
    text(result)
        .lines()
        .filter(|line| !line.starts_with("- duration_ms:"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn assert_success(result: &Value) {
    assert_eq!(result["isError"], false, "{result}");
}

fn assert_error(result: &Value, message: &str) {
    assert_eq!(result["isError"], true, "{result}");
    assert!(!text(result).is_empty(), "{result}");
    assert!(text(result).contains(message), "{result}");
}

fn with_nulls(mut arguments: Value, fields: &[&str]) -> Value {
    for field in fields {
        arguments
            .as_object_mut()
            .unwrap()
            .entry(*field)
            .or_insert(Value::Null);
    }
    arguments
}

const EXPLORE_OPTIONAL: &[&str] = &[
    "repository_root",
    "query",
    "path_prefix",
    "file_path",
    "start_line",
    "reads",
    "max_bytes",
];

#[test]
fn catalog_advertises_nullable_unset_only_for_the_default_three_tools() {
    for modern in [false, true] {
        let mut server = Server::start(None, true, modern);
        let catalog = server.request("tools/list", json!({}));
        let tools = catalog["tools"].as_array().unwrap();
        for tool in tools {
            let name = tool["name"].as_str().unwrap();
            if ["explore", "expand", "impact"].contains(&name) {
                assert!(tool["description"]
                    .as_str()
                    .unwrap()
                    .contains("Omit or use null for unused optional fields."));
            }
            let schema = &tool["inputSchema"];
            assert_eq!(schema["additionalProperties"], false);
            let required = schema["required"].as_array().unwrap();
            for (field, property) in schema["properties"].as_object().unwrap() {
                if ["explore", "expand", "impact"].contains(&name)
                    && !required.contains(&json!(field))
                {
                    let types = property["type"].as_array().expect("nullable type union");
                    assert_eq!(types.len(), 2);
                    assert_eq!(types[1], "null");
                    if let Some(values) = property.get("enum") {
                        assert!(values.as_array().unwrap().contains(&Value::Null));
                    }
                } else {
                    assert!(property["type"].is_string(), "{name}.{field}: {property}");
                }
            }
            if name == "explore" {
                assert!(required.is_empty());
                let reads = &schema["properties"]["reads"];
                assert_eq!(reads["minItems"], 1);
                assert_eq!(reads["maxItems"], 8);
                assert_eq!(reads["items"]["required"], json!(["file_path"]));
                assert_eq!(reads["items"]["additionalProperties"], false);
                let properties = &reads["items"]["properties"];
                assert_eq!(properties["file_path"]["type"], "string");
                assert_eq!(properties["file_path"]["minLength"], 1);
                for field in ["start_line", "end_line"] {
                    assert_eq!(properties[field]["type"], json!(["integer", "null"]));
                    assert_eq!(properties[field]["minimum"], 1);
                }
                assert_eq!(schema["properties"]["max_bytes"]["minimum"], 2000);
                assert_eq!(schema["properties"]["max_bytes"]["maximum"], 32000);
            } else if ["expand", "impact"].contains(&name) {
                assert_eq!(required, &vec![json!("symbol")]);
                assert_eq!(schema["properties"]["symbol"]["type"], "string");
                assert_eq!(schema["properties"]["symbol"]["minLength"], 1);
            }
        }
    }
}

#[test]
fn explore_nulls_preserve_all_modes_and_nested_read_defaults_over_stdio() {
    let repository = fixture();
    for modern in [false, true] {
        let mut server = Server::start(Some(repository.path()), false, modern);
        assert_success(&server.call("explore", json!({}))); // Warm the first refresh.
        for omitted in [
            json!({}),
            json!({"query":"sink"}),
            json!({"query":"sink", "path_prefix":"src"}),
            json!({"path_prefix":"src"}),
            json!({"file_path":"src/lib.rs"}),
            json!({"file_path":"src/lib.rs", "start_line":2}),
            json!({"reads":[{"file_path":"src/lib.rs"}, {"file_path":"README.md", "end_line":1}]}),
        ] {
            let mut explicit = with_nulls(omitted.clone(), EXPLORE_OPTIONAL);
            if let Some(reads) = explicit["reads"].as_array_mut() {
                for read in reads {
                    *read = with_nulls(read.take(), &["start_line", "end_line"]);
                }
            }
            let expected = server.call("explore", omitted);
            let actual = server.call("explore", explicit);
            assert_success(&expected);
            assert_success(&actual);
            assert_eq!(text(&actual), text(&expected));
            assert!(text(&actual).contains("src/lib.rs:"), "{actual}");
            assert!(text(&actual).contains("Freshness: fresh"));
        }
        let read = server.call(
            "explore",
            json!({"reads":[{"file_path":"src/lib.rs", "start_line":null, "end_line":null}]}),
        );
        assert!(text(&read).contains("1: pub fn sink() {}"));
        assert!(text(&read).contains("6: pub fn top()"));
    }
}

#[test]
fn expand_and_impact_nulls_keep_defaults_and_real_cursor_identity() {
    let repository = fixture();
    for modern in [false, true] {
        let mut server = Server::start(Some(repository.path()), false, modern);
        assert_success(&server.call("explore", json!({})));
        for (name, fields) in [
            (
                "expand",
                &[
                    "repository_root",
                    "file_path",
                    "limit",
                    "format",
                    "section",
                    "cursor",
                ][..],
            ),
            (
                "impact",
                &[
                    "repository_root",
                    "file_path",
                    "limit",
                    "format",
                    "max_depth",
                ][..],
            ),
        ] {
            let omitted = server.call(name, json!({"symbol":"sink"}));
            let explicit = server.call(name, with_nulls(json!({"symbol":"sink"}), fields));
            assert_success(&omitted);
            assert_success(&explicit);
            assert_eq!(stable_text(&explicit), stable_text(&omitted));
            assert!(
                explicit.get("structuredContent").is_none(),
                "default format is Markdown"
            );
        }
        let impact = server.call(
            "impact",
            json!({"symbol":"sink", "format":"full", "max_depth":null, "limit":null}),
        );
        assert_success(&impact);
        assert_eq!(impact["structuredContent"]["max_depth"], 3);
        let bounded = server.call(
            "impact",
            json!({"symbol":"sink", "format":"full", "max_depth":1}),
        );
        assert_success(&bounded);
        assert_eq!(bounded["structuredContent"]["max_depth"], 1);
        assert!(
            bounded["structuredContent"]["affected"]
                .as_array()
                .unwrap()
                .len()
                < impact["structuredContent"]["affected"]
                    .as_array()
                    .unwrap()
                    .len()
        );

        let first = server.call("expand", json!({"symbol":"entry", "format":"compact", "section":null, "cursor":null, "limit":1, "file_path":null, "repository_root":null}));
        assert_success(&first);
        let cursor = first["structuredContent"]["next"]["callees"]
            .as_str()
            .expect("real continuation");
        let continued = server.call("expand", json!({"symbol":"entry", "format":"compact", "section":"callees", "cursor":cursor, "limit":1, "file_path":null, "repository_root":null}));
        assert_success(&continued);
        assert_ne!(
            first["structuredContent"]["callees"],
            continued["structuredContent"]["callees"]
        );
        for arguments in [
            json!({"symbol":"entry", "format":"compact", "section":"callees", "cursor":"invented"}),
            json!({"symbol":"sink", "format":"compact", "section":"callees", "cursor":cursor}),
            json!({"symbol":"entry", "format":"compact", "section":"callers", "cursor":cursor}),
            json!({"symbol":"entry", "format":"compact", "section":null, "cursor":cursor}),
        ] {
            assert_error(&server.call("expand", arguments), "cursor");
        }
    }
}

#[test]
fn nullable_roots_use_the_configured_default_and_rootless_calls_still_need_a_root() {
    let repository = fixture();
    for modern in [false, true] {
        let mut rootless = Server::start(None, false, modern);
        for name in ["explore", "expand", "impact"] {
            for root in [json!({}), json!({"repository_root":null})] {
                let mut arguments = root;
                if name != "explore" {
                    arguments["symbol"] = json!("sink");
                }
                assert_error(&rootless.call(name, arguments), "repository_root");
            }
            let mut arguments = json!({"repository_root":repository.path()});
            if name != "explore" {
                arguments["symbol"] = json!("sink");
            }
            let result = rootless.call(name, arguments);
            assert_success(&result);
            assert!(text(&result).contains("src/lib.rs"));
        }
    }
}

#[test]
fn null_unset_keeps_nonnull_validation_and_legacy_limit_contracts() {
    let repository = fixture();
    let mut server = Server::start(Some(repository.path()), true, false);
    let mut invalid = vec![
        json!({"query":true}),
        json!({"query":""}),
        json!({"path_prefix":1}),
        json!({"file_path":[]}),
        json!({"file_path":""}),
        json!({"reads":{}}),
        json!({"reads":[]}),
        json!({"reads":vec![json!({"file_path":"src/lib.rs"}); 9]}),
        json!({"reads":[{}]}),
        json!({"reads":[{"file_path":null}]}),
        json!({"reads":[{"file_path":1}]}),
        json!({"reads":[{"file_path":""}]}),
        json!({"reads":[{"file_path":"src/lib.rs", "unknown":null}]}),
        json!({"start_line":1}),
        json!({"file_path":"src/lib.rs", "start_line":4294967296_u64}),
        json!({"max_bytes":1999}),
        json!({"max_bytes":32001}),
        json!({"reads":[{"file_path":"src/lib.rs", "start_line":3, "end_line":2}]}),
    ];
    for bad in [
        json!(0),
        json!(-1),
        json!(1.5),
        json!("1"),
        json!(true),
        json!(u64::MAX),
    ] {
        invalid.push(json!({"file_path":"src/lib.rs", "start_line":bad}));
        invalid.push(json!({"max_bytes":bad}));
        invalid.push(json!({"reads":[{"file_path":"src/lib.rs", "start_line":bad}]}));
        invalid.push(json!({"reads":[{"file_path":"src/lib.rs", "end_line":bad}]}));
    }
    for arguments in invalid {
        assert_error(&server.call("explore", arguments), "");
    }
    for active in ["src/lib.rs", "x", "ignored", "unused", " "] {
        for arguments in [
            json!({"file_path":active, "query":"sink"}),
            json!({"file_path":active, "path_prefix":"src"}),
            json!({"reads":[{"file_path":"src/lib.rs"}], "query":active}),
            json!({"reads":[{"file_path":"src/lib.rs"}], "path_prefix":active}),
            json!({"reads":[{"file_path":"src/lib.rs"}], "file_path":active}),
        ] {
            assert_error(
                &server.call("explore", arguments),
                "Choose one explore mode",
            );
        }
    }
    assert_error(
        &server.call(
            "explore",
            json!({"reads":[{"file_path":"src/lib.rs"}], "start_line":1}),
        ),
        "Choose one explore mode",
    );
    for name in ["expand", "impact"] {
        for bad in [json!(0), json!(-1), json!(1.5), json!("1"), json!(true)] {
            assert_error(
                &server.call(name, json!({"symbol":"sink", "limit":bad})),
                "limit",
            );
        }
        for symbol in [Value::Null, json!(""), json!(1)] {
            assert_error(&server.call(name, json!({"symbol":symbol})), "symbol");
        }
        assert_error(
            &server.call(name, json!({"symbol":"sink", "format":"invalid"})),
            "format",
        );
    }
    for bad in [
        json!(0),
        json!(-1),
        json!(1.5),
        json!("1"),
        json!(true),
        json!(11),
        json!(u64::MAX),
    ] {
        assert_error(
            &server.call("impact", json!({"symbol":"sink", "max_depth":bad})),
            "max_depth",
        );
    }
    for (name, arguments) in [
        ("map", json!({"limit":null})),
        ("search", json!({"query":"sink", "limit":null})),
        ("outline", json!({"file_path":"src/lib.rs", "limit":null})),
        ("path", json!({"from":"entry", "to":"sink", "limit":null})),
    ] {
        assert_error(&server.call(name, arguments), "limit");
    }
}
