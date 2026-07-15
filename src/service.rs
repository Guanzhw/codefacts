//! Read-only, source-backed CodeFacts workflows.
//!
//! This module is intentionally the boundary between the reusable indexing
//! core and the five MCP tools. It does not edit repositories, start a
//! watcher, or retain an agent conversation.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};

use rusqlite::params;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::db::converters::row_to_code_node;
use crate::error::{CodeFactsError, Result};
use crate::graph::store::GraphStore;
use crate::indexer::{IndexOptions, IndexResult, IndexingPipeline};
use crate::lsp::{self, LspManager, LspMode, SemanticReferenceResult};
use crate::types::{CodeEdge, CodeNode, EdgeKind};

const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 50;

/// A CodeFacts index rooted at one repository.
#[derive(Debug)]
pub struct CodeFacts {
    root: PathBuf,
    database_path: PathBuf,
    store: GraphStore,
    lsp: LspManager,
}

#[derive(Debug, Serialize)]
pub struct Freshness {
    pub status: &'static str,
    pub files_indexed: usize,
    pub files_skipped: usize,
    pub duration_ms: u128,
}

#[derive(Debug, Serialize)]
pub struct Evidence {
    pub file_path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub source_hash: Option<String>,
    pub extractor: String,
    pub confidence: String,
}

#[derive(Debug, Serialize)]
pub struct SymbolFact {
    pub id: String,
    pub name: String,
    pub qualified_name: Option<String>,
    pub kind: String,
    pub language: String,
    pub evidence: Evidence,
}

#[derive(Debug, Serialize)]
pub struct RelationshipFact {
    pub kind: String,
    pub from: SymbolFact,
    pub to: SymbolFact,
    pub evidence: Evidence,
}

#[derive(Debug, Serialize)]
pub struct SemanticLocationFact {
    pub evidence: Evidence,
    pub start_column: u32,
    pub end_column: u32,
}

impl CodeFacts {
    /// Open an external SQLite state file for `root`.
    pub fn open(root: impl AsRef<Path>, database_path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_lsp(root, database_path, LspMode::Auto)
    }

    /// Open an external SQLite state file and choose whether optional,
    /// user-installed LSP enrichment is permitted for this process.
    pub fn open_with_lsp(
        root: impl AsRef<Path>,
        database_path: impl AsRef<Path>,
        lsp_mode: LspMode,
    ) -> Result<Self> {
        let root = root.as_ref().canonicalize().map_err(CodeFactsError::Io)?;
        if !root.is_dir() {
            return Err(CodeFactsError::Other(format!(
                "repository root is not a directory: {}",
                root.display()
            )));
        }

        let database_path = database_path.as_ref().to_path_buf();
        if let Some(parent) = database_path.parent() {
            fs::create_dir_all(parent).map_err(CodeFactsError::Io)?;
        }
        let database = database_path.to_string_lossy().to_string();
        let store = GraphStore::new(&database)?;

        Ok(Self {
            root,
            database_path,
            store,
            lsp: LspManager::new(lsp_mode),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    /// Refresh incrementally before every read workflow. That makes each MCP
    /// result explicitly fresh, rather than serving a silently stale snapshot.
    pub fn refresh(&self) -> Result<Freshness> {
        let pipeline = IndexingPipeline::new(&self.store);
        let result = pipeline.index_directory(&IndexOptions {
            root_dir: self.root.clone(),
            incremental: true,
        })?;
        Ok(freshness(result))
    }

    pub fn map(&self) -> Result<Value> {
        let freshness = self.refresh()?;
        let stats = self.store.get_stats()?;
        let nodes = self.store.get_all_nodes()?;
        let mut languages = BTreeMap::<String, usize>::new();
        let mut kinds = BTreeMap::<String, usize>::new();
        let mut indexed_languages = Vec::with_capacity(nodes.len());
        for node in &nodes {
            *languages
                .entry(node.language.as_str().to_string())
                .or_default() += 1;
            *kinds.entry(node.kind.as_str().to_string()).or_default() += 1;
            indexed_languages.push(node.language);
        }

        Ok(json!({
            "repository": self.root,
            "freshness": freshness,
            "files": stats.files,
            "symbols": stats.nodes,
            "relationships": stats.edges,
            "languages": languages,
            "symbol_kinds": kinds,
            "lsp": self.lsp.report(indexed_languages),
        }))
    }

    pub fn search(&self, query: &str, limit: Option<usize>) -> Result<Value> {
        let freshness = self.refresh()?;
        let limit = bounded_limit(limit);
        let Some(fts_query) = fts_query(query) else {
            return Ok(json!({
                "freshness": freshness,
                "query": query,
                "results": [],
                "message": "Search needs at least one identifier or word; raw grep is not supported."
            }));
        };

        // A symbol-name lookup is stronger evidence than a full-text match.
        // Put exact names first so a common identifier does not get pushed out
        // of the bounded FTS result set by comments, signatures, or file paths.
        let exact_name = query.trim();
        let mut nodes = self.store.get_nodes_by_name(exact_name)?;
        nodes.truncate(limit);

        if nodes.len() < limit {
            let remaining = limit - nodes.len();
            let mut statement = self.store.conn.prepare_cached(
                "SELECT nodes.* FROM fts_nodes
                 JOIN nodes ON nodes.rowid = fts_nodes.rowid
                 WHERE fts_nodes MATCH ?1
                   AND nodes.name <> ?2
                 ORDER BY bm25(fts_nodes), nodes.file_path, nodes.start_line, nodes.id
                 LIMIT ?3",
            )?;
            let rows = statement.query_and_then(
                params![fts_query, exact_name, remaining as i64],
                row_to_code_node,
            )?;
            nodes.extend(rows.collect::<std::result::Result<Vec<_>, _>>()?);
        }
        let results = nodes
            .iter()
            .map(|node| self.symbol_fact(node))
            .collect::<Result<Vec<_>>>()?;

        Ok(json!({
            "freshness": freshness,
            "query": query,
            "results": results,
            "bounded_by": limit,
        }))
    }

    pub fn outline(&self, file_path: &str, limit: Option<usize>) -> Result<Value> {
        let freshness = self.refresh()?;
        let file_path = self.relative_path(file_path)?;
        let limit = bounded_limit(limit);
        let mut nodes = self.store.get_nodes_by_file(&file_path)?;
        nodes.sort_by_key(|node| (node.start_line, node.start_column));
        let truncated = nodes.len() > limit;
        let symbols = nodes
            .iter()
            .take(limit)
            .map(|node| self.symbol_fact(node))
            .collect::<Result<Vec<_>>>()?;

        Ok(json!({
            "freshness": freshness,
            "file_path": file_path,
            "symbols": symbols,
            "truncated": truncated,
            "bounded_by": limit,
        }))
    }

    pub fn expand(
        &self,
        symbol: &str,
        file_path: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Value> {
        let freshness = self.refresh()?;
        let limit = bounded_limit(limit);
        let resolution = self.resolve_symbol(symbol, file_path)?;
        let node = match resolution {
            SymbolResolution::NotFound => {
                return Ok(json!({
                    "freshness": freshness,
                    "status": "not_found",
                    "symbol": symbol,
                    "message": "No indexed symbol matches this identifier."
                }));
            }
            SymbolResolution::Ambiguous(matches) => {
                return Ok(json!({
                    "freshness": freshness,
                    "status": "ambiguous",
                    "symbol": symbol,
                    "matches": matches,
                    "message": "Use an exact symbol id or add file_path; CodeFacts does not guess."
                }));
            }
            SymbolResolution::One(node) => node,
        };

        let callers = self.relationships_to(&node, true, Some(EdgeKind::Calls), limit)?;
        let callees = self.relationships_to(&node, false, Some(EdgeKind::Calls), limit)?;
        let references = self.relationships_to(&node, true, Some(EdgeKind::References), limit)?;
        let outbound_references =
            self.relationships_to(&node, false, Some(EdgeKind::References), limit)?;
        let tests = self.related_tests(&node, limit)?;
        let semantic_references = self.semantic_references(&node, limit)?;

        Ok(json!({
            "freshness": freshness,
            "status": "ok",
            "definition": self.symbol_fact(&node)?,
            "callers": callers,
            "callees": callees,
            "references": {
                "inbound": references,
                "outbound": outbound_references,
                "semantic": semantic_references,
            },
            "tests": tests,
            "bounded_by": limit,
        }))
    }

    pub fn path(&self, from: &str, to: &str, limit: Option<usize>) -> Result<Value> {
        let freshness = self.refresh()?;
        let limit = bounded_limit(limit);
        let from = match self.resolve_symbol(from, None)? {
            SymbolResolution::One(node) => node,
            other => return self.path_resolution_result(freshness, "from", other),
        };
        let to = match self.resolve_symbol(to, None)? {
            SymbolResolution::One(node) => node,
            other => return self.path_resolution_result(freshness, "to", other),
        };

        if from.id == to.id {
            return Ok(json!({
                "freshness": freshness,
                "status": "ok",
                "path": [self.symbol_fact(&from)?],
                "relationships": [],
            }));
        }

        let known_node_ids: HashSet<String> = self
            .store
            .get_all_nodes()?
            .into_iter()
            .map(|node| node.id)
            .collect();
        let edges = self.store.get_all_edges()?;
        let mut outgoing = HashMap::<String, Vec<CodeEdge>>::new();
        for edge in edges.into_iter().filter(|edge| {
            edge.kind == EdgeKind::Calls
                && known_node_ids.contains(&edge.source)
                && known_node_ids.contains(&edge.target)
        }) {
            outgoing.entry(edge.source.clone()).or_default().push(edge);
        }

        let mut queue = VecDeque::from([from.id.clone()]);
        let mut previous = HashMap::<String, (String, CodeEdge)>::new();
        let mut visited = HashSet::from([from.id.clone()]);

        while let Some(current) = queue.pop_front() {
            if visited.len() > limit.saturating_mul(100) {
                break;
            }
            for edge in outgoing.get(&current).into_iter().flatten() {
                if visited.insert(edge.target.clone()) {
                    previous.insert(edge.target.clone(), (current.clone(), edge.clone()));
                    if edge.target == to.id {
                        let (nodes, relationships) =
                            self.reconstruct_path(&from.id, &to.id, &previous)?;
                        return Ok(json!({
                            "freshness": freshness,
                            "status": "ok",
                            "path": nodes,
                            "relationships": relationships,
                            "relationship_kind": "calls",
                        }));
                    }
                    queue.push_back(edge.target.clone());
                }
            }
        }

        Ok(json!({
            "freshness": freshness,
            "status": "no_static_path",
            "from": self.symbol_fact(&from)?,
            "to": self.symbol_fact(&to)?,
            "message": "No bounded static calls path was found. This does not establish runtime unreachability.",
        }))
    }

    fn path_resolution_result(
        &self,
        freshness: Freshness,
        parameter: &str,
        resolution: SymbolResolution,
    ) -> Result<Value> {
        match resolution {
            SymbolResolution::NotFound => Ok(json!({
                "freshness": freshness,
                "status": "not_found",
                "parameter": parameter,
                "message": "No indexed symbol matches this endpoint."
            })),
            SymbolResolution::Ambiguous(matches) => Ok(json!({
                "freshness": freshness,
                "status": "ambiguous",
                "parameter": parameter,
                "matches": matches,
                "message": "Path endpoints must resolve to one confirmed symbol."
            })),
            SymbolResolution::One(_) => unreachable!("handled by caller"),
        }
    }

    fn reconstruct_path(
        &self,
        from: &str,
        to: &str,
        previous: &HashMap<String, (String, CodeEdge)>,
    ) -> Result<(Vec<SymbolFact>, Vec<RelationshipFact>)> {
        let mut ids = vec![to.to_string()];
        let mut edges = Vec::new();
        let mut cursor = to;
        while cursor != from {
            let (parent, edge) = previous.get(cursor).ok_or_else(|| {
                CodeFactsError::Other("path predecessor disappeared during reconstruction".into())
            })?;
            ids.push(parent.clone());
            edges.push(edge.clone());
            cursor = parent;
        }
        ids.reverse();
        edges.reverse();

        let mut nodes = Vec::with_capacity(ids.len());
        for id in &ids {
            let node = self.store.get_node(id)?.ok_or_else(|| {
                CodeFactsError::Other(format!("path contains missing node: {id}"))
            })?;
            nodes.push(self.symbol_fact(&node)?);
        }
        let relationships = edges
            .iter()
            .map(|edge| self.relationship_fact(edge))
            .collect::<Result<Vec<_>>>()?;
        Ok((nodes, relationships))
    }

    fn resolve_symbol(&self, symbol: &str, file_path: Option<&str>) -> Result<SymbolResolution> {
        if let Some(node) = self.store.get_node(symbol)? {
            return Ok(SymbolResolution::One(node));
        }
        let requested_file = file_path.map(|path| self.relative_path(path)).transpose()?;
        let mut matches = self.store.get_nodes_by_name(symbol)?;
        if let Some(file) = requested_file {
            matches.retain(|node| node.file_path == file);
        }
        match matches.len() {
            0 => Ok(SymbolResolution::NotFound),
            1 => Ok(SymbolResolution::One(matches.remove(0))),
            _ => Ok(SymbolResolution::Ambiguous(
                matches
                    .iter()
                    .take(MAX_LIMIT)
                    .map(|node| self.symbol_fact(node))
                    .collect::<Result<Vec<_>>>()?,
            )),
        }
    }

    fn relationships_to(
        &self,
        node: &CodeNode,
        incoming: bool,
        kind: Option<EdgeKind>,
        limit: usize,
    ) -> Result<Vec<RelationshipFact>> {
        let edges = if incoming {
            self.store
                .get_in_edges(&node.id, kind.map(|kind| kind.as_str()))?
        } else {
            self.store
                .get_out_edges(&node.id, kind.map(|kind| kind.as_str()))?
        };
        let mut relationships = Vec::with_capacity(limit);
        for edge in &edges {
            if relationships.len() == limit {
                break;
            }

            // Extractors retain unresolved static references as edges so the
            // fact store can represent uncertainty. MCP relationship results
            // only expose confirmed symbol-to-symbol facts, however: a target
            // that no longer exists after refresh must not turn `expand` into
            // an internal error or be presented as a confirmed relationship.
            if self.store.get_node(&edge.source)?.is_none()
                || self.store.get_node(&edge.target)?.is_none()
            {
                continue;
            }
            relationships.push(self.relationship_fact(edge)?);
        }
        Ok(relationships)
    }

    fn related_tests(&self, node: &CodeNode, limit: usize) -> Result<Vec<SymbolFact>> {
        let nodes = self.store.get_all_nodes()?;
        let test_ids: HashSet<String> = self
            .store
            .conn
            .prepare_cached("SELECT id FROM nodes WHERE is_test = 1")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<HashSet<_>, _>>()?;
        let related_ids: HashSet<String> = self
            .store
            .get_in_edges(&node.id, None)?
            .into_iter()
            .map(|edge| edge.source)
            .chain(
                self.store
                    .get_out_edges(&node.id, None)?
                    .into_iter()
                    .map(|edge| edge.target),
            )
            .filter(|id| test_ids.contains(id))
            .collect();
        nodes
            .iter()
            .filter(|candidate| related_ids.contains(&candidate.id))
            .take(limit)
            .map(|candidate| self.symbol_fact(candidate))
            .collect()
    }

    fn semantic_references(&self, node: &CodeNode, limit: usize) -> Result<Value> {
        match self.lsp.references(&self.root, node) {
            SemanticReferenceResult::Disabled => Ok(json!({
                "status": "disabled",
                "message": "Semantic LSP references are disabled by --lsp off.",
            })),
            SemanticReferenceResult::Unsupported { language } => Ok(json!({
                "status": "unsupported",
                "language": language,
                "message": "No optional LSP provider is supported for this symbol language.",
            })),
            SemanticReferenceResult::Unavailable { provider, message } => Ok(json!({
                "status": "unavailable",
                "provider": provider,
                "message": message,
            })),
            SemanticReferenceResult::NotApplicable { provider, message } => Ok(json!({
                "status": "not_applicable",
                "provider": provider,
                "message": message,
            })),
            SemanticReferenceResult::Failed { provider, message } => Ok(json!({
                "status": "failed",
                "provider": provider,
                "message": message,
            })),
            SemanticReferenceResult::Success {
                provider,
                locations,
            } => {
                let mut facts = Vec::with_capacity(locations.len().min(limit));
                let mut omitted_locations = 0usize;
                for location in locations {
                    if facts.len() == limit {
                        omitted_locations += 1;
                        continue;
                    }
                    let Some(path) = lsp::path_from_file_uri(&location.uri) else {
                        omitted_locations += 1;
                        continue;
                    };
                    let Ok(file_path) = self.relative_path(&path.to_string_lossy()) else {
                        // A semantic answer can legitimately include a standard
                        // library or dependency location. CodeFacts only returns
                        // repository facts with an indexed source hash.
                        omitted_locations += 1;
                        continue;
                    };
                    let Some(source_hash) = self.source_hash(&file_path)? else {
                        omitted_locations += 1;
                        continue;
                    };
                    facts.push(SemanticLocationFact {
                        evidence: Evidence {
                            file_path,
                            start_line: location.start_line.saturating_add(1),
                            end_line: location.end_line.saturating_add(1),
                            source_hash: Some(source_hash),
                            extractor: format!("lsp:{provider}"),
                            confidence: "semantic".to_string(),
                        },
                        start_column: location.start_character,
                        end_column: location.end_character,
                    });
                }
                Ok(json!({
                    "status": "ok",
                    "provider": provider,
                    "position_encoding": "utf-16",
                    "locations": facts,
                    "truncated": omitted_locations > 0,
                    "omitted_locations": omitted_locations,
                }))
            }
        }
    }

    fn relationship_fact(&self, edge: &CodeEdge) -> Result<RelationshipFact> {
        let from = self.store.get_node(&edge.source)?.ok_or_else(|| {
            CodeFactsError::Other(format!("relationship source is missing: {}", edge.source))
        })?;
        let to = self.store.get_node(&edge.target)?.ok_or_else(|| {
            CodeFactsError::Other(format!("relationship target is missing: {}", edge.target))
        })?;
        Ok(RelationshipFact {
            kind: edge.kind.as_str().to_string(),
            from: self.symbol_fact(&from)?,
            to: self.symbol_fact(&to)?,
            evidence: Evidence {
                file_path: edge.file_path.clone(),
                start_line: edge.line,
                end_line: edge.line,
                source_hash: self.source_hash(&edge.file_path)?,
                extractor: extractor_for_edge(edge),
                confidence: edge
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.get("confidence"))
                    .cloned()
                    .unwrap_or_else(|| "static".to_string()),
            },
        })
    }

    fn symbol_fact(&self, node: &CodeNode) -> Result<SymbolFact> {
        Ok(SymbolFact {
            id: node.id.clone(),
            name: node.name.clone(),
            qualified_name: node.qualified_name.clone(),
            kind: node.kind.as_str().to_string(),
            language: node.language.as_str().to_string(),
            evidence: Evidence {
                file_path: node.file_path.clone(),
                start_line: node.start_line,
                end_line: node.end_line,
                source_hash: self.source_hash(&node.file_path)?,
                extractor: extractor_for(node).to_string(),
                confidence: confidence_for(node).to_string(),
            },
        })
    }

    fn source_hash(&self, file_path: &str) -> Result<Option<String>> {
        let mut statement = self
            .store
            .conn
            .prepare_cached("SELECT content_hash FROM file_hashes WHERE file_path = ?1")?;
        let value = statement.query_row([file_path], |row| row.get(0));
        match value {
            Ok(hash) => Ok(Some(hash)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn relative_path(&self, input: &str) -> Result<String> {
        let path = Path::new(input);
        let relative = if path.is_absolute() {
            let canonical = path.canonicalize().map_err(CodeFactsError::Io)?;
            canonical
                .strip_prefix(&self.root)
                .map_err(|_| {
                    CodeFactsError::Other("file_path must remain inside the repository root".into())
                })?
                .to_path_buf()
        } else {
            path.to_path_buf()
        };
        if relative
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        {
            return Err(CodeFactsError::Other(
                "file_path must not escape the repository root".into(),
            ));
        }
        Ok(relative.to_string_lossy().replace('\\', "/"))
    }
}

pub fn default_database_path(root: &Path) -> PathBuf {
    let state_dir = std::env::var_os("CODEFACTS_STATE_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("LOCALAPPDATA").map(|path| PathBuf::from(path).join("CodeFacts"))
        })
        .or_else(|| {
            std::env::var_os("HOME").map(|path| PathBuf::from(path).join(".local/share/codefacts"))
        })
        .unwrap_or_else(|| std::env::temp_dir().join("codefacts"));
    let digest = Sha256::digest(root.to_string_lossy().as_bytes());
    state_dir.join(format!("{}.sqlite", hex::encode(&digest[..12])))
}

enum SymbolResolution {
    NotFound,
    Ambiguous(Vec<SymbolFact>),
    One(CodeNode),
}

fn freshness(result: IndexResult) -> Freshness {
    Freshness {
        status: "fresh",
        files_indexed: result.files_indexed,
        files_skipped: result.files_skipped,
        duration_ms: result.duration_ms,
    }
}

fn bounded_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

fn fts_query(query: &str) -> Option<String> {
    let tokens = query
        .split(|character: char| !character.is_alphanumeric() && character != '_')
        .filter(|token| !token.is_empty())
        .map(|token| format!("\"{}\"*", token.replace('"', "")))
        .collect::<Vec<_>>();
    (!tokens.is_empty()).then(|| tokens.join(" AND "))
}

fn extractor_for(node: &CodeNode) -> &'static str {
    match node.kind {
        crate::types::NodeKind::Endpoint => "endpoint-pattern",
        crate::types::NodeKind::Heading => "markdown-heading",
        _ => "tree-sitter",
    }
}

fn extractor_for_edge(edge: &CodeEdge) -> String {
    edge.metadata
        .as_ref()
        .and_then(|metadata| metadata.get("extractor"))
        .cloned()
        .unwrap_or_else(|| "tree-sitter".to_string())
}

fn confidence_for(node: &CodeNode) -> &'static str {
    match node.kind {
        crate::types::NodeKind::Endpoint => "heuristic",
        _ => "confirmed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Language, NodeKind};
    use tempfile::tempdir;

    fn test_node(id: String, name: String, body: Option<String>) -> CodeNode {
        CodeNode {
            id,
            name,
            qualified_name: None,
            kind: NodeKind::Function,
            file_path: "lib.rs".to_string(),
            start_line: 100,
            end_line: 101,
            start_column: 0,
            end_column: 1,
            language: Language::Rust,
            body,
            documentation: None,
            exported: Some(true),
        }
    }

    #[test]
    fn search_prioritizes_an_exact_symbol_name_over_fts_noise() {
        let repository = tempdir().expect("temporary repository");
        fs::write(repository.path().join("lib.rs"), "pub fn retained() {}\n")
            .expect("source fixture");
        let facts = CodeFacts::open(repository.path(), repository.path().join("external.sqlite"))
            .expect("open source-backed facts");
        facts.map().expect("seed incremental file hashes");

        let mut nodes = vec![test_node(
            "function:lib.rs:agent_turn:100".to_string(),
            "agent_turn".to_string(),
            None,
        )];
        for index in 0..=MAX_LIMIT {
            nodes.push(test_node(
                format!("function:lib.rs:noise_{index}:{}", 101 + index),
                format!("noise_{index}"),
                Some("agent_turn ".repeat(128)),
            ));
        }
        facts.store.upsert_nodes(&nodes).expect("seed FTS noise");

        let result = facts
            .search("agent_turn", Some(1))
            .expect("search source-backed facts");
        assert_eq!(result["results"][0]["name"], "agent_turn");
    }

    #[test]
    fn search_fills_remaining_slots_without_repeating_an_exact_name() {
        let repository = tempdir().expect("temporary repository");
        fs::write(repository.path().join("lib.rs"), "pub fn retained() {}\n")
            .expect("source fixture");
        let facts = CodeFacts::open(repository.path(), repository.path().join("external.sqlite"))
            .expect("open source-backed facts");
        facts.map().expect("seed incremental file hashes");

        let mut nodes = vec![test_node(
            "function:lib.rs:agent_turn:100".to_string(),
            "agent_turn".to_string(),
            Some("agent_turn ".repeat(256)),
        )];
        for index in 0..3 {
            nodes.push(test_node(
                format!("function:lib.rs:noise_{index}:{}", 101 + index),
                format!("noise_{index}"),
                Some("agent_turn ".repeat(8)),
            ));
        }
        facts.store.upsert_nodes(&nodes).expect("seed FTS matches");

        let fts_first_name = facts
            .store
            .conn
            .query_row(
                "SELECT nodes.name FROM fts_nodes
                 JOIN nodes ON nodes.rowid = fts_nodes.rowid
                 WHERE fts_nodes MATCH ?1
                 ORDER BY bm25(fts_nodes), nodes.file_path, nodes.start_line, nodes.id
                 LIMIT 1",
                [fts_query("agent_turn").expect("valid FTS query")],
                |row| row.get::<_, String>(0),
            )
            .expect("rank the raw FTS result");
        assert_eq!(fts_first_name, "agent_turn");

        let result = facts
            .search("agent_turn", Some(3))
            .expect("search source-backed facts");
        let names = result["results"]
            .as_array()
            .expect("search results")
            .iter()
            .map(|result| result["name"].as_str().expect("symbol name"))
            .collect::<Vec<_>>();

        assert_eq!(names.len(), 3);
        assert_eq!(names[0], "agent_turn");
        assert_eq!(
            names.iter().filter(|name| **name == "agent_turn").count(),
            1,
            "the FTS fallback must not repeat the direct exact-name result"
        );
        assert!(
            names[1..].iter().all(|name| name.starts_with("noise_")),
            "remaining slots should come from the FTS fallback"
        );
    }
}
