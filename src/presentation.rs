//! Compact MCP presentation. Facts and their uncertainty remain unchanged;
//! shared hashes and relationship anchors are written once per response.

use serde_json::{Map, Value};

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
