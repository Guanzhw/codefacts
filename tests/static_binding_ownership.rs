use std::{collections::HashMap, fs};

use codefacts::{
    indexer::{extractor::Extractor, parser::CodeParser},
    lsp::LspMode,
    service::{CodeFacts, ExploreOptions, ImpactOptions},
    types::{CodeEdge, CodeNode, EdgeKind, Language},
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::tempdir;

fn extract(source: &str, language: Language) -> (Vec<CodeNode>, Vec<CodeEdge>) {
    let tree = CodeParser::new().parse(source, language).unwrap();
    assert!(
        !tree.root_node().has_error(),
        "{}",
        tree.root_node().to_sexp()
    );
    let nodes = Extractor::extract_nodes(&tree, "fixture", language, source).unwrap();
    let mut index: HashMap<String, Vec<&CodeNode>> = HashMap::new();
    for node in &nodes {
        index.entry(node.name.clone()).or_default().push(node);
    }
    let edges =
        Extractor::extract_edges(&tree, "fixture", language, source, &nodes, &index).unwrap();
    (nodes, edges)
}

fn impact(facts: &CodeFacts, symbol: &str) -> Value {
    facts
        .impact(ImpactOptions {
            symbol,
            file_path: None,
            max_depth: None,
            limit: Some(50),
        })
        .unwrap()
}

#[test]
fn go_selector_calls_preserve_receivers_at_the_capture_boundary() {
    let source = "package fixture\nfunc Caller(other Unknown) { other.Run(); factory().Run() }\n";
    let (_, edges) = extract(source, Language::Go);
    let calls = edges
        .iter()
        .filter(|edge| edge.kind == EdgeKind::Calls && edge.target_name.as_deref() == Some("Run"))
        .collect::<Vec<_>>();
    assert_eq!(calls.len(), 2);
    for (edge, receiver) in calls.into_iter().zip(["other", "factory()"]) {
        let metadata = edge.metadata.as_ref().unwrap();
        assert_eq!(metadata["object"], receiver);
        assert_eq!(metadata["call_form"], "member");
    }
}

#[test]
fn go_receiver_candidates_never_become_confirmed_static_paths_or_impact() {
    for second_receiver in [false, true] {
        let source = format!("package fixture\ntype Known struct{{}}\nfunc (k Known) Run() {{}}\n{}type Unknown interface {{ Run() }}\nfunc Caller(other Unknown, known Known) {{\n  other.Run()\n  known.Run()\n  leaf()\n}}\nfunc leaf() {{}}\n", if second_receiver { "type Another struct{}\nfunc (a Another) Run() {}\n" } else { "" });
        let repository = tempdir().unwrap();
        let state = tempdir().unwrap();
        fs::write(repository.path().join("fixture.go"), &source).unwrap();
        let facts = CodeFacts::open_with_lsp(
            repository.path(),
            state.path().join("facts.sqlite"),
            LspMode::Off,
        )
        .unwrap();
        let outline = facts.outline("fixture.go", Some(50)).unwrap();
        let methods = outline["symbols"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|symbol| symbol["name"] == "Run")
            .collect::<Vec<_>>();
        assert_eq!(methods.len(), if second_receiver { 2 } else { 1 });
        if second_receiver {
            assert_eq!(
                facts.expand("Run", Some("fixture.go"), Some(50)).unwrap()["status"],
                "ambiguous"
            );
            assert_eq!(impact(&facts, "Run")["status"], "ambiguous");
        }
        let expected_hash = hex::encode(Sha256::digest(source.as_bytes()));
        for method in methods {
            let id = method["id"].as_str().unwrap();
            let expanded = facts.expand(id, None, Some(50)).unwrap();
            let callers = expanded["callers"].as_array().unwrap();
            assert_eq!(
                callers.len(),
                2,
                "both receiver sites retain candidate evidence"
            );
            for caller in callers {
                assert_eq!(caller["from"]["name"], "Caller");
                assert_eq!(caller["to"]["id"], id);
                assert_eq!(caller["evidence"]["confidence"], "heuristic");
                assert_eq!(caller["evidence"]["source_hash"], expected_hash);
                assert_eq!(
                    caller["resolution"],
                    if second_receiver {
                        "polymorphic"
                    } else {
                        "unresolved_receiver"
                    }
                );
            }
            assert_eq!(
                facts.path("Caller", id, Some(50)).unwrap()["status"],
                "no_static_path"
            );
            assert!(impact(&facts, id)["affected"]
                .as_array()
                .unwrap()
                .is_empty());
        }
        let caller = facts.expand("Caller", None, Some(50)).unwrap();
        let callees = caller["callees"].as_array().unwrap();
        assert_eq!(
            callees
                .iter()
                .filter(|edge| edge["to"]["name"] == "Run")
                .count(),
            if second_receiver { 4 } else { 2 }
        );
        assert!(callees
            .iter()
            .filter(|edge| edge["to"]["name"] == "Run")
            .all(|edge| edge["evidence"]["confidence"] == "heuristic"));
        assert_eq!(
            facts.path("Caller", "leaf", Some(50)).unwrap()["status"],
            "ok"
        );
        assert!(impact(&facts, "leaf")["affected"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["symbol"]["name"] == "Caller"
                && entry["witness"]["evidence"]["confidence"] == "static"));
        let exploration = facts
            .explore(ExploreOptions {
                query: Some("Caller"),
                ..Default::default()
            })
            .unwrap();
        assert!(exploration.contains("receiver unresolved"), "{exploration}");
        let caller_line = caller["definition"]["evidence"]["start_line"]
            .as_u64()
            .unwrap();
        for call_line in [caller_line + 1, caller_line + 2] {
            assert!(
                !exploration.contains(&format!("direct static callee at fixture.go:{call_line}")),
                "{exploration}"
            );
        }
    }
}

#[test]
fn implements_edges_follow_the_actual_class_ast_with_same_line_unicode_and_nesting() {
    for (language, source) in [
        (Language::TypeScript, "interface Contract { run(): void; }\nclass Unrelated {} class Derived implements Contract { run() {} }\n"),
        (Language::Tsx, "interface Contract { run(): void; }\n/* 中文 */ class Unrelated {} class Derived implements Contract { run() {} }\n"),
        (Language::TypeScript, "interface Contract { run(): void; }\nclass Outer { make() { class Unrelated {} class Derived implements Contract { run() {} } } }\n"),
        (Language::Java, "interface Contract { void run(); }\n/* 中文 */ class Unrelated {} class Derived implements Contract { public void run() {} }\n"),
        (Language::Php, "<?php\ninterface Contract { public function run(); }\n/* 中文 */ class Unrelated {} class Derived implements Contract { public function run() {} }\n"),
    ] {
        let (nodes, edges) = extract(source, language);
        let derived = nodes.iter().find(|node| node.name == "Derived").unwrap();
        let contract = nodes.iter().find(|node| node.name == "Contract").unwrap();
        let implemented = edges.iter().filter(|edge| edge.kind == EdgeKind::Implements).collect::<Vec<_>>();
        assert_eq!(implemented.len(), 1, "{language:?}");
        assert_eq!(implemented[0].source, derived.id);
        assert_eq!(implemented[0].target, contract.id);
        let start = source.find("class Derived").unwrap();
        assert_eq!(derived.start_column as usize, source[..start].rsplit('\n').next().unwrap().len());
    }
}

#[test]
fn implements_impact_uses_derived_witness_and_never_unrelated() {
    let source = "interface Contract { run(): void; }\n/* 中文 */ class Unrelated {} class Derived implements Contract { run() {} }\n";
    let repository = tempdir().unwrap();
    let state = tempdir().unwrap();
    fs::write(repository.path().join("fixture.ts"), source).unwrap();
    let facts = CodeFacts::open_with_lsp(
        repository.path(),
        state.path().join("facts.sqlite"),
        LspMode::Off,
    )
    .unwrap();
    let result = impact(&facts, "Contract");
    let affected = result["affected"].as_array().unwrap();
    assert!(!affected
        .iter()
        .any(|entry| entry["symbol"]["name"] == "Unrelated"));
    let derived = affected
        .iter()
        .find(|entry| entry["symbol"]["name"] == "Derived")
        .unwrap();
    assert_eq!(derived["distance"], 1);
    assert_eq!(derived["witness"]["kind"], "implements");
    assert_eq!(derived["witness"]["from"]["name"], "Derived");
    assert_eq!(derived["witness"]["to"]["name"], "Contract");
    assert_eq!(derived["witness"]["evidence"]["confidence"], "static");
    assert_eq!(
        derived["witness"]["evidence"]["source_hash"],
        hex::encode(Sha256::digest(source.as_bytes()))
    );
}

#[test]
fn extends_owners_use_ast_identity_for_both_capture_styles() {
    for (language, file, source) in [
        (Language::Java, "Fixture.java", "class Base {}\nclass Unrelated {} class Derived extends Base {}\n"),
        (Language::Java, "Fixture.java", "interface Base {}\n/* 中文 */ interface Unrelated {} interface Derived extends Base {}\n"),
        (Language::TypeScript, "fixture.ts", "class Base {}\n/* 中文 */ class Derived {} class Outer { make() { class Derived extends Base {} } }\n"),
        (Language::Tsx, "fixture.tsx", "class Base {}\n/* 中文 */ class Derived {} class Outer { make() { class Derived extends Base {} } }\n"),
        (Language::TypeScript, "fixture.ts", "interface Base {}\n/* 中文 */ interface Derived {} interface Derived extends Base {}\n"),
        (Language::JavaScript, "fixture.js", "class Base {}\n/* 中文 */ class Derived {} class Outer { make() { class Derived extends Base {} } }\n"),
        (Language::Php, "fixture.php", "<?php\nclass Base {}\n/* 中文 */ class Unrelated {} class Derived extends Base {}\n"),
    ] {
        let (nodes, edges) = extract(source, language);
        let derived = nodes.iter().find(|node| node.name == "Derived" && node.body.as_ref().unwrap().contains("extends Base")).unwrap();
        let base = nodes.iter().find(|node| node.name == "Base").unwrap();
        let inheritance = edges.iter().filter(|edge| edge.kind == EdgeKind::Extends).collect::<Vec<_>>();
        assert_eq!(inheritance.len(), 1, "{language:?}");
        assert_eq!(inheritance[0].source, derived.id, "{language:?}");
        assert_eq!(inheritance[0].target, base.id, "{language:?}");

        let repository = tempdir().unwrap();
        let state = tempdir().unwrap();
        fs::write(repository.path().join(file), source).unwrap();
        let facts = CodeFacts::open_with_lsp(repository.path(), state.path().join("facts.sqlite"), LspMode::Off).unwrap();
        let expected_id = derived.id.replace(":fixture:", &format!(":{file}:"));
        let result = impact(&facts, "Base");
        let affected = result["affected"].as_array().unwrap();
        let owner = affected.iter().find(|entry| entry["witness"]["kind"] == "extends").unwrap();
        assert_eq!(owner["symbol"]["id"], expected_id, "{language:?}: {result}");
        assert_eq!(owner["witness"]["from"]["id"], expected_id);
        assert_eq!(owner["witness"]["to"]["name"], "Base");
        assert_eq!(owner["witness"]["evidence"]["confidence"], "static");
        assert_eq!(owner["witness"]["evidence"]["source_hash"], hex::encode(Sha256::digest(source.as_bytes())));
        assert!(!affected.iter().any(|entry| entry["symbol"]["name"] == "Unrelated"));
    }
}
