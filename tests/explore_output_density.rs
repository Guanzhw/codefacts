use codefacts::lsp::LspMode;
use codefacts::service::CodeFacts;
use codefacts::{ExploreOptions, ExploreRead};
use std::fs;
use tempfile::{tempdir, TempDir};

fn fixture(source: &str) -> (TempDir, TempDir, CodeFacts) {
    let root = tempdir().unwrap();
    let state = tempdir().unwrap();
    fs::write(root.path().join("entry.rs"), source).unwrap();
    let facts =
        CodeFacts::open_with_lsp(root.path(), state.path().join("facts.sqlite"), LspMode::Off)
            .unwrap();
    (root, state, facts)
}

#[test]
fn five_small_owners_are_complete_at_every_supported_budget() {
    let source = (0..5)
        .map(|index| {
            format!("pub fn needle_{index}() {{\n    let value = {index};\n    println!(\"{{value}}\");\n}}\n")
        })
        .collect::<String>();
    let (_root, _state, facts) = fixture(&source);
    for budget in [2000, 24_000, 32_000] {
        let response = facts
            .explore(ExploreOptions {
                query: Some("needle"),
                max_bytes: Some(budget),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            response.matches("[complete] implementation").count(),
            5,
            "{response}"
        );
        for (index, line) in source.lines().enumerate() {
            assert!(
                response.contains(&format!("{}: {line}\n", index + 1)),
                "{response}"
            );
        }
        for index in 0..5 {
            assert_eq!(
                response
                    .matches(&format!("entry.rs:{}-{}", index * 4 + 1, index * 4 + 4))
                    .count(),
                1
            );
        }
        assert!(!response.contains("SHA256:"));
        assert!(response.len() <= budget);
    }
}

#[test]
fn partial_read_has_one_requested_range_and_a_working_continuation() {
    let source = (1..=200)
        .map(|index| format!("// line {index}: 中文 {}\n", "evidence ".repeat(10)))
        .collect::<String>();
    let (_root, _state, facts) = fixture(&source);
    let response = facts
        .explore(ExploreOptions {
            reads: Some(&[ExploreRead {
                file_path: "entry.rs".into(),
                start_line: Some(10),
                end_line: Some(200),
            }]),
            max_bytes: Some(2000),
            ..Default::default()
        })
        .unwrap();
    assert!(response.contains("partial source; requested range 10-200"));
    assert!(!response.contains("Not fully returned"));
    assert!(!response.contains("SHA256:"));
    let next = response
        .split("start_line=")
        .nth(1)
        .unwrap()
        .split(')')
        .next()
        .unwrap()
        .parse::<u32>()
        .unwrap();
    let follow = facts
        .explore(ExploreOptions {
            reads: Some(&[ExploreRead {
                file_path: "entry.rs".into(),
                start_line: Some(next),
                end_line: Some(next),
            }]),
            max_bytes: Some(2000),
            ..Default::default()
        })
        .unwrap();
    assert!(follow.contains(&format!(
        "{next}: {}\n",
        source.lines().nth(next as usize - 1).unwrap()
    )));
    assert!(response.len() <= 2000);
    assert!(follow.len() <= 2000);
}

#[test]
fn source_text_that_resembles_removed_metadata_is_preserved_after_refresh() {
    let original = "pub fn needle() {\n    // SHA256: source-owned hash\n    // [preview; full owner range entry.rs:1-4]\n}\n";
    let (root, _state, facts) = fixture(original);
    let before = facts
        .explore(ExploreOptions {
            query: Some("needle"),
            ..Default::default()
        })
        .unwrap();
    let updated = original.replace("source-owned hash", "updated source-owned hash");
    fs::write(root.path().join("entry.rs"), &updated).unwrap();
    let after = facts
        .explore(ExploreOptions {
            query: Some("needle"),
            ..Default::default()
        })
        .unwrap();
    let read = facts
        .explore(ExploreOptions {
            file_path: Some("entry.rs"),
            ..Default::default()
        })
        .unwrap();
    assert!(before.contains("2:     // SHA256: source-owned hash\n"));
    for response in [after, read] {
        assert!(response.contains("2:     // SHA256: updated source-owned hash\n"));
        assert!(response.contains("3:     // [preview; full owner range entry.rs:1-4]\n"));
        assert!(response.contains("Freshness: fresh"));
    }
}

#[test]
fn single_line_owners_fit_as_attributed_column_previews() {
    for (file, preamble, definition) in [
        ("entry.rs", "", "pub fn needle() {}"),
        ("entry.go", "package fixture\r\n", "func Needle() {}"),
        ("entry.js", "", "function needle() { return '中文'; }"),
        (
            "entry.ts",
            "",
            "function needle(): string { return '中文'; }",
        ),
    ] {
        let root = tempdir().unwrap();
        let state = tempdir().unwrap();
        let prefix = format!("/*{}*/ ", "中文".repeat(900));
        // TypeScript's parser can include a trailing comment in its definition
        // span; a distinct next declaration gives this owner a short AST range.
        let suffix = if file.ends_with(".ts") {
            format!("; const trailing = '{}';", "tail".repeat(900))
        } else {
            format!(" /*{}*/", "tail".repeat(900))
        };
        let source = format!("{preamble}{prefix}{definition}{suffix}\r\n");
        fs::write(root.path().join(file), &source).unwrap();
        let facts =
            CodeFacts::open_with_lsp(root.path(), state.path().join("facts.sqlite"), LspMode::Off)
                .unwrap();
        let line = if preamble.is_empty() { 1 } else { 2 };
        let response = facts
            .explore(ExploreOptions {
                query: Some("needle"),
                max_bytes: Some(2000),
                ..Default::default()
            })
            .unwrap();
        assert!(response.contains("[preview] implementation"), "{response}");
        assert!(response.contains(definition), "{response}");
        assert!(
            response.contains(&format!(
                "{line}:{}..{} ",
                prefix.len(),
                prefix.len() + definition.len()
            )),
            "{response}"
        );
        assert!(response.contains("UTF-8 byte columns, 0-based, end-exclusive"));
        assert!(response.contains("surrounding line context omitted"));
        assert!(!response.lines().any(|line| line.starts_with("[complete]")));
        assert!(!response.contains("tailtail"));
        assert!(response.len() <= 2000);

        let read = facts
            .explore(ExploreOptions {
                reads: Some(&[ExploreRead {
                    file_path: file.into(),
                    start_line: Some(line),
                    end_line: Some(line),
                }]),
                max_bytes: Some(2000),
                ..Default::default()
            })
            .unwrap();
        assert!(read.contains("line does not fit"), "{read}");
        assert!(!read.contains("column fragment"));
        assert!(!read.contains(definition));

        let large = facts
            .explore(ExploreOptions {
                query: Some("needle"),
                max_bytes: Some(24_000),
                ..Default::default()
            })
            .unwrap();
        assert!(large.contains("[complete] implementation"), "{large}");
        assert!(large.contains(&format!("{line}: {prefix}{definition}{suffix}\n")));
        assert!(!large.contains("column fragment"));
    }
}

#[test]
fn oversized_single_line_owner_is_not_shortened_to_force_a_preview() {
    let source = format!(
        "/*{}*/ pub fn needle() {{ let value = \"{}\"; }}\n",
        "prefix".repeat(900),
        "x".repeat(3000)
    );
    let (_root, _state, facts) = fixture(&source);
    let response = facts
        .explore(ExploreOptions {
            query: Some("needle"),
            max_bytes: Some(2000),
            ..Default::default()
        })
        .unwrap();
    assert!(response.contains("[source omitted] implementation"));
    assert!(!response.contains("column fragment"));
    assert!(!response.contains("pub fn needle()"));
    assert!(response.len() <= 2000);
}
