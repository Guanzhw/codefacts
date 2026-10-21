use std::collections::BTreeSet;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::tempdir;

// Frozen mechanism fixture from rust-impl-explore-consumer-design-20261021.
// execute has no query terms and no call from the matching identity members.
const ARCHIVE_ENV: &str = r#"pub struct ArchiveEnv;
pub trait Command {
    fn name(&self) -> &str;
    fn signature(&self) -> &str;
    fn usage(&self) -> &str;
    fn examples(&self) -> &str;
    fn execute(&self, state: &mut State, keys: &[&str], tolerant: bool) -> Result<(), &'static str>;
}
impl Command for ArchiveEnv {
    fn name(&self) -> &str { "archive-env" }
    fn signature(&self) -> &str { "archive-env [names]" }
    fn usage(&self) -> &str { "Archive environment variables." }
    fn examples(&self) -> &str { "archive-env SAMPLE_KEY" }
    fn execute(&self, state: &mut State, keys: &[&str], tolerant: bool) -> Result<(), &'static str> {
        for key in keys {
            let taken = state.take(key);
            if !taken && !tolerant {
                return Err("missing-key-marker");
            }
        }
        state.finalize();
        Ok(())
    }
}

pub struct State;
impl State {
    fn take(&mut self, _key: &str) -> bool { false }
    fn finalize(&mut self) {}
}

// Same receiver, separate inherent block: not a direct sibling of Command methods.
impl ArchiveEnv {
    fn execute(&self) -> &'static str { "wrong-inherent-marker" }
}

pub trait Inspect { fn name(&self) -> &str; fn execute(&self) -> &str; }
impl Inspect for ArchiveEnv {
    fn name(&self) -> &str { "archive-env diagnostic" }
    fn execute(&self) -> &str { "wrong-trait-marker" }
}

mod other {
    pub struct ArchiveEnv;
    impl ArchiveEnv {
        fn name(&self) -> &str { "archive-env other" }
        fn execute(&self) -> &str { "wrong-module-marker" }
    }
}

fn nested() {
    struct Local;
    impl Local {
        fn name(&self) -> &str { "archive-env nested" }
        fn execute(&self) -> &str { "nested-owner-marker" }
    }
    fn helper() -> &'static str { "not-a-direct-member-marker" }
}

fn unicode_columns() { let _label = "中文"; struct Left; struct Right; impl Left { fn name(&self) -> &str { "left-marker" } } impl Right { fn name(&self) -> &str { "right-marker" } } }
"#;

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
        Self {
            input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()),
            child,
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
        let result = response["result"].clone();
        assert_eq!(result["isError"], false, "{result}");
        result
    }

    fn explore(&mut self, query: &str, budget: usize) -> String {
        let result = self.call(
            "explore",
            json!({"query":query,"path_prefix":"lib.rs","max_bytes":budget}),
        );
        assert!(result.get("structuredContent").is_none(), "{result}");
        assert_eq!(result["content"].as_array().unwrap().len(), 1);
        assert_eq!(result["content"][0]["type"], "text");
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(text.len() <= budget, "{} > {budget}: {text}", text.len());
        assert!(text.contains("Freshness: fresh | generation "), "{text}");
        text.to_owned()
    }
}

impl Drop for Mcp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn body(result: Value) -> Value {
    let decoded: Value =
        serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(decoded, result["structuredContent"]);
    decoded
}

fn owner<'a>(outline: &'a Value, method: &Value) -> &'a Value {
    let reference = method["rust_impl"]["owner_ref"]
        .as_str()
        .expect("direct method must carry canonical impl membership");
    let record = &outline["rust_impl_owners"][reference];
    assert!(record.is_object(), "{outline}");
    record
}

fn heading(record: &Value) -> String {
    format!(
        "## {}:{}:{}-{}:{} | Rust impl source",
        record["file_path"].as_str().unwrap(),
        record["start_line"],
        record["start_column"],
        record["end_line"],
        record["end_column"]
    )
}

fn card<'a>(text: &'a str, heading: &str) -> &'a str {
    let matching = text.lines().filter(|line| *line == heading).count();
    assert_eq!(matching, 1, "{heading}: {text}");
    let start = text.find(heading).unwrap();
    let tail = &text[start..];
    &tail[..tail.find("\n## ").unwrap_or(tail.len())]
}

#[test]
fn query_delivers_unmatched_sibling_source_and_keeps_original_method_selectors() {
    let root = tempdir().unwrap();
    let state = tempdir().unwrap();
    fs::write(root.path().join("lib.rs"), ARCHIVE_ENV).unwrap();
    let mut mcp = Mcp::new(root.path(), &state.path().join("facts.sqlite"));
    let outline = body(mcp.call(
        "outline",
        json!({"file_path":"lib.rs","kind":"method","limit":100,"format":"full"}),
    ));
    let methods = outline["symbols"].as_array().unwrap();
    let family: Vec<_> = methods
        .iter()
        .filter(|method| (10..=14).contains(&method["evidence"]["start_line"].as_u64().unwrap()))
        .collect();
    assert_eq!(family.len(), 5, "{outline}");
    assert_eq!(
        family
            .iter()
            .map(|m| m["name"].as_str().unwrap())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["name", "signature", "usage", "examples", "execute"])
    );
    let expected_owner = json!({"file_path":"lib.rs","receiver":"ArchiveEnv","trait_name":"Command","start_line":9,"start_column":0,"end_line":24,"end_column":1});
    for method in &family {
        assert_eq!(owner(&outline, method), &expected_owner);
    }
    let group_heading = heading(&expected_owner);
    for budget in [2_000, 24_000, 32_000] {
        let text = mcp.explore(
            "archive-env command implementation environment variables",
            budget,
        );
        // 2k may admit only a prefix of frames. Complete delivery is asserted
        // at the larger budgets, where the small family's pooled share fits.
        if budget == 2_000 {
            continue;
        }
        let group = card(&text, &group_heading);
        assert!(
            group.contains("[complete] same-impl source context via method "),
            "{group}"
        );
        let has_identity_anchor = family
            .iter()
            .filter(|method| method["name"] != "execute")
            .any(|method| {
                let start = method["evidence"]["start_line"].as_u64().unwrap() as usize;
                let end = method["evidence"]["end_line"].as_u64().unwrap() as usize;
                let lines: Vec<_> = ARCHIVE_ENV.lines().collect();
                let start_column = lines[start - 1].find("fn ").unwrap();
                let end_column = lines[end - 1].rfind('}').unwrap() + 1;
                group.contains(&format!(
                    "via method {} at {start}:{start_column}-{end}:{end_column}",
                    method["name"].as_str().unwrap()
                ))
            });
        assert!(
            has_identity_anchor,
            "query must admit an identity member: {group}"
        );
        for (index, line) in ARCHIVE_ENV.lines().enumerate().skip(8).take(16) {
            let expected = format!("{}: {line}", index + 1);
            assert_eq!(
                group.lines().filter(|line| *line == expected).count(),
                1,
                "{expected}: {group}"
            );
        }
        for marker in [
            "wrong-inherent-marker",
            "wrong-trait-marker",
            "wrong-module-marker",
            "nested-owner-marker",
            "not-a-direct-member-marker",
        ] {
            assert!(
                !group.contains(marker),
                "different owner merged into Command: {group}"
            );
        }
    }
    // Query grouping must not replace graph IDs with synthetic impl selectors.
    for method in family {
        let expanded = body(mcp.call("expand", json!({"symbol":method["id"],"format":"full"})));
        assert_eq!(expanded["definition"]["id"], method["id"]);
        assert_eq!(expanded["definition"]["evidence"], method["evidence"]);
        assert_eq!(owner(&expanded, &expanded["definition"]), &expected_owner);
    }
    // Distinct owner blocks remain discoverable under their own canonical range.
    for (marker, line) in [
        ("wrong-inherent-marker", 34),
        ("wrong-trait-marker", 40),
        ("wrong-module-marker", 47),
        ("nested-owner-marker", 55),
    ] {
        let method = methods
            .iter()
            .find(|m| m["evidence"]["start_line"] == line)
            .unwrap();
        let separate = owner(&outline, method);
        assert_ne!(separate, &expected_owner);
        let text = mcp.explore(marker, 32_000);
        let group = card(&text, &heading(separate));
        assert!(group.contains(marker), "{group}");
        assert!(!group.contains("missing-key-marker"), "{group}");
    }
}

#[test]
fn same_line_impl_cards_use_utf8_byte_columns_and_preserve_physical_lines() {
    let left = r#"impl Left { fn name(&self) -> &str { "left-marker" } }"#;
    let right = r#"impl Right { fn name(&self) -> &str { "right-marker" } }"#;
    let line = format!("fn unicode_columns() {{ let _label = \"中文\"; struct Left; struct Right; {left} {right} }}");
    for newline in ["\n", "\r\n"] {
        let root = tempdir().unwrap();
        let state = tempdir().unwrap();
        let source = format!("// physical prefix{newline}{line}{newline}");
        fs::write(root.path().join("lib.rs"), &source).unwrap();
        let mut mcp = Mcp::new(root.path(), &state.path().join("facts.sqlite"));
        let outline = body(mcp.call(
            "outline",
            json!({"file_path":"lib.rs","kind":"method","format":"full"}),
        ));
        let methods = outline["symbols"].as_array().unwrap();
        assert_eq!(methods.len(), 2, "{outline}");
        let mut headings = BTreeSet::new();
        for (receiver, snippet) in [("Left", left), ("Right", right)] {
            let method = methods
                .iter()
                .find(|m| owner(&outline, m)["receiver"] == receiver)
                .unwrap();
            let start = line.find(snippet).unwrap();
            assert!(
                start > line[..start].chars().count(),
                "fixture needs a UTF-8 prefix"
            );
            let record = owner(&outline, method);
            assert_eq!(record["start_line"], 2);
            assert_eq!(record["end_line"], 2);
            assert_eq!(record["start_column"], start);
            assert_eq!(record["end_column"], start + snippet.len());
            assert_eq!(
                method["evidence"]["source_hash"],
                hex::encode(Sha256::digest(source.as_bytes()))
            );
            headings.insert(heading(record));
        }
        assert_eq!(
            headings.len(),
            2,
            "same physical line must retain distinct owners"
        );
        for budget in [2_000, 24_000, 32_000] {
            let text = mcp.explore("left-marker right-marker", budget);
            // Larger budgets must deliver both cards, each with the complete
            // physical boundary line, including the neighboring impl's text.
            if budget > 2_000 {
                for group_heading in &headings {
                    let group = card(&text, group_heading);
                    assert!(group.contains("[complete]"), "{group}");
                    assert!(
                        group.lines().any(|source| source == format!("2: {line}")),
                        "{group}"
                    );
                }
            }
            assert!(text.contains("boundary"), "{text}");
        }
    }
}
