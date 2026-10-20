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
                "--tools",
                "all",
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
    if decoded["format"] == "compact" {
        assert_no_hashes(&decoded);
    }
    decoded
}

fn assert_no_hashes(value: &Value) {
    match value {
        Value::Object(fields) => {
            assert!(!fields.contains_key("source_hash"));
            assert!(!fields.contains_key("source_hashes"));
            for value in fields.values() {
                assert_no_hashes(value);
            }
        }
        Value::Array(values) => values.iter().for_each(assert_no_hashes),
        _ => {}
    }
}

fn evidence_file<'a>(neighborhood: &'a Value, evidence: &'a Value) -> &'a Value {
    evidence
        .get("file_path")
        .unwrap_or(&neighborhood["file_path"])
}

fn assert_evidence_matches(neighborhood: &Value, compact: &Value, full: &Value) {
    let mut restored = compact.clone();
    restored["file_path"] = evidence_file(neighborhood, compact).clone();
    let mut expected = full.clone();
    expected.as_object_mut().unwrap().remove("source_hash");
    assert_eq!(restored, expected);
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
    assert_eq!(
        full["callees"][0]["from"]["evidence"]["source_hash"],
        hex::encode(Sha256::digest(source.as_bytes()))
    );
    let first = body(&mcp.call(
        "expand",
        json!({"format":"compact","symbol":"entry","limit":50}),
    ));
    assert_eq!(first["format"], "compact");
    assert_eq!(first["source"]["text"], full["source"]["text"]);
    assert_eq!(first["file_path"], "lib.rs");
    assert!(first["definition"]["evidence"].get("file_path").is_none());
    assert_eq!(first["references"]["semantic"]["status"], "disabled");
    assert!(
        first["callees"].as_array().unwrap().len() < 50,
        "budget must trim a dense section"
    );
    let cursor = first["next"]["callees"].as_str().unwrap().to_owned();
    assert!(cursor.is_ascii());
    assert!(cursor.len() <= 128, "{} characters", cursor.len());
    let mut page = first;
    let mut sites = BTreeSet::new();
    let mut cursors = BTreeSet::new();
    loop {
        for relation in page["callees"].as_array().unwrap() {
            assert!(relation.get("from").is_none());
            assert!(relation["to"]["id"].as_str().unwrap().contains("helper_"));
            assert_eq!(relation["evidence"]["confidence"], "static");
            assert!(relation["evidence"].get("file_path").is_none());
            assert_eq!(evidence_file(&page, &relation["evidence"]), "lib.rs");
            assert_eq!(evidence_file(&page, &relation["to"]["evidence"]), "lib.rs");
            assert!(sites.insert((
                evidence_file(&page, &relation["evidence"])
                    .as_str()
                    .unwrap()
                    .to_owned(),
                relation["evidence"]["start_line"].as_u64().unwrap(),
            )));
        }
        let Some(next) = page["next"]["callees"].as_str() else {
            break;
        };
        assert!(next.len() <= 128, "{} characters", next.len());
        assert!(cursors.insert(next.to_owned()), "cursor must advance");
        page = body(&mcp.call(
            "expand",
            json!({"format":"compact","symbol":"entry","section":"callees","cursor":next,"limit":7}),
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
    assert_eq!(
        sites,
        (2..=81).map(|line| ("lib.rs".to_owned(), line)).collect()
    );
    let wrong_section = mcp.call(
        "expand",
        json!({"format":"compact","symbol":"entry","section":"callers","cursor":cursor}),
    );
    assert_eq!(wrong_section["isError"], true);
    let wrong_symbol = mcp.call("expand", json!({"format":"compact","symbol":"helper_000_with_a_descriptive_identifier_for_the_callsite","section":"callees","cursor":cursor}));
    assert_eq!(wrong_symbol["isError"], true);
    let other_root = tempdir().unwrap();
    fs::write(other_root.path().join("lib.rs"), &source).unwrap();
    let wrong_root = mcp.call("expand", json!({"format":"compact","repository_root":other_root.path(),"symbol":"entry","section":"callees","cursor":cursor}));
    assert_eq!(wrong_root["isError"], true);
    fs::write(
        root.path().join("lib.rs"),
        format!("{source}\npub fn added() {{}}\n"),
    )
    .unwrap();
    let stale = body(&mcp.call(
        "expand",
        json!({"format":"compact","symbol":"entry","section":"callees","cursor":cursor}),
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
    let compact = body(&mcp.call("expand", json!({"format":"compact","symbol":"invoke"})));
    let full_edges = full["callees"].as_array().unwrap();
    assert!(!full_edges.is_empty());
    for (original, edge) in full_edges
        .iter()
        .zip(compact["callees"].as_array().unwrap())
    {
        assert_eq!(edge["to"]["id"], original["to"]["id"]);
        assert_eq!(edge["evidence"]["confidence"], "heuristic");
        assert_eq!(edge["resolution"], original["resolution"]);
        assert_evidence_matches(&compact, &edge["evidence"], &original["evidence"]);
        assert_evidence_matches(
            &compact,
            &edge["to"]["evidence"],
            &original["to"]["evidence"],
        );
        assert!(edge.get("from").is_none());
    }
    let search = body(&mcp.call(
        "search",
        json!({"format":"compact","query":"invoke", "detail":"context", "context_limit":2}),
    ));
    for entry in search["context_entries"].as_array().unwrap() {
        let anchor = &entry["symbol"]["id"];
        for caller in entry["callers"].as_array().unwrap() {
            assert!(caller.get("to").is_none());
            assert_ne!(&caller["from"]["id"], anchor);
        }
    }
    let missing = body(&mcp.call("expand", json!({"format":"compact","symbol":"absent"})));
    assert_eq!(missing["status"], "not_found");
    assert_eq!(missing["format"], "compact");
    let invalid = mcp.call("expand", json!({"symbol":"invoke","format":"brief"}));
    assert_eq!(invalid["isError"], true);
}

#[test]
fn compact_cross_file_locations_and_search_context_defaults_are_independent() {
    let root = tempdir().unwrap();
    let state = tempdir().unwrap();
    for (file, source) in [
        ("left.go", "package fixture\nfunc entryLeft() { sink() }\n"),
        (
            "right.go",
            "package fixture\nfunc entryRight() { sink() }\n",
        ),
        ("sink.go", "package fixture\nfunc sink() {}\n"),
        (
            "caller.go",
            "package fixture\nfunc caller() { entryLeft(); entryRight() }\n",
        ),
    ] {
        fs::write(root.path().join(file), source).unwrap();
    }
    let mut mcp = Mcp::new(root.path(), &state.path().join("facts.sqlite"));
    let full = body(&mcp.call("expand", json!({"symbol":"entryLeft","format":"full"})));
    let compact = body(&mcp.call("expand", json!({"symbol":"entryLeft","format":"compact"})));
    assert_eq!(compact["file_path"], "left.go");
    assert_evidence_matches(
        &compact,
        &compact["definition"]["evidence"],
        &full["definition"]["evidence"],
    );
    for (section, retained, omitted) in [("callers", "from", "to"), ("callees", "to", "from")] {
        assert_eq!(compact[section].as_array().unwrap().len(), 1);
        let edge = &compact[section][0];
        let original = &full[section][0];
        assert!(edge.get(omitted).is_none());
        assert_eq!(edge["kind"], original["kind"]);
        assert_eq!(edge[retained]["id"], original[retained]["id"]);
        assert_evidence_matches(&compact, &edge["evidence"], &original["evidence"]);
        assert_evidence_matches(
            &compact,
            &edge[retained]["evidence"],
            &original[retained]["evidence"],
        );
    }
    assert_eq!(compact["callers"][0]["evidence"]["file_path"], "caller.go");
    assert_eq!(
        compact["callees"][0]["to"]["evidence"]["file_path"],
        "sink.go"
    );
    assert!(compact["callees"][0]["evidence"].get("file_path").is_none());

    let search = body(&mcp.call(
        "search",
        json!({"query":"entry", "detail":"context", "context_limit":2, "format":"compact"}),
    ));
    assert!(search.get("file_path").is_none());
    let entries = search["context_entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    let files: BTreeSet<_> = entries
        .iter()
        .map(|entry| entry["file_path"].as_str().unwrap())
        .collect();
    assert_eq!(files, BTreeSet::from(["left.go", "right.go"]));
    for entry in entries {
        let anchor = entry["symbol"]["id"].as_str().unwrap();
        let result = search["results"]
            .as_array()
            .unwrap()
            .iter()
            .find(|result| result["id"] == anchor)
            .unwrap();
        assert_eq!(entry["file_path"], result["evidence"]["file_path"]);
        assert!(entry["symbol"]["evidence"].get("file_path").is_none());
        assert_eq!(
            entry["callees"][0]["to"]["evidence"]["file_path"],
            "sink.go"
        );
        assert!(entry["callees"][0]["evidence"].get("file_path").is_none());
        assert_eq!(
            evidence_file(entry, &entry["callees"][0]["evidence"]),
            &entry["file_path"]
        );
        assert_eq!(entry["callers"][0]["evidence"]["file_path"], "caller.go");
    }
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
    let ambiguous = body(&mcp.call("expand", json!({"format":"compact","symbol":"duplicate"})));
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
