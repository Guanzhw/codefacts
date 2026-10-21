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
    decoded
}

fn owner_refs(value: &Value, refs: &mut BTreeSet<String>) {
    match value {
        Value::Object(fields) => {
            if let Some(owner_ref) = fields.get("owner_ref").and_then(Value::as_str) {
                refs.insert(owner_ref.to_owned());
            }
            for (name, value) in fields {
                if name != "rust_impl_owners" {
                    owner_refs(value, refs);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                owner_refs(value, refs);
            }
        }
        _ => {}
    }
}

fn assert_owner_dictionary(response: &Value) {
    let mut refs = BTreeSet::new();
    owner_refs(response, &mut refs);
    if refs.is_empty() {
        assert!(
            response.get("rust_impl_owners").is_none(),
            "unreferenced owner dictionary: {response}"
        );
        return;
    }
    let owners = response["rust_impl_owners"]
        .as_object()
        .expect("owner references require a root dictionary");
    for owner_ref in &refs {
        assert!(
            owners.contains_key(owner_ref),
            "missing {owner_ref}: {response}"
        );
    }
    assert_eq!(
        owners.keys().cloned().collect::<BTreeSet<_>>(),
        refs,
        "owner dictionary must not contain unreferenced records"
    );
}

fn owner_record(response: &Value, membership: &Value) -> Value {
    let owner_ref = membership["owner_ref"]
        .as_str()
        .expect("membership owner reference");
    response["rust_impl_owners"][owner_ref].clone()
}

#[test]
fn rust_impl_membership_survives_public_formats_and_exact_selectors() {
    let root = tempdir().unwrap();
    let state = tempdir().unwrap();
    let source = "struct P; trait A { fn run(); } trait B { fn run(); } impl A for P { fn run() { left(); } } impl B for P { fn run() { right(); } } fn left() {} fn right() {}";
    fs::write(root.path().join("lib.rs"), source).unwrap();
    let mut mcp = Mcp::new(root.path(), &state.path().join("facts.sqlite"));
    let full = body(&mcp.call(
        "outline",
        json!({"file_path":"lib.rs","kind":"method","format":"full"}),
    ));
    assert_owner_dictionary(&full);
    let compact = body(&mcp.call(
        "outline",
        json!({"file_path":"lib.rs","kind":"method","format":"compact"}),
    ));
    assert_owner_dictionary(&compact);
    let markdown = mcp.call(
        "outline",
        json!({"file_path":"lib.rs","kind":"method","format":"markdown"}),
    );
    assert_eq!(markdown["isError"], false);
    let text = markdown["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("rust_impl_owners"));
    assert_eq!(
        text.lines()
            .filter(|line| line.starts_with("### impl_"))
            .count(),
        2
    );
    let methods = full["symbols"].as_array().unwrap();
    assert_eq!(methods.len(), 2);
    let search = body(&mcp.call("search", json!({"query":"run","format":"full"})));
    assert_owner_dictionary(&search);
    assert_eq!(search["results"].as_array().unwrap().len(), 2);
    let ambiguous = body(&mcp.call("expand", json!({"symbol":"run","format":"full"})));
    assert_owner_dictionary(&ambiguous);
    assert_eq!(ambiguous["status"], "ambiguous");
    for (index, (method, leaf)) in methods.iter().zip(["left", "right"]).enumerate() {
        let id = method["id"].as_str().unwrap();
        assert!(text.contains(id));
        let membership = &method["rust_impl"];
        let expected_record = owner_record(&full, membership);
        assert_eq!(expected_record["receiver"], "P");
        assert_eq!(
            expected_record["trait_name"],
            if index == 0 { "A" } else { "B" }
        );
        assert_eq!(
            owner_record(&compact, &compact["symbols"][index]["rust_impl"]),
            expected_record
        );
        for field in [
            "file_path",
            "receiver",
            "trait_name",
            "start_line",
            "start_column",
            "end_line",
            "end_column",
        ] {
            assert!(text.contains(field), "{text}");
            let value = &expected_record[field];
            if let Some(value) = value.as_str() {
                assert!(text.contains(value), "missing {value} in {text}");
            } else {
                assert!(
                    text.contains(&value.to_string()),
                    "missing {value} in {text}"
                );
            }
        }
        for (response, collection) in [
            (&search, search["results"].as_array().unwrap()),
            (&ambiguous, ambiguous["matches"].as_array().unwrap()),
        ] {
            assert_eq!(
                owner_record(
                    response,
                    &collection.iter().find(|symbol| symbol["id"] == id).unwrap()["rust_impl"]
                ),
                expected_record
            );
        }
        let expanded = body(&mcp.call("expand", json!({"symbol":id,"format":"full"})));
        assert_owner_dictionary(&expanded);
        let compact_expanded = body(&mcp.call("expand", json!({"symbol":id,"format":"compact"})));
        assert_owner_dictionary(&compact_expanded);
        let markdown_expanded = mcp.call("expand", json!({"symbol":id,"format":"markdown"}));
        assert_eq!(markdown_expanded["isError"], false);
        assert_eq!(
            owner_record(&expanded, &expanded["definition"]["rust_impl"]),
            expected_record
        );
        assert_eq!(
            owner_record(
                &compact_expanded,
                &compact_expanded["definition"]["rust_impl"]
            ),
            expected_record
        );
        assert_eq!(expanded["callees"][0]["to"]["name"], leaf);
        assert_eq!(expanded["definition"]["evidence"], method["evidence"]);
        let rendered = markdown_expanded["content"][0]["text"].as_str().unwrap();
        assert!(rendered.contains("rust_impl"));
        assert!(rendered.contains("receiver: P"));
        assert!(rendered.contains("rust_impl_owners"));
        assert!(rendered.lines().any(|line| line.starts_with("### impl_")));
        assert!(rendered.contains("file_path: lib.rs"));
        assert!(rendered.contains(expected_record["trait_name"].as_str().unwrap()));
        for field in ["start_line", "start_column", "end_line", "end_column"] {
            assert!(rendered.contains(field), "{rendered}");
            assert!(
                rendered.contains(&expected_record[field].to_string()),
                "{rendered}"
            );
        }
        assert!(rendered.len() <= 16_384);
        eprintln!(
            "Rust impl expand {id}: full={} compact={} markdown={} bytes",
            expanded.to_string().len(),
            compact_expanded.to_string().len(),
            rendered.len()
        );
    }
    let first = body(&mcp.call(
        "outline",
        json!({"file_path":"lib.rs","kind":"method","limit":1,"format":"compact"}),
    ));
    assert_owner_dictionary(&first);
    let second = body(&mcp.call("outline", json!({"file_path":"lib.rs","kind":"method","limit":1,"cursor":first["next_cursor"],"format":"compact"})));
    assert_owner_dictionary(&second);
    assert_eq!(first["symbols"][0]["id"], methods[0]["id"]);
    assert_eq!(second["symbols"][0]["id"], methods[1]["id"]);
    assert!(second.get("next_cursor").is_none());
    let plain = body(&mcp.call("expand", json!({"symbol":"left","format":"full"})));
    assert!(plain["definition"].get("rust_impl").is_none());
    assert_owner_dictionary(&plain);
    eprintln!(
        "Rust impl outline: full={} compact={} markdown={} bytes",
        full.to_string().len(),
        compact.to_string().len(),
        text.len()
    );
}

#[test]
fn repeated_rust_impl_membership_remains_complete_across_budgeted_callee_pages() {
    let root = tempdir().unwrap();
    let state = tempdir().unwrap();
    let mut source = String::from("struct P;\nimpl P {\n fn entry() {\n");
    for index in 0..80 {
        source.push_str(&format!("  leaf_{index:03}();\n"));
    }
    source.push_str(" }\n");
    for index in 0..80 {
        source.push_str(&format!(" fn leaf_{index:03}() {{}}\n"));
    }
    source.push_str("}\n");
    fs::write(root.path().join("lib.rs"), source).unwrap();
    let mut mcp = Mcp::new(root.path(), &state.path().join("facts.sqlite"));
    for format in ["full", "compact", "markdown"] {
        let mut cursor = Value::Null;
        let mut seen = BTreeSet::new();
        let mut pages = 0;
        loop {
            let result = mcp.call("expand", json!({"symbol":"entry","section":"callees","format":format,"limit":50,"cursor":cursor}));
            assert_eq!(result["isError"], false, "{result}");
            let text = result["content"][0]["text"].as_str().unwrap();
            pages += 1;
            assert!(pages <= 80, "cursor must advance");
            if format == "markdown" {
                assert!(text.len() <= 16_384);
                assert!(text.contains("rust_impl_owners"));
                assert_eq!(
                    text.lines()
                        .filter(|line| line.starts_with("### impl_"))
                        .count(),
                    1
                );
                assert!(text.contains("to_rust_impl.owner_ref"), "{text}");
                assert!(text.contains("|to|"), "{text}");
                assert!(text.contains("method:lib.rs:leaf_"), "{text}");
                for index in 0..80 {
                    if text.contains(&format!("method:lib.rs:leaf_{index:03}:")) {
                        assert!(seen.insert(format!("leaf_{index:03}")), "duplicate {index}");
                    }
                }
                // Human relationship endpoints intentionally stay concise;
                // the selected definition still carries the canonical owner.
                assert!(text.contains("rust_impl"));
                cursor = text
                    .lines()
                    .find_map(|line| line.strip_prefix("- callees: "))
                    .map(Value::from)
                    .unwrap_or(Value::Null);
            } else {
                let page = body(&result);
                assert_owner_dictionary(&page);
                assert_eq!(page["rust_impl_owners"].as_object().unwrap().len(), 1);
                for relation in page["callees"].as_array().unwrap() {
                    assert_eq!(
                        owner_record(&page, &relation["to"]["rust_impl"]),
                        owner_record(&page, &page["definition"]["rust_impl"])
                    );
                    assert!(seen.insert(relation["to"]["name"].as_str().unwrap().to_owned()));
                }
                cursor = page["next"]["callees"].clone();
                if format == "compact" {
                    assert!(text.len() <= 16_384);
                    assert!(page["callees"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|relation| relation.get("from").is_none()));
                }
            }
            eprintln!(
                "Repeated Rust impl {format} page {pages}: {} bytes",
                text.len()
            );
            if cursor.is_null() {
                break;
            }
        }
        assert_eq!(seen.len(), 80, "{format}");
        assert!(pages >= 2, "{format}");
    }
    let callers = mcp.call(
        "expand",
        json!({"symbol":"leaf_000","section":"callers","format":"markdown"}),
    );
    let caller_text = callers["content"][0]["text"].as_str().unwrap();
    assert!(caller_text.contains("rust_impl_owners"));
    assert!(
        caller_text.contains("from_rust_impl.owner_ref"),
        "{caller_text}"
    );
    assert!(caller_text.contains("|from|"), "{caller_text}");
    assert!(caller_text.contains("method:lib.rs:entry"), "{caller_text}");
}

#[test]
fn oversized_rust_impl_spelling_keeps_full_facts_and_explicit_budget_failure() {
    let root = tempdir().unwrap();
    let state = tempdir().unwrap();
    let trait_name = format!("Trait{}", "x".repeat(17_000));
    fs::write(
        root.path().join("lib.rs"),
        format!("struct P; impl {trait_name} for P {{ fn run() {{}} }}"),
    )
    .unwrap();
    let mut mcp = Mcp::new(root.path(), &state.path().join("facts.sqlite"));
    let full = body(&mcp.call("expand", json!({"symbol":"run","format":"full"})));
    assert_owner_dictionary(&full);
    assert_eq!(
        owner_record(&full, &full["definition"]["rust_impl"])["trait_name"],
        trait_name
    );
    for format in ["compact", "markdown"] {
        let response = mcp.call("expand", json!({"symbol":"run","format":format}));
        assert_eq!(response["isError"], true);
        assert!(response["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("One fact exceeds the response text budget"));
    }
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
    let first = body(&mcp.call(
        "expand",
        json!({"format":"compact","symbol":"entry","limit":50}),
    ));
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
            assert_eq!(relation["evidence"]["file_path"], "lib.rs");
            assert!(sites.insert(relation["evidence"]["start_line"].as_u64().unwrap()));
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
    assert_eq!(sites, (2..=81).collect());
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
