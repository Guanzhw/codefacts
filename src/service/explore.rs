//! Budgeted repository orientation and task-to-source evidence for agents.
//!
//! Retrieval is lexical candidate selection. Source excerpts remain attributable
//! to current file hashes; ranking never changes relationship confidence.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt::Write as _;
use std::fs;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::{path_matches_prefix, CodeFacts, Freshness};
use crate::error::{CodeFactsError, Result};
use crate::graph::retrieval::{query_terms, SourceMatch};
use crate::graph::store::{detect_is_test_node, GraphStore};
use crate::types::{CodeNode, EdgeKind, NodeKind};

const DEFAULT_BYTES: usize = 24_000;
const MIN_BYTES: usize = 2_000;
const MAX_BYTES: usize = 32_000;
const MAX_MANIFEST_BYTES: u64 = 128 * 1024;

#[derive(Debug, Default)]
pub struct ExploreOptions<'a> {
    pub query: Option<&'a str>,
    pub path_prefix: Option<&'a str>,
    pub file_path: Option<&'a str>,
    pub start_line: Option<u32>,
    pub reads: Option<&'a [ExploreRead]>,
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExploreRead {
    pub file_path: String,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
}

struct Source {
    hash: String,
    text: String,
}

#[derive(Clone)]
struct Excerpt {
    path: String,
    start: u32,
    end: u32,
    reason: String,
    node_id: Option<String>,
    focus: u32,
}

/// One exploration request's hydrated graph; complete files preserve owner checks.
#[derive(Default)]
struct NodeCatalog {
    nodes: Vec<CodeNode>,
    by_id: HashMap<String, usize>,
    loaded_files: HashSet<String>,
    #[cfg(test)]
    hydrated_rows: usize,
}

impl NodeCatalog {
    /// The store's complete snapshot already has canonical order and unique IDs.
    fn from_all_nodes(nodes: Vec<CodeNode>) -> Self {
        let by_id = nodes
            .iter()
            .enumerate()
            .map(|(index, node)| (node.id.clone(), index))
            .collect();
        let loaded_files = nodes.iter().map(|node| node.file_path.clone()).collect();
        Self {
            #[cfg(test)]
            hydrated_rows: nodes.len(),
            nodes,
            by_id,
            loaded_files,
        }
    }

    fn insert(&mut self, nodes: Vec<CodeNode>) {
        #[cfg(test)]
        {
            self.hydrated_rows += nodes.len();
        }
        for node in nodes {
            if !self.by_id.contains_key(&node.id) {
                self.by_id.insert(node.id.clone(), self.nodes.len());
                self.nodes.push(node);
            }
        }
        self.nodes.sort_by(|a, b| {
            (&a.file_path, a.start_line, a.start_column, &a.id).cmp(&(
                &b.file_path,
                b.start_line,
                b.start_column,
                &b.id,
            ))
        });
        self.by_id = self
            .nodes
            .iter()
            .enumerate()
            .map(|(i, n)| (n.id.clone(), i))
            .collect();
    }

    fn load_ids(&mut self, store: &GraphStore, ids: &[String]) -> Result<()> {
        let missing: Vec<_> = ids
            .iter()
            .filter(|id| !self.by_id.contains_key(*id))
            .cloned()
            .collect();
        if !missing.is_empty() {
            self.insert(store.get_nodes_by_ids(&missing)?);
        }
        Ok(())
    }

    fn load_files(&mut self, store: &GraphStore, files: &[String]) -> Result<()> {
        let missing: Vec<_> = files
            .iter()
            .filter(|file| !self.loaded_files.contains(*file))
            .cloned()
            .collect();
        if !missing.is_empty() {
            self.insert(store.get_nodes_by_files(&missing)?);
            self.loaded_files.extend(missing);
        }
        Ok(())
    }

    fn get(&self, id: &str) -> Option<&CodeNode> {
        self.by_id.get(id).map(|index| &self.nodes[*index])
    }
}

impl CodeFacts {
    /// A single text response avoids serializing the same source into both MCP
    /// text and structuredContent. max_bytes bounds the rendered UTF-8 response.
    pub fn explore(&self, options: ExploreOptions<'_>) -> Result<String> {
        let budget = options.max_bytes.unwrap_or(DEFAULT_BYTES);
        if !(MIN_BYTES..=MAX_BYTES).contains(&budget) {
            return Err(CodeFactsError::Mcp(format!(
                "max_bytes must be between {MIN_BYTES} and {MAX_BYTES}"
            )));
        }
        if options.start_line.is_some() && options.file_path.is_none() {
            return Err(CodeFactsError::Mcp("start_line requires file_path".into()));
        }
        if options.start_line == Some(0) {
            return Err(CodeFactsError::Mcp("start_line must be positive".into()));
        }
        if options.file_path.is_some() && (options.query.is_some() || options.path_prefix.is_some())
        {
            return Err(CodeFactsError::Mcp(
                "file_path is a focused source read; omit query and path_prefix".into(),
            ));
        }
        if let Some(reads) = options.reads {
            if reads.is_empty() || reads.len() > 8 {
                return Err(CodeFactsError::Mcp(
                    "reads must contain 1 to 8 ranges".into(),
                ));
            }
            if options.query.is_some()
                || options.path_prefix.is_some()
                || options.file_path.is_some()
                || options.start_line.is_some()
            {
                return Err(CodeFactsError::Mcp(
                    "reads cannot be combined with query, path_prefix, file_path or start_line"
                        .into(),
                ));
            }
        }
        let scope = options
            .path_prefix
            .map(|p| self.normalized_path_prefix(p))
            .transpose()?
            .flatten();
        let freshness = self.refresh()?;
        let hashes = self.store.get_file_hashes()?;
        let mut output = header(&freshness, budget);
        let mut sources = HashMap::<String, Source>::new();
        let mut gaps = Vec::new();

        let single_read = options.file_path.map(|file| ExploreRead {
            file_path: file.into(),
            start_line: options.start_line,
            end_line: None,
        });
        let reads_are_batch = options.reads.is_some();
        if let Some(reads) = options
            .reads
            .or_else(|| single_read.as_ref().map(std::slice::from_ref))
        {
            let mut excerpts = Vec::new();
            let mut eof_notes = Vec::new();
            for (index, read) in reads.iter().enumerate() {
                let path = self.relative_path(&read.file_path)?;
                if !hashes.contains_key(&path) && !is_manifest(&path) {
                    let field = if reads_are_batch {
                        format!("reads[{index}].file_path")
                    } else {
                        "file_path".to_string()
                    };
                    return Err(CodeFactsError::Mcp(format!(
                        "{field} ({path:?}) must name indexed source or a package manifest"
                    )));
                }
                let source =
                    self.exploration_source(&path, hashes.get(&path).map(String::as_str))?;
                let file_end = source.text.lines().count() as u32;
                let start = read.start_line.unwrap_or(1);
                if start == 0 || read.end_line.is_some_and(|end| end == 0 || start > end) {
                    return Err(CodeFactsError::Mcp(
                        format!("invalid source range for {path}: use positive start_line and end_line with start_line <= end_line"),
                    ));
                }
                if start > file_end {
                    eof_notes.push(format!(
                        "{path}: start_line {start} is past EOF {file_end}; requested range unavailable"
                    ));
                    continue;
                }
                let requested_end = read.end_line.unwrap_or(file_end);
                let end = requested_end.min(file_end);
                if requested_end > file_end {
                    eof_notes.push(format!(
                        "{path}: requested end_line {requested_end} clipped to EOF {file_end}; available range {start}-{end}"
                    ));
                }
                sources.insert(path.clone(), source);
                excerpts.push(Excerpt {
                    path,
                    start,
                    end,
                    reason: "focused source".into(),
                    node_id: None,
                    focus: start,
                });
            }
            if excerpts.is_empty() {
                return Err(CodeFactsError::Mcp(format!(
                    "no readable source ranges: {}",
                    eof_notes.join("; ")
                )));
            }
            if !eof_notes.is_empty() {
                let _ = writeln!(output, "EOF notes ({}):", eof_notes.len());
                for note in eof_notes {
                    let _ = writeln!(output, "- {note}");
                }
            }
            render_excerpts(&mut output, excerpts, &sources, budget, false);
            return Ok(finish(output, budget));
        }

        let mut catalog = NodeCatalog::default();
        let manifests = self.exploration_manifests(&hashes)?;
        let scoped_files: BTreeSet<_> = hashes
            .keys()
            .chain(manifests.iter())
            .filter(|p| {
                scope
                    .as_deref()
                    .is_none_or(|scope| path_matches_prefix(p, scope))
            })
            .cloned()
            .collect();
        let _ = writeln!(
            output,
            "Scope: {} | {} indexed source/manifest files",
            scope.as_deref().unwrap_or("."),
            scoped_files.len()
        );

        let mut ranked_candidates = Vec::new();
        let excerpts = if let Some(query) = options.query {
            let terms = query_terms(query);
            if terms.is_empty() {
                return Err(CodeFactsError::Mcp(
                    "query needs at least one searchable code or behavior term".into(),
                ));
            }
            card_query_echo(&mut output, &terms, budget);
            let indexed = self.store.retrieval_hashes()?;
            let current: HashSet<_> = hashes.keys().chain(manifests.iter()).cloned().collect();
            for path in indexed.keys().filter(|p| !current.contains(*p)) {
                self.store.delete_retrieval_source(path)?;
            }
            // Refresh canonical source facts first. Only changed source is read
            // again to update this derived index; manifests are read directly.
            for path in &current {
                if !is_manifest(path) && indexed.get(path) == hashes.get(path) {
                    continue;
                }
                match self.exploration_source(path, hashes.get(path).map(String::as_str)) {
                    Ok(source) => {
                        if indexed.get(path) != Some(&source.hash) {
                            self.store
                                .upsert_retrieval_source(path, &source.hash, &source.text)?;
                        }
                        if is_manifest(path) {
                            sources.insert(path.clone(), source);
                        }
                    }
                    Err(error) => {
                        self.store.delete_retrieval_source(path)?;
                        gaps.push(format!("{path}: {error}"));
                    }
                }
            }
            let hits = self.store.search_retrieval(query, scope.as_deref(), 96)?;
            catalog.load_files(
                &self.store,
                &hits
                    .iter()
                    .map(|hit| hit.file_path.clone())
                    .collect::<Vec<_>>(),
            )?;
            self.task_excerpts(
                &hits,
                &terms,
                &catalog.nodes,
                &hashes,
                &mut sources,
                &mut gaps,
                &mut ranked_candidates,
            )?
        } else {
            catalog = NodeCatalog::from_all_nodes(self.store.get_all_nodes()?);
            self.orientation_excerpts(
                &catalog.nodes,
                &scoped_files,
                &hashes,
                &mut sources,
                &mut output,
                &mut gaps,
            )?
        };
        let excerpts = self.related_excerpts(
            excerpts,
            &mut catalog,
            &scoped_files,
            &query_terms(options.query.unwrap_or("")),
            &hashes,
            &mut sources,
            &mut gaps,
        )?;
        if !gaps.is_empty() {
            let _ = writeln!(
                output,
                "Source gaps ({}): {}",
                gaps.len(),
                gaps.iter().take(3).cloned().collect::<Vec<_>>().join("; ")
            );
        }
        if excerpts.is_empty() {
            output.push_str("No matching verified source excerpts. Refine the query or path scope; this does not establish absence.\n");
        } else if let Some(query) = options.query {
            render_cards(
                &mut output,
                card_sequence(excerpts, ranked_candidates),
                &catalog.nodes,
                &query_terms(query),
                &sources,
                budget,
            )?;
        } else {
            render_excerpts(&mut output, excerpts, &sources, budget, true);
        }
        Ok(finish(output, budget))
    }

    fn exploration_source(&self, path: &str, expected_hash: Option<&str>) -> Result<Source> {
        let canonical = self.root.join(path).canonicalize()?;
        if !canonical.starts_with(&self.root) {
            return Err(CodeFactsError::Other(
                "source resolves outside the selected repository".into(),
            ));
        }
        if is_manifest(path) && fs::metadata(&canonical)?.len() > MAX_MANIFEST_BYTES {
            return Err(CodeFactsError::Other(
                "package manifest exceeds 128 KiB".into(),
            ));
        }
        let text = fs::read_to_string(canonical)?;
        let hash = hex::encode(Sha256::digest(text.as_bytes()));
        if expected_hash.is_some_and(|expected| expected != hash) {
            return Err(CodeFactsError::Other(
                "source changed after refresh; retry the query".into(),
            ));
        }
        Ok(Source { hash, text })
    }

    fn exploration_manifests(&self, hashes: &HashMap<String, String>) -> Result<BTreeSet<String>> {
        let mut directories = BTreeSet::from([String::new()]);
        for path in hashes.keys() {
            let mut directory = std::path::Path::new(path).parent();
            while let Some(parent) = directory {
                directories.insert(parent.to_string_lossy().replace('\\', "/"));
                directory = parent.parent();
            }
        }
        let mut manifests = BTreeSet::new();
        for directory in directories {
            for name in ["package.json", "Cargo.toml"] {
                let path = if directory.is_empty() {
                    name.to_string()
                } else {
                    format!("{directory}/{name}")
                };
                if self.root.join(&path).is_file() {
                    manifests.insert(path);
                }
            }
        }
        Ok(manifests)
    }

    #[allow(clippy::too_many_arguments)] // Shares one verified source and selection state.
    fn task_excerpts(
        &self,
        hits: &[SourceMatch],
        terms: &[String],
        nodes: &[CodeNode],
        hashes: &HashMap<String, String>,
        sources: &mut HashMap<String, Source>,
        gaps: &mut Vec<String>,
        ranked_candidates: &mut Vec<Excerpt>,
    ) -> Result<Vec<Excerpt>> {
        let mut ranked = Vec::new();
        let mut seen = HashSet::new();
        let mut by_file = HashMap::<&str, Vec<&CodeNode>>::new();
        for node in nodes {
            by_file.entry(&node.file_path).or_default().push(node);
        }
        // Recall windows nominate whole owners; overlapping hits never multiply
        // the rank or source payload of one definition.
        for (rank, hit) in hits.iter().enumerate() {
            if !self.load_exploration_source(&hit.file_path, hashes, sources, gaps) {
                continue;
            }
            let lines: Vec<_> = sources[&hit.file_path].text.lines().collect();
            let file_nodes = by_file
                .get(hit.file_path.as_str())
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let owners = file_nodes.iter().filter(|n| {
                n.start_line <= hit.end_line
                    && n.end_line >= hit.start_line
                    && !matches!(
                        n.kind,
                        NodeKind::Variable | NodeKind::Module | NodeKind::Namespace
                    )
                    && (matches!(n.kind, NodeKind::Function | NodeKind::Method)
                        || !file_nodes.iter().any(|child| {
                            child.id != n.id
                                && child.start_line >= n.start_line
                                && child.end_line <= n.end_line
                                && (matches!(child.kind, NodeKind::Function | NodeKind::Method)
                                    || (n.kind == NodeKind::Heading
                                        && child.kind == NodeKind::Heading))
                                && child.start_line <= hit.end_line
                                && child.end_line >= hit.start_line
                        }))
            });
            let mut found = false;
            for node in owners {
                let body = owner_source(&lines, node);
                let score = line_score(&body, terms);
                if score == 0 {
                    continue;
                }
                found = true;
                if !seen.insert(node.id.clone()) {
                    continue;
                }
                let focus = best_line(&lines, node.start_line, node.end_line, terms);
                let role = if detect_is_test_node(node) {
                    "test"
                } else {
                    source_role(&node.file_path)
                };
                let named = line_score(&node.name, terms);
                ranked.push((
                    role != "implementation",
                    score + named,
                    rank,
                    Excerpt {
                        path: node.file_path.clone(),
                        start: node.start_line,
                        end: node.end_line,
                        focus,
                        node_id: Some(node.id.clone()),
                        reason: format!(
                            "{role}; complete {} {}; lexical candidate",
                            node.kind.as_str(),
                            node.name
                        ),
                    },
                ));
            }
            if !found && seen.insert(format!("{}:{}", hit.file_path, hit.start_line)) {
                ranked.push((
                    source_role(&hit.file_path) != "implementation",
                    0,
                    rank,
                    Excerpt {
                        path: hit.file_path.clone(),
                        start: hit.start_line,
                        end: hit.end_line,
                        focus: best_line(&lines, hit.start_line, hit.end_line, terms),
                        node_id: None,
                        reason: format!(
                            "{}; lexical range (owner unavailable)",
                            source_role(&hit.file_path)
                        ),
                    },
                ));
            }
        }
        ranked.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then_with(|| b.1.cmp(&a.1))
                .then_with(|| a.2.cmp(&b.2))
        });
        ranked_candidates.extend(ranked.iter().map(|(_, _, _, e)| e.clone()));
        let mut per_file = HashMap::<String, usize>::new();
        let mut per_role = HashMap::<String, usize>::new();
        Ok(ranked
            .into_iter()
            .filter_map(|(_, _, _, excerpt)| {
                let role = if excerpt.reason.starts_with("test") {
                    "test"
                } else {
                    source_role(&excerpt.path)
                };
                let role_count = per_role.entry(role.into()).or_default();
                let cap = if role == "implementation" { 12 } else { 2 };
                if *role_count >= cap {
                    return None;
                }
                let count = per_file.entry(excerpt.path.clone()).or_default();
                if *count >= 8 {
                    None
                } else {
                    *count += 1;
                    *role_count += 1;
                    Some(excerpt)
                }
            })
            .take(24)
            .collect())
    }

    fn load_exploration_source(
        &self,
        path: &str,
        hashes: &HashMap<String, String>,
        sources: &mut HashMap<String, Source>,
        gaps: &mut Vec<String>,
    ) -> bool {
        if sources.contains_key(path) {
            return true;
        }
        match self.exploration_source(path, hashes.get(path).map(String::as_str)) {
            Ok(source) => {
                sources.insert(path.into(), source);
                true
            }
            Err(error) => {
                gaps.push(format!("{path}: {error}"));
                false
            }
        }
    }

    #[allow(clippy::too_many_arguments)] // Shares one refreshed source snapshot and selection state.
    fn related_excerpts(
        &self,
        seeds: Vec<Excerpt>,
        catalog: &mut NodeCatalog,
        files: &BTreeSet<String>,
        terms: &[String],
        hashes: &HashMap<String, String>,
        sources: &mut HashMap<String, Source>,
        gaps: &mut Vec<String>,
    ) -> Result<Vec<Excerpt>> {
        let mut selected = Vec::new();
        let mut seen = HashSet::new();
        // Leading implementation owners plus bounded two-step source context.
        // Other recalled owners remain available after connected candidates.
        let (primary, remaining): (Vec<_>, Vec<_>) =
            seeds.into_iter().enumerate().partition(|(i, e)| {
                *i < 4 && !e.reason.starts_with("test") && !e.reason.starts_with("documentation")
            });
        for (_, excerpt) in primary {
            add_excerpt(&mut selected, &mut seen, excerpt);
        }
        let mut frontier: Vec<_> = selected.iter().filter_map(|e| e.node_id.clone()).collect();
        for _ in 0..2 {
            if selected.len() >= 12 || frontier.is_empty() {
                break;
            }
            catalog.load_ids(&self.store, &frontier)?;
            let owner_files: Vec<_> = frontier
                .iter()
                .filter_map(|id| catalog.get(id).map(|node| node.file_path.clone()))
                .collect();
            catalog.load_files(&self.store, &owner_files)?;
            let mut calls = HashMap::new();
            let mut target_ids = Vec::new();
            for id in &frontier {
                let edges = self
                    .store
                    .get_out_edges(id, Some(EdgeKind::Calls.as_str()))?;
                target_ids.extend(
                    edges
                        .iter()
                        .filter(|edge| {
                            edge.metadata
                                .as_ref()
                                .and_then(|m| m.get("confidence"))
                                .is_none_or(|c| c != "heuristic")
                        })
                        .map(|edge| edge.target.clone()),
                );
                calls.insert(id.clone(), edges);
            }
            catalog.load_ids(&self.store, &target_ids)?;
            let mut next = Vec::new();
            for id in frontier {
                if selected.len() >= 12 {
                    break;
                }
                let Some(owner) = catalog.get(&id) else {
                    continue;
                };
                let mut neighbors = Vec::new();
                for edge in &calls[&id] {
                    let heuristic = edge
                        .metadata
                        .as_ref()
                        .and_then(|m| m.get("confidence"))
                        .is_some_and(|c| c == "heuristic");
                    if !heuristic {
                        if let Some(node) = catalog.get(&edge.target).filter(|n| {
                            matches!(
                                n.kind,
                                NodeKind::Function | NodeKind::Method | NodeKind::Class
                            )
                        }) {
                            neighbors.push((
                                false,
                                edge.line,
                                node,
                                format!("direct static callee at {}:{}", edge.file_path, edge.line),
                            ));
                            continue;
                        }
                    }
                    if edge
                        .metadata
                        .as_ref()
                        .and_then(|m| m.get("call_form"))
                        .is_none_or(|r| r != "member")
                    {
                        continue;
                    }
                    if let Some(name) = edge.target_name.as_deref() {
                        let name = name
                            .rsplit(['.', ':'])
                            .find(|part| !part.is_empty())
                            .unwrap_or(name);
                        for node in catalog.nodes.iter().filter(|n| {
                            n.file_path == owner.file_path
                                && n.name == name
                                && matches!(n.kind, NodeKind::Function | NodeKind::Method)
                        }) {
                            neighbors.push((
                                true,
                                edge.line,
                                node,
                                format!(
                                    "name-matched source candidate at {}:{}; receiver unresolved",
                                    edge.file_path, edge.line
                                ),
                            ));
                        }
                    }
                }
                neighbors.sort_by(|a, b| {
                    let relevance = |n: &CodeNode| {
                        line_score(
                            &format!(
                                "{} {} {}",
                                n.name,
                                n.file_path,
                                n.body.as_deref().unwrap_or("")
                            ),
                            terms,
                        )
                    };
                    relevance(b.2)
                        .cmp(&relevance(a.2))
                        .then_with(|| a.0.cmp(&b.0))
                        .then_with(|| a.1.cmp(&b.1))
                        .then_with(|| a.2.id.cmp(&b.2.id))
                });
                let mut unique_neighbors = HashSet::new();
                for (_, _, node, reason) in neighbors
                    .into_iter()
                    .filter(|(_, _, node, _)| {
                        !seen.contains(&node.id) && unique_neighbors.insert(node.id.clone())
                    })
                    .take(3)
                    .collect::<Vec<_>>()
                {
                    if selected.len() >= 12 {
                        break;
                    }
                    if !files.contains(&node.file_path)
                        || detect_is_test_node(node)
                        || !self.load_exploration_source(&node.file_path, hashes, sources, gaps)
                    {
                        continue;
                    }
                    if add_excerpt(&mut selected, &mut seen, node_excerpt(node, reason)) {
                        next.push(node.id.clone());
                    }
                }
            }
            frontier = next;
        }
        let (support, implementation): (Vec<_>, Vec<_>) =
            remaining.into_iter().partition(|(_, e)| {
                e.reason.starts_with("test") || e.reason.starts_with("documentation")
            });
        for (_, excerpt) in support.into_iter().take(3).chain(implementation) {
            add_excerpt(&mut selected, &mut seen, excerpt);
        }
        selected.truncate(36);
        Ok(selected)
    }

    fn orientation_excerpts(
        &self,
        nodes: &[CodeNode],
        files: &BTreeSet<String>,
        hashes: &HashMap<String, String>,
        sources: &mut HashMap<String, Source>,
        output: &mut String,
        gaps: &mut Vec<String>,
    ) -> Result<Vec<Excerpt>> {
        let mut modules = BTreeMap::<String, usize>::new();
        for file in files {
            let parent = file
                .rsplit_once('/')
                .map(|(parent, _)| parent)
                .unwrap_or(".");
            *modules.entry(parent.into()).or_default() += 1;
        }
        let mut modules: Vec<_> = modules.into_iter().collect();
        modules.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        output.push_str("\nDirectories (structural groups, not inferred responsibilities):\n");
        for (directory, count) in modules.iter().take(6) {
            let _ = writeln!(output, "{directory}/: {count} files");
        }
        if modules.len() > 6 {
            let _ = writeln!(
                output,
                "... {} more directories; narrow path_prefix.",
                modules.len() - 6
            );
        }

        let mut ranked: Vec<_> = files
            .iter()
            .map(|path| (entry_priority(path), path))
            .collect();
        ranked.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| a.1.matches('/').count().cmp(&b.1.matches('/').count()))
                .then_with(|| a.1.cmp(b.1))
        });
        let mut selected = Vec::new();
        let mut role_counts = HashMap::<&str, usize>::new();
        for (priority, path) in ranked {
            if priority == 0 || selected.len() == 8 {
                break;
            }
            let role = source_role(path);
            let cap = if role == "manifest" {
                2
            } else if role == "documentation" {
                1
            } else {
                5
            };
            let count = role_counts.entry(role).or_default();
            if *count < cap {
                selected.push(path.clone());
                *count += 1;
            }
        }
        let mut excerpts = Vec::new();
        output.push_str("\nReading map (entry conventions and manifest evidence):\n");
        for path in &selected {
            let _ = writeln!(output, "{path} [{}]", source_role(path));
            match self.exploration_source(path, hashes.get(path).map(String::as_str)) {
                Ok(source) => {
                    let line_count = source.text.lines().count() as u32;
                    sources.insert(path.clone(), source);
                    let entry_nodes: Vec<_> = nodes
                        .iter()
                        .filter(|n| {
                            &n.file_path == path
                                && matches!(n.kind, NodeKind::Function | NodeKind::Method)
                                && !n.is_local
                                && !detect_is_test_node(n)
                        })
                        .take(3)
                        .collect();
                    if source_role(path) == "implementation" && !entry_nodes.is_empty() {
                        for node in entry_nodes {
                            excerpts.push(node_excerpt(
                                node,
                                "entry convention; complete source definition".into(),
                            ));
                        }
                    } else if line_count > 0 {
                        excerpts.push(Excerpt {
                            path: path.clone(),
                            start: 1,
                            end: line_count.min(if is_manifest(path) { 45 } else { 36 }),
                            reason: format!("{}; entry/overview source range", source_role(path)),
                            node_id: None,
                            focus: 1,
                        });
                    }
                }
                Err(error) => gaps.push(format!("{path}: {error}")),
            }
        }
        let node_files: HashMap<_, _> = nodes
            .iter()
            .map(|n| (n.id.as_str(), n.file_path.as_str()))
            .collect();
        let selected_set: HashSet<_> = selected.iter().map(String::as_str).collect();
        let mut dependencies = BTreeSet::new();
        for edge in self
            .store
            .get_all_edges()?
            .iter()
            .filter(|e| e.kind == EdgeKind::Imports)
        {
            let Some(target) = node_files.get(edge.target.as_str()) else {
                continue;
            };
            if edge.file_path != *target && selected_set.contains(edge.file_path.as_str()) {
                dependencies.insert(format!("{}:{} -> {}", edge.file_path, edge.line, target));
            }
        }
        if !dependencies.is_empty() {
            output.push_str("\nIndexed import destinations (static):\n");
            for dependency in dependencies.iter().take(12) {
                let _ = writeln!(output, "{dependency}");
            }
            if dependencies.len() > 12 {
                output.push_str("... more imports omitted.\n");
            }
        }
        excerpts.sort_by_key(|e| match source_role(&e.path) {
            "implementation" => 0,
            "manifest" => 1,
            _ => 2,
        });
        Ok(excerpts)
    }
}

fn header(freshness: &Freshness, budget: usize) -> String {
    let mut output = format!("CodeFacts exploration\nRoot: {}\nFreshness: {} | generation {} | UTF-8 response budget {} bytes\n", freshness.repository_root, freshness.status, freshness.generation, budget);
    if freshness.status == "partial" {
        let omitted = freshness.files_too_large
            + freshness.files_unreadable
            + freshness.files_parse_failed
            + freshness.files_extract_failed;
        writeln!(
            output,
            "Index omissions: {omitted} files | too_large={} | unreadable={} | parse_failed={} | extract_failed={}",
            freshness.files_too_large,
            freshness.files_unreadable,
            freshness.files_parse_failed,
            freshness.files_extract_failed,
        )
        .unwrap();
    }
    output
}

fn is_manifest(path: &str) -> bool {
    matches!(path.rsplit('/').next(), Some("package.json" | "Cargo.toml"))
}

fn source_role(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if is_manifest(path) {
        "manifest"
    } else if lower.ends_with(".md") || lower.ends_with(".mdx") {
        "documentation"
    } else if lower
        .split('/')
        .any(|part| matches!(part, "test" | "tests" | "__tests__" | "spec" | "specs"))
        || lower.contains(".test.")
        || lower.contains(".spec.")
        || lower.contains("_test.")
    {
        "test"
    } else {
        "implementation"
    }
}

fn entry_priority(path: &str) -> usize {
    let name = path.rsplit('/').next().unwrap_or(path);
    if is_manifest(path) {
        100
    } else if name.eq_ignore_ascii_case("README.md") {
        90
    } else if matches!(
        name,
        "lib.rs" | "main.rs" | "index.ts" | "index.js" | "index.mjs" | "mod.rs"
    ) && source_role(path) == "implementation"
    {
        80
    } else if source_role(path) == "implementation" {
        10
    } else {
        0
    }
}

fn line_score(line: &str, terms: &[String]) -> usize {
    let lower = crate::graph::retrieval::normalize_words(line);
    let words: HashSet<_> = lower.split_whitespace().collect();
    terms
        .iter()
        .filter(|term| words.contains(term.as_str()))
        .count()
}

fn best_line(lines: &[&str], start: u32, end: u32, terms: &[String]) -> u32 {
    (start..=end)
        .filter_map(|line| {
            lines
                .get(line.saturating_sub(1) as usize)
                .map(|text| (line, line_score(text, terms)))
        })
        .max_by(|(a, sa), (b, sb)| sa.cmp(sb).then_with(|| b.cmp(a)))
        .map_or(start, |(line, _)| line)
}

fn node_excerpt(node: &CodeNode, reason: String) -> Excerpt {
    Excerpt {
        path: node.file_path.clone(),
        start: node.start_line,
        end: node.end_line,
        focus: node.start_line,
        node_id: Some(node.id.clone()),
        reason: format!("{reason}; {} {}", node.kind.as_str(), node.name),
    }
}

fn owner_source(lines: &[&str], node: &CodeNode) -> String {
    // Markdown headings are line-based owners; their extractor has no column spans.
    if node.kind == NodeKind::Heading {
        return lines[(node.start_line - 1) as usize..node.end_line as usize].join("\n");
    }
    (node.start_line..=node.end_line)
        .map(|line| {
            let text = lines[(line - 1) as usize];
            let start = if line == node.start_line {
                node.start_column as usize
            } else {
                0
            };
            let end = if line == node.end_line {
                node.end_column as usize
            } else {
                text.len()
            };
            &text[start..end]
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn add_excerpt(selected: &mut Vec<Excerpt>, seen: &mut HashSet<String>, excerpt: Excerpt) -> bool {
    let key = excerpt_key(&excerpt);
    if !seen.insert(key) {
        return false;
    }
    selected.push(excerpt);
    true
}

fn excerpt_key(excerpt: &Excerpt) -> String {
    excerpt
        .node_id
        .clone()
        .unwrap_or_else(|| format!("{}:{}:{}", excerpt.path, excerpt.start, excerpt.end))
}

fn render_excerpts(
    output: &mut String,
    excerpts: Vec<Excerpt>,
    sources: &HashMap<String, Source>,
    budget: usize,
    discovery: bool,
) {
    let reserve = 600.min(budget / 4);
    let mut delivered = Vec::<(&str, u32, u32)>::new();
    let mut omitted = Vec::new();
    for (index, excerpt) in excerpts.iter().enumerate() {
        if delivered.iter().any(|(path, start, end)| {
            *path == excerpt.path && *start <= excerpt.start && *end >= excerpt.end
        }) {
            continue;
        }
        let source = &sources[&excerpt.path];
        let heading = format!(
            "\n## {}:{}-{} | {}\n",
            excerpt.path, excerpt.start, excerpt.end, excerpt.reason
        );
        let lines: Vec<_> = source.text.lines().collect();
        let body = (excerpt.start..=excerpt.end)
            .map(|line| format!("{line}: {}\n", lines[(line - 1) as usize]))
            .collect::<String>();
        if output.len() + heading.len() + body.len() + reserve <= budget {
            output.push_str(&heading);
            output.push_str(&body);
            delivered.push((&excerpt.path, excerpt.start, excerpt.end));
            continue;
        }
        // Only an oversized first owner gets a partial range. Remaining owners
        // are admitted whole or retained as exact omitted locators.
        if delivered.is_empty() && output.len() + heading.len() + 300 + reserve < budget {
            let start = excerpt.focus.saturating_sub(8).max(excerpt.start);
            let mut end = start.saturating_sub(1);
            // Discovery leaves equal capacity for the remaining candidates.
            // Explicit reads and a sole owner retain their natural budget.
            let partial_cap = (discovery && index + 1 < excerpts.len())
                .then(|| (budget - output.len() - reserve) / 2);
            let partial_frame = |end: u32| {
                (
                    format!(
                        "\n## {}:{}-{} | partial source; requested range {}-{}\n",
                        excerpt.path, start, end, excerpt.start, excerpt.end
                    ),
                    format!(
                        "[excerpt incomplete; continue explore(file_path={:?}, start_line={})]\n",
                        excerpt.path,
                        end + 1
                    ),
                )
            };
            let partial_heading = format!(
                "\n## {}:{}-{} | partial source; requested range {}-{}\n",
                excerpt.path, start, excerpt.end, excerpt.start, excerpt.end
            );
            let mut partial = String::new();
            for line in start..=excerpt.end {
                let rendered = format!("{line}: {}\n", lines[(line - 1) as usize]);
                if output.len()
                    + partial_heading.len()
                    + partial.len()
                    + rendered.len()
                    + reserve
                    + 180
                    > budget
                {
                    break;
                }
                if let Some(cap) = partial_cap {
                    let (prefix, continuation) = partial_frame(line);
                    if prefix.len() + partial.len() + rendered.len() + continuation.len() > cap {
                        break;
                    }
                }
                partial.push_str(&rendered);
                end = line;
            }
            if end >= start {
                let (prefix, continuation) = partial_frame(end);
                output.push_str(&prefix);
                output.push_str(&partial);
                output.push_str(&continuation);
                delivered.push((&excerpt.path, start, end));
                continue;
            } else {
                let message = format!(
                    "\n{}:{}: line does not fit; read the cited file directly.\n",
                    excerpt.path, start
                );
                if output.len() + message.len() + reserve <= budget {
                    output.push_str(&message);
                }
            }
        }
        omitted.push(format!(
            "{}:{}-{}",
            excerpt.path, excerpt.start, excerpt.end
        ));
    }
    if !omitted.is_empty() {
        let _ = writeln!(output, "\nNot fully returned ({} ranges):", omitted.len());
        for locator in omitted {
            if output.len() + locator.len() + 130 > budget {
                output.push_str("... additional candidates omitted.\n");
                break;
            }
            let _ = writeln!(output, "{locator}");
        }
    }
    if discovery {
        output.push_str("\nSource candidates; relationships retain stated uncertainty. Use reads for exact follow-up ranges.\n");
    }
}

fn finish(mut output: String, budget: usize) -> String {
    if output.len() > budget {
        let suffix = "\n[response truncated by byte budget; narrow scope or increase max_bytes]\n";
        output.truncate(output.floor_char_boundary(budget - suffix.len()));
        output.push_str(suffix);
    }
    output
}

const CARD_FOOTER: &str = "\nLexical candidates; symbol ranges cover full owners. [complete] covers the range; [preview] omits context. [source omitted] has no fitting whole line. Use reads for full ranges.\n";

fn card_omission(count: usize) -> String {
    if count == 0 {
        String::new()
    } else {
        format!("\n{count} additional cards omitted by metadata byte budget.\n")
    }
}

fn card_query_echo(output: &mut String, terms: &[String], budget: usize) {
    let echo = format!("Lexical candidates for: {}\n\n", terms.join(", "));
    if output.len() + echo.len() + CARD_FOOTER.len() + card_omission(36).len() <= budget {
        output.push_str(&echo);
    } else {
        output.push_str("Lexical candidate term echo omitted by byte budget.\n");
    }
}

fn card_sequence(selected: Vec<Excerpt>, ranked: Vec<Excerpt>) -> Vec<(Excerpt, bool)> {
    let mut sequence = Vec::new();
    let mut seen = HashSet::new();
    for (excerpts, deferred) in [(selected, false), (ranked, true)] {
        for excerpt in excerpts {
            if sequence.len() == 36 {
                break;
            }
            if seen.insert(excerpt_key(&excerpt)) {
                sequence.push((excerpt, deferred));
            }
        }
    }
    sequence
}

fn render_cards(
    output: &mut String,
    cards: Vec<(Excerpt, bool)>,
    nodes: &[CodeNode],
    terms: &[String],
    sources: &HashMap<String, Source>,
    budget: usize,
) -> Result<()> {
    if output.len() + CARD_FOOTER.len() + card_omission(cards.len()).len() > budget {
        return Err(CodeFactsError::Mcp(
            "mandatory exploration metadata exceeds max_bytes; narrow scope or increase max_bytes"
                .into(),
        ));
    }
    let by_id: HashMap<_, _> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut frames = Vec::new();
    for (excerpt, deferred) in &cards {
        let node = excerpt.node_id.as_deref().and_then(|id| by_id.get(id));
        let identity = node.map_or_else(
            || "lexical source range".to_string(),
            |n| format!("{} {}", n.kind.as_str(), n.name),
        );
        let derivation = if excerpt.reason.starts_with("direct static callee at ")
            || excerpt
                .reason
                .starts_with("name-matched source candidate at ")
        {
            // node_excerpt appends the target identity for range reads. The
            // card heading already presents that same typed identity.
            node.map_or_else(
                || excerpt.reason.clone(),
                |n| {
                    excerpt
                        .reason
                        .strip_suffix(&format!("; {} {}", n.kind.as_str(), n.name))
                        .unwrap_or(&excerpt.reason)
                        .to_string()
                },
            )
        } else {
            let role = if node.is_some_and(|n| detect_is_test_node(n)) {
                "test"
            } else {
                source_role(&excerpt.path)
            };
            format!("{role}{}", if *deferred { "; deferred" } else { "" })
        };
        let prefix = format!(
            "\n## {}:{}-{} | {identity}\n",
            excerpt.path, excerpt.start, excerpt.end
        );
        let suffix = format!("] {derivation}\n");
        frames.push((prefix, suffix));
    }
    let omission = |retained: usize| card_omission(cards.len() - retained);
    let mut retained = 0;
    let mut metadata_bytes = output.len() + CARD_FOOTER.len();
    for (index, (prefix, suffix)) in frames.iter().enumerate() {
        let bytes = prefix.len() + "[source omitted".len() + suffix.len();
        if metadata_bytes + bytes + omission(index + 1).len() > budget {
            break;
        }
        metadata_bytes += bytes;
        retained = index + 1;
    }
    metadata_bytes += omission(retained).len();
    let allocation = (budget - metadata_bytes).checked_div(retained).unwrap_or(0);
    for (index, (excerpt, _)) in cards.iter().take(retained).enumerate() {
        let source = &sources[&excerpt.path];
        let lines: Vec<_> = source.text.lines().collect();
        let focus = best_line(&lines, excerpt.start, excerpt.end, terms);
        let body = (excerpt.start..=excerpt.end)
            .map(|line| format!("{line}: {}\n", lines[(line - 1) as usize]))
            .collect::<String>();
        let mut preview = String::new();
        let mut delivered = Vec::new();
        let complete = body.len() <= allocation;
        if complete {
            preview = body;
        } else {
            // Keep the identity and strongest lexical evidence first, then
            // spend the remaining share on surrounding whole source lines.
            for (index, line) in [excerpt.start, focus]
                .into_iter()
                .chain(focus + 1..=excerpt.end)
                .chain((excerpt.start + 1..focus).rev())
                .enumerate()
            {
                if delivered.contains(&line) {
                    continue;
                }
                let mut candidate_lines = delivered.clone();
                candidate_lines.push(line);
                candidate_lines.sort_unstable();
                let mut candidate = String::new();
                for (index, &line) in candidate_lines.iter().enumerate() {
                    if index > 0 && line > candidate_lines[index - 1] + 1 {
                        candidate.push_str("[... source lines omitted ...]\n");
                    }
                    let _ = writeln!(candidate, "{line}: {}", lines[(line - 1) as usize]);
                }
                if candidate.len() <= allocation {
                    preview = candidate;
                    delivered = candidate_lines;
                } else if index >= 2 {
                    break;
                }
            }
        }
        output.push_str(&frames[index].0);
        output.push_str(if preview.is_empty() {
            "[source omitted"
        } else if complete {
            "[complete"
        } else {
            "[preview"
        });
        output.push_str(&frames[index].1);
        output.push_str(&preview);
    }
    output.push_str(&omission(retained));
    output.push_str(CARD_FOOTER);
    assert!(
        output.len() <= budget,
        "card metadata/source accounting exceeded budget"
    );
    Ok(())
}

#[cfg(test)]
#[path = "explore_hydration_tests.rs"]
mod hydration_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::LspMode;
    use tempfile::tempdir;

    #[test]
    fn query_cards_preserve_owner_ranges_for_complete_followup_reads() {
        let root = tempdir().unwrap();
        let state = tempdir().unwrap();
        let padding = (0..75)
            .map(|i| format!("  // implementation line {i}\n"))
            .collect::<String>();
        fs::write(root.path().join("entry.ts"), format!("import {{ finish }} from './helper';\nexport function reconnect() {{\n  // exponential jitter\n{padding}  return finish();\n}}\n")).unwrap();
        fs::write(
            root.path().join("helper.ts"),
            "export function finish() {\n  return 'done';\n}\n",
        )
        .unwrap();
        let facts =
            CodeFacts::open_with_lsp(root.path(), state.path().join("facts.sqlite"), LspMode::Off)
                .unwrap();
        let response = facts
            .explore(ExploreOptions {
                query: Some("exponential jitter reconnect"),
                max_bytes: Some(2000),
                ..Default::default()
            })
            .unwrap();
        assert!(response.contains("entry.ts:2-80"), "{response}");
        assert!(response.contains("[preview] implementation"), "{response}");
        assert!(response.contains("2: export function reconnect() {"));
        assert!(response.contains("3:   // exponential jitter"));
        assert!(!response.contains("79:   return finish();"));
        let full_source = facts
            .explore(ExploreOptions {
                reads: Some(&[
                    ExploreRead {
                        file_path: "entry.ts".into(),
                        start_line: Some(2),
                        end_line: Some(80),
                    },
                    ExploreRead {
                        file_path: "helper.ts".into(),
                        start_line: Some(1),
                        end_line: Some(3),
                    },
                ]),
                ..Default::default()
            })
            .unwrap();
        assert!(
            full_source.contains("79:   return finish();"),
            "{full_source}"
        );
        assert!(full_source.contains("80: }"));
        assert!(full_source.contains("2:   return 'done';"));
        assert!(!full_source.contains("excerpt incomplete"));
        assert!(response.contains("helper.ts:1-3"), "{response}");
        assert!(response.contains("direct static callee at entry.ts:79"));
        assert!(!response.contains("excerpt incomplete"));
    }

    #[test]
    fn unindexed_source_read_errors_locate_the_input_field_and_normalized_path() {
        let root = tempdir().unwrap();
        let state = tempdir().unwrap();
        fs::write(root.path().join("first.js"), "export const first = 1;\n").unwrap();
        fs::write(
            root.path().join("unsupported.svelte"),
            "<script>const x = 1;</script>\n",
        )
        .unwrap();
        fs::write(root.path().join("last.js"), "export const last = 1;\n").unwrap();
        let facts =
            CodeFacts::open_with_lsp(root.path(), state.path().join("facts.sqlite"), LspMode::Off)
                .unwrap();

        for bad_index in 0..3 {
            let mut reads =
                ["first.js", "unsupported.svelte", "last.js"].map(|file_path| ExploreRead {
                    file_path: file_path.into(),
                    start_line: None,
                    end_line: None,
                });
            reads.swap(1, bad_index);
            let error = facts
                .explore(ExploreOptions {
                    reads: Some(&reads),
                    ..Default::default()
                })
                .unwrap_err()
                .to_string();
            assert!(
                error.contains(&format!("reads[{bad_index}].file_path")),
                "{error}"
            );
            assert!(error.contains("unsupported.svelte"), "{error}");
            assert!(
                error.contains("must name indexed source or a package manifest"),
                "{error}"
            );
        }

        let unsupported_path = root
            .path()
            .join("unsupported.svelte")
            .to_string_lossy()
            .into_owned();
        let error = facts
            .explore(ExploreOptions {
                file_path: Some(&unsupported_path),
                ..Default::default()
            })
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("file_path (\"unsupported.svelte\")"),
            "{error}"
        );
        assert!(!error.contains("reads["), "{error}");
        assert!(
            error.contains("must name indexed source or a package manifest"),
            "{error}"
        );
    }

    #[test]
    fn packing_skips_nonfitting_owner_and_keeps_small_complete_dependency() {
        let sources = HashMap::from([(
            "a.rs".into(),
            Source {
                hash: "hash".into(),
                text: format!("first\n{}last\n", "long line of source\n".repeat(150)),
            },
        )]);
        let excerpt = |start, end| Excerpt {
            path: "a.rs".into(),
            start,
            end,
            focus: start,
            node_id: None,
            reason: "complete fixture".into(),
        };
        let mut output = String::new();
        render_excerpts(
            &mut output,
            vec![excerpt(1, 1), excerpt(2, 151), excerpt(152, 152)],
            &sources,
            2000,
            true,
        );
        assert!(output.contains("1: first"));
        assert!(output.contains("152: last"));
        assert!(!output.contains("long line of source"));
        assert!(output.contains("a.rs:2-151"));
        assert!(!output.contains("SHA256:"));
        assert!(output.len() <= 2000);
    }

    #[test]
    fn whole_source_renderer_shares_oversized_owner_capacity_with_sibling() {
        let sources = HashMap::from([
            (
                "entry.rs".into(),
                Source {
                    hash: "entry-hash".into(),
                    text: (1..=200)
                        .map(|i| format!("// line {i}: 中文 source evidence {}\n", "x".repeat(30)))
                        .collect(),
                },
            ),
            (
                "helper.rs".into(),
                Source {
                    hash: "helper-hash".into(),
                    text: "pub fn helper() {\n    finish();\n}\n".into(),
                },
            ),
        ]);
        let excerpt = |path: &str, start, end, focus| Excerpt {
            path: path.into(),
            start,
            end,
            focus,
            node_id: None,
            reason: "implementation".into(),
        };
        let render = |discovery, sibling, end| {
            let mut excerpts = vec![excerpt("entry.rs", 1, end, 80.min(end))];
            if sibling {
                excerpts.push(excerpt("helper.rs", 1, 3, 1));
            }
            let mut output = "Discovery\n".to_string();
            render_excerpts(&mut output, excerpts, &sources, 4000, discovery);
            output
        };
        let response = render(true, true, 200);
        let first_start = response.find("\n## entry.rs:72-").unwrap();
        let continuation = response.find("[excerpt incomplete;").unwrap();
        let first_end = continuation + response[continuation..].find('\n').unwrap() + 1;
        assert!(first_end - first_start <= (4000 - "Discovery\n".len() - 600) / 2);
        assert!(response.contains("72: // line 72: 中文 source evidence"));
        assert!(response.contains("helper.rs:1-3 | implementation\n"));
        assert!(response.contains("2:     finish();"));
        assert!(response.contains("requested range 1-200"));
        assert!(response.len() <= 4000);

        let focused = render(false, true, 200);
        assert!(
            focused.matches("中文 source evidence").count()
                > response.matches("中文 source evidence").count()
        );
        for (sibling, end) in [(false, 200), (true, 3)] {
            assert!(render(true, sibling, end).starts_with(&render(false, sibling, end)));
        }

        let mut long_line_sources = sources;
        long_line_sources.get_mut("entry.rs").unwrap().text =
            format!("{}\n{}\n", "中文".repeat(500), "中文".repeat(500));
        let mut output = String::new();
        render_excerpts(
            &mut output,
            vec![excerpt("entry.rs", 1, 2, 1), excerpt("helper.rs", 1, 3, 1)],
            &long_line_sources,
            4000,
            true,
        );
        assert!(output.contains("line does not fit; read the cited file directly"));
        assert!(output.contains("helper.rs:1-3 | implementation"));
        assert!(!output.contains("excerpt incomplete"));
        assert!(output.len() <= 4000);
    }

    #[test]
    fn ambiguous_receiver_neighbors_are_labeled_candidates() {
        let root = tempdir().unwrap();
        let state = tempdir().unwrap();
        fs::write(root.path().join("entry.ts"), "class A {\n run = () => { /* nectar retry */ this.work(); };\n work = () => 'a';\n}\nclass B {\n work = () => 'b';\n}\n").unwrap();
        let facts =
            CodeFacts::open_with_lsp(root.path(), state.path().join("facts.sqlite"), LspMode::Off)
                .unwrap();
        let response = facts
            .explore(ExploreOptions {
                query: Some("nectar retry"),
                ..Default::default()
            })
            .unwrap();
        assert!(response.contains("receiver unresolved"), "{response}");
        assert!(!response.contains("direct static callee"), "{response}");
    }

    #[test]
    fn shared_line_query_uses_owner_columns_for_related_source() {
        let root = tempdir().unwrap();
        let state = tempdir().unwrap();
        fs::write(root.path().join("entry.ts"), "class C { same = () => first(); } class D { same = () => second(); }\nfunction first() { return 'wrong'; }\nfunction second() { return 'right'; }\n").unwrap();
        let facts =
            CodeFacts::open_with_lsp(root.path(), state.path().join("facts.sqlite"), LspMode::Off)
                .unwrap();
        let response = facts
            .explore(ExploreOptions {
                query: Some("second"),
                ..Default::default()
            })
            .unwrap();
        assert!(response.contains("return 'right'"), "{response}");
        assert!(!response.contains("return 'wrong'"), "{response}");
    }

    #[test]
    fn task_exploration_returns_body_evidence_and_refreshes_changed_sources() {
        let root = tempdir().unwrap();
        let state = tempdir().unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::create_dir(root.path().join("tests")).unwrap();
        let implementation = "export function reconnectSocket() {\n  // exponential jitter avoids synchronized reconnection\n  return computeDelay();\n}\n";
        fs::write(root.path().join("src/retry.ts"), implementation).unwrap();
        fs::write(root.path().join("tests/retry.test.ts"), "test('jitter delays socket reconnection', () => expect(reconnectSocket()).toBeDefined());\n").unwrap();
        let facts =
            CodeFacts::open_with_lsp(root.path(), state.path().join("facts.sqlite"), LspMode::Off)
                .unwrap();
        let response = facts
            .explore(ExploreOptions {
                query: Some("where is exponential jitter before reconnecting the socket"),
                ..Default::default()
            })
            .unwrap();
        assert!(response.contains("src/retry.ts:1-4"), "{response}");
        assert!(response.contains("2:   // exponential jitter"));
        assert!(!response.contains(&hex::encode(Sha256::digest(implementation.as_bytes()))));
        assert!(response.contains("tests/retry.test.ts"));
        fs::write(
            root.path().join("src/retry.ts"),
            "export function connectOnce() { return true; }\n",
        )
        .unwrap();
        let changed = facts
            .explore(ExploreOptions {
                query: Some("exponential"),
                ..Default::default()
            })
            .unwrap();
        assert!(!changed.contains("exponential jitter"));
        assert!(changed.contains("No matching verified source"));
        assert!(changed.contains("generation 2"));
    }

    #[test]
    fn orientation_keeps_code_entries_when_many_manifests_exist() {
        let root = tempdir().unwrap();
        let state = tempdir().unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(
            root.path().join("Cargo.toml"),
            "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
        fs::write(
            root.path().join("src/lib.rs"),
            "pub mod network;\npub use network::connect;\n",
        )
        .unwrap();
        fs::write(root.path().join("src/network.rs"), "pub fn connect() {}\n").unwrap();
        for index in 0..12 {
            let directory = root.path().join(format!("packages/p{index}"));
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join("package.json"), "{\"main\":\"index.js\"}\n").unwrap();
            fs::write(directory.join("index.js"), "export function helper() {}\n").unwrap();
        }
        let facts =
            CodeFacts::open_with_lsp(root.path(), state.path().join("facts.sqlite"), LspMode::Off)
                .unwrap();
        let response = facts.explore(ExploreOptions::default()).unwrap();
        assert!(response.contains("src/lib.rs"), "{response}");
        assert!(response.contains("Cargo.toml"));
        assert!(response.contains("Directories"));
        assert!(response.len() <= DEFAULT_BYTES);
    }

    #[test]
    fn focused_continuation_and_utf8_budget_preserve_line_locations() {
        let root = tempdir().unwrap();
        let state = tempdir().unwrap();
        let source = (1..=200)
            .map(|i| format!("// line {i}: 中文 evidence {}\n", "x".repeat(50)))
            .collect::<String>();
        fs::write(root.path().join("lib.rs"), source).unwrap();
        let facts =
            CodeFacts::open_with_lsp(root.path(), state.path().join("facts.sqlite"), LspMode::Off)
                .unwrap();
        let response = facts
            .explore(ExploreOptions {
                file_path: Some("lib.rs"),
                start_line: Some(20),
                max_bytes: Some(2000),
                ..Default::default()
            })
            .unwrap();
        assert!(response.len() <= 2000, "{}", response.len());
        assert!(response.contains("20: // line 20:"));
        assert!(!response.contains("19: // line 19:"));
        assert!(response.contains("excerpt incomplete"));
        assert!(!response.contains("SHA256:"));
        assert!(!response.contains("Not fully returned"));
        assert!(response.contains("requested range 20-200"));
        let next = response
            .split("start_line=")
            .nth(1)
            .unwrap()
            .split(')')
            .next()
            .unwrap()
            .parse::<u32>()
            .unwrap();
        let continued = facts
            .explore(ExploreOptions {
                reads: Some(&[ExploreRead {
                    file_path: "lib.rs".into(),
                    start_line: Some(next),
                    end_line: Some(next),
                }]),
                max_bytes: Some(2000),
                ..Default::default()
            })
            .unwrap();
        assert!(continued.contains(&format!("{next}: // line {next}: 中文 evidence")));
        let batch = facts
            .explore(ExploreOptions {
                reads: Some(&[
                    ExploreRead {
                        file_path: "lib.rs".into(),
                        start_line: Some(201),
                        end_line: Some(240),
                    },
                    ExploreRead {
                        file_path: "lib.rs".into(),
                        start_line: Some(20),
                        end_line: Some(240),
                    },
                ]),
                max_bytes: Some(2000),
                ..Default::default()
            })
            .unwrap();
        assert!(batch.len() <= 2000, "{}", batch.len());
        assert!(batch.contains("start_line 201 is past EOF 200"), "{batch}");
        assert!(batch.contains("end_line 240 clipped to EOF 200"), "{batch}");
        assert!(batch.contains("20: // line 20: 中文 evidence"), "{batch}");
        assert!(batch.contains("excerpt incomplete"), "{batch}");
        let follow = facts
            .explore(ExploreOptions {
                file_path: Some("lib.rs"),
                start_line: Some(80),
                ..Default::default()
            })
            .unwrap();
        assert!(follow.contains("80: // line 80:"));
        assert!(facts
            .explore(ExploreOptions {
                file_path: Some("../outside.rs"),
                ..Default::default()
            })
            .is_err());
        assert!(facts
            .explore(ExploreOptions {
                start_line: Some(1),
                ..Default::default()
            })
            .is_err());
    }

    #[test]
    fn verified_source_rejects_post_refresh_changes() {
        let root = tempdir().unwrap();
        let state = tempdir().unwrap();
        fs::write(root.path().join("lib.rs"), "pub fn before() {}\n").unwrap();
        let facts =
            CodeFacts::open_with_lsp(root.path(), state.path().join("facts.sqlite"), LspMode::Off)
                .unwrap();
        facts.refresh().unwrap();
        let hashes = facts.store.get_file_hashes().unwrap();
        fs::write(root.path().join("lib.rs"), "pub fn after() {}\n").unwrap();
        assert!(facts
            .exploration_source("lib.rs", Some(&hashes["lib.rs"]))
            .err()
            .unwrap()
            .to_string()
            .contains("changed after refresh"));
    }

    #[test]
    fn lexical_focus_uses_words_and_long_lines_have_explicit_nonprogress() {
        assert_eq!(
            line_score(
                "const unrelated = \"repayment_retryless\";",
                &["payment".into(), "retry".into()]
            ),
            0
        );
        assert_eq!(
            line_score("// payment retry", &["payment".into(), "retry".into()]),
            2
        );
        assert_eq!(source_role("src/inspector.ts"), "implementation");
        assert_eq!(source_role("src/latest.rs"), "implementation");
        assert_eq!(source_role("tests/network.rs"), "test");
        let source = Source {
            hash: "hash".into(),
            text: format!("{}\n", "x".repeat(40_000)),
        };
        let mut output = String::new();
        render_excerpts(
            &mut output,
            vec![Excerpt {
                path: "long.js".into(),
                start: 1,
                end: 1,
                reason: "focused source".into(),
                node_id: None,
                focus: 1,
            }],
            &HashMap::from([("long.js".into(), source)]),
            MAX_BYTES,
            false,
        );
        assert!(output.contains("read the cited file directly"));
        assert!(!output.contains("start_line=1"));
        assert!(output.len() <= MAX_BYTES);
    }
    fn card_excerpt(path: &str, start: u32, end: u32, id: Option<&str>) -> Excerpt {
        Excerpt {
            path: path.into(),
            start,
            end,
            reason: "implementation; lexical candidate".into(),
            node_id: id.map(str::to_string),
            focus: start,
        }
    }

    fn card_node(id: &str, name: &str, path: &str, start: u32, end: u32) -> CodeNode {
        CodeNode {
            id: id.into(),
            name: name.into(),
            qualified_name: None,
            kind: NodeKind::Function,
            file_path: path.into(),
            start_line: start,
            end_line: end,
            start_column: 0,
            end_column: 1,
            language: crate::types::Language::Rust,
            body: None,
            documentation: None,
            exported: None,
            is_local: false,
        }
    }

    fn card_source(path: &str, text: &str) -> HashMap<String, Source> {
        HashMap::from([(
            path.into(),
            Source {
                hash: hex::encode(Sha256::digest(text.as_bytes())),
                text: text.into(),
            },
        )])
    }

    #[test]
    fn cards_preserve_selected_and_ranked_order_and_distinct_contained_owners() {
        let parent = card_excerpt("fixture.rs", 1, 8, Some("parent"));
        let child = card_excerpt("fixture.rs", 2, 3, Some("child"));
        let fallback = card_excerpt("fixture.rs", 5, 6, None);
        let cards = card_sequence(
            vec![parent.clone(), child.clone(), parent.clone()],
            vec![child, fallback, parent],
        );
        assert_eq!(cards.len(), 3);
        assert_eq!(cards[0].0.node_id.as_deref(), Some("parent"));
        assert_eq!(cards[1].0.node_id.as_deref(), Some("child"));
        assert_eq!(cards[2].0.start, 5);
        assert_eq!(
            cards
                .iter()
                .map(|(_, deferred)| *deferred)
                .collect::<Vec<_>>(),
            vec![false, false, true]
        );
        let nodes = vec![
            card_node("parent", "parent", "fixture.rs", 1, 8),
            card_node("child", "child", "fixture.rs", 2, 3),
        ];
        let sources = card_source(
            "fixture.rs",
            "fn parent() {\nfn child() {\n}\nplain\nfallback\nneedle\nplain\n}\n",
        );
        let mut response = String::new();
        render_cards(
            &mut response,
            cards,
            &nodes,
            &["needle".into()],
            &sources,
            2000,
        )
        .unwrap();
        for range in ["fixture.rs:1-8", "fixture.rs:2-3", "fixture.rs:5-6"] {
            assert_eq!(response.matches(range).count(), 1);
        }
        assert_eq!(response.matches("[complete] implementation").count(), 3);
        assert!(response.contains("implementation; deferred"));
    }

    #[test]
    fn cards_keep_36_selected_owners_without_overflow() {
        let selected = (0..36)
            .map(|i| card_excerpt("fixture.rs", i + 1, i + 1, None))
            .collect();
        let cards = card_sequence(selected, vec![card_excerpt("fixture.rs", 37, 37, None)]);
        assert_eq!(cards.len(), 36);
        assert_eq!(cards.last().unwrap().0.start, 36);
        assert!(cards.iter().all(|(_, deferred)| !deferred));
    }

    #[test]
    fn cards_show_numbered_first_and_best_lines_with_an_explicit_gap() {
        let text = format!(
            "identity\n{}\n{}\nneedle\nneedle\n",
            "plain".repeat(500),
            "plain".repeat(500)
        );
        let sources = card_source("fixture.rs", &text);
        let mut response = String::new();
        render_cards(
            &mut response,
            card_sequence(vec![card_excerpt("fixture.rs", 1, 5, None)], vec![]),
            &[],
            &["needle".into()],
            &sources,
            2000,
        )
        .unwrap();
        assert!(response
            .contains("1: identity\n[... source lines omitted ...]\n4: needle\n5: needle\n"));
        assert!(!response.contains("2: plain"));
        assert!(!response.contains("complete function"));
    }

    #[test]
    fn cards_show_an_identical_start_and_focus_line_once() {
        let sources = card_source("fixture.rs", "needle\nplain\n");
        let mut response = String::new();
        render_cards(
            &mut response,
            card_sequence(vec![card_excerpt("fixture.rs", 1, 2, None)], vec![]),
            &[],
            &["needle".into()],
            &sources,
            2000,
        )
        .unwrap();
        assert_eq!(response.matches("1: needle\n").count(), 1);
        assert!(!response.contains("source lines omitted"));
    }

    #[test]
    fn cards_with_no_matching_line_return_a_complete_fitting_range() {
        let sources = card_source("fixture.rs", "identity\nplain\n");
        let mut response = String::new();
        render_cards(
            &mut response,
            card_sequence(vec![card_excerpt("fixture.rs", 1, 2, None)], vec![]),
            &[],
            &["absent".into()],
            &sources,
            2000,
        )
        .unwrap();
        assert_eq!(response.matches("1: identity\n").count(), 1);
        assert!(response.contains("2: plain"));
        assert!(response.contains("[complete] implementation"));
    }

    #[test]
    fn card_metadata_budget_keeps_a_whole_prefix_and_reports_omissions() {
        let text = (1..=36).map(|i| format!("line_{i}\n")).collect::<String>();
        let sources = card_source("fixture.rs", &text);
        let cards = card_sequence(
            (1..=36)
                .map(|i| card_excerpt("fixture.rs", i, i, None))
                .collect(),
            vec![],
        );
        let mut response = String::new();
        render_cards(&mut response, cards, &[], &[], &sources, 2000).unwrap();
        let returned = response.matches("\n## fixture.rs:").count();
        assert!((1..36).contains(&returned));
        for line in 1..=returned {
            assert_eq!(
                response
                    .matches(&format!("fixture.rs:{line}-{line} |"))
                    .count(),
                1
            );
        }
        assert!(!response.contains(&format!("## fixture.rs:{}-{}", returned + 1, returned + 1)));
        assert!(response.contains(&format!("{} additional cards omitted", 36 - returned)));
        assert!(response.len() <= 2000);
        assert!(!response.contains("[response truncated"));
    }

    #[test]
    fn cards_with_no_fitting_metadata_emit_only_an_explicit_omission() {
        let path = "x".repeat(2000);
        let sources = card_source(&path, "identity\n");
        let mut response = String::new();
        render_cards(
            &mut response,
            card_sequence(vec![card_excerpt(&path, 1, 1, None)], vec![]),
            &[],
            &[],
            &sources,
            2000,
        )
        .unwrap();
        assert!(response.contains("1 additional cards omitted by metadata byte budget"));
        assert!(!response.contains("## "));
        assert!(!response.contains("SHA256:"));
        assert!(response.len() <= 2000);
    }

    #[test]
    fn cards_omit_whole_long_utf8_lines_and_mark_source_omitted() {
        let text = format!("{}\n", "中文".repeat(1000));
        let sources = card_source("fixture.rs", &text);
        let mut response = String::new();
        render_cards(
            &mut response,
            card_sequence(vec![card_excerpt("fixture.rs", 1, 1, None)], vec![]),
            &[],
            &[],
            &sources,
            2000,
        )
        .unwrap();
        assert!(response.contains("[source omitted] implementation"));
        assert!(!response.contains("1: 中文"));
        assert!(response.len() <= 2000);
    }

    #[test]
    fn cards_do_not_borrow_unused_preview_bytes_from_another_card() {
        let text = format!("short\n{}\n", "x".repeat(1400));
        let sources = card_source("fixture.rs", &text);
        let mut response = String::new();
        render_cards(
            &mut response,
            card_sequence(
                vec![
                    card_excerpt("fixture.rs", 1, 1, None),
                    card_excerpt("fixture.rs", 2, 2, None),
                ],
                vec![],
            ),
            &[],
            &[],
            &sources,
            2000,
        )
        .unwrap();
        assert!(response.contains("1: short\n"));
        assert!(response
            .contains("fixture.rs:2-2 | lexical source range\n[source omitted] implementation"));
        assert!(!response.contains("2: x"));
    }

    #[test]
    fn cards_keep_verified_hashes_internal() {
        let sources = card_source("fixture.rs", "first\nsecond\n");
        let mut response = String::new();
        render_cards(
            &mut response,
            card_sequence(
                vec![
                    card_excerpt("fixture.rs", 1, 1, None),
                    card_excerpt("fixture.rs", 2, 2, None),
                ],
                vec![],
            ),
            &[],
            &[],
            &sources,
            2000,
        )
        .unwrap();
        assert!(!response.contains("SHA256:"));
        assert!(!response.contains(&sources["fixture.rs"].hash));
        assert!(response.contains("1: first\n"));
        assert!(response.contains("2: second\n"));
    }

    #[test]
    fn cards_spend_removed_metadata_bytes_on_complete_source() {
        let text = (1..=4)
            .map(|line| format!("// needle {line}: {}\n", "x".repeat(415)))
            .collect::<String>();
        let sources = card_source("fixture.rs", &text);
        let node = card_node("owner", "needle", "fixture.rs", 1, 4);
        let mut response = String::new();
        render_cards(
            &mut response,
            card_sequence(
                vec![card_excerpt("fixture.rs", 1, 4, Some("owner"))],
                vec![],
            ),
            &[node],
            &["needle".into()],
            &sources,
            2000,
        )
        .unwrap();
        assert!(response.contains("[complete] implementation"), "{response}");
        for (index, line) in text.lines().enumerate() {
            assert!(response.contains(&format!("{}: {line}\n", index + 1)));
        }
        assert_eq!(response.matches("fixture.rs:1-4").count(), 1);
        assert!(!response.contains(&sources["fixture.rs"].hash));
        assert!(response.len() <= 2000);
    }

    #[test]
    fn card_previews_use_remaining_capacity_and_preserve_utf8_lines() {
        let text = (1..=200)
            .map(|line| format!("// needle {line}: {}\n", "中文".repeat(25)))
            .collect::<String>();
        let sources = card_source("fixture.rs", &text);
        for budget in [2000, 4000, 24_000, 32_000] {
            let mut response = String::new();
            render_cards(
                &mut response,
                card_sequence(vec![card_excerpt("fixture.rs", 1, 200, None)], vec![]),
                &[],
                &["needle".into()],
                &sources,
                budget,
            )
            .unwrap();
            assert!(response.contains("[preview] implementation"));
            let returned = response
                .lines()
                .filter_map(|line| line.split_once(": "))
                .filter_map(|(number, source)| {
                    number.parse::<usize>().ok().map(|line| (line, source))
                })
                .collect::<Vec<_>>();
            assert!(returned.len() > 2, "budget {budget}: {response}");
            for (line, actual) in returned {
                assert_eq!(actual, text.lines().nth(line - 1).unwrap());
            }
            assert_eq!(response.matches("fixture.rs:1-200").count(), 1);
            assert!(response.len() <= budget);
        }
    }

    #[test]
    fn source_metadata_like_text_remains_verbatim_in_cards_and_reads() {
        let text = "SHA256: source-owned hash\n[preview; full owner range fixture.rs:1-2]\n";
        let sources = card_source("fixture.rs", text);
        let mut cards = String::new();
        render_cards(
            &mut cards,
            card_sequence(vec![card_excerpt("fixture.rs", 1, 2, None)], vec![]),
            &[],
            &[],
            &sources,
            2000,
        )
        .unwrap();
        let mut reads = String::new();
        render_excerpts(
            &mut reads,
            vec![card_excerpt("fixture.rs", 1, 2, None)],
            &sources,
            2000,
            false,
        );
        for response in [cards, reads] {
            assert!(response.contains("1: SHA256: source-owned hash\n"));
            assert!(response.contains("2: [preview; full owner range fixture.rs:1-2]\n"));
            assert!(!response.contains(&sources["fixture.rs"].hash));
        }
    }

    #[test]
    fn cards_preserve_source_names_status_and_relationship_uncertainty() {
        let path = "[locator-only;lexical candidate/fixture.rs";
        let mut node = card_node("owner", "[locator-only;owner", path, 1, 2);
        node.kind = NodeKind::Heading;
        let sources = card_source(path, "identity\nneedle\n");
        for reason in [
            "direct static callee at lexical candidate/file.rs:1",
            "name-matched source candidate at owner unavailable/file.rs:1; receiver unresolved",
        ] {
            let mut excerpt = card_excerpt(path, 1, 2, Some("owner"));
            excerpt.reason = format!("{reason}; heading {}", node.name);
            let mut response = String::new();
            render_cards(
                &mut response,
                card_sequence(vec![excerpt], vec![]),
                std::slice::from_ref(&node),
                &["needle".into()],
                &sources,
                2000,
            )
            .unwrap();
            assert!(response.contains(&format!("## {path}:1-2 | heading [locator-only;owner\n")));
            assert!(response.contains("[complete]"));
            assert!(response.contains(reason));
            assert_eq!(response.matches(&node.name).count(), 1);
        }
    }

    #[test]
    fn card_query_echo_is_omitted_only_when_fixed_metadata_cannot_fit() {
        let raw = "a".repeat(8192);
        let terms = query_terms(&raw);
        assert_eq!(terms, vec![raw]);
        let mut response = "Root: fixture\nFreshness: fresh | generation 1\nScope: .\n".to_string();
        card_query_echo(&mut response, &terms, 2000);
        assert!(response.contains("term echo omitted by byte budget"));
        assert!(response.contains("Freshness: fresh | generation 1"));
        let sources = card_source("fixture.rs", "identity\n");
        render_cards(
            &mut response,
            card_sequence(vec![card_excerpt("fixture.rs", 1, 1, None)], vec![]),
            &[],
            &terms,
            &sources,
            2000,
        )
        .unwrap();
        assert!(response.len() <= 2000);

        let mut fitting_echo = String::new();
        card_query_echo(&mut fitting_echo, &["b".repeat(1600)], 2000);
        assert!(fitting_echo.contains("Lexical candidates for:"));
        let path = "x".repeat(200);
        render_cards(
            &mut fitting_echo,
            card_sequence(vec![card_excerpt(&path, 1, 1, None)], vec![]),
            &[],
            &[],
            &card_source(&path, "identity\n"),
            2000,
        )
        .unwrap();
        assert!(fitting_echo.contains("1 additional cards omitted"));
        assert!(!fitting_echo.contains("## "));
    }

    #[test]
    fn card_renderer_returns_an_error_when_mandatory_provenance_cannot_fit() {
        let mut response = "mandatory provenance".repeat(200);
        let result = render_cards(
            &mut response,
            card_sequence(vec![card_excerpt("fixture.rs", 1, 1, None)], vec![]),
            &[],
            &[],
            &card_source("fixture.rs", "identity\n"),
            2000,
        );
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("mandatory exploration metadata exceeds max_bytes"));
    }
}
