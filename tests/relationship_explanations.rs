use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use codefacts::lsp::LspMode;
use codefacts::service::{CodeFacts, ImpactOptions};
use serde_json::{json, Value};
use tempfile::tempdir;

// A new synthetic regression, not a reproduction of an unavailable user repo.
const PYTHON: &str = r#"class First:
    def get(self, key):
        return key

class Second:
    def get(self, key):
        return key

def target():
    return 1

def direct_caller():
    target()

def test_direct():
    target()
    target()

def test_target_name_only():
    return 'target'

def lookup(mapping):
    return mapping.get('key')

def dict_lookup():
    data = {'key': 1}
    return data.get('key')

def test_receiver(mapping):
    return mapping.get('key')

def test_sink():
    return 0

def invokes_test():
    test_sink()

def test_recursive():
    test_recursive()
"#;

fn ids(values: &Value, key: &str) -> Vec<String> {
    values
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item[key].as_str().unwrap().to_owned())
        .collect()
}

fn associations_match_tests(page: &Value) {
    let tests = ids(&page["tests"], "id");
    if tests.is_empty() {
        assert!(page.get("test_associations").is_none(), "{page}");
        assert!(page.get("test_association_notes").is_none(), "{page}");
    } else {
        assert_eq!(ids(&page["test_associations"], "test_id"), tests);
        for association in page["test_associations"].as_array().unwrap() {
            assert_eq!(association["evidence"]["confidence"], "static");
            assert_eq!(association["kind"], "calls");
        }
        let note = page["test_association_notes"].as_str().unwrap();
        assert!(note.contains("only rank"), "{note}");
        assert!(
            note.contains("does not establish execution or coverage"),
            "{note}"
        );
    }
}

fn edge_snapshot(database: &Path) -> Vec<Value> {
    let connection = rusqlite::Connection::open(database).unwrap();
    let mut statement = connection
        .prepare("SELECT id, source_id, target_id, type, file_path, line, properties FROM edges ORDER BY source_id, target_id, type, file_path, line, id")
        .unwrap();
    statement
        .query_map([], |row| {
            Ok(
                json!({"id":row.get::<_, i64>(0)?, "from":row.get::<_, String>(1)?,
                "to":row.get::<_, String>(2)?, "kind":row.get::<_, String>(3)?,
                "file":row.get::<_, String>(4)?, "line":row.get::<_, i64>(5)?,
                "properties":row.get::<_, Option<String>>(6)?}),
            )
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

#[test]
fn python_test_associations_explain_adjacency_without_changing_static_facts() {
    let root = tempdir().unwrap();
    let state = tempdir().unwrap();
    fs::write(root.path().join("app.py"), PYTHON).unwrap();
    let database = state.path().join("facts.sqlite");
    let facts = CodeFacts::open_with_lsp(root.path(), &database, LspMode::Off).unwrap();
    let target = facts.expand("target", None, Some(50)).unwrap();
    let before = edge_snapshot(&database);
    assert_eq!(target["callers"].as_array().unwrap().len(), 3);
    assert_eq!(target["tests"].as_array().unwrap().len(), 1);
    assert_eq!(target["tests"][0]["name"], "test_direct");
    assert_eq!(
        target["test_associations"][0]["direction"],
        "test_to_symbol"
    );
    assert!(target.get("relationship_notes").is_none());
    associations_match_tests(&target);
    let direct = facts.expand("test_direct", None, Some(50)).unwrap();
    assert_eq!(direct["callees"].as_array().unwrap().len(), 2);
    assert!(direct["callees"].as_array().unwrap().iter().all(|edge| {
        edge["to"]["name"] == "target" && edge["evidence"]["confidence"] == "static"
    }));
    assert!(facts
        .expand("test_target_name_only", None, Some(50))
        .unwrap()["callees"]
        .as_array()
        .unwrap()
        .is_empty());
    let reverse = facts.expand("invokes_test", None, Some(50)).unwrap();
    associations_match_tests(&reverse);
    assert_eq!(reverse["tests"][0]["name"], "test_sink");
    assert_eq!(
        reverse["test_associations"][0]["direction"],
        "symbol_to_test"
    );
    let recursive = facts.expand("test_recursive", None, Some(50)).unwrap();
    associations_match_tests(&recursive);
    assert_eq!(recursive["tests"].as_array().unwrap().len(), 1);
    assert_eq!(recursive["test_associations"][0]["direction"], "self");

    let outline = facts.outline("app.py", Some(50)).unwrap();
    for method in outline["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|node| node["name"] == "get")
    {
        let id = method["id"].as_str().unwrap();
        let expanded = facts.expand(id, None, Some(50)).unwrap();
        assert_eq!(expanded["callers"].as_array().unwrap().len(), 3);
        assert!(expanded["callers"].as_array().unwrap().iter().all(|edge| {
            edge["evidence"]["confidence"] == "heuristic" && edge["resolution"] == "polymorphic"
        }));
        assert!(expanded["tests"].as_array().unwrap().is_empty());
        associations_match_tests(&expanded);
        assert_eq!(
            facts.path("test_receiver", id, Some(50)).unwrap()["status"],
            "no_static_path"
        );
        assert!(facts
            .impact(ImpactOptions {
                symbol: id,
                file_path: None,
                max_depth: None,
                limit: Some(50)
            })
            .unwrap()["affected"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    let calls = before
        .iter()
        .filter(|edge| edge["kind"] == "calls")
        .collect::<Vec<_>>();
    assert_eq!(calls.len(), 11);
    assert_eq!(
        edge_snapshot(&database),
        before,
        "explanations must not mutate stored facts"
    );
}

struct Mcp {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    sequence: usize,
}

impl Mcp {
    fn new(root: &Path, database: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_codefacts"))
            .args([
                "mcp",
                "--tools",
                "all",
                "--root",
                root.to_str().unwrap(),
                "--state",
                database.to_str().unwrap(),
                "--lsp",
                "off",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            input,
            output,
            sequence: 0,
        }
    }

    fn call(&mut self, name: &str, arguments: Value) -> Value {
        self.sequence += 1;
        writeln!(
            self.input,
            "{}",
            json!({"jsonrpc":"2.0", "id":self.sequence,
            "method":"tools/call", "params":{"name":name, "arguments":arguments}})
        )
        .unwrap();
        self.input.flush().unwrap();
        let mut line = String::new();
        assert!(self.output.read_line(&mut line).unwrap() > 0);
        let response: Value = serde_json::from_str(&line).unwrap();
        assert!(response.get("error").is_none(), "{response}");
        let result = response["result"].clone();
        assert_eq!(result["isError"], false, "{result}");
        result
    }
}

impl Drop for Mcp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn body(result: &Value) -> Value {
    let body = result["structuredContent"].clone();
    assert_eq!(
        serde_json::from_str::<Value>(result["content"][0]["text"].as_str().unwrap()).unwrap(),
        body
    );
    body
}

fn relation_keys(page: &Value) -> Vec<Value> {
    page["callees"].as_array().unwrap().iter().map(|edge| json!({
        "kind":edge["kind"], "from":edge.get("from").map(|node| node["id"].clone()).unwrap_or_else(||page["definition"]["id"].clone()),
        "to":edge["to"]["id"], "file":edge["evidence"]["file_path"],
        "line":edge["evidence"]["start_line"], "confidence":edge["evidence"]["confidence"], "resolution":edge["resolution"]
    })).collect()
}

#[test]
fn python_receiver_explanations_are_honest_in_full_compact_and_default_markdown() {
    for multiple in [false, true] {
        let root = tempdir().unwrap();
        let state = tempdir().unwrap();
        let source = if multiple {
            PYTHON.to_owned()
        } else {
            PYTHON.replace(
                "class Second:\n    def get(self, key):\n        return key\n\n",
                "",
            )
        };
        fs::write(root.path().join("app.py"), source).unwrap();
        let mut mcp = Mcp::new(root.path(), &state.path().join("facts.sqlite"));
        let full = body(&mcp.call("expand", json!({"symbol":"lookup", "format":"full"})));
        let compact = body(&mcp.call("expand", json!({"symbol":"lookup", "format":"compact"})));
        assert_eq!(relation_keys(&full), relation_keys(&compact));
        assert_eq!(
            full["callees"].as_array().unwrap().len(),
            if multiple { 2 } else { 1 }
        );
        let reason = if multiple {
            "polymorphic"
        } else {
            "unresolved_receiver"
        };
        assert_eq!(full["relationship_notes"], compact["relationship_notes"]);
        assert!(full["relationship_notes"][reason]
            .as_str()
            .unwrap()
            .contains("receiver is not statically bound"));
        assert!(full["callees"]
            .as_array()
            .unwrap()
            .iter()
            .all(|edge| edge["evidence"]["confidence"] == "heuristic"
                && edge["resolution"] == reason));
        let markdown = mcp.call("expand", json!({"symbol":"lookup"}));
        assert!(markdown.get("structuredContent").is_none());
        let text = markdown["content"][0]["text"].as_str().unwrap();
        for expected in [
            "candidate",
            "heuristic",
            reason,
            "receiver is not statically bound",
        ] {
            assert!(text.contains(expected), "missing {expected}: {text}");
        }
        let static_page =
            body(&mcp.call("expand", json!({"symbol":"test_direct", "format":"full"})));
        assert!(static_page.get("relationship_notes").is_none());
        for format in ["full", "compact"] {
            let page = body(&mcp.call("expand", json!({"symbol":"target", "format":format})));
            associations_match_tests(&page);
        }
        let markdown = mcp.call("expand", json!({"symbol":"target"}));
        let text = markdown["content"][0]["text"].as_str().unwrap();
        for expected in [
            "test_to_symbol",
            "test_associations",
            "only rank",
            "does not establish execution or coverage",
        ] {
            assert!(text.contains(expected), "missing {expected}: {text}");
        }
        let context = body(&mcp.call(
            "search",
            json!({"query":"target", "detail":"context", "format":"full"}),
        ));
        let entry = context["context_entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["symbol"]["name"] == "target")
            .unwrap();
        associations_match_tests(entry);
    }
}

#[test]
fn test_witnesses_follow_visible_test_pages_and_preserve_continuation_order() {
    let root = tempdir().unwrap();
    let state = tempdir().unwrap();
    let mut source = String::from("def target():\n    return 1\n\n");
    for index in 0..61 {
        source.push_str(&format!("def test_target_{index:03}():\n    target()\n\n"));
    }
    fs::write(root.path().join("app.py"), source).unwrap();
    let mut mcp = Mcp::new(root.path(), &state.path().join("facts.sqlite"));
    let mut expected = Vec::new();
    for format in ["full", "compact"] {
        let mut collected = Vec::new();
        let mut cursor = None;
        for _ in 0..100 {
            let page = body(&mcp.call(
                "expand",
                json!({"symbol":"target", "section":"tests", "limit":50,
                "cursor":cursor, "format":format}),
            ));
            associations_match_tests(&page);
            assert!(page.get("callers").is_none());
            assert!(page.get("relationship_notes").is_none());
            collected.extend(ids(&page["tests"], "id"));
            if format == "compact" {
                assert!(page.to_string().len() <= 16_384);
            }
            cursor = page["next"]["tests"].as_str().map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        assert!(cursor.is_none(), "pagination must terminate");
        assert_eq!(collected.len(), 61);
        if format == "full" {
            expected = collected;
        } else {
            assert_eq!(collected, expected);
        }
    }
    let markdown = mcp.call(
        "expand",
        json!({"symbol":"target", "section":"tests", "limit":50}),
    );
    let text = markdown["content"][0]["text"].as_str().unwrap();
    assert!(text.len() <= 16_384);
    assert!(text.contains("test_associations"));
    assert!(text.contains("only rank"));
}
