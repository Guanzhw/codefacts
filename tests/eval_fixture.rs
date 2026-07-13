use std::path::PathBuf;
use std::time::{Duration, Instant};

use codefacts::service::CodeFacts;
use tempfile::tempdir;

#[test]
fn eval_fixture_preserves_source_backed_facts_with_a_generous_performance_budget() {
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/eval-project");
    let temporary = tempdir().expect("benchmark state directory");
    let facts = CodeFacts::open(&repository, temporary.path().join("external.sqlite"))
        .expect("open source-backed facts");

    let started = Instant::now();
    let map = facts.map().expect("index fixture");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the small fixed fixture should not take multiple seconds to index"
    );
    assert_eq!(map["files"], 11);
    assert!(map["symbols"].as_u64().unwrap_or_default() >= 86);
    assert!(map["relationships"].as_u64().unwrap_or_default() >= 362);

    let search = facts.search("AuthService", None).expect("search fixture");
    assert!(search["results"].as_array().is_some_and(|results| {
        results.iter().any(|result| {
            result["name"] == "AuthService"
                && result["evidence"]["file_path"] == "src/auth/service.ts"
        })
    }));

    let expand = facts
        .expand("handleLogin", Some("src/api/handlers.ts"), None)
        .expect("expand fixture relationship");
    assert!(expand["callees"]
        .as_array()
        .is_some_and(|callees| { callees.iter().any(|callee| callee["to"]["name"] == "login") }));
}

#[test]
fn public_refresh_removes_relationships_to_changed_definitions() {
    let repository = tempdir().expect("temporary repository");
    std::fs::create_dir_all(repository.path().join("src")).expect("source directory");
    std::fs::write(
        repository.path().join("src/main.ts"),
        "export function entry() { return helper(); }\n",
    )
    .expect("caller fixture");
    let helper = repository.path().join("src/helper.ts");
    std::fs::write(&helper, "export function helper() { return 'ok'; }\n").expect("callee fixture");
    let facts = CodeFacts::open(repository.path(), repository.path().join("external.sqlite"))
        .expect("open source-backed facts");

    let initial = facts
        .expand("entry", Some("src/main.ts"), None)
        .expect("initial relationship");
    assert!(initial["callees"].as_array().is_some_and(|callees| {
        callees
            .iter()
            .any(|callee| callee["to"]["name"] == "helper")
    }));

    std::fs::write(&helper, "export function renamed() { return 'ok'; }\n")
        .expect("changed callee fixture");
    let refreshed = facts
        .expand("entry", Some("src/main.ts"), None)
        .expect("refresh after definition change");
    assert!(refreshed["callees"]
        .as_array()
        .is_some_and(|callees| callees
            .iter()
            .all(|callee| callee["to"]["name"] != "helper")));
}

#[test]
fn public_workflows_find_cpp_pointer_return_definitions() {
    let repository = tempdir().expect("temporary C++ repository");
    let source = repository.path().join("api.cpp");
    std::fs::write(
        &source,
        r#"
struct Widget {};

Widget * make_widget() {
    return nullptr;
}

Widget * load_widget() {
    return make_widget();
}
"#,
    )
    .expect("C++ fixture");
    let facts = CodeFacts::open(repository.path(), repository.path().join("external.sqlite"))
        .expect("open C++ source-backed facts");

    let search = facts
        .search("load_widget", None)
        .expect("search pointer-return definition");
    assert!(search["results"].as_array().is_some_and(|results| {
        results.iter().any(|result| {
            result["name"] == "load_widget"
                && result["evidence"]["file_path"] == "api.cpp"
                && result["evidence"]["start_line"] == 8
        })
    }));

    let expanded = facts
        .expand("load_widget", Some("api.cpp"), None)
        .expect("expand pointer-return definition");
    assert_eq!(expanded["status"], "ok");
    assert!(expanded["callees"].as_array().is_some_and(|callees| {
        callees
            .iter()
            .any(|callee| callee["to"]["name"] == "make_widget")
    }));

    let path = facts
        .path("load_widget", "make_widget", None)
        .expect("path through pointer-return definitions");
    assert_eq!(path["status"], "ok");
    assert_eq!(path["path"][0]["name"], "load_widget");
    assert_eq!(path["path"][1]["name"], "make_widget");
}
