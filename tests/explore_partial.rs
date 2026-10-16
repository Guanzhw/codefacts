use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::tempdir;

const SOURCE: &str = "package fixture\n// 中文 source evidence\nfunc entry() {}\n";

fn explore_twice(root: &std::path::Path, budget: usize, modern: bool) -> Vec<String> {
    let state = tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_codefacts"))
        .args(["mcp", "--lsp", "off"])
        .env("CODEFACTS_STATE_DIR", state.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    for id in 1..=2 {
        let mut params = json!({"name":"explore","arguments":{
            "repository_root":root,"max_bytes":budget
        }});
        if modern {
            params["_meta"] = json!({
                "io.modelcontextprotocol/protocolVersion":"2026-07-28",
                "io.modelcontextprotocol/clientCapabilities":{}
            });
        }
        writeln!(
            input,
            "{}",
            json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":params})
        )
        .unwrap();
    }
    drop(input);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    let responses: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(responses.len(), 2);
    responses
        .into_iter()
        .map(|response| {
            let result = &response["result"];
            assert_eq!(result["isError"], false, "{response}");
            assert!(result.get("structuredContent").is_none());
            let text = result["content"][0]["text"].as_str().unwrap().to_owned();
            assert!(text.len() <= budget, "{} > {budget}: {text}", text.len());
            let root_text = fs::canonicalize(root)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            assert!(text.contains(&format!(
                "Root: {}\n",
                root_text.trim_start_matches(r"\\?\")
            )));
            assert!(text.contains(" | generation "));
            assert!(text.contains(&format!("UTF-8 response budget {budget} bytes")));
            assert!(text.contains("fixture.go"));
            assert!(!text.contains(&format!("{:x}", Sha256::digest(SOURCE.as_bytes()))));
            assert!(text.contains("func entry() {}"));
            text
        })
        .collect()
}

#[test]
fn default_explore_reports_real_index_omissions_within_utf8_budget() {
    let repository = tempdir().unwrap();
    fs::write(repository.path().join("fixture.go"), SOURCE).unwrap();
    // The index limit is 2 MiB; this produces the same omission on Windows and Unix.
    fs::write(
        repository.path().join("large.go"),
        vec![b'x'; 2 * 1024 * 1024 + 1],
    )
    .unwrap();
    // Invalid UTF-8 is a deterministic read failure without permission assumptions.
    fs::write(repository.path().join("unreadable.go"), [0xff, 0xfe]).unwrap();
    for modern in [false, true] {
        for budget in [2_000, 24_000] {
            for text in explore_twice(repository.path(), budget, modern) {
                assert!(text.contains("Freshness: partial"));
                assert!(text.contains("Index omissions: 2 files | too_large=1 | unreadable=1 | parse_failed=0 | extract_failed=0"));
            }
        }
    }
}

#[test]
fn default_explore_does_not_report_unchanged_files_as_omissions() {
    let repository = tempdir().unwrap();
    fs::write(repository.path().join("fixture.go"), SOURCE).unwrap();
    for modern in [false, true] {
        for text in explore_twice(repository.path(), 2_000, modern) {
            assert!(text.contains("Freshness: fresh"));
            assert!(!text.contains("Index omissions:"));
            assert!(!text.contains("Freshness: partial"));
        }
    }
}
