//! Machine presentation and workflow-aware human views of canonical facts.

use serde_json::Value;

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
    pub(crate) fn present_for(self, workflow: &str, value: Value) -> Value {
        match self {
            Self::Full => value,
            Self::Compact => compact(workflow, value),
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

fn compact(workflow: &str, mut value: Value) -> Value {
    match workflow {
        "expand" => compact_neighborhood(&mut value),
        "search" => {
            if let Some(entries) = value
                .get_mut("context_entries")
                .and_then(Value::as_array_mut)
            {
                for entry in entries {
                    compact_neighborhood(entry);
                }
            }
        }
        _ => {}
    }
    if let Some(freshness) = value.get_mut("freshness").and_then(Value::as_object_mut) {
        freshness.retain(|key, value| key == "generation" || value.as_u64() != Some(0));
    }
    hide_hashes_and_nulls(&mut value);
    let object = value.as_object_mut().expect("tool result object");
    object.insert("format".into(), Value::from("compact"));
    value
}

fn compact_neighborhood(value: &mut Value) {
    let Some(symbol) = value
        .get("definition")
        .or_else(|| value.get("symbol"))
        .filter(|symbol| symbol.get("id").is_some())
    else {
        return;
    };
    let anchor = symbol["id"].clone();
    let default_file = symbol["evidence"]["file_path"]
        .as_str()
        .expect("anchor evidence file path")
        .to_owned();
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
    omit_default_file_paths(value, &default_file);
    value["file_path"] = Value::from(default_file);
}

fn omit_default_file_paths(value: &mut Value, default_file: &str) {
    match value {
        Value::Object(fields) => {
            if fields.get("file_path").and_then(Value::as_str) == Some(default_file) {
                fields.remove("file_path");
            }
            for value in fields.values_mut() {
                omit_default_file_paths(value, default_file);
            }
        }
        Value::Array(values) => {
            for value in values {
                omit_default_file_paths(value, default_file);
            }
        }
        _ => {}
    }
}

fn hide_hashes_and_nulls(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            fields.remove("source_hash");
            fields.remove("source_hashes");
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compact_semantic_locations_inherit_only_the_neighborhood_file() {
        let canonical = json!({
            "definition":{"id":"anchor", "evidence":{"file_path":"anchor.rs", "start_line":2,
                "end_line":3, "source_hash":"anchor-hash"}},
            "references":{"semantic":{"status":"ok", "locations":[
                {"evidence":{"file_path":"anchor.rs", "start_line":5, "end_line":5,
                    "source_hash":"anchor-hash", "confidence":"semantic"}, "start_column":4, "end_column":9},
                {"evidence":{"file_path":"other.rs", "start_line":8, "end_line":8,
                    "source_hash":"other-hash", "confidence":"semantic"}, "start_column":2, "end_column":7}
            ]}}
        });
        let compact = Format::Compact.present_for("expand", canonical.clone());
        assert_eq!(compact["file_path"], "anchor.rs");
        assert_eq!(
            compact["references"]["semantic"]["locations"],
            json!([
                {"evidence":{"start_line":5, "end_line":5, "confidence":"semantic"}, "start_column":4, "end_column":9},
                {"evidence":{"file_path":"other.rs", "start_line":8, "end_line":8, "confidence":"semantic"}, "start_column":2, "end_column":7}
            ])
        );
        assert_eq!(
            Format::Full.present_for("expand", canonical.clone()),
            canonical
        );
    }
}
