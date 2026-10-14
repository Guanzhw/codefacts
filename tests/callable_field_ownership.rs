use std::{collections::HashMap, fs};

use codefacts::{
    indexer::{extractor::Extractor, parser::CodeParser},
    service::CodeFacts,
    types::{CodeEdge, CodeNode, EdgeKind, Language, NodeKind},
};
use rusqlite::Connection;
use tempfile::tempdir;

fn extract(source: &str, language: Language) -> (Vec<CodeNode>, Vec<CodeEdge>) {
    let tree = CodeParser::new().parse(source, language).unwrap();
    assert!(
        !tree.root_node().has_error(),
        "{}",
        tree.root_node().to_sexp()
    );
    let nodes = Extractor::extract_nodes(&tree, "fixture", language, source).unwrap();
    let mut index: HashMap<String, Vec<CodeNode>> = HashMap::new();
    for node in &nodes {
        index
            .entry(node.name.clone())
            .or_default()
            .push(node.clone());
    }
    let edges =
        Extractor::extract_edges(&tree, "fixture", language, source, &nodes, &index).unwrap();
    (nodes, edges)
}

fn assert_owner(
    source: &str,
    nodes: &[CodeNode],
    name: &str,
    qualified: &str,
    expected: &str,
) -> String {
    let node = nodes
        .iter()
        .find(|node| node.qualified_name.as_deref() == Some(qualified))
        .unwrap();
    assert_eq!(node.name, name);
    assert_eq!(node.kind, NodeKind::Method);
    assert_eq!(node.body.as_deref(), Some(expected));
    let start = source.find(expected).unwrap();
    let end = start + expected.len();
    assert_eq!(
        node.start_line,
        source[..start].bytes().filter(|b| *b == b'\n').count() as u32 + 1
    );
    assert_eq!(
        node.end_line,
        source[..end].bytes().filter(|b| *b == b'\n').count() as u32 + 1
    );
    assert_eq!(
        node.start_column as usize,
        source[..start].rsplit('\n').next().unwrap().len()
    );
    assert_eq!(
        node.end_column as usize,
        source[..end].rsplit('\n').next().unwrap().len()
    );
    node.id.clone()
}

#[test]
fn typed_wrapped_callable_fields_own_calls_in_ts_and_tsx() {
    let source = "function leaf() {}\nclass Proxy {\n  middleware: Handler = ((async () => {\n    leaf();\n    this.prepare();\n  }) as Handler);\n  prepare = function internal() {\n    leaf();\n  };\n  #secret = () => {\n    leaf();\n  };\n  number = 1;\n  factory = wrap(() => leaf());\n  conditional = true ? () => leaf() : null;\n}\n";
    for language in [Language::TypeScript, Language::Tsx] {
        let (nodes, edges) = extract(source, language);
        let fields = [
            ("middleware", "middleware: Handler = ((async () => {\n    leaf();\n    this.prepare();\n  }) as Handler)"),
            ("prepare", "prepare = function internal() {\n    leaf();\n  }"),
            ("#secret", "#secret = () => {\n    leaf();\n  }"),
        ];
        for (name, body) in fields {
            let id = assert_owner(source, &nodes, name, &format!("Proxy.{name}"), body);
            assert!(edges
                .iter()
                .any(|edge| edge.kind == EdgeKind::Contains && edge.target == id));
            assert!(edges.iter().any(|edge| edge.kind == EdgeKind::Calls
                && edge.source == id
                && edge.target_name.as_deref() == Some("leaf")));
        }
        for negative in ["number", "factory", "conditional"] {
            assert!(!nodes.iter().any(|node| node.name == negative));
        }
        let receiver = edges
            .iter()
            .find(|edge| edge.target_name.as_deref() == Some("prepare"))
            .unwrap();
        assert_eq!(
            receiver
                .metadata
                .as_ref()
                .unwrap()
                .get("call_form")
                .map(String::as_str),
            Some("member")
        );
    }
}

#[test]
fn javascript_fields_and_static_assignments_preserve_external_names() {
    let source = "function leaf() {}\nfunction Router() {}\nfunction Other() {}\nclass Proxy {\n  run = (async () => {\n    leaf();\n  });\n  state = {};\n}\nRouter.prototype.on = function internal() {\n  leaf();\n  queue(() => { leaf(); });\n};\nOther.prototype.on = (() => {\n  leaf();\n});\nobject.handle = function () {\n  leaf();\n};\nobject.value = 1;\nobject.factory = wrap(() => leaf());\nobject[key] = () => leaf();\ngetObject().handle = () => leaf();\nobject.changed += () => leaf();\n";
    for language in [Language::JavaScript, Language::Jsx] {
        let (nodes, edges) = extract(source, language);
        for (name, qualified, body) in [
            ("run", "Proxy.run", "run = (async () => {\n    leaf();\n  })"),
            ("on", "Router.prototype.on", "Router.prototype.on = function internal() {\n  leaf();\n  queue(() => { leaf(); });\n}"),
            ("on", "Other.prototype.on", "Other.prototype.on = (() => {\n  leaf();\n})"),
            ("handle", "object.handle", "object.handle = function () {\n  leaf();\n}"),
        ] {
            let id = assert_owner(source, &nodes, name, qualified, body);
            assert!(edges.iter().any(|edge| edge.kind == EdgeKind::Calls && edge.source == id && edge.target_name.as_deref() == Some("leaf")));
        }
        assert_eq!(
            nodes
                .iter()
                .filter(|node| node.kind == NodeKind::Method)
                .count(),
            4
        );
        assert!(!nodes.iter().any(|node| node.name == "internal"));
    }
}

#[test]
fn one_line_callable_fields_use_columns_to_own_their_calls() {
    for language in [Language::TypeScript, Language::JavaScript] {
        let source = "function first() {} function second() {} class C { a = () => first(); b = () => second(); } class D { c = () => second(); }";
        let (nodes, edges) = extract(source, language);
        for (owner, callee) in [("a", "first"), ("b", "second")] {
            let id = &nodes
                .iter()
                .find(|node| node.qualified_name.as_deref() == Some(&format!("C.{owner}")))
                .unwrap()
                .id;
            assert!(edges.iter().any(|edge| edge.kind == EdgeKind::Calls
                && &edge.source == id
                && edge.target_name.as_deref() == Some(callee)));
            assert!(!edges.iter().any(|edge| edge.kind == EdgeKind::Calls
                && &edge.source == id
                && edge.target_name.as_deref()
                    == Some(if callee == "first" { "second" } else { "first" })));
        }
        let d = nodes
            .iter()
            .find(|node| node.qualified_name.as_deref() == Some("D.c"))
            .unwrap();
        let container = nodes.iter().find(|node| node.name == "D").unwrap();
        assert!(edges.iter().any(|edge| edge.kind == EdgeKind::Contains
            && edge.source == container.id
            && edge.target == d.id));
        assert!(edges.iter().any(|edge| edge.kind == EdgeKind::Calls
            && edge.source == d.id
            && edge.target_name.as_deref() == Some("second")));
    }
}

#[test]
fn same_name_same_line_fields_get_distinct_stable_owner_ids() {
    for language in [
        Language::TypeScript,
        Language::Tsx,
        Language::JavaScript,
        Language::Jsx,
    ] {
        let source = "function first() {}\nfunction second() {}\nclass C { same = () => first(); } class D { same = () => second(); }\n";
        let (nodes, edges) = extract(source, language);
        for (qualified, callee, container) in [("C.same", "first", "C"), ("D.same", "second", "D")]
        {
            let node = nodes
                .iter()
                .find(|node| node.qualified_name.as_deref() == Some(qualified))
                .unwrap();
            assert_eq!(
                node.id,
                format!("method:fixture:same:3:column={}", node.start_column)
            );
            assert!(edges.iter().any(|edge| edge.kind == EdgeKind::Calls
                && edge.source == node.id
                && edge.target_name.as_deref() == Some(callee)));
            assert!(!edges.iter().any(|edge| edge.kind == EdgeKind::Calls
                && edge.source == node.id
                && edge.target_name.as_deref()
                    == Some(if callee == "first" { "second" } else { "first" })));
            let class = nodes.iter().find(|node| node.name == container).unwrap();
            assert!(edges.iter().any(|edge| edge.kind == EdgeKind::Contains
                && edge.source == class.id
                && edge.target == node.id));
        }
        assert_eq!(
            nodes.iter().find(|node| node.name == "first").unwrap().id,
            "function:fixture:first:1"
        );
        let (repeated, _) = extract(source, language);
        assert_eq!(
            nodes.iter().map(|node| &node.id).collect::<Vec<_>>(),
            repeated.iter().map(|node| &node.id).collect::<Vec<_>>()
        );
    }
}

#[test]
fn disambiguated_ids_round_trip_through_persisted_graph_and_exact_tools() {
    let repository = tempdir().unwrap();
    let state = tempdir().unwrap();
    fs::write(repository.path().join("main.ts"), "function first() {}\nfunction second() {}\nclass C { same = () => first(); } class D { same = () => second(); }\n").unwrap();
    let database = state.path().join("facts.sqlite");
    let facts = CodeFacts::open(repository.path(), &database).unwrap();
    let outline = facts.outline("main.ts", Some(100)).unwrap();
    let mut ids = Vec::new();
    for (qualified, callee) in [("C.same", "first"), ("D.same", "second")] {
        let owner = outline["symbols"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["qualified_name"] == qualified)
            .unwrap();
        let id = owner["id"].as_str().unwrap();
        ids.push(id.to_string());
        let expanded = facts.expand(id, Some("main.ts"), Some(100)).unwrap();
        let calls = expanded["callees"].as_array().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["to"]["name"], callee);
    }
    assert_ne!(ids[0], ids[1]);
    drop(facts);
    let reopened = CodeFacts::open(repository.path(), &database).unwrap();
    assert_eq!(
        reopened
            .expand(&ids[1], Some("main.ts"), Some(100))
            .unwrap()["callees"][0]["to"]["name"],
        "second"
    );
    assert_eq!(
        reopened
            .path(&ids[0], "function:main.ts:second:2", Some(100))
            .unwrap()["status"],
        "no_static_path"
    );
}

#[test]
fn version_six_unchanged_source_rebuilds_persisted_byte_columns() {
    let repository = tempdir().unwrap();
    let state = tempdir().unwrap();
    let source = "const 前缀 = 1; class C { run = () => {}; }\n";
    fs::write(repository.path().join("main.ts"), source).unwrap();
    let database = state.path().join("facts.sqlite");
    {
        let facts = CodeFacts::open(repository.path(), &database).unwrap();
        facts.refresh().unwrap();
    }
    let conn = Connection::open(&database).unwrap();
    conn.execute("UPDATE nodes SET start_column = 0, end_column = 0", [])
        .unwrap();
    conn.execute(
        "UPDATE index_metadata SET value = '6' WHERE key = 'fact_extraction_version'",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE index_metadata SET value = '0' WHERE key = 'full_reindex_required'",
        [],
    )
    .unwrap();
    drop(conn);
    let facts = CodeFacts::open(repository.path(), &database).unwrap();
    let outline = facts.outline("main.ts", Some(100)).unwrap();
    assert_eq!(outline["freshness"]["files_indexed"], 1);
    let conn = Connection::open(&database).unwrap();
    let columns: (u32, u32) = conn
        .query_row(
            "SELECT start_column, end_column FROM nodes WHERE name = 'run'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let start = source.find("run =").unwrap();
    assert_eq!(
        columns,
        (start as u32, (start + "run = () => {}".len()) as u32)
    );
    assert_eq!(
        facts.outline("main.ts", Some(100)).unwrap()["freshness"]["files_indexed"],
        0
    );
}

#[test]
fn version_five_unchanged_source_rebuilds_callable_fields_once() {
    let repository = tempdir().unwrap();
    let state = tempdir().unwrap();
    fs::write(repository.path().join("proxy.ts"), "function leaf() {}\nclass Proxy {\n  run = () => {\n    leaf();\n    this.run();\n  };\n}\n").unwrap();
    let database = state.path().join("facts.sqlite");
    {
        let facts = CodeFacts::open(repository.path(), &database).unwrap();
        facts.outline("proxy.ts", Some(100)).unwrap();
    }
    let old = Connection::open(&database).unwrap();
    old.execute("DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE name = 'run') OR target_id IN (SELECT id FROM nodes WHERE name = 'run')", []).unwrap();
    old.execute("DELETE FROM nodes WHERE name = 'run'", [])
        .unwrap();
    old.execute(
        "UPDATE index_metadata SET value = '5' WHERE key = 'fact_extraction_version'",
        [],
    )
    .unwrap();
    old.execute(
        "UPDATE index_metadata SET value = '0' WHERE key = 'full_reindex_required'",
        [],
    )
    .unwrap();
    drop(old);
    let facts = CodeFacts::open(repository.path(), &database).unwrap();
    let rebuilt = facts.expand("run", Some("proxy.ts"), Some(100)).unwrap();
    assert_eq!(rebuilt["freshness"]["files_indexed"], 1);
    let callees = rebuilt["callees"].as_array().unwrap();
    assert!(callees.iter().any(|callee| callee["to"]["name"] == "leaf"));
    let receiver = callees
        .iter()
        .find(|callee| callee["target_name"] == "run" || callee["to"]["name"] == "run")
        .unwrap();
    assert_eq!(receiver["evidence"]["confidence"], "heuristic");
    assert_eq!(receiver["resolution"], "unresolved_receiver");
    let unchanged = facts.outline("proxy.ts", Some(100)).unwrap();
    assert_eq!(unchanged["freshness"]["files_indexed"], 0);
    let conn = Connection::open(&database).unwrap();
    let marker: String = conn
        .query_row(
            "SELECT value FROM index_metadata WHERE key = 'full_reindex_required'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(marker, "0");
}

#[test]
fn incomplete_version_five_rebuild_keeps_required_marker() {
    let repository = tempdir().unwrap();
    let state = tempdir().unwrap();
    fs::write(
        repository.path().join("valid.ts"),
        "class C { run = () => {}; }",
    )
    .unwrap();
    let database = state.path().join("facts.sqlite");
    {
        let facts = CodeFacts::open(repository.path(), &database).unwrap();
        facts.refresh().unwrap();
    }
    let conn = Connection::open(&database).unwrap();
    conn.execute(
        "UPDATE index_metadata SET value = '5' WHERE key = 'fact_extraction_version'",
        [],
    )
    .unwrap();
    drop(conn);
    fs::write(repository.path().join("invalid.ts"), [0xff, 0xfe]).unwrap();
    let facts = CodeFacts::open(repository.path(), &database).unwrap();
    facts.refresh().unwrap();
    let conn = Connection::open(&database).unwrap();
    let marker: String = conn
        .query_row(
            "SELECT value FROM index_metadata WHERE key = 'full_reindex_required'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(marker, "1");
    fs::write(repository.path().join("invalid.ts"), "function valid() {}").unwrap();
    facts.refresh().unwrap();
    let marker: String = conn
        .query_row(
            "SELECT value FROM index_metadata WHERE key = 'full_reindex_required'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(marker, "0");
}
