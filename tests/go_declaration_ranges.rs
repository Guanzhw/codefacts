use std::fs;

use codefacts::indexer::{extractor::Extractor, parser::CodeParser};
use codefacts::service::{CodeFacts, SymbolScope};
use codefacts::types::Language;
use codefacts::types::NodeKind;
use tempfile::tempdir;

const SOURCE: &str = "package store\n\ntype Store struct{}\n\nvar (\n\tglobalAlpha = 1\n\tglobalBeta = 2\n\tpairLeft, pairRight = 3, 4\n\tmultiline = map[string]int{\n\t\t\"x\": 1,\n\t}\n)\n\nconst (\n\tfeatureEnabled = true\n\tretryCount = 3\n)\n\nvar singleLine = \"ready\"\n\nfunc (s *Store) Lookup(key string) int {\n\tlocal := 1\n\treturn helper(key) + local\n}\n\nfunc helper(key string) int {\n\treturn len(key)\n}\n";

fn outline_symbol<'a>(outline: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
    let matches = outline["symbols"]
        .as_array()
        .expect("outline symbols")
        .iter()
        .filter(|symbol| symbol["name"] == name)
        .collect::<Vec<_>>();
    assert_eq!(
        matches.len(),
        1,
        "{name} should resolve to one outline symbol"
    );
    matches[0]
}

fn assert_definition_source(facts: &CodeFacts, name: &str, expected: &str) {
    let expanded = facts.expand(name, Some("store.go"), Some(20)).unwrap();
    assert_eq!(expanded["status"], "ok", "{name} resolves");
    let source = &expanded["source"];
    assert_eq!(source["status"], "ok", "{name} source is available");
    assert_eq!(
        source["text"], expected,
        "{name} has its own declaration spec"
    );
}

#[test]
fn go_var_and_const_outline_evidence_uses_each_declaration_spec() {
    let repository = tempdir().unwrap();
    fs::write(repository.path().join("store.go"), SOURCE).unwrap();
    let facts = CodeFacts::open(repository.path(), repository.path().join("facts.sqlite")).unwrap();

    let outline = facts
        .outline_with_page_scope_options(
            "store.go",
            Some(NodeKind::Variable),
            SymbolScope::All,
            0,
            None,
            Some(100),
        )
        .unwrap();

    let spec_ranges = [
        ("globalAlpha", "\tglobalAlpha = 1\n", 6),
        ("globalBeta", "\tglobalBeta = 2\n", 7),
        ("pairLeft", "\tpairLeft, pairRight = 3, 4\n", 8),
        ("pairRight", "\tpairLeft, pairRight = 3, 4\n", 8),
        (
            "multiline",
            "\tmultiline = map[string]int{\n\t\t\"x\": 1,\n\t}\n",
            9,
        ),
        ("featureEnabled", "\tfeatureEnabled = true\n", 15),
        ("retryCount", "\tretryCount = 3\n", 16),
        ("singleLine", "var singleLine = \"ready\"\n", 19),
        ("local", "\tlocal := 1\n", 22),
    ];

    for (name, exact_spec, start_line) in spec_ranges {
        let symbol = outline_symbol(&outline, name);
        assert_eq!(symbol["kind"], "variable");
        assert_eq!(symbol["evidence"]["start_line"], start_line);
        let expected_end_line =
            start_line + exact_spec.trim_end_matches('\n').matches('\n').count() as u32;
        assert_eq!(symbol["evidence"]["end_line"], expected_end_line);
        assert_definition_source(&facts, name, exact_spec);
    }

    let lookup = facts.expand("Lookup", Some("store.go"), Some(20)).unwrap();
    assert_eq!(lookup["status"], "ok");
    assert_eq!(lookup["definition"]["kind"], "method");
    assert!(lookup["callees"]
        .as_array()
        .expect("Lookup callees")
        .iter()
        .any(|callee| callee["to"]["name"] == "helper"));
}

#[test]
fn go_grouped_types_have_individual_specs_and_preserve_serialized_kinds() {
    let source = "package fixture\ntype (\n  A struct{}\n  B struct {\n    value int\n  }\n  Reader interface { Read() }\n  Writer interface { Write() }\n  Scalar int\n  Alias = A\n)\n";
    let repository = tempdir().unwrap();
    fs::write(repository.path().join("store.go"), source).unwrap();
    let facts = CodeFacts::open(repository.path(), repository.path().join("facts.sqlite")).unwrap();
    let outline = facts.outline("store.go", Some(50)).unwrap();
    let tree = CodeParser::new().parse(source, Language::Go).unwrap();
    assert!(!tree.root_node().has_error());
    let nodes = Extractor::extract_nodes(&tree, "store.go", Language::Go, source).unwrap();

    for (name, kind, spec, line) in [
        ("A", "class", "A struct{}", 3),
        ("B", "class", "B struct {\n    value int\n  }", 4),
        ("Reader", "interface", "Reader interface { Read() }", 7),
        ("Writer", "interface", "Writer interface { Write() }", 8),
        ("Scalar", "type_alias", "Scalar int", 9),
        ("Alias", "type_alias", "Alias = A", 10),
    ] {
        let symbol = outline_symbol(&outline, name);
        let end_line = line + spec.matches('\n').count() as u32;
        assert_eq!(symbol["kind"], kind);
        assert_eq!(symbol["evidence"]["start_line"], line);
        assert_eq!(symbol["evidence"]["end_line"], end_line);
        let expanded = facts.expand(name, Some("store.go"), Some(20)).unwrap();
        let expected = format!("  {spec}\n");
        assert_eq!(expanded["source"]["text"], expected);
        assert_eq!(expanded["source"]["byte_length"], expected.len());
        assert_eq!(expanded["definition"]["evidence"], symbol["evidence"]);

        let node = nodes.iter().find(|node| node.name == name).unwrap();
        assert_eq!(node.body.as_deref(), Some(spec));
        assert_eq!(node.start_line, line);
        assert_eq!(node.end_line, end_line);
        assert_eq!(node.start_column, 2);
        let end_column =
            spec.rsplit('\n').next().unwrap().len() + if spec.contains('\n') { 0 } else { 2 };
        assert_eq!(node.end_column as usize, end_column);
    }
}
