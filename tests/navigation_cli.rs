use serde_json::Value;
use std::{
    fs,
    process::{Command, Output},
};
use tempfile::{tempdir, TempDir};

struct Fixture {
    root: TempDir,
    state: TempDir,
}
impl Fixture {
    fn new() -> Self {
        let root = tempdir().unwrap();
        for (file, source) in [
            (
                "lib.rs",
                "pub fn helper() {}\npub fn entry() { helper(); }\n",
            ),
            ("other.rs", "pub fn duplicate() {}\n"),
            ("again.rs", "pub fn duplicate() {}\n"),
            ("README.md", "# Navigation\n\n## helper contract\n"),
        ] {
            fs::write(root.path().join(file), source).unwrap();
        }
        Self {
            root,
            state: tempdir().unwrap(),
        }
    }
    fn run(&self, args: &[&str], json: bool) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_codefacts"));
        command.args(args).args([
            "--root",
            self.root.path().to_str().unwrap(),
            "--state",
            self.state.path().join("index.sqlite").to_str().unwrap(),
            "--lsp",
            "off",
        ]);
        if json {
            command.args(["--format", "full"]);
        }
        command.output().unwrap()
    }
    fn json(&self, args: &[&str]) -> Value {
        let output = self.run(args, true);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
}

#[test]
fn symbol_aliases_preserve_source_and_relationship_direction() {
    let fixture = Fixture::new();
    let node = fixture.json(&["node", "helper"]);
    assert_eq!(node["definition"]["evidence"]["file_path"], "lib.rs");
    assert_eq!(node["definition"]["evidence"]["start_line"], 1);
    assert_eq!(node["callers"][0]["from"]["name"], "entry");
    assert_eq!(node["callers"][0]["to"]["name"], "helper");
    let callers = fixture.json(&["callers", "helper"]);
    let callees = fixture.json(&["callees", "entry"]);
    assert_eq!(callers["section"], "callers");
    assert_eq!(callers["callers"][0]["from"]["name"], "entry");
    assert_eq!(callees["callees"][0]["to"]["name"], "helper");
    let ambiguous = fixture.json(&["node", "duplicate"]);
    assert_eq!(ambiguous["status"], "ambiguous");
    assert_eq!(ambiguous["matches"].as_array().unwrap().len(), 2);
    assert_eq!(
        fixture.json(&["node", "duplicate", "--file", "other.rs"])["definition"]["evidence"]
            ["file_path"],
        "other.rs"
    );
    assert_eq!(fixture.json(&["node", "absent"])["status"], "not_found");
}

#[test]
fn impact_path_and_edit_use_the_current_static_graph() {
    let fixture = Fixture::new();
    let map = fixture.json(&["map"]);
    let search = fixture.json(&["search", "helper", "--detail", "context"]);
    assert_eq!(
        map["freshness"]["generation"],
        search["freshness"]["generation"]
    );
    assert!(search["results"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["kind"] == "heading"));
    assert_eq!(
        fixture.json(&["outline", "lib.rs"])["symbols"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let impact = fixture.json(&["impact", "helper"]);
    assert_eq!(impact["affected"][0]["symbol"]["name"], "entry");
    assert_eq!(impact["affected"][0]["distance"], 1);
    assert_eq!(impact["affected"][0]["witness_direction"], "reverse");
    assert_eq!(impact["traversal"]["exhausted"], true);
    assert_eq!(fixture.json(&["path", "entry", "helper"])["status"], "ok");
    fs::write(
        fixture.root.path().join("lib.rs"),
        "pub fn helper() {}\npub fn changed() { helper(); }\n",
    )
    .unwrap();
    let changed = fixture.json(&["impact", "helper"]);
    assert!(
        changed["freshness"]["generation"].as_i64().unwrap()
            > map["freshness"]["generation"].as_i64().unwrap()
    );
    assert_eq!(changed["affected"][0]["symbol"]["name"], "changed");
}

#[test]
fn exploration_range_and_default_cwd_return_verified_source() {
    let fixture = Fixture::new();
    let hash = fixture.json(&["node", "helper"])["definition"]["evidence"]["source_hash"]
        .as_str()
        .unwrap()
        .to_owned();
    let output = fixture.run(
        &[
            "explore",
            "--file",
            "lib.rs",
            "--start-line",
            "1",
            "--end-line",
            "1",
        ],
        false,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("pub fn helper() {}"));
    assert!(!text.contains("pub fn entry()"));
    assert!(!text.contains(&hash), "{text}");
    assert!(text.len() <= 24_001);
    let output = Command::new(env!("CARGO_BIN_EXE_codefacts"))
        .current_dir(fixture.root.path())
        .args([
            "node",
            "helper",
            "--lsp",
            "off",
            "--state",
            fixture.state.path().join("cwd.sqlite").to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("pub fn helper() {}"));
    assert!(text.contains("repository_root"));
    assert!(!fixture.root.path().join(".codefacts").exists());
}

#[test]
fn invalid_options_and_mcp_root_constraints_fail_explicitly() {
    let fixture = Fixture::new();
    for args in [
        &["impact", "helper", "--max-depth", "0"][..],
        &["impact", "helper", "--max-depth", "11"],
        &["node", "helper", "--max-depth", "2"],
        &["explore", "--end-line", "3"],
        &["search"],
        &["map", "surplus"],
        &["map", "--tools", "all"],
    ] {
        let output = fixture.run(args, false);
        assert_eq!(
            output.status.code(),
            Some(2),
            "args={args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stdout.is_empty());
    }
    let output = Command::new(env!("CARGO_BIN_EXE_codefacts"))
        .args(["mcp", "--state", "outside.sqlite"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("--state requires --root"));
}

#[test]
fn default_alias_text_keeps_call_direction_and_locations_without_generated_hashes() {
    let fixture = Fixture::new();
    let hash = fixture.json(&["node", "helper"])["definition"]["evidence"]["source_hash"]
        .as_str()
        .unwrap()
        .to_owned();
    for (args, section, counterpart) in [
        (&["node", "helper"][..], "callers", "entry"),
        (&["callers", "helper"][..], "callers", "entry"),
        (&["callees", "entry"][..], "callees", "helper"),
    ] {
        let output = fixture.run(args, false);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let text = String::from_utf8(output.stdout).unwrap();
        for fact in [section, counterpart, "lib.rs:2", "static"] {
            assert!(text.contains(fact), "missing {fact}: {text}");
        }
        assert!(!text.contains(&hash), "{text}");
        assert!(!text.contains("source_hash"), "{text}");
        assert!(!text.contains("format:"), "{text}");
    }
}
