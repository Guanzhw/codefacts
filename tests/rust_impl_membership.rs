use std::{collections::HashMap, fs, sync::Arc};

use codefacts::{
    graph::store::{FtsSearchOptions, GraphStore},
    indexer::{extractor::Extractor, parser::CodeParser},
    lsp::LspMode,
    service::{CodeFacts, ExpandSection},
    types::{CodeEdge, CodeNode, EdgeKind, Language, NodeKind, RustImplMembership},
};
use rusqlite::Connection;
use serde_json::Value;
use tempfile::tempdir;

const SAME_LINE: &str = "struct P; trait A { fn run(); } trait B { fn run(); } impl A for P { fn run() { left(); } } impl B for P { fn run() { right(); } } fn left() {} fn right() {}";

fn extract(source: &str, language: Language) -> (Vec<CodeNode>, Vec<CodeEdge>) {
    let tree = CodeParser::new().parse(source, language).unwrap();
    assert!(
        !tree.root_node().has_error(),
        "{}",
        tree.root_node().to_sexp()
    );
    let nodes = Extractor::extract_nodes(&tree, "fixture.rs", language, source).unwrap();
    let mut index: HashMap<String, Vec<&CodeNode>> = HashMap::new();
    for node in &nodes {
        index.entry(node.name.clone()).or_default().push(node);
    }
    let edges =
        Extractor::extract_edges(&tree, "fixture.rs", language, source, &nodes, &index).unwrap();
    (nodes, edges)
}

fn position(source: &str, offset: usize) -> (u32, u32) {
    let prefix = &source[..offset];
    (
        prefix.bytes().filter(|byte| *byte == b'\n').count() as u32 + 1,
        prefix.rsplit('\n').next().unwrap().len() as u32,
    )
}

fn public_owner<'a>(response: &'a Value, symbol: &Value) -> &'a Value {
    let key = symbol["rust_impl"]["owner_ref"].as_str().unwrap();
    &response["rust_impl_owners"][key]
}

fn assert_owner(
    source: &str,
    node: &CodeNode,
    owner: &str,
    receiver: &str,
    trait_name: Option<&str>,
) {
    let membership = node.rust_impl.as_ref().unwrap();
    assert_eq!(membership.receiver, receiver);
    assert_eq!(membership.trait_name.as_deref(), trait_name);
    let start = source.find(owner).unwrap();
    assert_eq!(
        (membership.start_line, membership.start_column),
        position(source, start)
    );
    assert_eq!(
        (membership.end_line, membership.end_column),
        position(source, start + owner.len())
    );
    assert!(
        (membership.start_line, membership.start_column) <= (node.start_line, node.start_column)
    );
    assert!((node.end_line, node.end_column) <= (membership.end_line, membership.end_column));
}

#[test]
fn separate_command_impl_shares_only_its_actual_owner() {
    let source = "struct HideEnv;\ntrait Command {}\nimpl Command for HideEnv {\n fn name() {}\n fn run() {}\n}\nfn run() {}\n";
    let (nodes, edges) = extract(source, Language::Rust);
    let methods = nodes
        .iter()
        .filter(|node| node.kind == NodeKind::Method)
        .collect::<Vec<_>>();
    assert_eq!(methods.len(), 2);
    let owner = "impl Command for HideEnv {\n fn name() {}\n fn run() {}\n}";
    for method in &methods {
        assert_owner(source, method, owner, "HideEnv", Some("Command"));
        assert_eq!(method.qualified_name, None);
    }
    assert_eq!(methods[0].rust_impl, methods[1].rust_impl);
    assert!(nodes
        .iter()
        .filter(|node| node.kind != NodeKind::Method)
        .all(|node| node.rust_impl.is_none()));
    assert!(!edges.iter().any(|edge| edge.kind == EdgeKind::Contains));
}

#[test]
fn inherent_trait_repeated_blocks_paths_modules_and_utf8_have_exact_ranges() {
    let source = "struct Point;\nimpl Point { fn one() {} }\nimpl Left for Point { fn two() {} }\nimpl Right for Point { fn three() {} }\nimpl Point { fn four() {} }\nimpl<T: Bound> crate::Trait< T > for super::Wrapper<T> where T: Copy { fn generic() {} }\nmod first { /* 中文 */ impl Trait for T { fn run() {} } }\nmod second { impl Trait for T { fn run() {} } }\n";
    let (nodes, _) = extract(source, Language::Rust);
    for (name, owner, receiver, trait_name) in [
        ("one", "impl Point { fn one() {} }", "Point", None),
        ("two", "impl Left for Point { fn two() {} }", "Point", Some("Left")),
        ("three", "impl Right for Point { fn three() {} }", "Point", Some("Right")),
        ("four", "impl Point { fn four() {} }", "Point", None),
        ("generic", "impl<T: Bound> crate::Trait< T > for super::Wrapper<T> where T: Copy { fn generic() {} }", "super::Wrapper<T>", Some("crate::Trait< T >")),
    ] {
        let node = nodes.iter().find(|node| node.name == name).unwrap();
        assert_owner(source, node, owner, receiver, trait_name);
    }
    let methods = nodes
        .iter()
        .filter(|node| node.name == "run")
        .collect::<Vec<_>>();
    assert_eq!(methods.len(), 2);
    assert_eq!(methods[0].qualified_name.as_deref(), Some("first.run"));
    assert_eq!(methods[1].qualified_name.as_deref(), Some("second.run"));
    assert_ne!(methods[0].rust_impl, methods[1].rust_impl);
    for method in methods {
        let membership = method.rust_impl.as_ref().unwrap();
        let line = source
            .lines()
            .nth(membership.start_line as usize - 1)
            .unwrap();
        assert_eq!(
            &line[membership.start_column as usize..membership.end_column as usize],
            "impl Trait for T { fn run() {} }"
        );
        assert_eq!(
            &line[method.start_column as usize..method.end_column as usize],
            "fn run() {}"
        );
    }
    let owners = nodes
        .iter()
        .filter_map(|node| node.rust_impl.as_ref())
        .collect::<Vec<_>>();
    assert_eq!(owners.len(), 7);
    for (index, owner) in owners.iter().enumerate() {
        assert!(!owners[..index].contains(owner));
    }
}

#[test]
fn nested_helpers_nested_impls_cfg_and_other_languages_keep_syntax_scope() {
    let source = "struct P;\nimpl P { fn outer() { fn helper() {} struct Inner; impl Inner { fn nested() {} } } }\n#[cfg(feature = \"left\")]\nimpl P { fn left() {} }\n#[cfg(feature = \"right\")]\nimpl P { fn right() {} }\ntrait Trait { fn default_method() {} }\nfn standalone() {}\n";
    let (nodes, _) = extract(source, Language::Rust);
    for (name, owner, receiver) in [
        (
            "outer",
            "impl P { fn outer() { fn helper() {} struct Inner; impl Inner { fn nested() {} } } }",
            "P",
        ),
        ("nested", "impl Inner { fn nested() {} }", "Inner"),
        ("left", "impl P { fn left() {} }", "P"),
        ("right", "impl P { fn right() {} }", "P"),
    ] {
        assert_owner(
            source,
            nodes.iter().find(|node| node.name == name).unwrap(),
            owner,
            receiver,
            None,
        );
    }
    for name in ["helper", "standalone", "default_method", "Trait", "P"] {
        assert!(nodes
            .iter()
            .find(|node| node.name == name)
            .unwrap()
            .rust_impl
            .is_none());
    }
    for (language, source) in [
        (Language::TypeScript, "class P { run() {} }"),
        (Language::Python, "class P:\n def run(self):\n  pass\n"),
        (
            Language::Go,
            "package p\ntype P struct {}\nfunc (p P) Run() {}\n",
        ),
    ] {
        let (nodes, _) = extract(source, language);
        assert!(!nodes.is_empty());
        for node in nodes {
            assert!(node.rust_impl.is_none());
            assert!(serde_json::to_value(node)
                .unwrap()
                .get("rust_impl")
                .is_none());
        }
    }
}

#[test]
fn same_line_methods_keep_existing_unique_ids_and_call_owners() {
    let (nodes, edges) = extract(SAME_LINE, Language::Rust);
    let methods = nodes
        .iter()
        .filter(|node| node.kind == NodeKind::Method)
        .collect::<Vec<_>>();
    assert_eq!(methods.len(), 2);
    assert_ne!(methods[0].id, methods[1].id);
    for (method, trait_name, leaf) in [(methods[0], "A", "left"), (methods[1], "B", "right")] {
        // This collision suffix already exists before the membership feature.
        assert_eq!(
            method.id,
            format!("method:fixture.rs:run:1:column={}", method.start_column)
        );
        assert_eq!(
            method.rust_impl.as_ref().unwrap().trait_name.as_deref(),
            Some(trait_name)
        );
        let calls = edges
            .iter()
            .filter(|edge| edge.kind == EdgeKind::Calls && edge.source == method.id)
            .collect::<Vec<_>>();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].target_name.as_deref(), Some(leaf));
        let target = nodes.iter().find(|node| node.name == leaf).unwrap();
        assert_eq!(calls[0].target, target.id);
    }
    assert!(!edges.iter().any(|edge| edge.kind == EdgeKind::Contains));
}

#[test]
fn recovered_impl_syntax_does_not_emit_partial_membership() {
    let source = "impl P { fn run() { let broken = ; } }";
    let tree = CodeParser::new().parse(source, Language::Rust).unwrap();
    assert!(tree.root_node().has_error());
    let nodes = Extractor::extract_nodes(&tree, "fixture.rs", Language::Rust, source).unwrap();
    let method = nodes
        .iter()
        .find(|node| node.kind == NodeKind::Method && node.name == "run")
        .unwrap();
    assert!(method.rust_impl.is_none());
}

#[test]
fn every_writer_and_hydration_path_round_trips_parsed_membership_after_reopen() {
    let (nodes, _) = extract(SAME_LINE, Language::Rust);
    let methods = nodes
        .into_iter()
        .filter(|node| node.kind == NodeKind::Method)
        .collect::<Vec<_>>();
    let expected = methods
        .iter()
        .map(|node| serde_json::to_value(node).unwrap())
        .collect::<Vec<_>>();
    for writer in ["single", "batch", "file"] {
        let directory = tempdir().unwrap();
        let database = directory.path().join("facts.sqlite");
        {
            let store = GraphStore::new(database.to_str().unwrap()).unwrap();
            match writer {
                "single" => {
                    for method in &methods {
                        store.upsert_node(method).unwrap();
                    }
                }
                "batch" => store.upsert_nodes(&methods).unwrap(),
                "file" => store
                    .replace_file_data("fixture.rs", &methods, &[])
                    .unwrap(),
                _ => unreachable!(),
            }
        }
        let store = GraphStore::new(database.to_str().unwrap()).unwrap();
        let ids = methods
            .iter()
            .map(|node| node.id.clone())
            .collect::<Vec<_>>();
        let fts = store
            .search_fts_nodes(FtsSearchOptions {
                query: "run",
                excluded_node_ids: &[],
                kind: Some("method"),
                path_prefix: None,
                top_level: false,
                offset: 0,
                limit: 50,
            })
            .unwrap();
        for actual in [
            methods
                .iter()
                .map(|method| store.get_node(&method.id).unwrap().unwrap())
                .collect(),
            store.get_nodes_by_ids(&ids).unwrap(),
            store.get_nodes_by_files(&["fixture.rs".into()]).unwrap(),
            store.get_nodes_by_file("fixture.rs").unwrap(),
            store.get_nodes_by_name("run").unwrap(),
            store.get_nodes_by_type("method").unwrap(),
            store.get_all_nodes().unwrap(),
            fts,
        ] {
            let mut actual = actual
                .iter()
                .map(|node| serde_json::to_value(node).unwrap())
                .collect::<Vec<_>>();
            actual.sort_by_key(|node| node["start_column"].as_u64());
            assert_eq!(actual, expected, "writer {writer}");
        }
        let raw = Connection::open(&database).unwrap();
        for method in &methods {
            let metadata: String = raw
                .query_row(
                    "SELECT metadata FROM nodes WHERE id=?1",
                    [&method.id],
                    |row| row.get(0),
                )
                .unwrap();
            let metadata: Value = serde_json::from_str(&metadata).unwrap();
            assert!(metadata.get("rust_impl").is_none());
            let owner: String = raw.query_row(
                "SELECT receiver FROM rust_impl_owners WHERE id=(SELECT rust_impl_owner_id FROM nodes WHERE id=?1)",
                [&method.id], |row| row.get(0),
            ).unwrap();
            assert_eq!(owner, "P");
        }
    }
}

#[test]
fn missing_legacy_membership_is_absent_and_present_malformed_data_errors() {
    let (nodes, _) = extract(SAME_LINE, Language::Rust);
    let node = nodes
        .iter()
        .find(|node| node.kind == NodeKind::Method)
        .unwrap();
    let directory = tempdir().unwrap();
    let database = directory.path().join("facts.sqlite");
    let store = GraphStore::new(database.to_str().unwrap()).unwrap();
    store.upsert_node(node).unwrap();
    let conn = Connection::open(&database).unwrap();
    conn.execute("UPDATE nodes SET rust_impl_owner_id=NULL", [])
        .unwrap();
    assert!(store
        .get_node(&node.id)
        .unwrap()
        .unwrap()
        .rust_impl
        .is_none());
    for malformed in ["'bad-reference'", "999999"] {
        conn.execute(
            &format!("UPDATE nodes SET rust_impl_owner_id={malformed}"),
            [],
        )
        .unwrap();
        assert!(store.get_node(&node.id).is_err());
        assert!(store
            .get_nodes_by_ids(std::slice::from_ref(&node.id))
            .is_err());
        assert!(store.get_nodes_by_file("fixture.rs").is_err());
    }
    let owner_id: i64 = conn
        .query_row("SELECT id FROM rust_impl_owners LIMIT 1", [], |row| {
            row.get(0)
        })
        .unwrap();
    conn.execute("UPDATE nodes SET rust_impl_owner_id=?1", [owner_id])
        .unwrap();
    for mutation in [
        "UPDATE rust_impl_owners SET file_path='wrong.rs'",
        "UPDATE rust_impl_owners SET receiver=X'00'",
        "UPDATE rust_impl_owners SET start_line=-1",
        "UPDATE rust_impl_owners SET trait_name=X'00'",
    ] {
        conn.execute_batch("SAVEPOINT malformed_owner").unwrap();
        conn.execute(mutation, []).unwrap();
        assert!(store.get_node(&node.id).is_err(), "{mutation}");
        conn.execute_batch("ROLLBACK TO malformed_owner; RELEASE malformed_owner")
            .unwrap();
    }
}
fn metadata(conn: &Connection, key: &str) -> String {
    conn.query_row(
        "SELECT value FROM index_metadata WHERE key=?1",
        [key],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn version_ten_refresh_rebuilds_membership_atomically_and_then_returns_to_incremental() {
    let repository = tempdir().unwrap();
    let state = tempdir().unwrap();
    let database = state.path().join("facts.sqlite");
    fs::write(repository.path().join("fixture.rs"), SAME_LINE).unwrap();
    let generation = {
        let facts = CodeFacts::open_with_lsp(repository.path(), &database, LspMode::Off).unwrap();
        facts.refresh().unwrap().generation
    };
    let conn = Connection::open(&database).unwrap();
    let before_ids: Vec<String> = conn
        .prepare("SELECT id FROM nodes ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    conn.execute_batch("DROP INDEX idx_nodes_rust_impl_owner; ALTER TABLE nodes DROP COLUMN rust_impl_owner_id; DROP TABLE rust_impl_owners;").unwrap();
    conn.execute(
        "UPDATE index_metadata SET value='10' WHERE key='fact_extraction_version'",
        [],
    )
    .unwrap();
    let facts = CodeFacts::open_with_lsp(repository.path(), &database, LspMode::Off).unwrap();
    assert_eq!(metadata(&conn, "fact_extraction_version"), "11");
    assert_eq!(metadata(&conn, "full_reindex_required"), "1");
    conn.execute_batch("CREATE TRIGGER abort_impl_refresh BEFORE UPDATE OF value ON index_metadata WHEN OLD.key='generation' BEGIN SELECT RAISE(ABORT, 'injected impl refresh failure'); END;").unwrap();
    assert!(facts
        .refresh()
        .unwrap_err()
        .to_string()
        .contains("injected impl refresh failure"));
    assert_eq!(metadata(&conn, "generation"), generation.to_string());
    assert_eq!(metadata(&conn, "full_reindex_required"), "1");
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM rust_impl_owners", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let rollback_ids: Vec<String> = conn
        .prepare("SELECT id FROM nodes ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(rollback_ids, before_ids);
    conn.execute_batch("DROP TRIGGER abort_impl_refresh")
        .unwrap();
    let rebuilt = facts.refresh().unwrap();
    assert_eq!(rebuilt.files_indexed, 1);
    assert_eq!(rebuilt.generation, generation + 1);
    assert_eq!(metadata(&conn, "full_reindex_required"), "0");
    let outline = facts.outline("fixture.rs", Some(50)).unwrap();
    let methods = outline["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|symbol| symbol["kind"] == "method")
        .collect::<Vec<_>>();
    assert_eq!(methods.len(), 2);
    assert!(methods
        .iter()
        .all(|method| public_owner(&outline, method)["receiver"] == "P"));
    let stable = facts.refresh().unwrap();
    assert_eq!(stable.files_indexed, 0);
    assert_eq!(stable.generation, rebuilt.generation);
    assert_eq!(
        facts.outline("fixture.rs", Some(50)).unwrap()["symbols"],
        outline["symbols"]
    );
    drop(facts);
    let facts = CodeFacts::open_with_lsp(repository.path(), &database, LspMode::Off).unwrap();
    assert_eq!(
        facts.outline("fixture.rs", Some(50)).unwrap()["symbols"],
        outline["symbols"]
    );
    for (method, leaf) in methods.iter().zip(["left", "right"]) {
        let id = method["id"].as_str().unwrap();
        let expanded = facts
            .expand_page(id, None, ExpandSection::All, None, Some(50), false)
            .unwrap();
        assert_eq!(
            public_owner(&expanded, &expanded["definition"]),
            public_owner(&outline, method)
        );
        assert_eq!(expanded["callees"][0]["to"]["name"], leaf);
        assert_eq!(expanded["callees"][0]["evidence"]["confidence"], "static");
        assert_eq!(
            facts.path("P", id, Some(50)).unwrap()["status"],
            "no_static_path"
        );
    }
    fs::write(
        repository.path().join("fixture.rs"),
        "struct P; impl P { fn replaced() {} }",
    )
    .unwrap();
    let changed = facts.outline("fixture.rs", Some(50)).unwrap();
    assert_eq!(
        changed["symbols"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|symbol| symbol.get("rust_impl").is_some())
            .count(),
        1
    );
    assert_eq!(
        facts
            .expand(methods[0]["id"].as_str().unwrap(), None, None)
            .unwrap()["status"],
        "not_found"
    );
    fs::write(repository.path().join("fixture.rs"), "struct P;").unwrap();
    let deleted = facts.outline("fixture.rs", Some(50)).unwrap();
    assert!(deleted["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .all(|symbol| symbol.get("rust_impl").is_none()));
}

#[test]
fn old_serialized_nodes_and_inherent_membership_have_one_optional_contract() {
    let (nodes, _) = extract("struct P; impl P { fn run() {} }", Language::Rust);
    let method = nodes
        .iter()
        .find(|node| node.kind == NodeKind::Method)
        .unwrap();
    let encoded = serde_json::to_value(method).unwrap();
    assert!(encoded["rust_impl"].get("trait_name").is_none());
    let decoded: RustImplMembership = serde_json::from_value(encoded["rust_impl"].clone()).unwrap();
    assert_eq!(Some(Arc::new(decoded)), method.rust_impl);
    let mut old = encoded;
    old.as_object_mut().unwrap().remove("rust_impl");
    assert!(serde_json::from_value::<CodeNode>(old)
        .unwrap()
        .rust_impl
        .is_none());
}

fn large_impl_source(header_bytes: usize, methods: usize) -> (String, String) {
    let trait_name = format!("Trait{}", "x".repeat(header_bytes - 5));
    let mut source = format!("struct P;\nimpl {trait_name} for P {{\n");
    for index in 0..methods {
        source.push_str(&format!(" fn method_{index:04}() {{ leaf(); }}\n"));
    }
    source.push_str("}\nfn leaf() {}\n");
    (source, trait_name)
}

#[test]
fn large_headers_share_one_ast_owner_one_stored_row_and_batched_read_owner() {
    for (header_bytes, count) in [(16 * 1024, 512), (32 * 1024, 512), (32 * 1024, 1024)] {
        let (source, trait_name) = large_impl_source(header_bytes, count);
        let (nodes, _) = extract(&source, Language::Rust);
        let methods = nodes
            .into_iter()
            .filter(|node| node.kind == NodeKind::Method)
            .collect::<Vec<_>>();
        assert_eq!(methods.len(), count);
        let owner = methods[0].rust_impl.as_ref().unwrap();
        assert_eq!(owner.trait_name.as_deref(), Some(trait_name.as_str()));
        assert!(methods
            .iter()
            .all(|method| Arc::ptr_eq(owner, method.rust_impl.as_ref().unwrap())));
        let directory = tempdir().unwrap();
        let database = directory.path().join("facts.sqlite");
        let store = GraphStore::new(database.to_str().unwrap()).unwrap();
        store.upsert_nodes(&methods).unwrap();
        let conn = Connection::open(&database).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM rust_impl_owners", [], |row| row
                .get::<_, usize>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM nodes WHERE rust_impl_owner_id IS NOT NULL",
                [],
                |row| row.get::<_, usize>(0)
            )
            .unwrap(),
            count
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM nodes WHERE json_type(metadata,'$.rust_impl') IS NOT NULL",
                [],
                |row| row.get::<_, usize>(0)
            )
            .unwrap(),
            0
        );
        let header_storage: usize = conn
            .query_row(
                "SELECT SUM(length(receiver)+coalesce(length(trait_name),0)) FROM rust_impl_owners",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(header_storage, header_bytes + 1);
        let ids = methods
            .iter()
            .map(|method| method.id.clone())
            .collect::<Vec<_>>();
        let hydrated = store.get_nodes_by_ids(&ids).unwrap();
        assert_eq!(hydrated.len(), count);
        let hydrated_owner = hydrated[0].rust_impl.as_ref().unwrap();
        assert!(hydrated
            .iter()
            .all(|method| Arc::ptr_eq(hydrated_owner, method.rust_impl.as_ref().unwrap())));
        store
            .with_read_snapshot(|store| {
                let first = store.get_node(&ids[0])?.unwrap();
                for id in &ids {
                    let next = store.get_node(id)?.unwrap();
                    assert!(Arc::ptr_eq(
                        first.rust_impl.as_ref().unwrap(),
                        next.rust_impl.as_ref().unwrap()
                    ));
                }
                Ok(())
            })
            .unwrap();
        let pages: usize = conn
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .unwrap();
        let page_size: usize = conn
            .query_row("PRAGMA page_size", [], |row| row.get(0))
            .unwrap();
        eprintln!("Rust impl H={header_bytes} M={count}: source={} owner_header={header_storage} sqlite={} bytes", source.len(), pages * page_size);
        let repository = tempdir().unwrap();
        fs::write(repository.path().join("fixture.rs"), &source).unwrap();
        let facts = CodeFacts::open_with_lsp(repository.path(), &database, LspMode::Off).unwrap();
        let outline = facts.outline("fixture.rs", Some(50)).unwrap();
        assert_eq!(outline["rust_impl_owners"].as_object().unwrap().len(), 1);
        let method = outline["symbols"]
            .as_array()
            .unwrap()
            .iter()
            .find(|symbol| symbol["kind"] == "method")
            .unwrap();
        assert_eq!(public_owner(&outline, method)["trait_name"], trait_name);
        let rendered = outline.to_string();
        assert_eq!(rendered.matches(trait_name.as_str()).count(), 1);
        eprintln!(
            "Rust impl H={header_bytes} M={count}: full outline={} bytes",
            rendered.len()
        );
    }
}

#[test]
fn owner_reassignment_file_removal_and_replacement_leave_no_orphans() {
    let (nodes, _) = extract(
        "struct P; impl P { fn first() {} fn second() {} }",
        Language::Rust,
    );
    let methods = nodes
        .into_iter()
        .filter(|node| node.kind == NodeKind::Method)
        .collect::<Vec<_>>();
    for writer in ["single", "batch", "replace", "delete", "preserve_incoming"] {
        let directory = tempdir().unwrap();
        let database = directory.path().join("facts.sqlite");
        let store = GraphStore::new(database.to_str().unwrap()).unwrap();
        store.upsert_nodes(&methods).unwrap();
        let conn = Connection::open(&database).unwrap();
        match writer {
            "single" => {
                for method in &methods {
                    let mut changed = method.clone();
                    changed.rust_impl = None;
                    store.upsert_node(&changed).unwrap();
                }
            }
            "batch" => {
                let mut changed = methods.clone();
                for method in &mut changed {
                    method.rust_impl = None;
                }
                store.upsert_nodes(&changed).unwrap();
            }
            "replace" => store.replace_file_data("fixture.rs", &[], &[]).unwrap(),
            "delete" => store.delete_file_nodes("fixture.rs").unwrap(),
            "preserve_incoming" => store
                .delete_file_nodes_preserving_incoming("fixture.rs")
                .unwrap(),
            _ => unreachable!(),
        }
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM rust_impl_owners", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "{writer}"
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM nodes WHERE rust_impl_owner_id IS NOT NULL",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0,
            "{writer}"
        );
    }
}

#[test]
fn read_snapshot_keeps_shared_owners_stable_and_expires_before_later_writes() {
    let (nodes, _) = extract(
        "struct P; impl P { fn first() {} fn second() {} }",
        Language::Rust,
    );
    let methods = nodes
        .into_iter()
        .filter(|node| node.kind == NodeKind::Method)
        .collect::<Vec<_>>();
    let directory = tempdir().unwrap();
    let database = directory.path().join("facts.sqlite");
    let store = GraphStore::new(database.to_str().unwrap()).unwrap();
    store.upsert_nodes(&methods).unwrap();
    let conn = Connection::open(&database).unwrap();
    store
        .with_read_snapshot(|store| {
            let first = store.get_node(&methods[0].id)?.unwrap();
            conn.execute("UPDATE rust_impl_owners SET receiver='Changed'", [])
                .unwrap();
            let second = store.get_node(&methods[1].id)?.unwrap();
            assert!(Arc::ptr_eq(
                first.rust_impl.as_ref().unwrap(),
                second.rust_impl.as_ref().unwrap()
            ));
            assert_eq!(second.rust_impl.as_ref().unwrap().receiver, "P");
            assert!(store.upsert_node(&methods[0]).is_err());
            Ok(())
        })
        .unwrap();
    assert_eq!(
        store
            .get_node(&methods[0].id)
            .unwrap()
            .unwrap()
            .rust_impl
            .unwrap()
            .receiver,
        "Changed"
    );
}

#[test]
fn failed_source_refresh_retains_previous_normalized_owners_and_references() {
    let repository = tempdir().unwrap();
    let state = tempdir().unwrap();
    let database = state.path().join("facts.sqlite");
    fs::write(
        repository.path().join("fixture.rs"),
        "impl P { fn run() {} }",
    )
    .unwrap();
    let facts = CodeFacts::open_with_lsp(repository.path(), &database, LspMode::Off).unwrap();
    let before = facts.outline("fixture.rs", Some(50)).unwrap();
    let conn = Connection::open(&database).unwrap();
    let owner_id: i64 = conn
        .query_row(
            "SELECT rust_impl_owner_id FROM nodes WHERE name='run'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    fs::write(
        repository.path().join("fixture.rs"),
        "impl Q { fn run() {} }",
    )
    .unwrap();
    conn.execute_batch("CREATE TRIGGER fail_owner_refresh BEFORE UPDATE OF value ON index_metadata WHEN OLD.key='generation' BEGIN SELECT RAISE(ABORT, 'injected owner refresh failure'); END;").unwrap();
    assert!(facts
        .refresh()
        .unwrap_err()
        .to_string()
        .contains("injected owner refresh failure"));
    assert_eq!(
        conn.query_row(
            "SELECT receiver FROM rust_impl_owners WHERE id=?1",
            [owner_id],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "P"
    );
    assert_eq!(
        conn.query_row(
            "SELECT rust_impl_owner_id FROM nodes WHERE name='run'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        owner_id
    );
    assert_eq!(
        metadata(&conn, "generation"),
        before["freshness"]["generation"]
            .as_i64()
            .unwrap()
            .to_string()
    );
    conn.execute_batch("DROP TRIGGER fail_owner_refresh")
        .unwrap();
    let after = facts.outline("fixture.rs", Some(50)).unwrap();
    assert_eq!(public_owner(&after, &after["symbols"][0])["receiver"], "Q");
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM rust_impl_owners", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn parsed_owner_reassignment_removes_the_last_old_owner_reference() {
    let (before, _) = extract("impl P { fn run() {} }", Language::Rust);
    let (after, _) = extract("impl Wrapper<P> { fn run() {} }", Language::Rust);
    assert_eq!(before[0].id, after[0].id);
    for batch in [false, true] {
        let directory = tempdir().unwrap();
        let database = directory.path().join("facts.sqlite");
        let store = GraphStore::new(database.to_str().unwrap()).unwrap();
        store.upsert_nodes(&before).unwrap();
        if batch {
            store.upsert_nodes(&after).unwrap();
        } else {
            store.upsert_node(&after[0]).unwrap();
        }
        let conn = Connection::open(&database).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM rust_impl_owners", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .get_node(&after[0].id)
                .unwrap()
                .unwrap()
                .rust_impl
                .as_ref()
                .unwrap()
                .receiver,
            "Wrapper<P>"
        );
    }
}

#[test]
fn related_test_hydration_shares_the_response_owner_snapshot() {
    let source = "impl P {\n fn target() {}\n #[test]\n fn test_target() { target(); }\n}";
    let (nodes, edges) = extract(source, Language::Rust);
    let target = nodes.iter().find(|node| node.name == "target").unwrap();
    let directory = tempdir().unwrap();
    let database = directory.path().join("facts.sqlite");
    let store = GraphStore::new(database.to_str().unwrap()).unwrap();
    store
        .replace_file_data("fixture.rs", &nodes, &edges)
        .unwrap();
    store
        .with_read_snapshot(|store| {
            let target = store.get_node(&target.id)?.unwrap();
            let tests =
                store.get_related_test_nodes(&target.id, &target.name, &target.file_path, 50)?;
            assert_eq!(tests.len(), 1);
            assert_eq!(tests[0].name, "test_target");
            assert!(Arc::ptr_eq(
                target.rust_impl.as_ref().unwrap(),
                tests[0].rust_impl.as_ref().unwrap()
            ));
            Ok(())
        })
        .unwrap();
}
