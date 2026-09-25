//! Snapshot-bound continuation and a total presentation budget for MCP expand.

use super::*;
use crate::presentation::Format;

const COMPACT_EXPAND_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpandSection {
    All,
    Callers,
    Callees,
    Inbound,
    Outbound,
    Tests,
    Semantic,
}

impl ExpandSection {
    const PARTS: [Self; 6] = [
        Self::Callers,
        Self::Callees,
        Self::Inbound,
        Self::Outbound,
        Self::Tests,
        Self::Semantic,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Callers => "callers",
            Self::Callees => "callees",
            Self::Inbound => "inbound",
            Self::Outbound => "outbound",
            Self::Tests => "tests",
            Self::Semantic => "semantic",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        std::iter::once(Self::All)
            .chain(Self::PARTS)
            .find(|section| section.as_str() == value)
    }

    fn pointer(self) -> &'static str {
        match self {
            Self::Callers => "/callers",
            Self::Callees => "/callees",
            Self::Inbound => "/references/inbound",
            Self::Outbound => "/references/outbound",
            Self::Tests => "/tests",
            Self::Semantic => "/references/semantic/locations",
            Self::All => unreachable!("all is not a relation section"),
        }
    }
}

struct SectionPage {
    section: ExpandSection,
    offset: usize,
    more: bool,
}

impl CodeFacts {
    /// Compact mode bounds the final JSON body, including hashes and cursors.
    /// Full mode retains nested evidence for existing structured consumers.
    pub fn expand_page(
        &self,
        symbol: &str,
        file_path: Option<&str>,
        section: ExpandSection,
        cursor: Option<&str>,
        limit: Option<usize>,
        compact: bool,
    ) -> Result<Value> {
        self.expand_page_with_format(
            symbol,
            file_path,
            section,
            cursor,
            limit,
            if compact {
                Format::Compact
            } else {
                Format::Full
            },
        )
    }

    pub(crate) fn expand_page_with_format(
        &self,
        symbol: &str,
        file_path: Option<&str>,
        section: ExpandSection,
        cursor: Option<&str>,
        limit: Option<usize>,
        format: Format,
    ) -> Result<Value> {
        if section == ExpandSection::All && cursor.is_some() {
            return Err(CodeFactsError::Mcp(
                "Use the section named in next with its cursor.".into(),
            ));
        }
        let freshness = self.refresh()?;
        let node = match self.resolve_symbol(symbol, file_path)? {
            SymbolResolution::One(node) => node,
            other => {
                let result = match other {
                    SymbolResolution::NotFound => {
                        json!({"freshness": freshness, "status": "not_found", "symbol": symbol, "message": "No indexed symbol matches this identifier."})
                    }
                    SymbolResolution::Ambiguous(matches) => {
                        json!({"freshness": freshness, "status": "ambiguous", "symbol": symbol, "matches": matches, "message": "Use an exact symbol id or add file_path; CodeFacts does not guess."})
                    }
                    SymbolResolution::One(_) => unreachable!(),
                };
                return if format != Format::Full {
                    bounded_resolution_result(result, format)
                } else {
                    Ok(result)
                };
            }
        };
        let scope = |section: ExpandSection| {
            page_scope(&[
                "expand",
                &freshness.repository_root,
                &node.id,
                section.as_str(),
            ])
        };
        // LSP state can change without an indexed source refresh. Bind semantic
        // continuations to its complete, deterministically ordered result too.
        let semantic = if matches!(section, ExpandSection::All | ExpandSection::Semantic) {
            Some(self.semantic_references(&node, usize::MAX)?)
        } else {
            None
        };
        let semantic_snapshot = semantic
            .as_ref()
            .map(|value| hex::encode(Sha256::digest(value.to_string().as_bytes())));
        let offset = match page_offset_with_snapshot(
            cursor,
            0,
            freshness.generation,
            &scope(section),
            (section == ExpandSection::Semantic)
                .then_some(semantic_snapshot.as_deref())
                .flatten(),
        )? {
            PageOffset::Current(offset) => offset,
            PageOffset::Stale => {
                let result = json!({
                    "freshness": freshness, "status": "stale_cursor",
                    "message": "The index or semantic references changed. Restart expand without a cursor.",
                });
                return if format != Format::Full {
                    bounded_resolution_result(result, format)
                } else {
                    Ok(result)
                };
            }
        };
        let limit = bounded_limit(limit);
        let mut result = json!({
            "freshness": freshness, "status": "ok", "definition": self.symbol_fact(&node)?,
            "section": section.as_str(), "bounded_by": limit,
        });
        if section == ExpandSection::All {
            result["source"] = self.definition_source(&node, MAX_DEFINITION_SOURCE_RESPONSE_LEN)?;
            let markdown = markdown_section(&node);
            if !markdown.is_null() {
                result["markdown_section"] = markdown;
            }
        }
        let mut pages = Vec::new();
        for part in ExpandSection::PARTS {
            if section != ExpandSection::All && section != part {
                continue;
            }
            let mut items = match part {
                ExpandSection::Callers
                | ExpandSection::Callees
                | ExpandSection::Inbound
                | ExpandSection::Outbound => {
                    let incoming = matches!(part, ExpandSection::Callers | ExpandSection::Inbound);
                    let kind = if matches!(part, ExpandSection::Callers | ExpandSection::Callees) {
                        EdgeKind::Calls
                    } else {
                        EdgeKind::References
                    };
                    serde_json::to_value(self.relationship_page(
                        &node,
                        incoming,
                        kind,
                        offset,
                        limit + 1,
                    )?)?
                }
                ExpandSection::Tests => {
                    let end = offset
                        .checked_add(limit + 1)
                        .ok_or_else(|| CodeFactsError::Mcp("Invalid cursor offset".into()))?;
                    json!(self
                        .related_tests(&node, end)?
                        .into_iter()
                        .skip(offset)
                        .collect::<Vec<_>>())
                }
                ExpandSection::Semantic => {
                    let mut semantic = semantic.clone().expect("semantic section fetched");
                    let locations = semantic
                        .as_object_mut()
                        .expect("semantic result")
                        .remove("locations");
                    result["references"]["semantic"] = semantic;
                    let Some(locations) = locations else { continue };
                    Value::Array(
                        locations
                            .as_array()
                            .expect("locations")
                            .iter()
                            .skip(offset)
                            .cloned()
                            .collect(),
                    )
                }
                ExpandSection::All => unreachable!(),
            };
            let array = items.as_array_mut().expect("section array");
            let omitted = array.len().saturating_sub(limit);
            let more = omitted > 0;
            array.truncate(limit);
            if more && part == ExpandSection::Semantic {
                note_semantic_omission(&mut result, omitted);
            }
            match part {
                ExpandSection::Callers => result["callers"] = items,
                ExpandSection::Callees => result["callees"] = items,
                ExpandSection::Tests => result["tests"] = items,
                ExpandSection::Inbound => result["references"]["inbound"] = items,
                ExpandSection::Outbound => result["references"]["outbound"] = items,
                ExpandSection::Semantic => result["references"]["semantic"]["locations"] = items,
                ExpandSection::All => unreachable!(),
            }
            pages.push(SectionPage {
                section: part,
                offset,
                more,
            });
        }
        loop {
            let mut next = serde_json::Map::new();
            for page in &pages {
                if page.more {
                    let count = result
                        .pointer(page.section.pointer())
                        .expect("section")
                        .as_array()
                        .expect("section array")
                        .len();
                    let cursor = PageCursor {
                        version: PAGE_CURSOR_VERSION,
                        generation: freshness.generation,
                        offset: page.offset + count,
                        scope: scope(page.section),
                        semantic_snapshot: (page.section == ExpandSection::Semantic)
                            .then(|| semantic_snapshot.clone().expect("semantic snapshot")),
                    };
                    next.insert(
                        page.section.as_str().into(),
                        json!(encode_page_cursor_value(&cursor)?),
                    );
                }
            }
            result["truncated"] = json!(!next.is_empty());
            result["next"] = Value::Object(next);
            let mut presented = format.present(result.clone());
            if format == Format::Full {
                return Ok(presented);
            }
            presented["max_bytes"] = json!(COMPACT_EXPAND_BYTES);
            if format.text(&presented).len() <= COMPACT_EXPAND_BYTES {
                if section != ExpandSection::All
                    && pages.iter().any(|page| {
                        page.more
                            && result
                                .pointer(page.section.pointer())
                                .expect("section")
                                .as_array()
                                .expect("section array")
                                .is_empty()
                    })
                {
                    return Err(CodeFactsError::Mcp(
                        "One fact exceeds the response text budget; request format=full.".into(),
                    ));
                }
                return Ok(presented);
            }

            // Trim the largest section first. Re-project to retain only hashes
            // referenced by this page, and count the selected rendered text.
            let largest = pages
                .iter_mut()
                .filter(|page| {
                    !result
                        .pointer(page.section.pointer())
                        .expect("section")
                        .as_array()
                        .expect("section array")
                        .is_empty()
                })
                .max_by_key(|page| {
                    result
                        .pointer(page.section.pointer())
                        .expect("section")
                        .to_string()
                        .len()
                });
            if let Some(page) = largest {
                result
                    .pointer_mut(page.section.pointer())
                    .expect("section")
                    .as_array_mut()
                    .expect("section array")
                    .pop();
                page.more = true;
                if page.section == ExpandSection::Semantic {
                    note_semantic_omission(&mut result, 1);
                }
                continue;
            }
            // A long escaped definition can consume the fixed portion of the
            // budget. It remains available by the definition's exact source span.
            if result
                .get("source")
                .and_then(|source| source.get("text"))
                .is_some()
            {
                result["source"] =
                    json!({"status": "omitted", "reason": "response_budget", "truncated": true});
                continue;
            }
            return Err(CodeFactsError::Mcp(
                "One fact exceeds the response text budget; request format=full.".into(),
            ));
        }
    }

    fn relationship_page(
        &self,
        node: &CodeNode,
        incoming: bool,
        kind: EdgeKind,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<RelationshipFact>> {
        let edges = if incoming {
            self.store.get_in_edges(&node.id, Some(kind.as_str()))?
        } else {
            self.store.get_out_edges(&node.id, Some(kind.as_str()))?
        };
        let mut relationships = Vec::new();
        let mut skipped = 0;
        for edge in edges {
            if self.store.get_node(&edge.source)?.is_none()
                || self.store.get_node(&edge.target)?.is_none()
            {
                continue;
            }
            if skipped < offset {
                skipped += 1;
                continue;
            }
            relationships.push(self.relationship_fact(&edge)?);
            if relationships.len() == limit {
                break;
            }
        }
        Ok(relationships)
    }
}

fn note_semantic_omission(result: &mut Value, count: usize) {
    let semantic = &mut result["references"]["semantic"];
    semantic["truncated"] = json!(true);
    semantic["omitted_locations"] = json!(
        semantic["omitted_locations"]
            .as_u64()
            .expect("semantic omission count")
            + count as u64
    );
}

fn bounded_resolution_result(mut result: Value, format: Format) -> Result<Value> {
    loop {
        let mut presented = format.present(result.clone());
        presented["max_bytes"] = json!(COMPACT_EXPAND_BYTES);
        if format.text(&presented).len() <= COMPACT_EXPAND_BYTES {
            return Ok(presented);
        }
        if let Some(matches) = result.get_mut("matches").and_then(Value::as_array_mut) {
            if matches.len() > 1 {
                matches.pop();
                result["truncated"] = json!(true);
                result["message"] = json!("Candidate list truncated by response budget. Add file_path or use paged search to select an exact symbol id.");
                continue;
            }
        }
        return Err(CodeFactsError::Mcp(
            "One fact exceeds the response text budget; request format=full.".into(),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_budget_and_continuations_preserve_every_call_site() {
        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let mut source = String::from("pub fn entry() {\n");
        for i in 0..80 {
            source.push_str(&format!(
                "  helper_{i:03}_with_a_descriptive_identifier();\n"
            ));
        }
        source.push_str("}\n");
        for i in 0..80 {
            source.push_str(&format!(
                "pub fn helper_{i:03}_with_a_descriptive_identifier() {{}}\n"
            ));
        }
        fs::write(root.path().join("lib.rs"), &source).unwrap();
        let facts = CodeFacts::open(root.path(), state.path().join("facts.sqlite")).unwrap();
        let mut section = ExpandSection::All;
        let mut cursor = None;
        let mut sites = std::collections::BTreeSet::new();
        let mut cursors = std::collections::BTreeSet::new();
        loop {
            let page = facts
                .expand_page_with_format(
                    "entry",
                    None,
                    section,
                    cursor.as_deref(),
                    Some(50),
                    Format::Markdown,
                )
                .unwrap();
            let text = Format::Markdown.text(&page);
            assert!(text.len() <= COMPACT_EXPAND_BYTES);
            assert_eq!(page["format"], "markdown");
            for edge in page["callees"].as_array().unwrap() {
                assert_eq!(edge["evidence"]["confidence"], "static");
                assert!(text.contains(edge["to"]["id"].as_str().unwrap()));
                assert!(sites.insert(edge["evidence"]["start_line"].as_u64().unwrap()));
            }
            let Some(next) = page["next"]["callees"].as_str() else {
                break;
            };
            assert!(next.len() <= 128, "{} characters", next.len());
            assert!(text.contains(&format!("- callees: {next}\n")));
            assert!(cursors.insert(next.to_owned()), "continuation must advance");
            cursor = Some(next.to_owned());
            section = ExpandSection::Callees;
        }
        assert!(
            !cursors.is_empty(),
            "the dense fixture must exercise continuation"
        );
        assert_eq!(sites, (2..=81).collect());
    }

    #[test]
    fn semantic_cursor_rejects_changed_results_without_a_source_refresh() {
        let scope = page_scope(&["expand", "repository", "symbol", "semantic"]);
        let original_snapshot = hex::encode(Sha256::digest(b"original-lsp-result"));
        let changed_snapshot = hex::encode(Sha256::digest(b"changed-lsp-result"));
        let cursor = PageCursor {
            version: PAGE_CURSOR_VERSION,
            generation: 9,
            offset: 2,
            scope: scope.clone(),
            semantic_snapshot: Some(original_snapshot.clone()),
        };
        let encoded = encode_page_cursor_value(&cursor).unwrap();
        assert!(encoded.is_ascii());
        assert!(encoded.len() <= 128, "{} characters", encoded.len());
        assert!(matches!(
            page_offset_with_snapshot(Some(&encoded), 0, 9, &scope, Some(&original_snapshot))
                .unwrap(),
            PageOffset::Current(2)
        ));
        assert!(matches!(
            page_offset_with_snapshot(Some(&encoded), 0, 9, &scope, Some(&changed_snapshot))
                .unwrap(),
            PageOffset::Stale
        ));
        assert!(matches!(
            page_offset_with_snapshot(Some(&encoded), 0, 9, &scope, None).unwrap(),
            PageOffset::Stale
        ));
    }
}
