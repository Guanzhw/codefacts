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
    modern: bool,
    id: usize,
}
impl Mcp {
    fn new(root: &Path, state: &Path, modern: bool) -> Self {
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
            modern,
            id: 0,
        }
    }
    fn call(&mut self, name: &str, arguments: Value) -> Value {
        self.id += 1;
        let mut params = json!({"name":name,"arguments":arguments});
        if self.modern {
            params["_meta"] = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28", "io.modelcontextprotocol/clientCapabilities":{}});
        }
        writeln!(
            self.input,
            "{}",
            json!({"jsonrpc":"2.0","id":self.id,"method":"tools/call","params":params})
        )
        .unwrap();
        self.input.flush().unwrap();
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        assert!(response.get("error").is_none(), "{response}");
        let result = response["result"].clone();
        assert_eq!(result["isError"], false, "{result}");
        if self.modern {
            assert_eq!(result["resultType"], "complete");
        }
        result
    }
}
impl Drop for Mcp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn text(result: &Value) -> &str {
    assert!(result.get("structuredContent").is_none(), "{result}");
    assert_eq!(result["content"].as_array().unwrap().len(), 1);
    assert_eq!(result["content"][0]["type"], "text");
    let text = result["content"][0]["text"].as_str().unwrap();
    for metadata in [
        "source_hash",
        "SHA256:",
        "format:",
        "duration_ms",
        "files_unchanged",
        "files_indexed_this_refresh",
    ] {
        assert!(!text.contains(metadata), "unexpected {metadata}: {text}");
    }
    assert!(text.to_lowercase().contains("fresh"), "{text}");
    assert!(text.contains("generation"), "{text}");
    text
}
fn machine(result: &Value) -> &Value {
    let body = &result["structuredContent"];
    assert!(body.is_object(), "{result}");
    assert_eq!(
        serde_json::from_str::<Value>(result["content"][0]["text"].as_str().unwrap()).unwrap(),
        *body
    );
    body
}
fn has(text: &str, facts: &[&str]) {
    for fact in facts {
        assert!(text.contains(fact), "missing {fact:?}: {text}");
    }
}

// Read the visible contents of a GFM table cell, including literal code spans.
// This copies the returned value rather than constructing a selector from facts.
fn table_column(text: &str, section: &str, column: &str) -> Vec<String> {
    fn cells(line: &str) -> Vec<String> {
        let mut cells = vec![String::new()];
        let mut escaped = false;
        for character in line.trim_matches('|').chars() {
            if character == '|' && !escaped {
                cells.push(String::new());
            } else {
                cells.last_mut().unwrap().push(character);
            }
            escaped = character == '\\' && !escaped;
        }
        cells
    }
    let mut lines = text.lines().skip_while(|line| {
        !line.starts_with('#') || line.trim_start_matches('#').trim() != section
    });
    lines.next().expect("returned section");
    let header = lines.next().expect("table header");
    let column = cells(header)
        .iter()
        .position(|name| name == column)
        .expect("selector column");
    assert!(lines.next().unwrap().starts_with("|---"));
    lines
        .take_while(|line| line.starts_with('|'))
        .map(|line| {
            let row = cells(line);
            let cell = row[column].trim();
            let fence = cell.chars().take_while(|c| *c == '`').count();
            cell[fence..cell.len() - fence].trim().replace("\\|", "|")
        })
        .collect()
}

#[test]
fn returned_relation_selectors_roundtrip_to_exact_symbols_over_stdio() {
    let root = tempdir().unwrap();
    let file = "worker [one]`tick`.py";
    fs::write(
        root.path().join(file),
        "def helper():\n    return 1\ndef helper_again():\n    return 2\nclass First:\n    def run_with_input(self):\n        return helper()\nclass Second:\n    def run_with_input(self):\n        return helper_again()\n",
    )
    .unwrap();
    fs::write(
        root.path().join("other.py"),
        "class Third:\n    def run_with_input(self):\n        return 3\n",
    )
    .unwrap();
    fs::write(
        root.path().join("README.md"),
        "# Guide\n[child](#use-api-now)\n\n## Use | `api` now\nDetails.\n",
    )
    .unwrap();
    for modern in [false, true] {
        let state = tempdir().unwrap();
        let mut mcp = Mcp::new(root.path(), &state.path().join("facts.sqlite"), modern);
        let ambiguous = mcp.call(
            "expand",
            json!({"symbol":"run_with_input", "format":"full"}),
        );
        assert_eq!(machine(&ambiguous)["status"], "ambiguous");
        assert_eq!(machine(&ambiguous)["matches"].as_array().unwrap().len(), 3);

        for helper in ["helper", "helper_again"] {
            let full = mcp.call("expand", json!({"symbol":helper, "format":"full"}));
            let callers = machine(&full)["callers"].as_array().unwrap();
            assert_eq!(
                callers.len(),
                1,
                "one visible caller despite global ambiguity"
            );
            let expected = callers[0]["from"]["id"].as_str().unwrap();
            assert!(expected.starts_with("method:"), "{expected}");
            let response = mcp.call("expand", json!({"symbol":helper}));
            let selectors = table_column(text(&response), "callers", "from");
            assert_eq!(selectors, [expected]);
            let selector = &selectors[0];
            for tool in ["expand", "impact"] {
                let follow_up = mcp.call(tool, json!({"symbol":selector, "format":"full"}));
                assert_eq!(machine(&follow_up)["status"], "ok", "{follow_up}");
                assert_eq!(machine(&follow_up)["definition"]["id"], expected);
            }
            let caller = mcp.call("expand", json!({"symbol":selector}));
            let callees = table_column(text(&caller), "callees", "to");
            assert_eq!(
                callees,
                [machine(&full)["definition"]["id"].as_str().unwrap()]
            );
            let impact = mcp.call("impact", json!({"symbol":helper}));
            let parents = table_column(text(&impact), "affected", "parent");
            assert_eq!(parents, callees);
        }

        // Heading IDs contain spaces, a pipe, and backticks; qualification stays
        // reading context, while the returned exact ID is the follow-up input.
        let full = mcp.call("expand", json!({"symbol":"Guide", "format":"full"}));
        let expected = machine(&full)["references"]["outbound"][0]["to"]["id"]
            .as_str()
            .unwrap();
        let response = mcp.call("expand", json!({"symbol":"Guide"}));
        let selectors = table_column(text(&response), "outbound", "to");
        assert_eq!(selectors, [expected]);
        for tool in ["expand", "impact"] {
            let follow_up = mcp.call(tool, json!({"symbol":selectors[0], "format":"full"}));
            assert_eq!(machine(&follow_up)["status"], "ok", "{follow_up}");
            assert_eq!(machine(&follow_up)["definition"]["id"], expected);
        }
        let target = mcp.call("expand", json!({"symbol":selectors[0]}));
        let inbound = table_column(text(&target), "inbound", "from");
        assert_eq!(
            inbound,
            [machine(&full)["definition"]["id"].as_str().unwrap()]
        );
    }
}

#[test]
fn omitted_format_is_text_only_for_all_seven_workflows_in_both_protocol_eras() {
    let root = tempdir().unwrap();
    let source = "export function helper() { return 1; }\nexport function entry() {\n  helper();\n  return helper();\n}\nexport class Alpha { execute() {} }\nexport class Beta { execute() {} }\nexport function invoke(receiver: any) { receiver.execute(); }\n";
    fs::write(root.path().join("lib.ts"), source).unwrap();
    fs::write(
        root.path().join("entry.test.ts"),
        "import { entry } from './lib';\nexport function entry_test() { entry(); }\n",
    )
    .unwrap();
    fs::write(
        root.path().join("README.md"),
        "# Contract\n\n## literal\nSource SHA256: literal-source-text\n",
    )
    .unwrap();
    for modern in [false, true] {
        let state = tempdir().unwrap();
        let mut mcp = Mcp::new(root.path(), &state.path().join("facts.sqlite"), modern);
        for (tool, args, facts) in [
            (
                "map",
                json!({}),
                vec!["indexed_files", "symbols", "typescript"],
            ),
            (
                "search",
                json!({"query":"helper", "detail":"context", "path_prefix":"lib.ts"}),
                vec![
                    "helper", "lib.ts", "callers", "entry", "lib.ts:3", "lib.ts:4",
                ],
            ),
            (
                "outline",
                json!({"file_path":"lib.ts"}),
                vec!["lib.ts", "helper", "entry", "Alpha", "Beta"],
            ),
            (
                "expand",
                json!({"symbol":"entry", "file_path":"lib.ts"}),
                vec!["entry", "helper", "callees", "lib.ts:3", "lib.ts:4"],
            ),
            (
                "path",
                json!({"from":"entry", "to":"helper"}),
                vec!["entry", "helper", "relationships", "1 -> 2", "lib.ts:3"],
            ),
            (
                "impact",
                json!({"symbol":"helper", "max_depth":1}),
                vec![
                    "helper",
                    "entry",
                    "reverse",
                    "distance",
                    "depth_limit_reached",
                ],
            ),
            (
                "explore",
                json!({"reads":[{"file_path":"lib.ts", "start_line":1,"end_line":5}]}),
                vec!["lib.ts:1-5", "helper();"],
            ),
        ] {
            let response = mcp.call(tool, args.clone()); // Deliberately omit format: no helper injection.
            let reading = text(&response);
            has(reading, &facts);
            assert!(!reading.contains(&hex::encode(Sha256::digest(source.as_bytes()))));
            if tool != "explore" {
                let mut explicit = args;
                explicit["format"] = json!("full");
                let response = mcp.call(tool, explicit);
                let full = machine(&response);
                assert_eq!(full["freshness"]["status"], "fresh");
                if tool == "expand" {
                    assert_eq!(
                        full["definition"]["evidence"]["source_hash"],
                        hex::encode(Sha256::digest(source.as_bytes()))
                    );
                    assert_eq!(full["callees"].as_array().unwrap().len(), 2);
                    assert_eq!(full["callees"][0]["evidence"]["start_line"], 3);
                    assert_eq!(full["callees"][1]["evidence"]["start_line"], 4);
                }
            }
        }
        let missing = mcp.call("expand", json!({"symbol":"missing"}));
        has(text(&missing), &["not_found"]);
        let no_path = mcp.call("path", json!({"from":"helper", "to":"entry"}));
        has(text(&no_path), &["helper", "entry", "static"]);
        let uncertain = mcp.call("expand", json!({"symbol":"invoke"}));
        has(
            text(&uncertain),
            &["heuristic", "receiver", "execute", "lib.ts:8"],
        );
        let ambiguous = mcp.call("expand", json!({"symbol":"execute"}));
        let ambiguous_text = text(&ambiguous);
        let full = mcp.call("expand", json!({"symbol":"execute","format":"full"}));
        let matches = machine(&full)["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 2);
        for candidate in matches {
            has(ambiguous_text, &[candidate["id"].as_str().unwrap()]);
        }
        let tests = mcp.call("impact", json!({"symbol":"helper"}));
        has(
            text(&tests),
            &[
                "entry_test",
                "test_associated",
                "affected_entries",
                "reverse",
            ],
        );
        let markdown = mcp.call("expand", json!({"symbol":"entry", "format":"markdown"}));
        has(
            text(&markdown),
            &["entry", "helper", "lib.ts:3", "lib.ts:4", "static"],
        );
        // Source literals are data even when they resemble removed metadata.
        let literal = mcp.call(
            "expand",
            json!({"symbol":"literal", "file_path":"README.md"}),
        );
        let literal_text = literal["content"][0]["text"].as_str().unwrap();
        assert!(literal.get("structuredContent").is_none());
        has(literal_text, &["SHA256: literal-source-text"]);
    }
}

#[test]
fn omitted_format_preserves_real_continuation_cursors_and_paged_occurrences() {
    let root = tempdir().unwrap();
    let state = tempdir().unwrap();
    fs::write(
        root.path().join("lib.rs"),
        "pub fn helper() {}\npub fn entry() {\n helper();\n helper();\n helper();\n}\n",
    )
    .unwrap();
    let mut mcp = Mcp::new(root.path(), &state.path().join("facts.sqlite"), false);
    let first = mcp.call(
        "expand",
        json!({"symbol":"entry","section":"callees","limit":1,"format":"compact"}),
    );
    let compact = machine(&first);
    let cursor = compact["next"]["callees"].as_str().unwrap();
    let reading = mcp.call(
        "expand",
        json!({"symbol":"entry","section":"callees","limit":1}),
    );
    has(text(&reading), &[cursor, "lib.rs:3"]);
    let next = mcp.call(
        "expand",
        json!({"symbol":"entry","section":"callees","limit":1,"cursor":cursor}),
    );
    has(text(&next), &["lib.rs:4", "helper"]);
    assert!(!text(&next).contains("lib.rs:3"));
    fs::write(
        root.path().join("lib.rs"),
        "pub fn helper() {}\npub fn entry() {}\n",
    )
    .unwrap();
    let stale = mcp.call(
        "expand",
        json!({"symbol":"entry","section":"callees","cursor":cursor}),
    );
    has(text(&stale), &["stale_cursor"]);
}
