//! Workflow-owned human projections. The Markdown renderer remains generic:
//! it emits every value supplied here, without guessing which facts matter.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};

use super::hide_hashes_and_nulls;

pub(super) fn project(workflow: &str, mut value: Value) -> Value {
    hide_hashes_and_nulls(&mut value);
    let ids = disambiguated_ids(&value);
    let fields = value.as_object_mut().expect("workflow result object");
    if let Some(freshness) = fields.remove("freshness") {
        fields.insert("freshness".into(), freshness["status"].clone());
        fields.insert(
            "repository_root".into(),
            freshness["repository_root"].clone(),
        );
        fields.insert("generation".into(), freshness["generation"].clone());
        let reasons: Map<String, Value> = [
            "files_too_large",
            "files_unreadable",
            "files_parse_failed",
            "files_extract_failed",
            "files_failed",
        ]
        .into_iter()
        .filter_map(|name| {
            freshness
                .get(name)
                .filter(|count| count.as_u64() != Some(0))
                .map(|count| (name.into(), count.clone()))
        })
        .collect();
        if !reasons.is_empty() {
            fields.insert("partial_files".into(), Value::Object(reasons));
        }
    }
    // These are presentation metadata, never source facts.
    fields.remove("format");
    if fields
        .get("next")
        .is_some_and(|value| value.as_object().is_some_and(Map::is_empty))
    {
        fields.remove("next");
    }
    if let Some(matches) = fields.get_mut("matches") {
        symbol_list(matches, None, &ids, true);
    }
    match workflow {
        "map" => {
            fields.remove("files_indexed_this_refresh");
            if let Some(report) = fields.get_mut("unresolved_references") {
                unresolved_references(report);
            }
        }
        "search" => search(fields, &ids),
        "outline" => {
            let file = fields
                .get("file_path")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if let Some(symbols) = fields.get_mut("symbols") {
                symbol_list(symbols, file.as_deref(), &ids, false);
            }
        }
        "expand" => neighborhood(fields, &ids),
        "impact" => impact(fields, &ids),
        "path" => path(fields, &ids),
        _ => unreachable!("human projection requires a known structured workflow"),
    }
    value
}

// A visible same-name/file collision needs exact selection IDs even when line
// ranges differ. Ambiguous resolution candidates always retain their IDs.
fn disambiguated_ids(value: &Value) -> HashSet<String> {
    fn visit(value: &Value, groups: &mut HashMap<(String, String), HashSet<String>>) {
        match value {
            Value::Object(fields) => {
                if let (Some(id), Some(name), Some(file)) = (
                    fields.get("id").and_then(Value::as_str),
                    fields.get("name").and_then(Value::as_str),
                    fields
                        .get("evidence")
                        .and_then(|v| v.get("file_path"))
                        .and_then(Value::as_str),
                ) {
                    groups
                        .entry((name.into(), file.into()))
                        .or_default()
                        .insert(id.into());
                }
                for value in fields.values() {
                    visit(value, groups);
                }
            }
            Value::Array(values) => {
                for value in values {
                    visit(value, groups);
                }
            }
            _ => {}
        }
    }
    let mut groups = HashMap::new();
    visit(value, &mut groups);
    groups
        .into_values()
        .filter(|ids| ids.len() > 1)
        .flatten()
        .collect()
}

fn locator(evidence: &Value, shared_file: Option<&str>) -> String {
    let file = evidence["file_path"].as_str().expect("evidence file");
    let mut at = if Some(file) == shared_file {
        String::new()
    } else {
        file.to_owned()
    };
    if let Some(start) = evidence.get("start_line").and_then(Value::as_u64) {
        if !at.is_empty() {
            at.push(':');
        }
        at.push_str(&start.to_string());
        if let Some(end) = evidence
            .get("end_line")
            .and_then(Value::as_u64)
            .filter(|end| *end != start)
        {
            at.push('-');
            at.push_str(&end.to_string());
        }
    }
    at
}

fn evidence_details(fields: &mut Map<String, Value>, evidence: &Value, edge: bool) {
    if let Some(confidence) = evidence.get("confidence").and_then(Value::as_str) {
        if edge || confidence != "confirmed" {
            fields.insert("confidence".into(), json!(confidence));
        }
    }
    if let Some(extractor) = evidence.get("extractor").and_then(Value::as_str) {
        if extractor != "tree-sitter" {
            fields.insert("extractor".into(), json!(extractor));
        }
    }
}

fn symbol(
    value: &Value,
    shared_file: Option<&str>,
    ids: &HashSet<String>,
    force_id: bool,
) -> Value {
    let selector = value["name"].as_str().expect("symbol name");
    let name = value["qualified_name"].as_str().unwrap_or(selector);
    let mut fields = Map::new();
    fields.insert(
        "symbol".into(),
        json!(format!(
            "{} {name}",
            value["kind"].as_str().expect("symbol kind")
        )),
    );
    fields.insert(
        if shared_file.is_some() { "lines" } else { "at" }.into(),
        json!(locator(&value["evidence"], shared_file)),
    );
    let id = value["id"].as_str().expect("symbol id");
    if force_id || ids.contains(id) {
        fields.insert("id".into(), json!(id));
    } else if name != selector {
        // Qualification is useful reading context, while resolve_symbol accepts
        // the indexed raw name (or exact ID) as its follow-up selector.
        fields.insert("selector".into(), json!(selector));
    }
    evidence_details(&mut fields, &value["evidence"], false);
    Value::Object(fields)
}

fn symbol_ref(value: &Value, ids: &HashSet<String>) -> String {
    let projected = symbol(value, None, ids, false);
    let mut text = format!(
        "{} @ {}",
        projected["symbol"].as_str().unwrap(),
        projected["at"].as_str().unwrap()
    );
    if let Some(id) = projected.get("id").and_then(Value::as_str) {
        text.push_str(&format!(" [{id}]"));
    } else if let Some(selector) = projected.get("selector").and_then(Value::as_str) {
        text.push_str(&format!(" [selector: {selector}]"));
    }
    text
}

fn symbol_list(value: &mut Value, file: Option<&str>, ids: &HashSet<String>, force_ids: bool) {
    for value in value.as_array_mut().expect("symbol list") {
        *value = symbol(value, file, ids, force_ids);
    }
}

fn edge(value: &Value) -> Map<String, Value> {
    let mut fields = Map::new();
    if let Some(kind) = value.get("kind") {
        fields.insert("kind".into(), kind.clone());
    }
    fields.insert("callsite".into(), json!(locator(&value["evidence"], None)));
    evidence_details(&mut fields, &value["evidence"], true);
    if let Some(resolution) = value.get("resolution") {
        fields.insert("resolution".into(), resolution.clone());
    }
    fields
}

fn relationships(value: &mut Value, counterpart: &str, ids: &HashSet<String>) {
    for value in value.as_array_mut().expect("relationship list") {
        let mut fields = edge(value);
        // Counterpart definition and actual callsite are independent locations.
        fields.insert(
            counterpart.into(),
            json!(symbol_ref(&value[counterpart], ids)),
        );
        let mut details = Map::new();
        evidence_details(&mut details, &value[counterpart]["evidence"], false);
        for (name, value) in details {
            fields.insert(format!("{counterpart}_{name}"), value);
        }
        *value = Value::Object(fields);
    }
}

fn neighborhood(fields: &mut Map<String, Value>, ids: &HashSet<String>) {
    if let Some(definition) = fields.get_mut("definition") {
        *definition = symbol(definition, None, ids, false);
    }
    for (section, counterpart) in [("callers", "from"), ("callees", "to")] {
        if let Some(edges) = fields.get_mut(section) {
            relationships(edges, counterpart, ids);
        }
    }
    if let Some(references) = fields.get_mut("references").and_then(Value::as_object_mut) {
        for (section, counterpart) in [("inbound", "from"), ("outbound", "to")] {
            if let Some(edges) = references.get_mut(section) {
                relationships(edges, counterpart, ids);
            }
        }
        if let Some(semantic) = references
            .get_mut("semantic")
            .and_then(Value::as_object_mut)
        {
            if let Some(locations) = semantic.get_mut("locations").and_then(Value::as_array_mut) {
                for location in locations {
                    let mut fields = Map::new();
                    fields.insert("at".into(), json!(locator(&location["evidence"], None)));
                    for name in ["start_column", "end_column"] {
                        fields.insert(name.into(), location[name].clone());
                    }
                    evidence_details(&mut fields, &location["evidence"], true);
                    *location = Value::Object(fields);
                }
            }
        }
    }
    if let Some(tests) = fields.get_mut("tests") {
        symbol_list(tests, None, ids, false);
    }
    let duplicate_section = fields
        .get("source")
        .zip(fields.get("markdown_section"))
        .is_some_and(|(source, section)| {
            source["status"] == "ok"
                && source["start_line"] == section["start_line"]
                && source["definition_end_line"] == section["end_line"]
                && source["text"]
                    .as_str()
                    .zip(section["content"].as_str())
                    .is_some_and(|(text, content)| text.starts_with(content))
        });
    if duplicate_section {
        fields.remove("markdown_section");
    }
    if let Some(source) = fields.get_mut("source").and_then(Value::as_object_mut) {
        source.remove("byte_length");
        if source.get("status").and_then(Value::as_str) == Some("ok") {
            // The selected symbol owns the full source span. A clipped excerpt
            // additionally needs its delivered range; a complete one does not.
            if source.get("truncated").and_then(Value::as_bool) == Some(true) {
                let start = source["start_line"].as_u64().expect("source start line");
                let end = source["end_line"].as_u64().expect("source end line");
                source.insert(
                    "returned_lines".into(),
                    json!(if start == end {
                        start.to_string()
                    } else {
                        format!("{start}-{end}")
                    }),
                );
            }
            for name in ["start_line", "end_line", "definition_end_line"] {
                source.remove(name);
            }
        }
    }
}

fn search(fields: &mut Map<String, Value>, ids: &HashSet<String>) {
    let ranks: HashMap<String, usize> = fields
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(i, result)| (result["id"].as_str().expect("result id").into(), i + 1))
        .collect();
    if let Some(entries) = fields
        .get_mut("context_entries")
        .and_then(Value::as_array_mut)
    {
        for entry in entries {
            let entry = entry.as_object_mut().expect("context entry");
            let anchor = entry.remove("symbol").expect("context symbol");
            entry.insert(
                "result".into(),
                json!(ranks[anchor["id"].as_str().unwrap()]),
            );
            neighborhood(entry, ids);
        }
    }
    if let Some(results) = fields.get_mut("results") {
        symbol_list(results, None, ids, false);
    }
}

fn impact(fields: &mut Map<String, Value>, ids: &HashSet<String>) {
    if !fields.contains_key("affected") {
        return;
    }
    let tests: HashSet<String> = fields["tests"]
        .as_array()
        .expect("impact tests")
        .iter()
        .map(|entry| entry["symbol"]["id"].as_str().expect("test id").to_owned())
        .collect();
    let mut test_entries = Vec::new();
    for (index, entry) in fields
        .get_mut("affected")
        .unwrap()
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        let node = &entry["symbol"];
        let is_test = tests.contains(node["id"].as_str().unwrap());
        let mut row = symbol(node, None, ids, false).as_object().unwrap().clone();
        row.insert("entry".into(), json!(index + 1));
        row.insert("distance".into(), entry["distance"].clone());
        row.insert("test_associated".into(), json!(is_test));
        row.insert("direction".into(), entry["witness_direction"].clone());
        let parent = if entry["witness_direction"] == "forward" {
            "from"
        } else {
            "to"
        };
        row.insert(
            "parent".into(),
            json!(symbol_ref(&entry["witness"][parent], ids)),
        );
        let evidence = edge(&entry["witness"]);
        let mut witness = format!(
            "{} @ {}",
            evidence["kind"].as_str().unwrap(),
            evidence["callsite"].as_str().unwrap()
        );
        for name in ["confidence", "extractor", "resolution"] {
            if let Some(value) = evidence.get(name).and_then(Value::as_str) {
                witness.push_str(&format!("; {name}={value}"));
            }
        }
        row.insert("witness".into(), json!(witness));
        if is_test {
            test_entries.push(json!(index + 1));
        }
        *entry = Value::Object(row);
    }
    fields.insert("tests".into(), json!({"affected_entries": test_entries}));
    if let Some(definition) = fields.get_mut("definition") {
        *definition = symbol(definition, None, ids, false);
    }
    // The service's message already states scope, hop cost, import anchors,
    // extraction gaps, runtime uncertainty and the meaning of test association.
    fields.remove("scope");
    fields.remove("relationship_kinds");
    if let Some(traversal) = fields.get_mut("traversal").and_then(Value::as_object_mut) {
        traversal.remove("edges_examined");
        for name in [
            "depth_limit_reached",
            "node_limit_reached",
            "edge_limit_reached",
        ] {
            if traversal.get(name).and_then(Value::as_bool) == Some(false) {
                traversal.remove(name);
            }
        }
    }
}

fn path(fields: &mut Map<String, Value>, ids: &HashSet<String>) {
    if let Some(nodes) = fields.get_mut("path") {
        symbol_list(nodes, None, ids, false);
    }
    for name in ["from", "to"] {
        if let Some(node) = fields.get_mut(name) {
            *node = symbol(node, None, ids, false);
        }
    }
    if let Some(edges) = fields
        .get_mut("relationships")
        .and_then(Value::as_array_mut)
    {
        for (i, relationship) in edges.iter_mut().enumerate() {
            let mut row = edge(relationship);
            row.insert("hop".into(), json!(format!("{} -> {}", i + 1, i + 2)));
            *relationship = Value::Object(row);
        }
    }
}

fn unresolved_references(value: &mut Value) {
    if let Some(sample) = value.get_mut("samples").and_then(Value::as_array_mut) {
        for reference in sample {
            let reference = reference.as_object_mut().expect("unresolved reference");
            let evidence = reference.remove("evidence").expect("reference evidence");
            reference.insert("at".into(), json!(locator(&evidence, None)));
            evidence_details(reference, &evidence, true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presentation::{markdown, Format};

    fn symbol_fact(name: &str, file: &str, line: u32) -> Value {
        json!({
            "id": format!("function:{file}:{name}:{line}"), "name": name,
            "qualified_name": null, "kind": "function", "language": "rust",
            "evidence": {"file_path":file, "start_line":line, "end_line":line + 1,
                "source_hash":"full-fingerprint", "extractor":"tree-sitter", "confidence":"confirmed"}
        })
    }

    fn relation(from: &Value, to: &Value, line: u32) -> Value {
        json!({"kind":"calls", "from":from, "to":to,
            "evidence":{"file_path":"caller.rs", "start_line":line, "end_line":line,
                "source_hash":"callsite-fingerprint", "extractor":"tree-sitter", "confidence":"static"}})
    }

    #[test]
    fn human_scope_hides_routine_refresh_metadata_while_machine_exports_keep_hashes() {
        let canonical = json!({"freshness":{"repository_root":"D:/repo", "generation":7,
            "status":"partial", "files_indexed":2, "files_unchanged":3, "duration_ms":8,
            "files_unreadable":1, "files_parse_failed":0}, "symbols":[symbol_fact("entry", "lib.rs", 2)],
            "file_path":"lib.rs", "scope":"top_level", "truncated":false});
        let human = Format::Markdown.present_for("outline", canonical.clone());
        assert_eq!(human["freshness"], "partial");
        assert_eq!(human["repository_root"], "D:/repo");
        assert_eq!(human["generation"], 7);
        assert_eq!(human["partial_files"], json!({"files_unreadable":1}));
        assert_eq!(
            human["symbols"][0],
            json!({"symbol":"function entry", "lines":"2-3"})
        );
        let text = markdown(&human);
        assert_eq!(text.matches("lib.rs").count(), 1);
        assert!(!text.contains("fingerprint"));
        assert!(!text.contains("format:"));
        let compact = Format::Compact.present_for("outline", canonical.clone());
        assert_eq!(compact["source_hashes"]["lib.rs"], "full-fingerprint");
        assert!(compact["symbols"][0]["id"].is_string());
        assert_eq!(
            Format::Full.present_for("outline", canonical.clone()),
            canonical
        );
    }

    #[test]
    fn exact_ids_survive_ambiguity_and_same_file_overloads() {
        let mut first = symbol_fact("entry", "lib.rs", 2);
        first["qualified_name"] = json!("First::entry");
        let mut second = symbol_fact("entry", "lib.rs", 20);
        second["qualified_name"] = json!("Second::entry");
        let page = project("search", json!({"results":[first.clone(), second.clone()]}));
        assert_eq!(page["results"][0]["id"], first["id"]);
        assert_eq!(page["results"][1]["id"], second["id"]);
        assert!(page["results"][0].get("selector").is_none());
        assert!(page["results"][1].get("selector").is_none());
        let ids = disambiguated_ids(&json!([first.clone(), second.clone()]));
        assert!(symbol_ref(&first, &ids).contains(first["id"].as_str().unwrap()));
        assert!(!symbol_ref(&first, &ids).contains("selector:"));
        let ambiguous = project(
            "expand",
            json!({"status":"ambiguous", "matches":[first.clone()]}),
        );
        assert_eq!(ambiguous["matches"][0]["id"], first["id"]);
    }

    #[test]
    fn qualified_method_and_nested_heading_expose_a_working_raw_selector() {
        use crate::{lsp::LspMode, service::CodeFacts};

        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("widget.py"),
            "class Widget:\n    def run(self):\n        return 1\n",
        )
        .unwrap();
        std::fs::write(
            root.path().join("README.md"),
            "# Guide\n\n## Install\nDo it.\n",
        )
        .unwrap();
        let facts =
            CodeFacts::open_with_lsp(root.path(), state.path().join("facts.sqlite"), LspMode::Off)
                .unwrap();
        for (file, raw_name, qualified_name) in [
            ("widget.py", "run", "Widget.run"),
            ("README.md", "Install", "Guide > Install"),
        ] {
            let outline = facts.outline(file, Some(20)).unwrap();
            let canonical = outline["symbols"]
                .as_array()
                .unwrap()
                .iter()
                .find(|node| node["name"] == raw_name)
                .unwrap();
            assert_eq!(canonical["qualified_name"], qualified_name);
            let projected = project("outline", outline.clone());
            let displayed = projected["symbols"]
                .as_array()
                .unwrap()
                .iter()
                .find(|node| node["selector"] == raw_name)
                .unwrap();
            assert!(displayed["symbol"]
                .as_str()
                .unwrap()
                .contains(qualified_name));
            assert!(displayed.get("id").is_none());
            let selector = displayed["selector"].as_str().unwrap();
            assert_eq!(
                facts.expand(selector, Some(file), Some(20)).unwrap()["status"],
                "ok"
            );
            assert_eq!(
                facts.expand(qualified_name, Some(file), Some(20)).unwrap()["status"],
                "not_found"
            );
            assert!(
                symbol_ref(canonical, &HashSet::new()).contains(&format!("[selector: {raw_name}]"))
            );
        }
    }

    #[test]
    fn search_contexts_reference_independent_results_and_keep_site_uncertainty() {
        let first = symbol_fact("first", "first.rs", 1);
        let second = symbol_fact("second", "second.rs", 10);
        let mut candidate = symbol_fact("target", "target.rs", 40);
        candidate["qualified_name"] = json!("Owner::target");
        candidate["evidence"]["confidence"] = json!("heuristic");
        let mut uncertain = relation(&first, &candidate, 3);
        uncertain["resolution"] = json!("receiver_unresolved");
        uncertain["evidence"]["extractor"] = json!("name-candidate");
        uncertain["evidence"]["confidence"] = json!("heuristic");
        let second_relation = relation(&second, &candidate, 12);
        let page = project(
            "search",
            json!({"query":"target", "results":[first.clone(), second.clone()],
            "context_entries":[
                {"symbol":first, "callees":[uncertain], "source":{"status":"unavailable", "message":"read failed"}},
                {"symbol":second, "callees":[second_relation], "source":{"status":"ok", "text":"source", "start_line":10, "end_line":10, "definition_end_line":11, "truncated":true}}
            ], "context_entries_truncated":true, "next_cursor":"page-cursor"}),
        );
        assert_eq!(page["context_entries"][0]["result"], 1);
        assert_eq!(page["context_entries"][1]["result"], 2);
        assert!(page["context_entries"][0].get("symbol").is_none());
        let edge = &page["context_entries"][0]["callees"][0];
        assert_eq!(edge["callsite"], "caller.rs:3");
        assert_eq!(edge["confidence"], "heuristic");
        assert_eq!(edge["resolution"], "receiver_unresolved");
        assert_eq!(edge["extractor"], "name-candidate");
        assert_eq!(edge["to_confidence"], "heuristic");
        assert_eq!(
            page["context_entries"][1]["callees"][0]["confidence"],
            "static"
        );
        let text = markdown(&page);
        assert!(text.contains("Owner::target @ target.rs:40-41"));
        assert!(text.contains("read failed"));
        assert!(text.contains("page-cursor"));
        assert!(page["context_entries"][1]["source"]["truncated"]
            .as_bool()
            .unwrap());
        assert_eq!(page["context_entries"][1]["source"]["returned_lines"], "10");
        assert!(page["context_entries_truncated"].as_bool().unwrap());
    }

    #[test]
    fn impact_keeps_reconstructable_directions_test_references_and_file_anchors() {
        let root = symbol_fact("Container", "lib.rs", 1);
        let member = symbol_fact("member", "lib.rs", 4);
        let test = symbol_fact("test_member", "tests.rs", 3);
        let file = json!({"id":"file:import.rs", "name":"import.rs", "kind":"file", "language":"rust",
            "evidence":{"file_path":"import.rs", "extractor":"index-file-snapshot", "confidence":"confirmed"}});
        let mut contains = relation(&root, &member, 1);
        contains["kind"] = json!("contains");
        let test_entry = json!({"symbol":test, "distance":2, "witness_direction":"reverse", "witness":relation(&test, &member, 5)});
        let mut imports = relation(&file, &member, 9);
        imports["kind"] = json!("imports");
        let page = project(
            "impact",
            json!({"definition":root, "affected":[
            {"symbol":member, "distance":1, "witness_direction":"forward", "witness":contains},
            test_entry.clone(), {"symbol":file, "distance":2, "witness_direction":"reverse", "witness":imports}],
            "tests":[test_entry], "scope":{"hop_cost":1}, "relationship_kinds":["calls", "contains"],
            "traversal":{"depth_limit_reached":true}, "truncated":true, "message":"Static extraction can omit dependencies; tests are test-associated symbols."}),
        );
        assert_eq!(page["tests"], json!({"affected_entries":[2]}));
        assert_eq!(page["affected"][0]["direction"], "forward");
        assert_eq!(
            page["affected"][0]["parent"],
            "function Container @ lib.rs:1-2"
        );
        assert_eq!(page["affected"][1]["direction"], "reverse");
        assert_eq!(
            page["affected"][1]["parent"],
            "function member @ lib.rs:4-5"
        );
        assert_eq!(page["affected"][2]["at"], "import.rs");
        assert!(page["affected"][0]["witness"]
            .as_str()
            .unwrap()
            .contains("contains @ caller.rs:1; confidence=static"));
        assert!(page["affected"][0].as_object().unwrap().len() <= 8);
        let text = markdown(&page);
        assert!(!text.contains("witness.from"));
        assert!(!text.contains("import.rs:1"));
        assert!(text.contains("depth_limit_reached"));
        assert!(text.contains("test-associated"));
    }

    #[test]
    fn verified_markdown_source_is_shown_once_without_hiding_distinct_caps_or_failures() {
        let definition = symbol_fact("heading", "README.md", 1);
        let input = json!({"definition":definition, "source":{"status":"ok", "start_line":1,
            "end_line":3, "definition_end_line":3, "text":"# heading\nbody\n", "truncated":false},
            "markdown_section":{"start_line":1, "end_line":3, "content":"# heading\nbody\n", "truncated":false}});
        assert!(project("expand", input.clone())
            .get("markdown_section")
            .is_none());
        let mut capped = input.clone();
        capped["source"]["text"] = json!("# heading\n");
        capped["source"]["truncated"] = json!(true);
        assert!(project("expand", capped).get("markdown_section").is_some());
        let mut changed = input;
        changed["source"] = json!({"status":"changed_during_query", "message":"retry"});
        let projected = project("expand", changed);
        assert_eq!(projected["source"]["status"], "changed_during_query");
        assert!(projected.get("markdown_section").is_some());
    }

    #[test]
    fn path_order_and_per_hop_evidence_remain_separate() {
        let first = symbol_fact("first", "lib.rs", 1);
        let second = symbol_fact("second", "lib.rs", 4);
        let edge = relation(&first, &second, 2);
        let page = project(
            "path",
            json!({"path":[first, second], "relationships":[{"evidence":edge["evidence"]}], "relationship_kind":"calls"}),
        );
        assert_eq!(page["path"][0]["symbol"], "function first");
        assert_eq!(page["path"][1]["symbol"], "function second");
        assert_eq!(page["relationships"][0]["hop"], "1 -> 2");
        assert_eq!(page["relationships"][0]["callsite"], "caller.rs:2");
        assert_eq!(page["relationships"][0]["confidence"], "static");
    }
}
