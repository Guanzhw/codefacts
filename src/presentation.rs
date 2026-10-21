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
    pub(crate) fn present_for(self, workflow: &str, value: Value) -> Value {
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
mod rust_impl_tests {
    use super::*;
    use crate::{lsp::LspMode, service::CodeFacts};

    #[test]
    fn parsed_membership_has_identical_projection_values_in_every_format() {
        let repository = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::fs::write(
            repository.path().join("fixture.rs"),
            "struct P; impl Trait for P { fn run() {} }",
        )
        .unwrap();
        let facts = CodeFacts::open_with_lsp(
            repository.path(),
            state.path().join("facts.sqlite"),
            LspMode::Off,
        )
        .unwrap();
        for (workflow, full, pointer) in [
            (
                "outline",
                facts.outline("fixture.rs", Some(50)).unwrap(),
                "/symbols/1/rust_impl",
            ),
            (
                "search",
                facts.search("run", Some(50)).unwrap(),
                "/results/0/rust_impl",
            ),
            (
                "expand",
                facts.expand("run", None, Some(50)).unwrap(),
                "/definition/rust_impl",
            ),
        ] {
            let expected = full.pointer(pointer).unwrap();
            let owner_ref = expected["owner_ref"].as_str().unwrap();
            let owner = &full["rust_impl_owners"][owner_ref];
            assert_eq!(owner["receiver"], "P");
            assert_eq!(owner["trait_name"], "Trait");
            for format in [Format::Full, Format::Compact, Format::Markdown] {
                let presented = format.present_for(workflow, full.clone());
                assert_eq!(presented.pointer(pointer).unwrap(), expected);
                assert_eq!(presented["rust_impl_owners"][owner_ref], *owner);
                let bytes = format.text(&presented).len();
                assert!(bytes < 16 * 1024);
                eprintln!("Rust impl {workflow}: {bytes} presentation bytes");
            }
        }
    }
}
