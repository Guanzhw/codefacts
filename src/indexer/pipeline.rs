//! Indexing pipeline — the heart of CodeGraph.
//!
//! Orchestrates file discovery, parsing, node/edge extraction, and
//! incremental storage. Uses rayon for parallel parsing (the killer
//! Rust advantage over the sequential TypeScript version).
//!
//! # Two-pass architecture
//!
//! - **Pass 1**: Parse every file and extract nodes (embarrassingly parallel —
//!   each file is independent). tree-sitter `Parser` is not Send/Sync, so we
//!   create one per rayon task.
//! - **Pass 2**: Build a cross-file node index, then extract edges. Edge
//!   extraction needs the global symbol table, but each file is still
//!   independent once the index is built.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use ignore::WalkBuilder;
use rayon::prelude::*;
use sha2::{Digest, Sha256};

use crate::error::Result;
use crate::graph::store::GraphStore;
use crate::indexer::endpoints::{extract_endpoint_edges, extract_endpoints, EndpointBinding};
use crate::indexer::extractor::Extractor;
use crate::indexer::markdown::extract_markdown;
use crate::indexer::parser::CodeParser;
use crate::resolution::imports::resolve_imports;
use crate::types::{CodeEdge, CodeNode, EdgeKind, Language, NodeKind};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Skip files larger than 2 MB (generated files, minified bundles, etc.)
const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024;
/// A dynamic call can have many same-named candidates in a large repository.
/// Preserve a bounded, deterministic candidate set rather than falsely
/// promoting one arbitrary target to a static fact.
const MAX_AMBIGUOUS_CALL_TARGETS: usize = 32;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Options controlling an indexing run.
pub struct IndexOptions {
    pub root_dir: PathBuf,
    pub incremental: bool,
}

/// Summary of an indexing run.
#[derive(Debug, Clone)]
pub struct IndexResult {
    pub files_indexed: usize,
    pub files_skipped: usize,
    pub nodes_created: usize,
    pub edges_created: usize,
    /// Existing edge occurrences whose target bindings were recomputed during
    /// an incremental refresh.
    pub relationships_rebound: usize,
    pub duration_ms: u128,
}

impl std::fmt::Display for IndexResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Indexed {} files ({} skipped): {} nodes, {} edges in {}ms",
            self.files_indexed,
            self.files_skipped,
            self.nodes_created,
            self.edges_created,
            self.duration_ms,
        )
    }
}

/// Per-file state carried between Pass 1 and Pass 2.
struct FileParseState {
    relative_path: String,
    language: Language,
    content_hash: String,
    source_text: String,
    nodes: Vec<CodeNode>,
    endpoints: Vec<EndpointBinding>,
    markdown_edges: Vec<CodeEdge>,
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/// The two-pass indexing pipeline.
pub struct IndexingPipeline<'a> {
    store: &'a GraphStore,
}

impl<'a> IndexingPipeline<'a> {
    pub fn new(store: &'a GraphStore) -> Self {
        Self { store }
    }

    /// Index an entire directory tree.
    pub fn index_directory(&self, options: &IndexOptions) -> Result<IndexResult> {
        let start = Instant::now();
        let root = &options.root_dir;
        // Schema migrations can retain old rows only long enough to discover
        // the repository; their relationship evidence is not trustworthy.
        // Force one source pass, then return to the incremental path.
        let incremental = options.incremental && !self.store.full_reindex_required()?;

        // ---- Collect files ----
        let file_paths = collect_files(root);

        // Remove facts for files that are deleted, renamed, newly ignored, or
        // no longer indexable. Without this sweep an incremental index would
        // retain symbols that are absent from the current repository view.
        let current_paths: HashSet<String> = file_paths
            .iter()
            .filter_map(|path| path.strip_prefix(root).ok())
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect();
        let removed_nodes = self.remove_paths_not_in(&current_paths)?;

        // Pre-fetch all file hashes for incremental checks (before rayon).
        // This avoids touching the non-Sync Connection from parallel threads.
        let stored_hashes: HashMap<String, String> = if incremental {
            self.load_all_file_hashes()
        } else {
            HashMap::new()
        };

        let files_skipped = AtomicUsize::new(0);

        // ---- Pass 1: parse & extract nodes (parallel via rayon) ----
        // The closure only captures `root`, `stored_hashes`, `files_skipped`,
        // and `incremental` — all are Sync. No DB access here.
        let parsed: Vec<FileParseState> = file_paths
            .par_iter()
            .filter_map(|abs_path| {
                // Compute relative path
                let rel_path = match abs_path.strip_prefix(root) {
                    Ok(r) => r.to_string_lossy().replace('\\', "/"),
                    Err(_) => {
                        files_skipped.fetch_add(1, Ordering::Relaxed);
                        return None;
                    }
                };

                // Check file size
                let metadata = match fs::metadata(abs_path) {
                    Ok(m) => m,
                    Err(_) => {
                        files_skipped.fetch_add(1, Ordering::Relaxed);
                        return None;
                    }
                };
                if metadata.len() > MAX_FILE_SIZE {
                    files_skipped.fetch_add(1, Ordering::Relaxed);
                    return None;
                }

                // Read source text
                let source_text = match fs::read_to_string(abs_path) {
                    Ok(s) => s,
                    Err(_) => {
                        files_skipped.fetch_add(1, Ordering::Relaxed);
                        return None;
                    }
                };

                // Content hash for incremental indexing
                let content_hash = sha256_hex(&source_text);

                // Incremental: skip if unchanged (using pre-fetched hash map)
                if incremental {
                    if let Some(stored) = stored_hashes.get(&rel_path) {
                        if stored == &content_hash {
                            files_skipped.fetch_add(1, Ordering::Relaxed);
                            return None;
                        }
                    }
                }

                // Detect language
                let language = match CodeParser::detect_language(&rel_path) {
                    Some(l) => l,
                    None => {
                        files_skipped.fetch_add(1, Ordering::Relaxed);
                        return None;
                    }
                };

                let (mut nodes, endpoints, markdown_edges) = if language == Language::Markdown {
                    let extraction = extract_markdown(&rel_path, &source_text);
                    (extraction.nodes, Vec::new(), extraction.edges)
                } else {
                    // Parse with a thread-local Parser (Parser is NOT Send/Sync)
                    let parser = CodeParser::new();
                    let tree = match parser.parse(&source_text, language) {
                        Ok(t) => t,
                        Err(_) => {
                            files_skipped.fetch_add(1, Ordering::Relaxed);
                            return None;
                        }
                    };
                    let nodes =
                        match Extractor::extract_nodes(&tree, &rel_path, language, &source_text) {
                            Ok(n) => n,
                            Err(_) => {
                                files_skipped.fetch_add(1, Ordering::Relaxed);
                                return None;
                            }
                        };
                    (
                        nodes,
                        extract_endpoints(&rel_path, language, &source_text, &tree),
                        Vec::new(),
                    )
                };
                nodes.extend(endpoints.iter().map(|binding| binding.endpoint.clone()));

                Some(FileParseState {
                    relative_path: rel_path,
                    language,
                    content_hash,
                    source_text,
                    nodes,
                    endpoints,
                    markdown_edges,
                })
            })
            .collect();

        // ---- Build cross-file node index ----
        // Keep existing nodes owned for the entire pass because `all_nodes`
        // borrows them while extracting edges for changed files.
        let existing_nodes = if incremental {
            self.store.get_all_nodes()?
        } else {
            Vec::new()
        };
        let mut all_nodes: Vec<&CodeNode> = Vec::new();
        for state in &parsed {
            for node in &state.nodes {
                all_nodes.push(node);
            }
        }

        // In incremental mode, include existing nodes from files we didn't re-parse.
        if incremental {
            let reindexed_paths: std::collections::HashSet<&str> =
                parsed.iter().map(|s| s.relative_path.as_str()).collect();
            for node in &existing_nodes {
                if !reindexed_paths.contains(node.file_path.as_str()) {
                    all_nodes.push(node);
                }
            }
        }

        let node_index = build_node_index(&all_nodes);
        let reindexed_paths: HashSet<&str> = parsed
            .iter()
            .map(|state| state.relative_path.as_str())
            .collect();
        let mut changed_target_names: HashSet<String> =
            removed_nodes.iter().map(|node| node.name.clone()).collect();
        if incremental {
            changed_target_names.extend(
                existing_nodes
                    .iter()
                    .filter(|node| reindexed_paths.contains(node.file_path.as_str()))
                    .map(|node| node.name.clone()),
            );
        }
        changed_target_names.extend(
            parsed
                .iter()
                .flat_map(|state| state.nodes.iter().map(|node| node.name.clone())),
        );

        // ---- Pass 2: extract edges & persist (parallel edge extraction) ----
        #[allow(clippy::type_complexity)]
        let edge_results: Vec<
            Result<(String, Language, String, Vec<CodeNode>, Vec<CodeEdge>)>,
        > = parsed
            .par_iter()
            .map(|state| {
                let mut edges = if state.language == Language::Markdown {
                    state.markdown_edges.clone()
                } else {
                    // Each thread creates its own Parser (not Send/Sync)
                    let parser = CodeParser::new();
                    let tree = parser.parse(&state.source_text, state.language)?;
                    Extractor::extract_edges(
                        &tree,
                        &state.relative_path,
                        state.language,
                        &state.source_text,
                        &state.nodes,
                        &node_index,
                    )?
                };
                // On a full pass every source file is already present in the
                // in-memory node index. Resolve receiver dispatch here rather
                // than doing a second SQLite-wide relationship rewrite after
                // persistence. This keeps cold indexing proportional to the
                // source pass while still preserving polymorphic candidates.
                edges = resolve_initial_call_candidates(edges, &node_index);
                edges.extend(extract_endpoint_edges(&state.endpoints, &node_index));

                Ok((
                    state.relative_path.clone(),
                    state.language,
                    state.content_hash.clone(),
                    state.nodes.clone(),
                    edges,
                ))
            })
            .collect();

        // ---- Collect edge results ----
        type FileData = (String, Language, String, Vec<CodeNode>, Vec<CodeEdge>);
        let mut file_data: Vec<FileData> = Vec::new();
        for result in edge_results {
            file_data.push(result?);
        }

        // ---- Persist to SQLite (sequential — single connection) ----
        let mut files_indexed = 0usize;
        let mut nodes_created = 0usize;
        let mut edges_created = 0usize;
        let mut relationships_rebound = 0usize;

        for (rel_path, language, content_hash, nodes, edges) in file_data {
            self.store.replace_file_data(&rel_path, &nodes, &edges)?;
            self.upsert_file_hash(&rel_path, &content_hash, language)?;

            nodes_created += nodes.len();
            edges_created += edges.len();
            files_indexed += 1;
        }

        let changed = files_indexed > 0 || !removed_nodes.is_empty();
        if changed {
            let current_nodes = self.store.get_all_nodes()?;
            // A full pass resolves call candidates before persistence. Only
            // an incremental pass needs to revisit unchanged callers after a
            // target definition has been added, moved, or removed.
            if incremental {
                relationships_rebound =
                    self.rebind_static_targets(&changed_target_names, &current_nodes)?;
            }

            // Import resolution depends on both source paths and target
            // symbols. Re-evaluate its small derived relation set without
            // parsing unchanged files.
            self.store.delete_resolved_import_edges()?;
            self.store.clear_all_unresolved_refs()?;
            let current_node_refs = current_nodes.iter().collect::<Vec<_>>();
            let current_node_index = build_node_index(&current_node_refs);
            let mut nodes_by_file: HashMap<String, Vec<CodeNode>> = HashMap::new();
            for node in &current_nodes {
                nodes_by_file
                    .entry(node.file_path.clone())
                    .or_default()
                    .push(node.clone());
            }
            let raw_import_edges = self.store.get_raw_import_edges()?;
            let resolution_result = resolve_imports(
                &raw_import_edges,
                &current_paths,
                &current_node_index,
                &nodes_by_file,
            );
            self.store.upsert_edges(&resolution_result.resolved_edges)?;
            edges_created += resolution_result.resolved_edges.len();
            for uref in &resolution_result.unresolved_refs {
                self.store.insert_unresolved_ref(
                    &uref.source_id,
                    &uref.specifier,
                    &uref.ref_type,
                    &uref.file_path,
                    uref.line,
                )?;
            }

            if !incremental {
                self.store.mark_full_reindex_complete()?;
            }
            self.store.advance_generation()?;
        } else if !incremental {
            // An empty repository is still a successful full source pass.
            // Clear an extractor/schema migration marker so it does not force
            // every later read to repeat the same no-op rebuild.
            self.store.mark_full_reindex_complete()?;
        }

        Ok(IndexResult {
            files_indexed,
            files_skipped: files_skipped.load(Ordering::Relaxed),
            nodes_created,
            edges_created,
            relationships_rebound,
            duration_ms: start.elapsed().as_millis(),
        })
    }

    /// Remove a file from the index entirely.
    pub fn remove_file(&self, relative_path: &str) -> Result<()> {
        self.store
            .delete_file_nodes_preserving_incoming(relative_path)?;
        self.store.clear_unresolved_refs_for_file(relative_path)?;
        self.delete_file_hash(relative_path)?;
        Ok(())
    }

    /// Re-resolve unchanged static relationship facts whose source spelling
    /// names a definition that was added, moved, or removed.  This is a
    /// database relation pass, not a source reparse.
    fn rebind_static_targets(
        &self,
        changed_names: &HashSet<String>,
        current_nodes: &[CodeNode],
    ) -> Result<usize> {
        if changed_names.is_empty() {
            return Ok(0);
        }
        let mut names = changed_names.iter().cloned().collect::<Vec<_>>();
        names.sort();
        let edges = self.store.get_edges_by_target_names(&names)?;
        if edges.is_empty() {
            return Ok(0);
        }

        let node_refs = current_nodes.iter().collect::<Vec<_>>();
        let node_index = build_node_index(&node_refs);
        let mut candidate_groups: HashMap<String, Vec<CodeEdge>> = HashMap::new();
        let mut deleted = Vec::new();
        let mut inserted = Vec::new();

        for edge in edges {
            let Some(target_name) = edge.target_name.as_deref() else {
                continue;
            };
            if is_endpoint_candidate(&edge) || edge.kind == EdgeKind::Calls {
                candidate_groups
                    .entry(candidate_group_key(&edge, target_name))
                    .or_default()
                    .push(edge);
                continue;
            }

            let target_id = resolve_target_id(target_name, &edge.file_path, &node_index);
            if target_id != edge.target {
                deleted.push(edge.clone());
                let mut rebound_edge = edge;
                rebound_edge.target = target_id;
                inserted.push(rebound_edge);
            }
        }

        // Endpoint handler references and receiver dispatch with duplicate
        // definitions are candidate sets. Recreate each source location
        // instead of silently calling one same-named method a static fact.
        for group in candidate_groups.into_values() {
            let Some(template) = group.first() else {
                continue;
            };
            let Some(target_name) = template.target_name.as_deref() else {
                continue;
            };
            deleted.extend(group.iter().cloned());

            let candidates = if is_endpoint_candidate(template) {
                let targets = callable_candidates(template, target_name, &node_index);
                CandidateSet {
                    candidate_count: targets.len(),
                    targets,
                    resolution: Some("endpoint_handler_candidate"),
                }
            } else {
                call_candidates(template, target_name, &node_index)
            };
            if candidates.targets.is_empty() {
                let mut unresolved = template.clone();
                unresolved.target = format!("unresolved:{target_name}");
                inserted.push(unresolved);
            } else {
                inserted.extend(materialize_candidate_edges(template, candidates));
            }
        }

        // Count the persisted edge occurrences we actually replaced, rather
        // than endpoint candidate groups. A group can represent several
        // stored target edges after a previous heuristic resolution.
        let rebound = deleted.len();
        if !deleted.is_empty() {
            self.store.replace_edge_occurrences(&deleted, &inserted)?;
        }

        Ok(rebound)
    }

    // -----------------------------------------------------------------------
    // File hash helpers (incremental indexing)
    // -----------------------------------------------------------------------

    /// Load all stored file hashes into memory for fast incremental lookups.
    /// Called once before the parallel section to avoid DB access from rayon threads.
    fn load_all_file_hashes(&self) -> HashMap<String, String> {
        let mut map = HashMap::new();
        let result = self
            .store
            .conn
            .prepare("SELECT file_path, content_hash FROM file_hashes");
        if let Ok(mut stmt) = result {
            let _ = stmt
                .query_map([], |row| {
                    let path: String = row.get(0)?;
                    let hash: String = row.get(1)?;
                    Ok((path, hash))
                })
                .map(|rows| {
                    for row in rows.flatten() {
                        map.insert(row.0, row.1);
                    }
                });
        }
        map
    }

    fn remove_paths_not_in(&self, current_paths: &HashSet<String>) -> Result<Vec<CodeNode>> {
        let mut removed_nodes = Vec::new();
        for relative_path in self.load_all_file_hashes().into_keys() {
            if !current_paths.contains(&relative_path) {
                removed_nodes.extend(self.store.get_nodes_by_file(&relative_path)?);
                self.remove_file(&relative_path)?;
            }
        }
        Ok(removed_nodes)
    }

    fn upsert_file_hash(
        &self,
        file_path: &str,
        content_hash: &str,
        language: Language,
    ) -> Result<()> {
        self.store
            .conn
            .prepare_cached(
                "INSERT INTO file_hashes (file_path, content_hash, language)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(file_path) DO UPDATE SET
               content_hash = excluded.content_hash,
               indexed_at = datetime('now'),
               language = excluded.language",
            )?
            .execute(rusqlite::params![
                file_path,
                content_hash,
                language.as_str()
            ])?;
        Ok(())
    }

    fn delete_file_hash(&self, file_path: &str) -> Result<()> {
        self.store
            .conn
            .prepare_cached("DELETE FROM file_hashes WHERE file_path = ?1")?
            .execute([file_path])?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// File collection (using the `ignore` crate for gitignore awareness)
// ---------------------------------------------------------------------------

fn resolve_target_id(
    name: &str,
    source_file: &str,
    node_index: &HashMap<String, Vec<CodeNode>>,
) -> String {
    let Some(candidates) = node_index.get(name) else {
        return format!("unresolved:{name}");
    };
    let target = candidates
        .iter()
        .find(|node| node.file_path == source_file)
        .or_else(|| {
            (candidates.len() == 1)
                .then(|| candidates.first())
                .flatten()
        })
        .or_else(|| candidates.iter().find(|node| node.exported == Some(true)))
        .or_else(|| candidates.iter().find(|node| node.file_path != source_file))
        .or_else(|| candidates.first());
    target
        .map(|node| node.id.clone())
        .unwrap_or_else(|| format!("unresolved:{name}"))
}

fn is_endpoint_candidate(edge: &CodeEdge) -> bool {
    edge.metadata
        .as_ref()
        .and_then(|metadata| metadata.get("relation"))
        .is_some_and(|relation| relation == "endpoint_handler_candidate")
}

fn candidate_group_key(edge: &CodeEdge, target_name: &str) -> String {
    format!(
        "{}\u{0}{}\u{0}{}\u{0}{}\u{0}{}",
        edge.source,
        edge.kind.as_str(),
        edge.file_path,
        edge.line,
        target_name
    )
}

struct CandidateSet<'a> {
    targets: Vec<&'a CodeNode>,
    resolution: Option<&'static str>,
    candidate_count: usize,
}

/// Materialize a bounded candidate set as relationship occurrences while
/// retaining the uncertainty label on every emitted edge.
fn materialize_candidate_edges(template: &CodeEdge, candidates: CandidateSet<'_>) -> Vec<CodeEdge> {
    let truncated = candidates.candidate_count > MAX_AMBIGUOUS_CALL_TARGETS;
    candidates
        .targets
        .into_iter()
        .take(MAX_AMBIGUOUS_CALL_TARGETS)
        .map(|target| {
            let mut resolved = template.clone();
            resolved.target = target.id.clone();
            if let Some(resolution) = candidates.resolution {
                let metadata = resolved.metadata.get_or_insert_with(HashMap::new);
                metadata.insert("confidence".to_string(), "heuristic".to_string());
                metadata.insert("resolution".to_string(), resolution.to_string());
                metadata.insert(
                    "candidate_count".to_string(),
                    candidates.candidate_count.to_string(),
                );
                if truncated {
                    metadata.insert("candidates_truncated".to_string(), "true".to_string());
                }
            }
            resolved
        })
        .collect()
}

/// Resolve ambiguous calls directly against the complete in-memory node index
/// for files being parsed in this pass. This avoids a full-database rebinding
/// scan on cold indexes; unchanged callers are repaired by the incremental
/// rebinding path after later source changes.
fn resolve_initial_call_candidates(
    edges: Vec<CodeEdge>,
    node_index: &HashMap<String, Vec<CodeNode>>,
) -> Vec<CodeEdge> {
    let mut resolved = Vec::with_capacity(edges.len());
    for edge in edges {
        if edge.kind != EdgeKind::Calls {
            resolved.push(edge);
            continue;
        }
        let Some(target_name) = edge.target_name.as_deref() else {
            resolved.push(edge);
            continue;
        };
        let candidates = call_candidates(&edge, target_name, node_index);
        if candidates.resolution.is_none() || candidates.targets.is_empty() {
            resolved.push(edge);
        } else {
            resolved.extend(materialize_candidate_edges(&edge, candidates));
        }
    }
    resolved
}

fn callable_candidates<'a>(
    edge: &CodeEdge,
    target_name: &str,
    node_index: &'a HashMap<String, Vec<CodeNode>>,
) -> Vec<&'a CodeNode> {
    let is_constructor = edge
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("constructor"))
        .is_some_and(|value| value == "true");
    let mut candidates = node_index
        .get(target_name)
        .into_iter()
        .flatten()
        .filter(|node| {
            if is_constructor {
                matches!(node.kind, NodeKind::Class | NodeKind::Struct)
            } else {
                matches!(node.kind, NodeKind::Function | NodeKind::Method)
            }
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        (&left.file_path, left.start_line, &left.id).cmp(&(
            &right.file_path,
            right.start_line,
            &right.id,
        ))
    });
    candidates
}

/// Return candidates for one call site and label ambiguity explicitly. A
/// unique same-file callable is static. Receiver dispatch preserves all
/// bounded targets, while a plain duplicate-name call retains one deterministic
/// heuristic representative so a large C/C++ overload set cannot multiply the
/// stored graph at every call site.
fn call_candidates<'a>(
    edge: &CodeEdge,
    target_name: &str,
    node_index: &'a HashMap<String, Vec<CodeNode>>,
) -> CandidateSet<'a> {
    let candidates = callable_candidates(edge, target_name, node_index);
    let is_member_call = edge
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("call_form"))
        .is_some_and(|form| form == "member");
    // A member call has a receiver. Once multiple compatible methods exist,
    // a same-file spelling is not enough evidence to claim that it is the
    // runtime receiver's one static target. Preserve the candidate set.
    if is_member_call && candidates.len() > 1 {
        let candidate_count = candidates.len();
        return CandidateSet {
            targets: candidates,
            resolution: Some("polymorphic"),
            candidate_count,
        };
    }
    let same_file = candidates
        .iter()
        .copied()
        .filter(|candidate| candidate.file_path == edge.file_path)
        .collect::<Vec<_>>();
    if same_file.len() == 1 {
        return CandidateSet {
            candidate_count: same_file.len(),
            targets: same_file,
            resolution: None,
        };
    }
    if candidates.len() <= 1 {
        return CandidateSet {
            candidate_count: candidates.len(),
            targets: candidates,
            resolution: None,
        };
    }

    let candidate_count = candidates.len();
    CandidateSet {
        targets: candidates.into_iter().take(1).collect(),
        resolution: Some("ambiguous_name"),
        candidate_count,
    }
}

/// Directories that are always skipped, regardless of `.gitignore`.
const ALWAYS_SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "vendor",
    "third_party",
    "__pycache__",
    ".venv",
    "venv",
    "target",
    "build",
    "dist",
    ".next",
    ".nuxt",
    ".output",
    ".cache",
];

/// Collect all supported source files under `root`, respecting `.gitignore`.
fn collect_files(root: &Path) -> Vec<PathBuf> {
    let walker = WalkBuilder::new(root)
        .standard_filters(true) // respects .gitignore, .ignore, hidden files
        .filter_entry(|entry| {
            // Skip well-known dependency/output directories unconditionally.
            if entry.file_type().is_some_and(|ft| ft.is_dir()) {
                if let Some(name) = entry.file_name().to_str() {
                    return !ALWAYS_SKIP_DIRS.contains(&name);
                }
            }
            true
        })
        .build();

    let mut files = Vec::new();
    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|ft| ft.is_file()) {
            continue;
        }
        let path = entry.path();
        if CodeParser::is_supported(&path.to_string_lossy())
            && fs::metadata(path).is_ok_and(|metadata| metadata.len() <= MAX_FILE_SIZE)
        {
            files.push(path.to_path_buf());
        }
    }
    files
}

// ---------------------------------------------------------------------------
// Node index builder
// ---------------------------------------------------------------------------

/// Build a lookup from symbol name -> all CodeNodes with that name.
fn build_node_index(nodes: &[&CodeNode]) -> HashMap<String, Vec<CodeNode>> {
    let mut index: HashMap<String, Vec<CodeNode>> = HashMap::new();
    for &node in nodes {
        index
            .entry(node.name.clone())
            .or_default()
            .push(node.clone());
    }
    index
}

// ---------------------------------------------------------------------------
// SHA-256 hashing
// ---------------------------------------------------------------------------

fn sha256_hex(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::initialize_database;
    use crate::types::EdgeKind;
    use std::fs;

    fn setup_test_project() -> (tempfile::TempDir, GraphStore) {
        let tmp = tempfile::tempdir().unwrap();

        // Create a simple TypeScript file
        let ts_file = tmp.path().join("hello.ts");
        fs::write(
            &ts_file,
            r#"
export function greet(name: string): string {
    return `Hello, ${name}!`;
}

export class Greeter {
    greet(name: string): string {
        return greet(name);
    }
}
"#,
        )
        .unwrap();

        // Create a Python file
        let py_file = tmp.path().join("util.py");
        fs::write(
            &py_file,
            r#"
def helper():
    return 42

class Calculator:
    def add(self, a, b):
        return a + b
"#,
        )
        .unwrap();

        // Create a file that should be ignored
        let txt_file = tmp.path().join("readme.txt");
        fs::write(&txt_file, "This should be ignored").unwrap();

        let conn = initialize_database(":memory:").unwrap();
        let store = GraphStore::from_connection(conn);

        (tmp, store)
    }

    #[test]
    fn sha256_produces_hex_string() {
        let hash = sha256_hex("hello world");
        assert_eq!(hash.len(), 64); // SHA-256 = 32 bytes = 64 hex chars
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn collect_files_finds_supported_files() {
        let (tmp, _store) = setup_test_project();
        let files = collect_files(tmp.path());

        let names: Vec<String> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();

        assert!(names.contains(&"hello.ts".to_string()));
        assert!(names.contains(&"util.py".to_string()));
        assert!(!names.contains(&"readme.txt".to_string()));
    }

    #[test]
    fn index_directory_full_pipeline() {
        let (tmp, store) = setup_test_project();
        let pipeline = IndexingPipeline::new(&store);

        let result = pipeline
            .index_directory(&IndexOptions {
                root_dir: tmp.path().to_path_buf(),
                incremental: false,
            })
            .unwrap();

        assert_eq!(result.files_indexed, 2);
        assert!(result.nodes_created > 0, "should have extracted nodes");
        // edges_created is usize, always >= 0; just verify pipeline completed

        // Verify data persisted in store
        let stats = store.get_stats().unwrap();
        assert_eq!(stats.nodes, result.nodes_created);
        assert_eq!(stats.files, 2);
    }

    #[test]
    fn incremental_indexing_skips_unchanged_files() {
        let (tmp, store) = setup_test_project();
        let pipeline = IndexingPipeline::new(&store);

        // First full index
        let r1 = pipeline
            .index_directory(&IndexOptions {
                root_dir: tmp.path().to_path_buf(),
                incremental: true,
            })
            .unwrap();
        assert_eq!(r1.files_indexed, 2);

        // Second index — nothing changed, everything skipped
        let r2 = pipeline
            .index_directory(&IndexOptions {
                root_dir: tmp.path().to_path_buf(),
                incremental: true,
            })
            .unwrap();
        assert_eq!(r2.files_indexed, 0);
        assert_eq!(r2.files_skipped, 2);
    }

    #[test]
    fn incremental_reindexes_modified_file() {
        let (tmp, store) = setup_test_project();
        let pipeline = IndexingPipeline::new(&store);

        // First full index
        pipeline
            .index_directory(&IndexOptions {
                root_dir: tmp.path().to_path_buf(),
                incremental: true,
            })
            .unwrap();

        // Modify one file
        let ts_file = tmp.path().join("hello.ts");
        fs::write(
            &ts_file,
            r#"
export function greetV2(name: string): string {
    return `Hey, ${name}!`;
}
"#,
        )
        .unwrap();

        // Only the changed file is reparsed; affected callers and derived
        // imports are rebound from persisted facts.
        let r2 = pipeline
            .index_directory(&IndexOptions {
                root_dir: tmp.path().to_path_buf(),
                incremental: true,
            })
            .unwrap();
        assert_eq!(r2.files_indexed, 1);
        assert_eq!(r2.files_skipped, 1);
    }

    #[test]
    fn cross_file_import_resolution() {
        let tmp = tempfile::tempdir().unwrap();

        // Create src/ directory
        fs::create_dir_all(tmp.path().join("src")).unwrap();

        // utils.ts — exports functions
        fs::write(
            tmp.path().join("src/utils.ts"),
            r#"
export function validate(input: string): boolean {
    return input.length > 0;
}

export function sanitize(input: string): string {
    return input.trim();
}

function internal(): void {}
"#,
        )
        .unwrap();

        // main.ts — imports from utils
        fs::write(
            tmp.path().join("src/main.ts"),
            r#"
import { validate, sanitize } from './utils';

function processInput(input: string): string {
    if (validate(input)) {
        return sanitize(input);
    }
    return '';
}
"#,
        )
        .unwrap();

        let conn = initialize_database(":memory:").unwrap();
        let store = GraphStore::from_connection(conn);
        let pipeline = IndexingPipeline::new(&store);

        let result = pipeline
            .index_directory(&IndexOptions {
                root_dir: tmp.path().to_path_buf(),
                incremental: false,
            })
            .unwrap();

        assert_eq!(result.files_indexed, 2);

        // Check that we have cross-file import edges
        // The import resolution should create edges from file:src/main.ts
        // to the actual validate and sanitize nodes in src/utils.ts
        let all_edges = store.get_all_edges().unwrap();
        let resolved_imports: Vec<_> = all_edges
            .iter()
            .filter(|e| {
                e.kind == EdgeKind::Imports
                    && e.file_path == "src/main.ts"
                    && !e.target.starts_with("module:")
            })
            .collect();

        assert!(
            resolved_imports.len() >= 2,
            "Expected at least 2 resolved import edges (validate, sanitize), got {}. \
             All import edges: {:?}",
            resolved_imports.len(),
            all_edges
                .iter()
                .filter(|e| e.kind == EdgeKind::Imports)
                .map(|e| format!("{} -> {}", e.source, e.target))
                .collect::<Vec<_>>()
        );

        // Verify the resolved edges point to actual nodes (not module: targets)
        for edge in &resolved_imports {
            assert!(
                !edge.target.starts_with("module:"),
                "Resolved edge should not target module: prefix, got: {}",
                edge.target
            );
        }
    }

    #[test]
    fn remove_file_clears_data() {
        let (tmp, store) = setup_test_project();
        let pipeline = IndexingPipeline::new(&store);

        // Index everything
        pipeline
            .index_directory(&IndexOptions {
                root_dir: tmp.path().to_path_buf(),
                incremental: false,
            })
            .unwrap();

        let before = store.get_stats().unwrap();
        assert!(before.nodes > 0);

        // Remove one file
        pipeline.remove_file("hello.ts").unwrap();

        let after = store.get_stats().unwrap();
        assert!(after.nodes < before.nodes);
        assert_eq!(after.files, 1); // only util.py remains
    }
}
