//! Read-only, source-backed CodeFacts workflows.
//!
//! This module is intentionally the boundary between the reusable indexing
//! core and the five MCP tools. It does not edit repositories, start a
//! watcher, or retain an agent conversation.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};

use rusqlite::params_from_iter;
use rusqlite::types::Value as SqlValue;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::db::converters::row_to_code_node;
use crate::error::{CodeFactsError, Result};
use crate::graph::store::GraphStore;
use crate::indexer::{IndexOptions, IndexResult, IndexingPipeline};
use crate::lsp::{self, LspManager, LspMode, SemanticReferenceResult};
use crate::types::{CodeEdge, CodeNode, EdgeKind, NodeKind};

const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 50;
const UNRESOLVED_REFERENCE_SAMPLE_LIMIT: usize = 20;
const PATH_SEARCH_VISIT_LIMIT: usize = MAX_LIMIT * 100;
const MAX_MARKDOWN_SECTION_RESPONSE_LEN: usize = 2 * 1024;

/// A CodeFacts index rooted at one repository.
#[derive(Debug)]
pub struct CodeFacts {
    root: PathBuf,
    database_path: PathBuf,
    store: GraphStore,
    lsp: LspManager,
}

/// Lazily opens one independent, external fact store for each repository that
/// an MCP request explicitly selects. A server may still have one configured
/// default root for backwards-compatible project-local configuration.
///
/// The registry deliberately does not merge stores: source paths, symbol IDs,
/// freshness generations, and pagination cursors remain meaningful only within
/// one repository snapshot. Cross-project use means selecting a repository per
/// tool call, not treating unrelated source trees as one synthetic project.
#[derive(Debug)]
pub struct CodeFactsRegistry {
    projects: HashMap<PathBuf, CodeFacts>,
    default_root: Option<PathBuf>,
    lsp_mode: LspMode,
}

#[derive(Debug, Serialize)]
pub struct Freshness {
    pub status: &'static str,
    /// Canonical repository identity for this fact snapshot.  MCP clients can
    /// reject facts from a different project instead of inferring scope from a
    /// server name or a user-level configuration entry.
    pub repository_root: String,
    /// Monotonically increasing fact-store generation. Pagination cursors are
    /// tied to this value and become stale after a source refresh.
    pub generation: i64,
    /// Supported source files parsed or re-parsed during this refresh; this
    /// is not a total repository-file count.
    pub files_indexed: usize,
    pub files_skipped: usize,
    /// Existing edge occurrences whose target binding was recomputed during
    /// this refresh.
    pub relationships_rebound: usize,
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
    /// Why this relationship resolves to a candidate set rather than a
    /// confirmed single target. Absent for ordinary static facts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SemanticLocationFact {
    pub evidence: Evidence,
    pub start_column: u32,
    pub end_column: u32,
}

#[derive(Debug, Serialize)]
pub struct UnresolvedReferenceFact {
    pub specifier: String,
    pub kind: String,
    pub evidence: Evidence,
}

const PAGE_CURSOR_VERSION: u8 = 1;

#[derive(Debug, Serialize, Deserialize)]
struct PageCursor {
    version: u8,
    generation: i64,
    offset: usize,
    scope: String,
}

/// Discovery scope for `search` and `outline`.
///
/// `TopLevel` keeps structural symbols while excluding variables declared
/// inside a function or method. `All` retains every indexed symbol for callers
/// that need to inspect local implementation detail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymbolScope {
    TopLevel,
    All,
}

impl SymbolScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TopLevel => "top_level",
            Self::All => "all",
        }
    }

    pub fn parse(input: &str) -> Option<Self> {
        match input {
            "top_level" => Some(Self::TopLevel),
            "all" => Some(Self::All),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct SearchFilters<'a> {
    kind: Option<NodeKind>,
    path_prefix: Option<&'a str>,
    symbol_scope: SymbolScope,
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
        let root = canonical_repository_root(root.as_ref())?;

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
        Ok(freshness(
            result,
            repository_root_identity(&self.root),
            self.store.generation()?,
        ))
    }

    pub fn map(&self) -> Result<Value> {
        let freshness = self.refresh()?;
        let stats = self.store.get_stats()?;
        let nodes = self.store.get_all_nodes()?;
        let unresolved_references = self.unresolved_reference_report()?;
        let mut language_symbol_counts = BTreeMap::<String, usize>::new();
        let mut kinds = BTreeMap::<String, usize>::new();
        let mut indexed_languages = Vec::with_capacity(nodes.len());
        for node in &nodes {
            *language_symbol_counts
                .entry(node.language.as_str().to_string())
                .or_default() += 1;
            *kinds.entry(node.kind.as_str().to_string()).or_default() += 1;
            indexed_languages.push(node.language);
        }
        let language_file_counts = self.store.get_language_file_counts()?;
        let languages = language_file_counts.clone();
        let indexed_files = language_file_counts.values().sum::<usize>();
        let files_indexed_this_refresh = freshness.files_indexed;

        Ok(json!({
            "repository": repository_root_identity(&self.root),
            "freshness": freshness,
            // `files` and `languages` are retained as compact compatibility
            // aliases. The explicit fields below make their meanings visible
            // without comparing an all-time fact count to one refresh pass.
            "files": stats.files,
            "files_with_facts": stats.files,
            "indexed_files": indexed_files,
            "files_indexed_this_refresh": files_indexed_this_refresh,
            "symbols": stats.nodes,
            "relationships": stats.edges,
            "languages": languages,
            "language_file_counts": language_file_counts,
            "language_symbol_counts": language_symbol_counts,
            "symbol_kinds": kinds,
            "unresolved_references": unresolved_references,
            "lsp": self.lsp.report(indexed_languages, false),
        }))
    }

    pub fn search(&self, query: &str, limit: Option<usize>) -> Result<Value> {
        self.search_with_options(query, None, None, 0, limit)
    }

    /// Search while narrowing by an exact node kind and repository-relative
    /// path prefix, then return one bounded page of the stable result order.
    pub fn search_with_options(
        &self,
        query: &str,
        kind: Option<NodeKind>,
        path_prefix: Option<&str>,
        offset: usize,
        limit: Option<usize>,
    ) -> Result<Value> {
        self.search_with_page_options(query, kind, path_prefix, offset, None, limit)
    }

    /// Search a bounded page using an optional opaque snapshot cursor.  The
    /// legacy `offset` remains supported for compatibility, but callers that
    /// need a coherent multi-page answer should pass `next_cursor` back.
    pub fn search_with_page_options(
        &self,
        query: &str,
        kind: Option<NodeKind>,
        path_prefix: Option<&str>,
        offset: usize,
        cursor: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Value> {
        self.search_with_page_scope_options(
            query,
            kind,
            path_prefix,
            SymbolScope::TopLevel,
            offset,
            cursor,
            limit,
        )
    }

    /// Search with an explicit structural/local scope. This preserves the
    /// legacy Rust API above while exposing a narrow MCP filter for callers
    /// that need local variables.
    #[allow(clippy::too_many_arguments)] // Mirrors the individually optional MCP arguments.
    pub fn search_with_page_scope_options(
        &self,
        query: &str,
        kind: Option<NodeKind>,
        path_prefix: Option<&str>,
        symbol_scope: SymbolScope,
        offset: usize,
        cursor: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Value> {
        let freshness = self.refresh()?;
        let limit = bounded_limit(limit);
        let path_prefix = path_prefix
            .map(|prefix| self.normalized_path_prefix(prefix))
            .transpose()?
            .flatten();
        let filters = SearchFilters {
            kind,
            path_prefix: path_prefix.as_deref(),
            symbol_scope,
        };
        let scope = page_scope(&[
            "search",
            &freshness.repository_root,
            query,
            kind.map(|kind| kind.as_str()).unwrap_or(""),
            path_prefix.as_deref().unwrap_or(""),
            symbol_scope.as_str(),
        ]);
        let offset = match page_offset(cursor, offset, freshness.generation, &scope)? {
            PageOffset::Current(offset) => offset,
            PageOffset::Stale => {
                return Ok(json!({
                    "freshness": freshness,
                    "status": "stale_cursor",
                    "query": query,
                    "scope": symbol_scope.as_str(),
                    "results": [],
                    "next_cursor": Value::Null,
                    "next_offset": Value::Null,
                    "message": "The index changed after this page was issued. Restart the search from the first page so every result comes from one snapshot.",
                }));
            }
        };
        let Some(fts_query) = fts_query(query) else {
            return Ok(json!({
                "freshness": freshness,
                "status": "ok",
                "query": query,
                "scope": symbol_scope.as_str(),
                "results": [],
                "offset": offset,
                "next_cursor": Value::Null,
                "next_offset": Value::Null,
                "message": "Search needs at least one identifier or word; raw grep is not supported."
            }));
        };

        // A symbol-name lookup is stronger evidence than a full-text match.
        // Put exact names first so a common identifier does not get pushed out
        // of the bounded FTS result set by comments, signatures, or file paths.
        // Filtering and paging happen after this ordering is established.
        let exact_name = query.trim();
        let mut exact_nodes = self.store.get_nodes_by_name(exact_name)?;
        exact_nodes.retain(|node| node_matches_filters(node, filters.kind, filters.path_prefix));
        self.filter_nodes_by_scope(&mut exact_nodes, filters.symbol_scope)?;
        let exact_count = exact_nodes.len();

        // Fetch one additional item to say whether the caller can continue.
        let page_capacity = limit.saturating_add(1);
        let mut nodes = if offset < exact_count {
            exact_nodes
                .into_iter()
                .skip(offset)
                .take(page_capacity)
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };

        if nodes.len() < page_capacity {
            let fts_offset = offset.saturating_sub(exact_count);
            let remaining = page_capacity - nodes.len();
            nodes.extend(
                self.search_fts_nodes(&fts_query, exact_name, filters, fts_offset, remaining)?,
            );
        }

        let has_more = nodes.len() > limit;
        nodes.truncate(limit);
        let results = nodes
            .iter()
            .map(|node| self.symbol_fact(node))
            .collect::<Result<Vec<_>>>()?;

        Ok(json!({
            "freshness": freshness,
            "query": query,
            "scope": symbol_scope.as_str(),
            "results": results,
            "offset": offset,
            "next_cursor": has_more.then(|| encode_page_cursor(freshness.generation, offset.saturating_add(limit), &scope)).transpose()?,
            "next_offset": has_more.then_some(offset.saturating_add(limit)),
            "bounded_by": limit,
        }))
    }

    pub fn outline(&self, file_path: &str, limit: Option<usize>) -> Result<Value> {
        self.outline_with_offset(file_path, 0, limit)
    }

    /// Return one bounded page of symbols in a file, in source order.
    pub fn outline_with_offset(
        &self,
        file_path: &str,
        offset: usize,
        limit: Option<usize>,
    ) -> Result<Value> {
        self.outline_with_page_options(file_path, offset, None, limit)
    }

    /// Return a snapshot-bound source-order page for one file.
    pub fn outline_with_page_options(
        &self,
        file_path: &str,
        offset: usize,
        cursor: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Value> {
        self.outline_with_page_scope_options(
            file_path,
            None,
            SymbolScope::TopLevel,
            offset,
            cursor,
            limit,
        )
    }

    /// Return a snapshot-bound source-order page with optional kind and local
    /// implementation-detail filters.
    pub fn outline_with_page_scope_options(
        &self,
        file_path: &str,
        kind: Option<NodeKind>,
        symbol_scope: SymbolScope,
        offset: usize,
        cursor: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Value> {
        let freshness = self.refresh()?;
        let file_path = self.relative_path(file_path)?;
        let limit = bounded_limit(limit);
        let page_scope = page_scope(&[
            "outline",
            &freshness.repository_root,
            &file_path,
            kind.map(|kind| kind.as_str()).unwrap_or(""),
            symbol_scope.as_str(),
        ]);
        let offset = match page_offset(cursor, offset, freshness.generation, &page_scope)? {
            PageOffset::Current(offset) => offset,
            PageOffset::Stale => {
                return Ok(json!({
                    "freshness": freshness,
                    "status": "stale_cursor",
                    "file_path": file_path,
                    "kind": kind.map(|kind| kind.as_str()),
                    "scope": symbol_scope.as_str(),
                    "symbols": [],
                    "next_cursor": Value::Null,
                    "next_offset": Value::Null,
                    "message": "The index changed after this page was issued. Restart the outline from the first page so every result comes from one snapshot.",
                }));
            }
        };
        let mut nodes = self.store.get_nodes_by_file(&file_path)?;
        if let Some(kind) = kind {
            nodes.retain(|node| node.kind == kind);
        }
        self.filter_nodes_by_scope(&mut nodes, symbol_scope)?;
        nodes.sort_by_key(|node| (node.start_line, node.start_column));
        let page_end = offset.saturating_add(limit);
        let truncated = nodes.len() > page_end;
        let symbols = nodes
            .iter()
            .skip(offset)
            .take(limit)
            .map(|node| self.symbol_fact(node))
            .collect::<Result<Vec<_>>>()?;

        Ok(json!({
            "freshness": freshness,
            "file_path": file_path,
            "kind": kind.map(|kind| kind.as_str()),
            "scope": symbol_scope.as_str(),
            "symbols": symbols,
            "offset": offset,
            "next_cursor": truncated.then(|| encode_page_cursor(freshness.generation, page_end, &page_scope)).transpose()?,
            "next_offset": truncated.then_some(page_end),
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
        let section = markdown_section(&node);

        Ok(json!({
            "freshness": freshness,
            "status": "ok",
            "definition": self.symbol_fact(&node)?,
            "section": section,
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
        self.path_with_files(from, None, to, None, limit)
    }

    /// Find a static calls path after optionally disambiguating each endpoint
    /// with a repository-relative file path.
    pub fn path_with_files(
        &self,
        from: &str,
        from_file_path: Option<&str>,
        to: &str,
        to_file_path: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Value> {
        let freshness = self.refresh()?;
        let limit = bounded_limit(limit);
        let from = match self.resolve_symbol(from, from_file_path)? {
            SymbolResolution::One(node) => node,
            other => return self.path_resolution_result(freshness, "from", other),
        };
        let to = match self.resolve_symbol(to, to_file_path)? {
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

        let mut queue = VecDeque::from([from.id.clone()]);
        let mut previous = HashMap::<String, (String, CodeEdge)>::new();
        let mut visited = HashSet::from([from.id.clone()]);

        while !queue.is_empty() {
            if visited.len() >= PATH_SEARCH_VISIT_LIMIT {
                break;
            }
            // Query only the current breadth-first frontier. This preserves
            // shortest-path semantics without loading every node and edge in
            // a large repository for each MCP request.
            let frontier_size = queue
                .len()
                .min(PATH_SEARCH_VISIT_LIMIT.saturating_sub(visited.len()));
            let frontier = queue.drain(..frontier_size).collect::<Vec<_>>();
            let edges = self
                .store
                .get_confirmed_outgoing_edges(&frontier, EdgeKind::Calls.as_str())?;
            for edge in edges {
                if visited.len() >= PATH_SEARCH_VISIT_LIMIT {
                    break;
                }
                if visited.insert(edge.target.clone()) {
                    previous.insert(edge.target.clone(), (edge.source.clone(), edge.clone()));
                    if edge.target == to.id {
                        let (nodes, relationships) =
                            self.reconstruct_path(&from.id, &to.id, &previous)?;
                        if nodes.len() > limit {
                            return Ok(json!({
                                "freshness": freshness,
                                "status": "path_too_long",
                                "from": self.symbol_fact(&from)?,
                                "to": self.symbol_fact(&to)?,
                                "path_length": nodes.len(),
                                "maximum_path_length": limit,
                                "relationship_kind": "calls",
                                "message": "A shortest static calls path was found, but returning it would exceed the response limit. Increase limit up to 50 or inspect intermediate symbols with expand.",
                            }));
                        }
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

    fn unresolved_reference_report(&self) -> Result<Value> {
        let references = self.store.get_unresolved_refs(None)?;
        let count = references.len();
        let samples = references
            .into_iter()
            .take(UNRESOLVED_REFERENCE_SAMPLE_LIMIT)
            .map(|reference| {
                Ok(UnresolvedReferenceFact {
                    specifier: reference.specifier,
                    kind: reference.ref_type,
                    evidence: Evidence {
                        file_path: reference.file_path.clone(),
                        start_line: reference.line,
                        end_line: reference.line,
                        source_hash: self.source_hash(&reference.file_path)?,
                        extractor: "tree-sitter".to_string(),
                        confidence: "unresolved".to_string(),
                    },
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(json!({
            "count": count,
            "samples": samples,
            "truncated": count > UNRESOLVED_REFERENCE_SAMPLE_LIMIT,
        }))
    }

    fn filter_nodes_by_scope(
        &self,
        nodes: &mut Vec<CodeNode>,
        symbol_scope: SymbolScope,
    ) -> Result<()> {
        if symbol_scope == SymbolScope::All || nodes.is_empty() {
            return Ok(());
        }
        let mut nodes_by_file = HashMap::<String, Vec<CodeNode>>::new();
        for file_path in nodes.iter().map(|node| node.file_path.as_str()) {
            if !nodes_by_file.contains_key(file_path) {
                nodes_by_file.insert(
                    file_path.to_string(),
                    self.store.get_nodes_by_file(file_path)?,
                );
            }
        }
        nodes.retain(|node| {
            nodes_by_file
                .get(&node.file_path)
                .is_none_or(|file_nodes| !is_local_variable(node, file_nodes))
        });
        Ok(())
    }

    fn search_fts_nodes(
        &self,
        fts_query: &str,
        exact_name: &str,
        filters: SearchFilters<'_>,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<CodeNode>> {
        let mut query = String::from(
            "SELECT nodes.* FROM fts_nodes
             JOIN nodes ON nodes.rowid = fts_nodes.rowid
             WHERE fts_nodes MATCH ?
               AND nodes.name <> ?",
        );
        let mut values = vec![
            SqlValue::Text(fts_query.to_string()),
            SqlValue::Text(exact_name.to_string()),
        ];

        if let Some(kind) = filters.kind {
            query.push_str(" AND nodes.type = ?");
            values.push(SqlValue::Text(kind.as_str().to_string()));
        }
        if let Some(prefix) = filters.path_prefix {
            let prefix_with_separator = format!("{prefix}/");
            // Avoid LIKE so valid path characters such as '%' and '_' retain
            // their literal meaning. The extra separator prevents `src` from
            // matching an unrelated `src-old` directory.
            query.push_str(
                " AND (nodes.file_path = ?
                   OR substr(nodes.file_path, 1, length(?)) = ?)",
            );
            values.push(SqlValue::Text(prefix.to_string()));
            values.push(SqlValue::Text(prefix_with_separator.clone()));
            values.push(SqlValue::Text(prefix_with_separator));
        }
        if filters.symbol_scope == SymbolScope::TopLevel {
            // Variables declared inside a function/method are useful only on
            // demand. Apply this before ranking and pagination so a page of
            // lexical noise cannot hide every structural symbol that follows.
            query.push_str(
                " AND (nodes.type <> 'variable' OR NOT EXISTS ( \
                    SELECT 1 FROM nodes enclosing \
                    WHERE enclosing.file_path = nodes.file_path \
                      AND enclosing.type IN ('function', 'method') \
                      AND enclosing.id <> nodes.id \
                      AND enclosing.start_line <= nodes.start_line \
                      AND enclosing.end_line >= nodes.end_line \
                ))",
            );
        }
        query.push_str(
            " ORDER BY bm25(fts_nodes), nodes.file_path, nodes.start_line, nodes.id
              LIMIT ? OFFSET ?",
        );
        let sql_limit = i64::try_from(limit)
            .map_err(|_| CodeFactsError::Other("search page limit is too large".into()))?;
        let sql_offset = i64::try_from(offset)
            .map_err(|_| CodeFactsError::Other("offset is too large".into()))?;
        values.push(SqlValue::Integer(sql_limit));
        values.push(SqlValue::Integer(sql_offset));

        let mut statement = self.store.conn.prepare_cached(&query)?;
        let rows = statement.query_and_then(params_from_iter(values.iter()), row_to_code_node)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
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
        self.store
            .get_related_test_nodes(&node.id, &node.name, &node.file_path, limit)?
            .iter()
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
            resolution: edge
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("resolution"))
                .cloned(),
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

    fn normalized_path_prefix(&self, input: &str) -> Result<Option<String>> {
        let prefix = self.relative_path(input)?;
        let prefix = prefix.trim_end_matches('/');
        if prefix.is_empty() || prefix == "." {
            Ok(None)
        } else {
            Ok(Some(prefix.to_string()))
        }
    }
}

impl CodeFactsRegistry {
    /// Create a registry with an optional default repository. Omitting the
    /// default never infers the process working directory: callers must pass
    /// `repository_root` to each MCP tool invocation instead.
    pub fn open_with_lsp(
        default_root: Option<PathBuf>,
        default_state_path: Option<PathBuf>,
        lsp_mode: LspMode,
    ) -> Result<Self> {
        if default_root.is_none() && default_state_path.is_some() {
            return Err(CodeFactsError::Other(
                "--state requires --root; dynamic project roots each use their own external default state path"
                    .into(),
            ));
        }

        let mut registry = Self {
            projects: HashMap::new(),
            default_root: None,
            lsp_mode,
        };
        if let Some(default_root) = default_root {
            let root = canonical_repository_root(&default_root)?;
            let state_path = default_state_path.unwrap_or_else(|| default_database_path(&root));
            let facts = CodeFacts::open_with_lsp(&root, &state_path, lsp_mode)?;
            registry.default_root = Some(root.clone());
            registry.projects.insert(root, facts);
        }
        Ok(registry)
    }

    /// Return the project selected for one tool call, opening its independent
    /// external SQLite store on first use.
    pub fn project(&mut self, repository_root: Option<&str>) -> Result<&CodeFacts> {
        let root = match repository_root {
            Some(repository_root) => canonical_repository_root(Path::new(repository_root))?,
            None => self.default_root.clone().ok_or_else(|| {
                CodeFactsError::Mcp(
                    "'repository_root' is required when CodeFacts was started without --root"
                        .into(),
                )
            })?,
        };

        if !self.projects.contains_key(&root) {
            let state_path = default_database_path(&root);
            let facts = CodeFacts::open_with_lsp(&root, &state_path, self.lsp_mode)?;
            self.projects.insert(root.clone(), facts);
        }
        self.projects.get(&root).ok_or_else(|| {
            CodeFactsError::Other(
                "selected repository disappeared from the CodeFacts registry".into(),
            )
        })
    }
}

fn canonical_repository_root(root: &Path) -> Result<PathBuf> {
    let root = root.canonicalize().map_err(CodeFactsError::Io)?;
    if !root.is_dir() {
        return Err(CodeFactsError::Other(format!(
            "repository root is not a directory: {}",
            root.display()
        )));
    }
    Ok(root)
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

fn freshness(result: IndexResult, repository_root: String, generation: i64) -> Freshness {
    Freshness {
        status: "fresh",
        repository_root,
        generation,
        files_indexed: result.files_indexed,
        files_skipped: result.files_skipped,
        relationships_rebound: result.relationships_rebound,
        duration_ms: result.duration_ms,
    }
}

/// Return a stable, user-facing form of the canonical root. Windows
/// `canonicalize` commonly prepends `\\?\`, which is correct for Win32 APIs
/// but makes an otherwise identical `D:\repo` scope check fail in an MCP
/// client that compares paths as strings.
fn repository_root_identity(root: &Path) -> String {
    let root = root.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        if let Some(unc) = root.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{unc}")
        } else {
            root.strip_prefix(r"\\?\")
                .unwrap_or(root.as_str())
                .to_string()
        }
    }
    #[cfg(not(windows))]
    root
}

enum PageOffset {
    Current(usize),
    Stale,
}

fn page_scope(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    hex::encode(hasher.finalize())
}

fn encode_page_cursor(generation: i64, offset: usize, scope: &str) -> Result<String> {
    let cursor = PageCursor {
        version: PAGE_CURSOR_VERSION,
        generation,
        offset,
        scope: scope.to_string(),
    };
    Ok(hex::encode(serde_json::to_vec(&cursor)?))
}

fn page_offset(
    cursor: Option<&str>,
    offset: usize,
    generation: i64,
    scope: &str,
) -> Result<PageOffset> {
    let Some(cursor) = cursor else {
        return Ok(PageOffset::Current(offset));
    };
    if offset != 0 {
        return Err(CodeFactsError::Other(
            "use either cursor or a non-zero offset, not both".into(),
        ));
    }
    let bytes = hex::decode(cursor)
        .map_err(|_| CodeFactsError::Other("cursor is not valid CodeFacts page data".into()))?;
    let cursor: PageCursor = serde_json::from_slice(&bytes)
        .map_err(|_| CodeFactsError::Other("cursor is not valid CodeFacts page data".into()))?;
    if cursor.version != PAGE_CURSOR_VERSION || cursor.scope != scope {
        return Err(CodeFactsError::Other(
            "cursor does not belong to this search or outline request".into(),
        ));
    }
    if cursor.generation != generation {
        return Ok(PageOffset::Stale);
    }
    Ok(PageOffset::Current(cursor.offset))
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

fn node_matches_filters(
    node: &CodeNode,
    kind: Option<NodeKind>,
    path_prefix: Option<&str>,
) -> bool {
    kind.is_none_or(|kind| node.kind == kind)
        && path_prefix.is_none_or(|prefix| path_matches_prefix(&node.file_path, prefix))
}

fn is_local_variable(node: &CodeNode, file_nodes: &[CodeNode]) -> bool {
    node.kind == NodeKind::Variable
        && file_nodes.iter().any(|enclosing| {
            matches!(enclosing.kind, NodeKind::Function | NodeKind::Method)
                && enclosing.id != node.id
                && enclosing.start_line <= node.start_line
                && enclosing.end_line >= node.end_line
        })
}

fn path_matches_prefix(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn extractor_for(node: &CodeNode) -> &'static str {
    match node.kind {
        crate::types::NodeKind::Endpoint => "endpoint-ast",
        crate::types::NodeKind::Heading => "markdown-heading",
        _ => "tree-sitter",
    }
}

fn markdown_section(node: &CodeNode) -> Value {
    if node.language != crate::types::Language::Markdown || node.kind != NodeKind::Heading {
        return Value::Null;
    }
    let content = node.body.as_deref().unwrap_or("");
    let end = content.floor_char_boundary(content.len().min(MAX_MARKDOWN_SECTION_RESPONSE_LEN));
    json!({
        "content": &content[..end],
        "truncated": end < content.len(),
        "start_line": node.start_line,
        "end_line": node.end_line,
    })
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
