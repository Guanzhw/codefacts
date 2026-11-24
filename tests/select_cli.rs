use std::fs;
use std::path::Path;
use std::process::{Command, Output};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::tempdir;

fn select(root: &Path, symptom: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_codefacts"));
    command
        .current_dir(root)
        .env("CODEFACTS_STATE_DIR", root.join("unexpected-state"))
        .args(["select", "--query", " dispatch ", "--symptom", symptom]);
    command
}

fn stdout(output: Output) -> Vec<u8> {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn comparable(mut trace: Value) -> Value {
    trace.as_object_mut().unwrap().remove("elapsed_seconds");
    trace["routing"]
        .as_object_mut()
        .unwrap()
        .remove("elapsed_seconds");
    trace
}

#[test]
fn select_defaults_to_baseline_and_caps_utf8_evidence_at_two_reads() {
    let root = tempdir().unwrap();
    let padding = format!("    # {}\n", "é".repeat(36)).repeat(40);
    for number in 0..5 {
        let file = if number == 0 {
            "entry.py".to_owned()
        } else {
            format!("test_entry{number}.py")
        };
        let source = format!("def dispatch(value):\n{padding}    return value + {number}\n");
        fs::write(root.path().join(file), source).unwrap();
    }
    let symptom = format!("dispatch changes a café value. {}", "é".repeat(850));

    let baseline: Value = serde_json::from_slice(&stdout(
        select(root.path(), &symptom)
            .args(["--policy", "baseline", "--format", "json", "--root"])
            .arg(root.path())
            .output()
            .unwrap(),
    ))
    .unwrap();
    let default: Value = serde_json::from_slice(&stdout(
        select(root.path(), &symptom)
            .args(["--format", "json"])
            .output()
            .unwrap(),
    ))
    .unwrap();
    assert_eq!(default["query"], "dispatch");
    assert_eq!(
        stdout(select(root.path(), &symptom).output().unwrap()),
        default["evidence"].as_str().unwrap().as_bytes()
    );
    assert_eq!(comparable(default), comparable(baseline));

    let candidate: Value = serde_json::from_slice(&stdout(
        select(root.path(), &symptom)
            .args(["--policy", "candidate", "--format", "json"])
            .output()
            .unwrap(),
    ))
    .unwrap();
    assert_eq!(candidate["routing"]["gate"], "top-wide");
    assert_eq!(candidate["routing"]["branch"], "then");
    let evidence = candidate["evidence"].as_str().unwrap();
    assert_eq!(candidate["bytes"], 4_200);
    assert_eq!(evidence.len(), 4_200);
    assert!(evidence.chars().count() < evidence.len());
    assert_eq!(
        candidate["stream_sha256"],
        hex::encode(Sha256::digest(evidence.as_bytes()))
    );
    let pages = candidate["pages"].as_array().unwrap();
    assert_eq!(pages.len(), 2);
    assert!(pages[0]
        .as_str()
        .unwrap()
        .starts_with("[1] entry.py:21-42\n"));
    assert!(pages[1]
        .as_str()
        .unwrap()
        .starts_with("[2] test_entry1.py:1-42\n"));
    for page in pages {
        assert!(evidence.contains(page.as_str().unwrap()));
    }
    let steps = candidate["steps"].as_array().unwrap();
    assert_eq!(
        steps
            .iter()
            .filter(|step| step["action"] == "read" && step["accepted"] == true)
            .count(),
        2
    );
    assert!(!root.path().join(".codefacts").exists());
    assert!(!root.path().join("unexpected-state").exists());
}
