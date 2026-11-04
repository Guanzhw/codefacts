//! Machine presentation and workflow-aware human views of canonical facts.

use serde_json::{Map, Value};

mod human;
mod markdown;
pub(crate) use markdown::render as markdown;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Format {
    Compact,
    Full,
    Markdown,
}

impl Format {
    pub(crate) fn present_for(self, workflow: &str, mut value: Value) -> Value {
        refresh_neighborhood_metadata(&mut value);
        match self {
            Self::Full => value,
            Self::Compact => compact(value),
            Self::Markdown => human::project(workflow, value),
        }
    }

    pub(crate) fn text(self, value: &Value) -> String {
        match self {
            Self::Markdown => markdown(value),
            Self::Compact | Self::Full => value.to_string(),
        }
    }
}

/// Explanations describe only facts that survived the current page and budget.
/// This runs before every projection, including each expand budget retry.
pub(crate) fn refresh_neighborhood_metadata(value: &mut Value) {
    fn neighborhood(value: &mut Value) {
        let mut notes = Map::new();
        for pointer in [
            "/callers",
            "/callees",
            "/references/inbound",
            "/references/outbound",
        ] {
            for edge in value
                .pointer(pointer)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if edge["evidence"]["confidence"] != "heuristic" {
                    continue;
                }
                let (reason, explanation) = match edge["resolution"].as_str() {
                    Some("unresolved_receiver") => ("unresolved_receiver", "The receiver is not statically bound. This same-name target is a heuristic candidate, not a confirmed call."),
                    Some("polymorphic") => ("polymorphic", "The receiver is not statically bound. Same-name targets are heuristic candidates; multiple targets do not establish runtime dispatch."),
                    Some("ambiguous_name") => ("ambiguous_name", "The target name is ambiguous. The listed target is one heuristic representative, not a confirmed call."),
                    _ => ("heuristic", "This relationship is a heuristic candidate, not a confirmed static binding."),
                };
                notes.insert(reason.into(), Value::from(explanation));
            }
        }
        let test_ids = value["tests"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|test| test["id"].as_str().map(str::to_owned))
            .collect::<std::collections::HashSet<_>>();
        let has_associations = value
            .get_mut("test_associations")
            .and_then(Value::as_array_mut)
            .is_some_and(|associations| {
                associations.retain(|association| {
                    association["test_id"]
                        .as_str()
                        .is_some_and(|id| test_ids.contains(id))
                });
                !associations.is_empty()
            });
        let Some(fields) = value.as_object_mut() else {
            return;
        };
        if notes.is_empty() {
            fields.remove("relationship_notes");
        } else {
            fields.insert("relationship_notes".into(), Value::Object(notes));
        }
        if has_associations {
            fields.insert("test_association_notes".into(), Value::from("Tests are indexed test symbols joined by a direct non-heuristic graph edge; each witness shows one such edge. Matches to the target's name or file only rank results. Association does not establish execution or coverage."));
        } else {
            fields.remove("test_associations");
            fields.remove("test_association_notes");
        }
    }
    neighborhood(value);
    if let Some(entries) = value
        .get_mut("context_entries")
        .and_then(Value::as_array_mut)
    {
        for entry in entries {
            neighborhood(entry);
        }
    }
}

pub(crate) fn compact(mut value: Value) -> Value {
    compact_neighborhood(&mut value);
    if let Some(entries) = value
        .get_mut("context_entries")
        .and_then(Value::as_array_mut)
    {
        for entry in entries {
            compact_neighborhood(entry);
        }
    }
    if let Some(freshness) = value.get_mut("freshness").and_then(Value::as_object_mut) {
        freshness.retain(|key, value| key == "generation" || value.as_u64() != Some(0));
    }
    let mut hashes = Map::new();
    share_hashes(&mut value, &mut hashes);
    let object = value.as_object_mut().expect("tool result object");
    object.insert("format".into(), Value::from("compact"));
    if !hashes.is_empty() {
        object.insert("source_hashes".into(), Value::Object(hashes));
    }
    value
}

fn compact_neighborhood(value: &mut Value) {
    let anchor = value
        .get("definition")
        .or_else(|| value.get("symbol"))
        .and_then(|symbol| symbol.get("id"))
        .cloned();
    let Some(anchor) = anchor else { return };
    for (pointer, repeated_endpoint) in [
        ("/callers", "to"),
        ("/callees", "from"),
        ("/references/inbound", "to"),
        ("/references/outbound", "from"),
    ] {
        if let Some(relationships) = value.pointer_mut(pointer).and_then(Value::as_array_mut) {
            for relationship in relationships {
                let fields = relationship.as_object_mut().expect("relationship object");
                // Search context has its own anchor per entry. Never infer an
                // endpoint from the first result or from the relation direction alone.
                if fields[repeated_endpoint]["id"] == anchor {
                    fields.remove(repeated_endpoint);
                }
            }
        }
    }
}

fn hide_hashes_and_nulls(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            if fields.contains_key("file_path") {
                fields.remove("source_hash");
            }
            fields.retain(|_, value| !value.is_null());
            for value in fields.values_mut() {
                hide_hashes_and_nulls(value);
            }
        }
        Value::Array(values) => {
            for value in values {
                hide_hashes_and_nulls(value);
            }
        }
        _ => {}
    }
}

fn share_hashes(value: &mut Value, hashes: &mut Map<String, Value>) {
    match value {
        Value::Object(fields) => {
            if let (Some(Value::String(file)), Some(hash)) =
                (fields.get("file_path"), fields.get("source_hash"))
            {
                hashes.insert(file.clone(), hash.clone());
                fields.remove("source_hash");
            }
            fields.retain(|_, value| !value.is_null());
            for value in fields.values_mut() {
                share_hashes(value, hashes);
            }
        }
        Value::Array(values) => {
            for value in values {
                share_hashes(value, hashes);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod metadata_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn budget_reprojection_removes_notes_and_witnesses_for_omitted_facts() {
        let mut page = json!({
            "callees": [{"evidence":{"confidence":"heuristic"}, "resolution":"polymorphic"}],
            "tests": [{"id":"kept"}, {"id":"trimmed"}],
            "test_associations": [{"test_id":"kept"}, {"test_id":"trimmed"}],
        });
        refresh_neighborhood_metadata(&mut page);
        assert!(page["relationship_notes"]["polymorphic"].is_string());
        page["tests"].as_array_mut().unwrap().pop();
        page["callees"].as_array_mut().unwrap().clear();
        refresh_neighborhood_metadata(&mut page);
        assert!(page.get("relationship_notes").is_none());
        assert_eq!(page["test_associations"], json!([{"test_id":"kept"}]));
        page["tests"].as_array_mut().unwrap().clear();
        refresh_neighborhood_metadata(&mut page);
        assert!(page.get("test_associations").is_none());
        assert!(page.get("test_association_notes").is_none());
    }
}
