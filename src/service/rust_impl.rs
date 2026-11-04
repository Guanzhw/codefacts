//! Response-local references to exact source impl owners.

use crate::types::{CodeNode, RustImplMembership, RustImplOwnerKey};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

#[derive(Debug, Serialize)]
pub struct RustImplReference {
    /// A key in this response's rust_impl_owners dictionary, not a symbol ID.
    pub owner_ref: String,
}

#[derive(Default)]
pub(super) struct RustImplProjection {
    owners: RefCell<BTreeMap<RustImplOwnerKey, (String, Arc<RustImplMembership>)>>,
}

impl RustImplProjection {
    pub fn register(&self, node: &CodeNode) -> Option<RustImplReference> {
        let owner = node.rust_impl.as_ref()?;
        let mut owners = self.owners.borrow_mut();
        let next = owners.len();
        let entry = owners
            .entry(owner.owner_key(&node.file_path))
            .or_insert_with(|| (format!("impl_{next}"), owner.clone()));
        Some(RustImplReference {
            owner_ref: entry.0.clone(),
        })
    }

    /// Materialize each remaining owner once, after selection or budget trimming.
    /// The canonical candidate contains only small references during that work.
    pub fn finish(&self, mut response: Value) -> Value {
        response
            .as_object_mut()
            .expect("workflow response")
            .remove("rust_impl_owners");
        let mut referenced = BTreeSet::new();
        collect_refs(&response, &mut referenced);
        if !referenced.is_empty() {
            let owners = self.owners.borrow();
            let dictionary = owners
                .iter()
                .filter(|(_, (key, _))| referenced.contains(key))
                .map(|((file, ..), (key, owner))| {
                    let mut record =
                        serde_json::to_value(owner.as_ref()).expect("typed impl owner");
                    record["file_path"] = json!(file);
                    (key.clone(), record)
                })
                .collect::<serde_json::Map<_, _>>();
            response["rust_impl_owners"] = Value::Object(dictionary);
        }
        response
    }
}

fn collect_refs(value: &Value, referenced: &mut BTreeSet<String>) {
    match value {
        Value::Object(fields) => {
            for (name, value) in fields {
                if matches!(
                    name.as_str(),
                    "rust_impl" | "from_rust_impl" | "to_rust_impl"
                ) {
                    referenced.insert(
                        value["owner_ref"]
                            .as_str()
                            .expect("typed impl reference")
                            .to_owned(),
                    );
                } else {
                    collect_refs(value, referenced);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_refs(value, referenced);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::super::{CodeFacts, ExpandSection, ImpactOptions};
    use super::*;
    use crate::{lsp::LspMode, presentation::Format};

    fn assert_dictionary(response: &Value) {
        let mut refs = BTreeSet::new();
        let mut small = response.clone();
        small.as_object_mut().unwrap().remove("rust_impl_owners");
        collect_refs(&small, &mut refs);
        let definitions = response
            .get("rust_impl_owners")
            .map(|owners| {
                owners
                    .as_object()
                    .unwrap()
                    .keys()
                    .cloned()
                    .collect::<BTreeSet<_>>()
            })
            .unwrap_or_default();
        assert_eq!(refs, definitions);
    }

    #[test]
    fn expand_path_and_impact_read_each_shared_owner_once_per_response() {
        let repository = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let mut source = format!("struct P; impl Trait{} for P {{\n", "x".repeat(16 * 1024));
        for index in 0..512 {
            source.push_str(&format!("fn method_{index:04}() {{ leaf(); }}\n"));
        }
        source.push_str("}\nfn leaf() {}\n");
        std::fs::write(repository.path().join("fixture.rs"), source).unwrap();
        let facts = CodeFacts::open_with_lsp(
            repository.path(),
            state.path().join("facts.sqlite"),
            LspMode::Off,
        )
        .unwrap();
        facts.refresh().unwrap();
        let before = facts.store.impl_owner_query_count();
        let expanded = facts
            .expand_page("leaf", None, ExpandSection::Callers, None, Some(50), false)
            .unwrap();
        assert_eq!(expanded["callers"].as_array().unwrap().len(), 50);
        assert_eq!(facts.store.impl_owner_query_count() - before, 1);
        assert_dictionary(&expanded);
        let before = facts.store.impl_owner_query_count();
        let path = facts.path("method_0000", "leaf", Some(50)).unwrap();
        assert_eq!(path["status"], "ok");
        assert_eq!(facts.store.impl_owner_query_count() - before, 1);
        assert_dictionary(&path);
        let before = facts.store.impl_owner_query_count();
        let impact = facts
            .impact(ImpactOptions {
                symbol: "leaf",
                file_path: None,
                max_depth: Some(1),
                limit: Some(50),
            })
            .unwrap();
        assert_eq!(impact["affected"].as_array().unwrap().len(), 50);
        assert_eq!(facts.store.impl_owner_query_count() - before, 1);
        for (workflow, response) in [("expand", expanded), ("path", path), ("impact", impact)] {
            for format in [Format::Full, Format::Compact, Format::Markdown] {
                let projected = format.present_for(workflow, response.clone());
                assert_dictionary(&projected);
                assert_eq!(projected["rust_impl_owners"].as_object().unwrap().len(), 1);
            }
        }
    }

    #[test]
    fn budgeted_ambiguity_prunes_unused_distinct_owner_records() {
        let repository = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let mut source = String::from("struct P;\n");
        for index in 0..12 {
            source.push_str(&format!(
                "impl Trait{index}{} for P {{ fn run() {{}} }}\n",
                "x".repeat(2000)
            ));
        }
        std::fs::write(repository.path().join("fixture.rs"), source).unwrap();
        let facts = CodeFacts::open_with_lsp(
            repository.path(),
            state.path().join("facts.sqlite"),
            LspMode::Off,
        )
        .unwrap();
        for format in [Format::Compact, Format::Markdown] {
            let result = facts
                .expand_page_with_format("run", None, ExpandSection::All, None, Some(50), format)
                .unwrap();
            assert_eq!(result["status"], "ambiguous");
            assert!(result["matches"].as_array().unwrap().len() < 12);
            assert_dictionary(&result);
            assert!(format.text(&result).len() <= 16 * 1024);
        }
    }

    #[test]
    fn callee_budget_pages_prune_removed_owners_without_losing_methods() {
        let repository = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let mut source = String::from("fn entry() {\n");
        for index in 0..30 {
            source.push_str(&format!("leaf_{index}();\n"));
        }
        source.push_str("}\n");
        for index in 0..30 {
            source.push_str(&format!(
                "impl Trait{index}{} for P {{ fn leaf_{index}() {{}} }}\n",
                "x".repeat(1024)
            ));
        }
        std::fs::write(repository.path().join("fixture.rs"), source).unwrap();
        let facts = CodeFacts::open_with_lsp(
            repository.path(),
            state.path().join("facts.sqlite"),
            LspMode::Off,
        )
        .unwrap();
        for format in [Format::Compact, Format::Markdown] {
            let mut seen = BTreeSet::new();
            let mut cursor = None;
            loop {
                let page = facts
                    .expand_page_with_format(
                        "entry",
                        None,
                        ExpandSection::Callees,
                        cursor.as_deref(),
                        Some(50),
                        format,
                    )
                    .unwrap();
                assert_dictionary(&page);
                assert!(format.text(&page).len() <= 16 * 1024);
                let callees = page["callees"].as_array().unwrap();
                assert!(!callees.is_empty());
                assert_eq!(
                    page["rust_impl_owners"].as_object().unwrap().len(),
                    callees.len()
                );
                for callee in callees {
                    let id = if format == Format::Markdown {
                        callee["to"].as_str().unwrap()
                    } else {
                        callee["to"]["id"].as_str().unwrap()
                    };
                    assert!(seen.insert(id.to_owned()));
                }
                cursor = page["next"]["callees"].as_str().map(str::to_owned);
                if cursor.is_none() {
                    break;
                }
            }
            assert_eq!(seen.len(), 30);
        }
    }
}
