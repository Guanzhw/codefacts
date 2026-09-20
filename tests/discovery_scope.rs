use std::collections::BTreeSet;
use std::fs;

use codefacts::service::{CodeFacts, SymbolScope};
use codefacts::types::NodeKind;
use rusqlite::Connection;
use serde_json::Value;
use tempfile::tempdir;

fn names(value: &Value, key: &str) -> BTreeSet<String> {
    value[key]
        .as_array()
        .expect("symbol array")
        .iter()
        .map(|node| node["name"].as_str().expect("symbol name").to_string())
        .collect()
}

#[test]
fn discovery_excludes_js_ts_callback_locals_and_retains_them_in_all_scope() {
    let repository = tempdir().unwrap();
    let source = r#"
export function renderSessionsPage() { return "page"; }
const moduleResult = renderSessionsPage();
test("arrow callback", () => {
    const arrowResult = renderSessionsPage();
});
test("function callback", function () {
    const expressionResult = renderSessionsPage();
});
test("generator callback", function* () {
    const generatorResult = renderSessionsPage();
    yield generatorResult;
});
function named() {
    const namedResult = renderSessionsPage();
}
const assigned = () => {
    const assignedResult = renderSessionsPage();
};
class View {
    render() {
        const methodResult = renderSessionsPage();
    }
}
const afterResult = renderSessionsPage();
"#;
    for extension in ["js", "jsx", "ts", "tsx"] {
        fs::write(repository.path().join(format!("view.{extension}")), source).unwrap();
    }
    let facts = CodeFacts::open(repository.path(), repository.path().join("index.sqlite")).unwrap();
    let top_names = BTreeSet::from(["moduleResult".to_string(), "afterResult".to_string()]);
    let local_names = BTreeSet::from([
        "arrowResult".to_string(),
        "expressionResult".to_string(),
        "generatorResult".to_string(),
        "namedResult".to_string(),
        "assignedResult".to_string(),
        "methodResult".to_string(),
    ]);
    let all_names = top_names.union(&local_names).cloned().collect();

    for extension in ["js", "jsx", "ts", "tsx"] {
        let file = format!("view.{extension}");
        // A prefix that occurs in variable initializers takes the FTS path.
        let search = facts
            .search_with_options(
                "renderSessions",
                Some(NodeKind::Variable),
                Some(&file),
                0,
                Some(30),
            )
            .unwrap();
        assert_eq!(
            names(&search, "results"),
            top_names,
            "{extension}: FTS scope"
        );

        let outline = facts.outline(&file, Some(30)).unwrap();
        let outline_names = names(&outline, "symbols");
        assert!(top_names.is_subset(&outline_names));
        assert!(local_names.is_disjoint(&outline_names));

        let all = facts
            .outline_with_page_scope_options(
                &file,
                Some(NodeKind::Variable),
                SymbolScope::All,
                0,
                None,
                Some(30),
            )
            .unwrap();
        assert_eq!(
            names(&all, "symbols"),
            all_names,
            "{extension}: complete outline"
        );

        // Exact-name search bypasses FTS, so verify it uses the same scope.
        let exact = facts
            .search_with_options("arrowResult", None, Some(&file), 0, Some(5))
            .unwrap();
        assert!(names(&exact, "results").is_empty());
        let exact_all = facts
            .search_with_page_scope_options(
                "arrowResult",
                None,
                Some(&file),
                SymbolScope::All,
                0,
                None,
                Some(5),
            )
            .unwrap();
        assert_eq!(
            names(&exact_all, "results"),
            BTreeSet::from(["arrowResult".to_string()])
        );
    }
}

#[test]
fn old_scope_facts_are_reextracted_once_even_when_source_is_unchanged() {
    let repository = tempdir().unwrap();
    fs::write(
        repository.path().join("test.js"),
        "test('callback', () => { const localResult = renderSessionsPage(); });\n",
    )
    .unwrap();
    let state = repository.path().join("index.sqlite");
    {
        let facts = CodeFacts::open(repository.path(), &state).unwrap();
        facts.map().unwrap();
    }
    // Recreate the previous extractor's persisted facts without changing the
    // source hashes. Reopening must regenerate the missing lexical scope.
    let old = Connection::open(&state).unwrap();
    old.execute(
        "UPDATE nodes SET metadata = json_remove(metadata, '$.local')",
        [],
    )
    .unwrap();
    old.execute(
        "UPDATE index_metadata SET value = '4' WHERE key = 'fact_extraction_version'",
        [],
    )
    .unwrap();
    drop(old);

    let facts = CodeFacts::open(repository.path(), &state).unwrap();
    let rebuilt = facts.search("localResult", Some(5)).unwrap();
    assert_eq!(rebuilt["freshness"]["files_indexed"], 1);
    assert!(names(&rebuilt, "results").is_empty());
    let all = facts
        .search_with_page_scope_options(
            "localResult",
            None,
            None,
            SymbolScope::All,
            0,
            None,
            Some(5),
        )
        .unwrap();
    assert_eq!(all["freshness"]["files_indexed"], 0);
    assert_eq!(
        names(&all, "results"),
        BTreeSet::from(["localResult".to_string()])
    );
}
