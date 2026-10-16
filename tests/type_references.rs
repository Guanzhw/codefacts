use std::{collections::HashMap, fs};

use codefacts::{
    indexer::{extractor::Extractor, parser::CodeParser},
    lsp::LspMode,
    service::{CodeFacts, ImpactOptions},
    types::{CodeEdge, CodeNode, EdgeKind, Language},
};
use rusqlite::Connection;
use streaming_iterator::StreamingIterator;
use tempfile::tempdir;
use test_case::test_case;
use tree_sitter::QueryCursor;

fn extract(source: &str, language: Language) -> (Vec<CodeNode>, Vec<CodeEdge>) {
    let tree = CodeParser::new().parse(source, language).unwrap();
    assert!(
        !tree.root_node().has_error(),
        "{}",
        tree.root_node().to_sexp()
    );
    let query = CodeParser::load_query(language).unwrap();
    let captures = query.capture_names();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&query, tree.root_node(), source.as_bytes());
    while let Some(m) = matches.next() {
        if m.captures
            .iter()
            .any(|capture| captures[capture.index as usize] == "reference.type")
        {
            assert!(
                m.captures
                    .iter()
                    .any(|capture| captures[capture.index as usize] == "name"),
                "{language}: type-reference match supplies its name"
            );
        }
    }
    let nodes = Extractor::extract_nodes(&tree, "fixture", language, source).unwrap();
    let mut index: HashMap<String, Vec<&CodeNode>> = HashMap::new();
    for node in &nodes {
        index.entry(node.name.clone()).or_default().push(node);
    }
    let edges =
        Extractor::extract_edges(&tree, "fixture", language, source, &nodes, &index).unwrap();
    (nodes, edges)
}

#[test_case(Language::Go, "package fixture\ntype Container[T any] struct {}\n"; "go")]
#[test_case(Language::Rust, "struct Container<T> {}\n"; "rust")]
#[test_case(Language::Java, "class Container<T> {}\n"; "java")]
#[test_case(Language::C, "typedef int Payload;\ntypedef int First, Second;\ntypedef int *Pointer;\ntypedef int Callback(int);\ntypedef int (*CallbackPointer)(int);\nstruct Forward;\nunion Choice;\nenum State;\n"; "c")]
#[test_case(Language::Cpp, "template<typename T> struct Container {};\nclass Forward;\nunion Choice;\nenum State : int;\n"; "cpp")]
fn declarations_do_not_manufacture_type_uses(language: Language, source: &str) {
    let (nodes, edges) = extract(source, language);
    assert!(!nodes.is_empty());
    let references = edges
        .iter()
        .filter(|edge| edge.kind == EdgeKind::References)
        .collect::<Vec<_>>();
    assert!(references.is_empty(), "{language}: {references:#?}");
    if matches!(language, Language::C | Language::Cpp) {
        for name in ["Forward", "Choice", "State"] {
            assert!(
                nodes.iter().any(|node| node.name == name),
                "missing forward declaration {name}: {nodes:#?}"
            );
        }
    }
}

#[test_case(Language::C; "c")]
#[test_case(Language::Cpp; "cpp")]
fn opaque_typedef_tag_declarations_preserve_forward_facts_without_references(language: Language) {
    for source in ["typedef struct Foo Foo;\n", "typedef struct Foo *FooPtr;\n"] {
        let (nodes, edges) = extract(source, language);
        assert!(
            nodes
                .iter()
                .any(|node| node.name == "Foo" && node.kind == codefacts::types::NodeKind::Class),
            "{language}: {source}: {nodes:#?}"
        );
        assert!(
            edges.iter().all(|edge| edge.kind != EdgeKind::References),
            "{language}: {source}: {edges:#?}"
        );
    }
}

#[test_case(Language::C; "c")]
#[test_case(Language::Cpp; "cpp")]
fn preprocessor_forward_declarations_preserve_facts_without_references(language: Language) {
    let source = "#ifndef H\n#define H\nstruct Guarded;\n#endif\n#if 1\nstruct First;\n#elif 0\nstruct Second;\n#else\nstruct Third;\n#endif\n";
    let (nodes, edges) = extract(source, language);
    for name in ["Guarded", "First", "Second", "Third"] {
        assert!(
            nodes
                .iter()
                .any(|node| node.name == name && node.kind == codefacts::types::NodeKind::Class),
            "{language}: missing {name}: {nodes:#?}"
        );
    }
    assert!(
        edges.iter().all(|edge| edge.kind != EdgeKind::References),
        "{language}: {edges:#?}"
    );
}

#[test]
fn rust_union_declaration_name_is_not_a_type_use() {
    let (nodes, edges) = extract("union U { a: u32 }\n", Language::Rust);
    assert!(
        nodes.iter().all(|node| node.name != "U"),
        "union definition support is unchanged"
    );
    assert!(
        edges.iter().all(|edge| edge.kind != EdgeKind::References),
        "{edges:#?}"
    );
    let (nodes, edges) = extract(
        "struct Payload {}\nunion U { value: *const Payload }\n",
        Language::Rust,
    );
    let payload = nodes.iter().find(|node| node.name == "Payload").unwrap();
    let references = edges
        .iter()
        .filter(|edge| edge.kind == EdgeKind::References)
        .collect::<Vec<_>>();
    assert_eq!(references.len(), 1, "{references:#?}");
    assert_eq!(references[0].target, payload.id);
    assert_eq!(references[0].line, 2);
}

#[test]
fn rust_associated_type_declaration_does_not_reference_the_implementation_alias() {
    let (_, edges) = extract(
        "trait Tr { type Out; }\nimpl Tr for S { type Out = u8; }\nstruct S;\n",
        Language::Rust,
    );
    let references = edges
        .iter()
        .filter(|edge| edge.kind == EdgeKind::References)
        .collect::<Vec<_>>();
    assert!(
        references
            .iter()
            .all(|edge| edge.target_name.as_deref() != Some("Out")),
        "{references:#?}"
    );
    for name in ["Tr", "S"] {
        assert!(
            references
                .iter()
                .any(|edge| edge.target_name.as_deref() == Some(name) && edge.line == 2),
            "real impl type use {name}: {references:#?}"
        );
    }
}

#[test_case(Language::Java, "class Payload {}\nclass Container<@Anno T extends Payload> {}\n"; "java_annotated_parameter")]
#[test_case(Language::Cpp, "struct Payload {};\ntemplate<typename T = Payload, typename... Ts> struct Container {};\n"; "cpp_default_and_variadic_parameters")]
#[test_case(Language::Rust, "struct Payload {}\nstruct Container<T = Payload> {}\n"; "rust_default_parameter")]
fn type_parameter_declarations_preserve_only_real_bound_or_default_uses(
    language: Language,
    source: &str,
) {
    let (nodes, edges) = extract(source, language);
    let target = nodes.iter().find(|node| node.name == "Payload").unwrap();
    let references = edges
        .iter()
        .filter(|edge| edge.kind == EdgeKind::References)
        .collect::<Vec<_>>();
    assert_eq!(references.len(), 1, "{language}: {references:#?}");
    assert_eq!(references[0].target_name.as_deref(), Some("Payload"));
    assert_eq!(references[0].target, target.id);
    assert_eq!(references[0].line, 2);
}

#[test_case(Language::Cpp, "struct Container {\n struct Inner;\n Inner *value;\n};\n"; "cpp")]
#[test_case(Language::C, "struct Container {\n struct Inner;\n struct Inner *value;\n};\n"; "c")]
fn nested_forward_declaration_is_retained_without_a_declaration_reference(
    language: Language,
    source: &str,
) {
    let (nodes, edges) = extract(source, language);
    let inner = nodes
        .iter()
        .find(|node| node.name == "Inner")
        .expect("nested forward declaration");
    let container = nodes.iter().find(|node| node.name == "Container").unwrap();
    let references = edges
        .iter()
        .filter(|edge| edge.kind == EdgeKind::References)
        .collect::<Vec<_>>();
    assert_eq!(references.len(), 1, "{references:#?}");
    assert_eq!(references[0].line, 3);
    assert_eq!(references[0].source, container.id);
    assert_eq!(references[0].target, inner.id);
}

#[test]
fn qualified_type_reference_resolves_an_existing_exact_rust_identity() {
    let (nodes, edges) = extract(
        "mod schema {\n pub struct Payload {}\n}\nfn consume(x: schema::Payload) {}\n",
        Language::Rust,
    );
    let target = nodes.iter().find(|node| node.name == "Payload").unwrap();
    assert_eq!(target.qualified_name.as_deref(), Some("schema.Payload"));
    let references = edges
        .iter()
        .filter(|edge| edge.kind == EdgeKind::References)
        .collect::<Vec<_>>();
    assert_eq!(references.len(), 1);
    assert_eq!(
        references[0].target_name.as_deref(),
        Some("schema::Payload")
    );
    assert_eq!(references[0].target, target.id);
}

#[test]
fn qualified_rust_type_reference_rebinds_unchanged_source_when_target_is_added_and_removed() {
    let repository = tempdir().unwrap();
    let state = tempdir().unwrap();
    let main = repository.path().join("main.rs");
    fs::write(&main, "mod consumer;\n").unwrap();
    fs::write(
        repository.path().join("consumer.rs"),
        "use crate::schema;\nfn consume(x: schema::Payload) {}\n",
    )
    .unwrap();
    let database = state.path().join("facts.sqlite");
    let facts = CodeFacts::open_with_lsp(repository.path(), &database, LspMode::Off).unwrap();
    let conn = Connection::open(&database).unwrap();
    let target = || {
        conn.query_row::<String, _, _>("SELECT target_id FROM edges WHERE type = 'references' AND target_name = 'schema::Payload'", [], |row| row.get(0)).unwrap()
    };
    facts.refresh().unwrap();
    assert_eq!(target(), "unresolved:schema::Payload");
    fs::write(
        &main,
        "mod consumer;\nmod schema { pub struct Payload {} }\n",
    )
    .unwrap();
    let added = facts.refresh().unwrap();
    assert_eq!(added.files_indexed, 1);
    assert_eq!(added.relationships_rebound, 1);
    assert_eq!(target(), "struct:main.rs:Payload:2");
    assert_eq!(
        facts
            .expand("consume", Some("consumer.rs"), Some(20))
            .unwrap()["references"]["outbound"][0]["to"]["qualified_name"],
        "schema.Payload"
    );
    fs::write(&main, "mod consumer;\n").unwrap();
    let removed = facts.refresh().unwrap();
    assert_eq!(removed.files_indexed, 1);
    assert_eq!(removed.relationships_rebound, 1);
    assert_eq!(target(), "unresolved:schema::Payload");
}

#[test]
fn go_external_type_namesakes_remain_unresolved_instead_of_selecting_the_first() {
    let repository = tempdir().unwrap();
    let state = tempdir().unwrap();
    fs::write(
        repository.path().join("consumer.go"),
        "package fixture\nfunc consume(x Payload) {}\n",
    )
    .unwrap();
    for package in ["a", "b"] {
        fs::create_dir(repository.path().join(package)).unwrap();
        fs::write(
            repository.path().join(package).join("model.go"),
            format!("package {package}\ntype Payload struct{{}}\n"),
        )
        .unwrap();
    }
    let database = state.path().join("facts.sqlite");
    let facts = CodeFacts::open_with_lsp(repository.path(), &database, LspMode::Off).unwrap();
    facts.refresh().unwrap();
    let conn = Connection::open(&database).unwrap();
    let target = || {
        conn.query_row::<String, _, _>(
            "SELECT target_id FROM edges WHERE type = 'references' AND target_name = 'Payload'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(target(), "unresolved:Payload");
    fs::remove_file(repository.path().join("b/model.go")).unwrap();
    facts.refresh().unwrap();
    assert_eq!(
        target(),
        "unresolved:Payload",
        "an external short name alone still has no package identity evidence"
    );
}

#[test]
fn c_tag_and_typedef_namesakes_stay_explicitly_unresolved_without_namespace_evidence() {
    let (_, edges) = extract(
        "typedef struct Payload {} Payload;\nPayload consume(Payload x) { return x; }\n",
        Language::C,
    );
    let references = edges
        .iter()
        .filter(|edge| edge.kind == EdgeKind::References)
        .collect::<Vec<_>>();
    assert!(!references.is_empty());
    assert!(
        references
            .iter()
            .all(|edge| edge.target == "unresolved:Payload"),
        "{references:#?}"
    );
}

#[test]
fn qualified_cpp_template_keeps_its_qualification_and_real_argument_type_use() {
    let source = "namespace A { template<typename T> struct Container {}; }\nnamespace B { template<typename T> struct Container {}; }\nstruct Payload {};\nvoid consume(B::Container<Payload> x) {}\n";
    let (nodes, edges) = extract(source, Language::Cpp);
    let payload = nodes.iter().find(|node| node.name == "Payload").unwrap();
    let references = edges
        .iter()
        .filter(|edge| edge.kind == EdgeKind::References)
        .collect::<Vec<_>>();
    assert_eq!(references.len(), 2, "{references:#?}");
    assert_eq!(
        references[0].target_name.as_deref(),
        Some("B::Container<Payload>")
    );
    assert_eq!(references[0].target, "unresolved:B::Container<Payload>");
    assert_eq!(references[1].target_name.as_deref(), Some("Payload"));
    assert_eq!(references[1].target, payload.id);
}

#[test]
fn c_each_typedef_alias_owns_the_shared_target_type_use() {
    let (nodes, edges) = extract(
        "typedef int Payload;\ntypedef Payload Alias, Other;\n",
        Language::C,
    );
    let target = nodes.iter().find(|node| node.name == "Payload").unwrap();
    let references = edges
        .iter()
        .filter(|edge| edge.kind == EdgeKind::References)
        .collect::<Vec<_>>();
    assert_eq!(references.len(), 2, "{references:#?}");
    for name in ["Alias", "Other"] {
        let owner = nodes.iter().find(|node| node.name == name).unwrap();
        let reference = references
            .iter()
            .find(|edge| edge.source == owner.id)
            .unwrap();
        assert_eq!(reference.target, target.id);
        assert_eq!(reference.line, 2);
    }
}

#[test]
fn go_type_reference_does_not_bind_a_same_named_value() {
    let source = "package fixture\nfunc first() { Payload := 1; _ = Payload }\ntype Payload struct{}\nfunc consume(x Payload) {}\n";
    let (nodes, edges) = extract(source, Language::Go);
    let target = nodes
        .iter()
        .find(|node| node.name == "Payload" && node.kind == codefacts::types::NodeKind::Class)
        .unwrap();
    let reference = edges
        .iter()
        .find(|edge| edge.kind == EdgeKind::References)
        .unwrap();
    assert_eq!(reference.target, target.id);
    let repository = tempdir().unwrap();
    let state = tempdir().unwrap();
    fs::write(repository.path().join("fixture.go"), source).unwrap();
    let facts = CodeFacts::open_with_lsp(
        repository.path(),
        state.path().join("facts.sqlite"),
        LspMode::Off,
    )
    .unwrap();
    for _ in 0..2 {
        let expanded = facts
            .expand("consume", Some("fixture.go"), Some(20))
            .unwrap();
        let refs = expanded["references"]["outbound"].as_array().unwrap();
        assert_eq!(refs.len(), 1, "{expanded}");
        assert_eq!(refs[0]["to"]["kind"], "class");
        fs::write(
            repository.path().join("other.go"),
            "package fixture\nfunc unrelated() { Payload := 2; _ = Payload }\n",
        )
        .unwrap();
    }
}

#[test_case(Language::Cpp, "namespace A { struct Payload {}; }\nnamespace B { struct Payload {}; }\nvoid consume(B::Payload x) {}\n", "B::Payload"; "cpp")]
#[test_case(Language::Go, "package fixture\ntype Payload struct{}\nfunc consume(x pkg.Payload) {}\n", "pkg.Payload"; "go")]
#[test_case(Language::Java, "class Payload {}\nclass Consumer { void consume(pkg.Payload x) {} }\n", "pkg.Payload"; "java")]
fn explicitly_qualified_type_uses_never_bind_an_unqualified_namesake(
    language: Language,
    source: &str,
    spelling: &str,
) {
    let (_, edges) = extract(source, language);
    let references = edges
        .iter()
        .filter(|edge| edge.kind == EdgeKind::References)
        .collect::<Vec<_>>();
    assert_eq!(references.len(), 1, "{language}: {references:#?}");
    assert_eq!(references[0].target_name.as_deref(), Some(spelling));
    assert_eq!(references[0].target, format!("unresolved:{spelling}"));
    let repository = tempdir().unwrap();
    let state = tempdir().unwrap();
    let file = match language {
        Language::Cpp => "fixture.cpp",
        Language::Go => "fixture.go",
        Language::Java => "Fixture.java",
        _ => unreachable!(),
    };
    fs::write(repository.path().join(file), source).unwrap();
    let database = state.path().join("facts.sqlite");
    let facts = CodeFacts::open_with_lsp(repository.path(), &database, LspMode::Off).unwrap();
    facts.refresh().unwrap();
    let conn = Connection::open(&database).unwrap();
    let stored: (String, String, String) = conn
        .query_row(
            "SELECT target_id, target_name, properties FROM edges WHERE type = 'references'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(stored.0, format!("unresolved:{spelling}"));
    assert_eq!(stored.1, spelling);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&stored.2).unwrap()["type_reference"],
        "true"
    );
}

#[test]
fn c_shared_typedef_base_type_reaches_each_alias_in_real_impact() {
    let repository = tempdir().unwrap();
    let state = tempdir().unwrap();
    fs::write(
        repository.path().join("fixture.c"),
        "typedef int Payload;\ntypedef Payload Alias, Other;\n",
    )
    .unwrap();
    let facts = CodeFacts::open_with_lsp(
        repository.path(),
        state.path().join("facts.sqlite"),
        LspMode::Off,
    )
    .unwrap();
    let expanded = facts.expand("Other", Some("fixture.c"), Some(20)).unwrap();
    assert_eq!(
        expanded["references"]["outbound"][0]["to"]["name"],
        "Payload"
    );
    let impact = facts
        .impact(ImpactOptions {
            symbol: "Payload",
            file_path: Some("fixture.c"),
            max_depth: Some(1),
            limit: Some(20),
        })
        .unwrap();
    let affected = impact["affected"].as_array().unwrap();
    assert_eq!(affected.len(), 2, "{impact}");
    for name in ["Alias", "Other"] {
        assert!(affected.iter().any(|entry| entry["symbol"]["name"] == name));
    }
}

#[test_case(Language::Go, "package fixture\ntype Payload struct {\n next *Payload\n value int\n}\nfunc consume(\n input Payload,\n) Payload {\n return input\n}\n", 3, 7, 8; "go")]
#[test_case(Language::Rust, "struct Payload {\n next: Option<Box<Payload>>,\n value: i32,\n}\nfn consume(\n input: Payload,\n) -> Payload {\n input\n}\n", 2, 6, 7; "rust")]
#[test_case(Language::Java, "class Payload {\n Payload next;\n int value;\n Payload consume(\n Payload input\n ) { return input; }\n}\n", 2, 4, 5; "java")]
#[test_case(Language::C, "struct Payload {\n struct Payload *next;\n int value;\n};\nstruct Payload consume(\n struct Payload input\n) {\n return input;\n}\n", 2, 5, 6; "c")]
#[test_case(Language::Cpp, "struct Payload {\n Payload *next;\n int value;\n};\nPayload consume(\n Payload input\n) {\n return input;\n}\n", 2, 5, 6; "cpp")]
fn type_uses_have_exact_locations_owners_and_targets(
    language: Language,
    source: &str,
    recursive_line: u32,
    first_use: u32,
    second_use: u32,
) {
    let (nodes, edges) = extract(source, language);
    let target = nodes.iter().find(|node| node.name == "Payload").unwrap();
    let consumer = nodes.iter().find(|node| node.name == "consume").unwrap();
    let references = edges
        .iter()
        .filter(|edge| edge.kind == EdgeKind::References)
        .collect::<Vec<_>>();
    assert_eq!(references.len(), 3, "{language}: {references:#?}");
    for (edge, line) in references
        .iter()
        .zip([recursive_line, first_use, second_use])
    {
        assert_eq!(edge.line, line, "{language}: real type use line");
        assert_eq!(edge.file_path, "fixture");
        assert_eq!(edge.target_name.as_deref(), Some("Payload"));
        assert_eq!(edge.target, target.id, "{language}: resolved local type");
        assert_eq!(
            edge.source,
            if line == recursive_line {
                &target.id
            } else {
                &consumer.id
            }
            .as_str(),
            "{language}: enclosing owner"
        );
    }
}

#[test]
fn go_unresolved_type_uses_keep_explicit_unresolved_targets() {
    let (nodes, edges) = extract(
        "package fixture\nfunc consume(input Missing) {}\n",
        Language::Go,
    );
    let owner = nodes.iter().find(|node| node.name == "consume").unwrap();
    let edge = edges
        .iter()
        .find(|edge| edge.kind == EdgeKind::References)
        .unwrap();
    assert_eq!(edge.line, 2);
    assert_eq!(edge.source, owner.id);
    assert_eq!(edge.target, "unresolved:Missing");
    assert_eq!(edge.target_name.as_deref(), Some("Missing"));
}

#[test_case(Language::Go, "package fixture\ntype Payload struct{}\ntype Alias = Payload\n", 3; "go")]
#[test_case(Language::Rust, "struct Payload {}\ntype Alias = Payload;\n", 2; "rust")]
#[test_case(Language::C, "typedef int Payload;\ntypedef Payload Alias;\n", 2; "c")]
#[test_case(Language::Cpp, "struct Payload {};\nusing Alias = Payload;\n", 2; "cpp")]
fn aliases_own_their_real_target_type_use(language: Language, source: &str, line: u32) {
    let (nodes, edges) = extract(source, language);
    let alias = nodes.iter().find(|node| node.name == "Alias").unwrap();
    let target = nodes.iter().find(|node| node.name == "Payload").unwrap();
    let references = edges
        .iter()
        .filter(|edge| edge.kind == EdgeKind::References)
        .collect::<Vec<_>>();
    assert_eq!(references.len(), 1, "{language}: {references:#?}");
    assert_eq!(references[0].line, line);
    assert_eq!(references[0].source, alias.id);
    assert_eq!(references[0].target, target.id);
}

#[test]
fn java_type_parameter_bound_remains_a_real_use() {
    let (nodes, edges) = extract(
        "class Payload {}\nclass Container<T extends Payload> {}\n",
        Language::Java,
    );
    let owner = nodes.iter().find(|node| node.name == "Container").unwrap();
    let target = nodes.iter().find(|node| node.name == "Payload").unwrap();
    let references = edges
        .iter()
        .filter(|edge| edge.kind == EdgeKind::References)
        .collect::<Vec<_>>();
    assert_eq!(references.len(), 1, "{references:#?}");
    assert_eq!(references[0].line, 2);
    assert_eq!(references[0].source, owner.id);
    assert_eq!(references[0].target, target.id);
}

#[test]
fn go_primitive_uintptr_is_not_an_unresolved_reference() {
    let (_, edges) = extract(
        "package fixture\nfunc primitive(value uintptr) bool { return true }\n",
        Language::Go,
    );
    assert!(
        edges.iter().all(|edge| edge.kind != EdgeKind::References),
        "{edges:#?}"
    );
}

const GO_SOURCE: &str = "package fixture\ntype Payload struct{}\nfunc consume(\n input Payload,\n) Payload {\n return input\n}\n";

fn assert_go_surface(facts: &CodeFacts) {
    let expanded = facts
        .expand("Payload", Some("fixture.go"), Some(20))
        .unwrap();
    let inbound = expanded["references"]["inbound"].as_array().unwrap();
    assert_eq!(inbound.len(), 2, "{expanded}");
    for (edge, line) in inbound.iter().zip([4, 5]) {
        assert_eq!(edge["from"]["name"], "consume");
        assert_eq!(edge["to"]["name"], "Payload");
        assert_eq!(edge["evidence"]["start_line"], line);
    }
    let expanded = facts
        .expand("consume", Some("fixture.go"), Some(20))
        .unwrap();
    assert_eq!(
        expanded["references"]["outbound"].as_array().unwrap().len(),
        2
    );
    assert!(expanded["callees"].as_array().unwrap().is_empty());
    let affected = facts
        .impact(ImpactOptions {
            symbol: "Payload",
            file_path: Some("fixture.go"),
            max_depth: Some(2),
            limit: Some(20),
        })
        .unwrap();
    let entries = affected["affected"].as_array().unwrap();
    assert_eq!(entries.len(), 1, "{affected}");
    assert_eq!(entries[0]["symbol"]["name"], "consume");
    assert_eq!(entries[0]["distance"], 1);
    assert_eq!(entries[0]["witness"]["kind"], "references");
    assert_eq!(entries[0]["witness"]["evidence"]["start_line"], 4);
}

#[test]
fn fresh_go_index_exposes_type_only_expand_and_impact_dependencies() {
    let repository = tempdir().unwrap();
    let state = tempdir().unwrap();
    fs::write(repository.path().join("fixture.go"), GO_SOURCE).unwrap();
    let facts = CodeFacts::open_with_lsp(
        repository.path(),
        state.path().join("facts.sqlite"),
        LspMode::Off,
    )
    .unwrap();
    assert_go_surface(&facts);
}

#[test]
fn version_nine_unchanged_source_rebuilds_missing_type_references_once() {
    let repository = tempdir().unwrap();
    let state = tempdir().unwrap();
    fs::write(repository.path().join("fixture.go"), GO_SOURCE).unwrap();
    let database = state.path().join("facts.sqlite");
    {
        let facts = CodeFacts::open_with_lsp(repository.path(), &database, LspMode::Off).unwrap();
        facts.refresh().unwrap();
    }
    let conn = Connection::open(&database).unwrap();
    conn.execute("DELETE FROM edges WHERE type = 'references'", [])
        .unwrap();
    conn.execute(
        "UPDATE index_metadata SET value = '9' WHERE key = 'fact_extraction_version'",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE index_metadata SET value = '0' WHERE key = 'full_reindex_required'",
        [],
    )
    .unwrap();
    drop(conn);
    let facts = CodeFacts::open_with_lsp(repository.path(), &database, LspMode::Off).unwrap();
    assert_eq!(facts.refresh().unwrap().files_indexed, 1);
    assert_go_surface(&facts);
    assert_eq!(facts.refresh().unwrap().files_indexed, 0);
}
