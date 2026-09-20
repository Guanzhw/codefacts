use std::collections::BTreeSet;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::tempdir;

struct Mcp {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    id: usize,
}

impl Mcp {
    fn new(root: &Path, state: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_codefacts"))
            .args([
                "mcp",
                "--root",
                root.to_str().unwrap(),
                "--state",
                state.to_str().unwrap(),
                "--lsp",
                "off",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            input,
            output,
            id: 0,
        }
    }

    fn call(&mut self, name: &str, arguments: Value) -> Value {
        self.id += 1;
        writeln!(self.input, "{}", json!({"jsonrpc":"2.0", "id":self.id, "method":"tools/call", "params":{"name":name,"arguments":arguments}})).unwrap();
        self.input.flush().unwrap();
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        assert!(response.get("error").is_none(), "{response}");
        response["result"].clone()
    }
}

impl Drop for Mcp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn body(result: &Value) -> Value {
    assert_eq!(result["isError"], false, "{result}");
    let text = result["content"][0]["text"].as_str().unwrap();
    let decoded: Value = serde_json::from_str(text).unwrap();
    assert_eq!(decoded, result["structuredContent"]);
    if decoded["max_bytes"].is_number() {
        assert!(text.len() <= 16_384, "{} bytes", text.len());
    }
    decoded
}

#[test]
fn compact_relations_preserve_all_call_sites_with_bounded_continuations() {
    let root = tempdir().unwrap();
    let state = tempdir().unwrap();
    let mut source = String::from("pub fn entry() {\n");
    for i in 0..80 {
        source.push_str(&format!(
            "  helper_{i:03}_with_a_descriptive_identifier_for_the_callsite();\n"
        ));
    }
    source.push_str("}\n");
    for i in 0..80 {
        source.push_str(&format!(
            "pub fn helper_{i:03}_with_a_descriptive_identifier_for_the_callsite() {{}}\n"
        ));
    }
    fs::write(root.path().join("lib.rs"), &source).unwrap();
    let mut mcp = Mcp::new(root.path(), &state.path().join("facts.sqlite"));
    let full = body(&mcp.call(
        "expand",
        json!({"symbol":"entry","limit":50,"format":"full"}),
    ));
    assert_eq!(full["callees"].as_array().unwrap().len(), 50);
    assert!(full["callees"][0]["from"]["evidence"]["source_hash"].is_string());
    let first = body(&mcp.call("expand", json!({"symbol":"entry","limit":50})));
    assert_eq!(first["format"], "compact");
    assert_eq!(first["source"]["text"], full["source"]["text"]);
    assert_eq!(
        first["source_hashes"]["lib.rs"],
        hex::encode(Sha256::digest(source.as_bytes()))
    );
    assert_eq!(first["references"]["semantic"]["status"], "disabled");
    assert!(
        first["callees"].as_array().unwrap().len() < 50,
        "budget must trim a dense section"
    );
    let cursor = first["next"]["callees"].as_str().unwrap().to_owned();
    let mut page = first;
    let mut sites = BTreeSet::new();
    let mut cursors = BTreeSet::new();
    loop {
        for relation in page["callees"].as_array().unwrap() {
            assert!(relation.get("from").is_none());
            assert!(relation["to"]["id"].as_str().unwrap().contains("helper_"));
            assert_eq!(relation["evidence"]["confidence"], "static");
            assert_eq!(relation["evidence"]["file_path"], "lib.rs");
            assert!(sites.insert(relation["evidence"]["start_line"].as_u64().unwrap()));
        }
        let Some(next) = page["next"]["callees"].as_str() else {
            break;
        };
        assert!(cursors.insert(next.to_owned()), "cursor must advance");
        page = body(&mcp.call(
            "expand",
            json!({"symbol":"entry","section":"callees","cursor":next,"limit":7}),
        ));
        assert!(
            page.get("callers").is_none(),
            "unrequested sections aren't empty evidence"
        );
        assert!(
            page.get("source").is_none(),
            "continuation must not repeat source"
        );
    }
    assert_eq!(sites, (2..=81).collect());
    let wrong_section = mcp.call(
        "expand",
        json!({"symbol":"entry","section":"callers","cursor":cursor}),
    );
    assert_eq!(wrong_section["isError"], true);
    let wrong_symbol = mcp.call("expand", json!({"symbol":"helper_000_with_a_descriptive_identifier_for_the_callsite","section":"callees","cursor":cursor}));
    assert_eq!(wrong_symbol["isError"], true);
    let other_root = tempdir().unwrap();
    fs::write(other_root.path().join("lib.rs"), &source).unwrap();
    let wrong_root = mcp.call("expand", json!({"repository_root":other_root.path(),"symbol":"entry","section":"callees","cursor":cursor}));
    assert_eq!(wrong_root["isError"], true);
    fs::write(
        root.path().join("lib.rs"),
        format!("{source}\npub fn added() {{}}\n"),
    )
    .unwrap();
    let stale = body(&mcp.call(
        "expand",
        json!({"symbol":"entry","section":"callees","cursor":cursor}),
    ));
    assert_eq!(stale["status"], "stale_cursor");
    assert_eq!(stale["format"], "compact");
    assert!(stale["freshness"]["generation"].is_number());
}

#[test]
fn compact_context_and_uncertain_edges_retain_their_own_anchors_and_evidence() {
    let root = tempdir().unwrap();
    let state = tempdir().unwrap();
    fs::write(root.path().join("lib.ts"), "export class Alpha { execute() {} }\nexport class Beta { execute() {} }\nexport function invoke(receiver: any) { receiver.execute(); }\nexport function invokeAgain(receiver: any) { invoke(receiver); }\n").unwrap();
    let mut mcp = Mcp::new(root.path(), &state.path().join("facts.sqlite"));
    let full = body(&mcp.call("expand", json!({"symbol":"invoke","format":"full"})));
    let compact = body(&mcp.call("expand", json!({"symbol":"invoke"})));
    let full_edges = full["callees"].as_array().unwrap();
    assert!(!full_edges.is_empty());
    for (original, edge) in full_edges
        .iter()
        .zip(compact["callees"].as_array().unwrap())
    {
        assert_eq!(edge["to"]["id"], original["to"]["id"]);
        assert_eq!(edge["evidence"]["confidence"], "heuristic");
        assert_eq!(edge["resolution"], original["resolution"]);
        assert!(edge.get("from").is_none());
    }
    let search = body(&mcp.call(
        "search",
        json!({"query":"invoke", "detail":"context", "context_limit":2}),
    ));
    for entry in search["context_entries"].as_array().unwrap() {
        let anchor = &entry["symbol"]["id"];
        for caller in entry["callers"].as_array().unwrap() {
            assert!(caller.get("to").is_none());
            assert_ne!(&caller["from"]["id"], anchor);
        }
    }
    let missing = body(&mcp.call("expand", json!({"symbol":"absent"})));
    assert_eq!(missing["status"], "not_found");
    assert_eq!(missing["format"], "compact");
    let invalid = mcp.call("expand", json!({"symbol":"invoke","format":"brief"}));
    assert_eq!(invalid["isError"], true);
}

#[test]
fn ambiguous_candidates_also_obey_the_compact_budget() {
    let root = tempdir().unwrap();
    let state = tempdir().unwrap();
    for i in 0..50 {
        let file =
            format!("module_{i:03}_with_a_long_filename_to_exercise_hash_and_location_overhead.rs");
        fs::write(root.path().join(file), "pub fn duplicate() {}\n").unwrap();
    }
    let mut mcp = Mcp::new(root.path(), &state.path().join("facts.sqlite"));
    let ambiguous = body(&mcp.call("expand", json!({"symbol":"duplicate"})));
    assert_eq!(ambiguous["status"], "ambiguous");
    assert_eq!(ambiguous["truncated"], true);
    assert!(ambiguous["matches"].as_array().unwrap().len() < 50);
    assert!(ambiguous["message"]
        .as_str()
        .unwrap()
        .contains("paged search"));
}

#[test]
fn source_truncation_is_explicit_even_within_a_single_definition_line() {
    let root = tempdir().unwrap();
    let state = tempdir().unwrap();
    let prefix = "export function deferredState() { const text = \"";
    let suffix = "\"; return \"stale\"; }";
    let cases = [
        ("short", "ok".to_owned(), false),
        (
            "exact",
            "x".repeat(4096 - prefix.len() - suffix.len()),
            false,
        ),
        ("ascii_over", "x".repeat(5000), true),
        ("unicode_over", "界".repeat(1800), true),
    ];
    let mut mcp = Mcp::new(root.path(), &state.path().join("facts.sqlite"));
    for (name, filler, truncated) in cases {
        let file = format!("{name}.ts");
        let source = format!("{prefix}{filler}{suffix}");
        fs::write(root.path().join(&file), &source).unwrap();
        for format in ["compact", "full"] {
            let search = body(&mcp.call(
                "search",
                json!({"query":"deferredState", "path_prefix":file, "detail":"context", "format":format}),
            ));
            let expand = body(&mcp.call(
                "expand",
                json!({"symbol":"deferredState", "file_path":file, "format":format}),
            ));
            for excerpt in [&search["context_entries"][0]["source"], &expand["source"]] {
                assert_eq!(excerpt["status"], "ok");
                assert_eq!(excerpt["start_line"], 1);
                assert_eq!(excerpt["end_line"], 1);
                assert_eq!(excerpt["definition_end_line"], 1);
                assert_eq!(excerpt["truncated"], truncated, "{name}/{format}");
                let text = excerpt["text"].as_str().unwrap();
                assert!(source.starts_with(text));
                assert!(text.len() <= 4096);
                assert_eq!(excerpt["byte_length"], text.len());
                if truncated {
                    assert!(!text.contains("return \"stale\""));
                } else {
                    assert_eq!(text, source);
                }
            }
        }
    }
}

#[test]
fn markdown_is_opt_in_and_preserves_facts_across_the_five_tools() {
    let root = tempdir().unwrap();
    let state = tempdir().unwrap();
    fs::write(root.path().join("lib.ts"), "export function helper() { return 1; }\nexport function entry() { return helper(); }\nexport class Alpha { execute() {} }\nexport class Beta { execute() {} }\nexport function invoke(receiver: any) { receiver.execute(); }\n").unwrap();
    let mut mcp = Mcp::new(root.path(), &state.path().join("facts.sqlite"));
    body(&mcp.call("map", json!({})));
    let queries = [
        ("map", json!({})),
        ("search", json!({"query":"invoke", "detail":"context"})),
        ("search", json!({"query":"helper", "detail":"context"})),
        ("outline", json!({"file_path":"lib.ts"})),
        ("expand", json!({"symbol":"invoke", "limit":5})),
        ("path", json!({"from":"entry", "to":"helper"})),
        ("expand", json!({"symbol":"missing"})),
        (
            "path",
            json!({"from":"invoke", "to":"execute", "to_file_path":"lib.ts"}),
        ),
    ];
    for (tool, mut arguments) in queries {
        let mut expected = body(&mcp.call(tool, arguments.clone()));
        assert_eq!(expected["format"], "compact");
        expected["format"] = json!("markdown");
        let singleton_caller = tool == "search" && arguments["query"] == "helper";
        arguments["format"] = json!("markdown");
        let response = mcp.call(tool, arguments);
        assert_eq!(response["isError"], false, "{response}");
        assert!(response.get("structuredContent").is_none());
        assert_eq!(response["content"].as_array().unwrap().len(), 1);
        let text = response["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("markdown"));
        assert!(text.contains("freshness"));
        assert!(text.contains("generation"));
        if singleton_caller {
            assert!(text.contains("from.evidence.start_line"));
            assert!(text.contains("evidence.confidence"));
            assert!(
                !text.contains("######"),
                "relationship ownership must remain explicit"
            );
        }
        if tool == "expand" {
            assert!(text.len() <= 16_384);
        }
        assert_markdown_strings(&expected, text);
    }
}

fn assert_markdown_strings(value: &Value, text: &str) {
    match value {
        Value::String(value) => assert!(text.contains(value), "missing {value:?} in {text}"),
        Value::Object(fields) => {
            for (key, value) in fields {
                assert!(text.contains(key), "missing field {key} in {text}");
                assert_markdown_strings(value, text);
            }
        }
        Value::Array(items) => {
            for item in items {
                assert_markdown_strings(item, text);
            }
        }
        _ => {}
    }
}
