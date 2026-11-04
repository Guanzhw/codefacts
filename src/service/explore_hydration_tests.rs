//! Frozen pre-hydration selection oracle, compiled only for correctness tests.
use super::*;
use crate::lsp::LspMode;
use crate::types::{CodeEdge, Language};
use tempfile::tempdir;

fn node(id: &str, name: &str, path: &str, kind: NodeKind, start: u32, end: u32) -> CodeNode {
    CodeNode {
        id: id.into(),
        name: name.into(),
        qualified_name: Some(format!("owner.{name}")),
        rust_impl: None,
        kind,
        file_path: path.into(),
        start_line: start,
        end_line: end,
        start_column: 0,
        end_column: 1,
        language: Language::TypeScript,
        body: Some(format!("function {name}() {{ return 'fixture'; }}")),
        documentation: Some("中文 evidence".into()),
        exported: Some(true),
        is_local: false,
    }
}

fn call(
    source: &str,
    target: &str,
    path: &str,
    line: u32,
    member: Option<&str>,
    heuristic: bool,
) -> CodeEdge {
    let mut metadata = HashMap::new();
    if member.is_some() {
        metadata.insert("call_form".into(), "member".into());
    }
    if heuristic {
        metadata.insert("confidence".into(), "heuristic".into());
    }
    CodeEdge {
        source: source.into(),
        target: target.into(),
        kind: EdgeKind::Calls,
        file_path: path.into(),
        line,
        target_name: member.map(str::to_string),
        metadata: Some(metadata),
    }
}

fn fixture(files: &[(&str, &str)]) -> (tempfile::TempDir, tempfile::TempDir, CodeFacts) {
    let root = tempdir().unwrap();
    let state = tempdir().unwrap();
    for (path, text) in files {
        let full = root.path().join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, text).unwrap();
    }
    let facts =
        CodeFacts::open_with_lsp(root.path(), state.path().join("facts.sqlite"), LspMode::Off)
            .unwrap();
    facts.refresh().unwrap();
    (root, state, facts)
}

fn assert_public_parity(facts: &CodeFacts, query: &str, scope: Option<&str>) {
    for budget in [2_000, 24_000, 32_000] {
        let options = || ExploreOptions {
            query: Some(query),
            path_prefix: scope,
            max_bytes: Some(budget),
            ..Default::default()
        };
        let actual = facts.explore(options()).unwrap();
        let expected = facts.explore_full_store_oracle(options()).unwrap();
        assert_eq!(
            actual, expected,
            "query {query}, scope {scope:?}, budget {budget}"
        );
    }
}

fn assert_related_parity(
    facts: &CodeFacts,
    seeds: Vec<Excerpt>,
    files: BTreeSet<String>,
    terms: &[String],
) -> (Vec<Excerpt>, NodeCatalog) {
    let nodes = facts.store.get_all_nodes().unwrap();
    let hashes = facts.store.get_file_hashes().unwrap();
    let mut catalog = NodeCatalog::default();
    catalog
        .load_files(
            &facts.store,
            &seeds.iter().map(|e| e.path.clone()).collect::<Vec<_>>(),
        )
        .unwrap();
    let mut actual_sources = HashMap::new();
    let mut expected_sources = HashMap::new();
    let mut actual_gaps = Vec::new();
    let mut expected_gaps = Vec::new();
    for seed in &seeds {
        assert!(facts.load_exploration_source(
            &seed.path,
            &hashes,
            &mut actual_sources,
            &mut actual_gaps
        ));
        assert!(facts.load_exploration_source(
            &seed.path,
            &hashes,
            &mut expected_sources,
            &mut expected_gaps
        ));
    }
    let actual = facts
        .related_excerpts(
            seeds.clone(),
            &mut catalog,
            &files,
            terms,
            &hashes,
            &mut actual_sources,
            &mut actual_gaps,
        )
        .unwrap();
    let expected = facts
        .related_excerpts_full_store_oracle(
            seeds,
            &nodes,
            &files,
            terms,
            &hashes,
            &mut expected_sources,
            &mut expected_gaps,
        )
        .unwrap();
    let fingerprint = |excerpts: &[Excerpt]| {
        excerpts
            .iter()
            .map(|e| {
                (
                    e.path.clone(),
                    e.start,
                    e.end,
                    e.reason.clone(),
                    e.node_id.clone(),
                    e.focus,
                )
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(fingerprint(&actual), fingerprint(&expected));
    assert_eq!(actual_gaps, expected_gaps);
    for budget in [2_000, 24_000, 32_000] {
        let mut actual_text = String::from("fixture metadata\n");
        let mut expected_text = actual_text.clone();
        render_cards(
            &mut actual_text,
            card_sequence(actual.clone(), Vec::new()),
            &catalog.nodes,
            terms,
            &actual_sources,
            budget,
        )
        .unwrap();
        render_cards(
            &mut expected_text,
            card_sequence(expected.clone(), Vec::new()),
            &nodes,
            terms,
            &expected_sources,
            budget,
        )
        .unwrap();
        assert_eq!(actual_text, expected_text, "related render budget {budget}");
    }
    (actual, catalog)
}

#[test]
fn complete_orientation_catalog_preserves_order_and_never_rehydrates_frontier_files() {
    let (_root, _state, facts) = fixture(&[
        (
            "index.ts",
            "import { middle } from './middle';\nexport function main() { return middle(); }\n",
        ),
        (
            "middle.ts",
            "import { leaf } from './leaf';\nexport function middle() { return leaf(); }\n",
        ),
        (
            "leaf.ts",
            "export function leaf() { return '中文 evidence'; }\n",
        ),
        ("README.md", "# Orientation\nRepository source evidence.\n"),
        ("a0.ts", "export function noise0() { return 0; }\n"),
        ("a1.ts", "export function noise1() { return 1; }\n"),
        ("a2.ts", "export function noise2() { return 2; }\n"),
        ("a3.ts", "export function noise3() { return 3; }\n"),
    ]);
    let all = facts.store.get_all_nodes().unwrap();
    let main = all.iter().find(|node| node.name == "main").unwrap();
    let middle = all.iter().find(|node| node.name == "middle").unwrap();
    let leaf = all.iter().find(|node| node.name == "leaf").unwrap();
    facts
        .store
        .upsert_edges(&[
            call(&main.id, &middle.id, "index.ts", 2, None, false),
            call(&middle.id, &leaf.id, "middle.ts", 2, None, false),
        ])
        .unwrap();
    let expected_ids: Vec<_> = all.iter().map(|node| node.id.clone()).collect();
    let expected_files: HashSet<_> = all.iter().map(|node| node.file_path.clone()).collect();
    let mut catalog = NodeCatalog::from_all_nodes(all.clone());
    assert_eq!(
        catalog
            .nodes
            .iter()
            .map(|node| node.id.clone())
            .collect::<Vec<_>>(),
        expected_ids
    );
    assert_eq!(catalog.loaded_files, expected_files);
    for node in &all {
        assert_eq!(
            serde_json::to_value(catalog.get(&node.id).unwrap()).unwrap(),
            serde_json::to_value(node).unwrap()
        );
    }
    let initial_hydrated_rows = catalog.hydrated_rows;
    // Complete files and IDs are already authoritative; both loads must be no-ops.
    catalog
        .load_files(
            &facts.store,
            &expected_files.iter().cloned().collect::<Vec<_>>(),
        )
        .unwrap();
    catalog.load_ids(&facts.store, &expected_ids).unwrap();
    assert_eq!(catalog.hydrated_rows, initial_hydrated_rows);

    let hashes = facts.store.get_file_hashes().unwrap();
    let files: BTreeSet<_> = hashes.keys().cloned().collect();
    let mut sources = HashMap::new();
    let mut gaps = Vec::new();
    let mut output = String::new();
    let seeds = facts
        .orientation_excerpts(
            &catalog.nodes,
            &files,
            &hashes,
            &mut sources,
            &mut output,
            &mut gaps,
        )
        .unwrap();
    assert!(seeds
        .iter()
        .any(|excerpt| excerpt.node_id.as_deref() == Some(main.id.as_str())));
    assert!(!seeds
        .iter()
        .any(|excerpt| excerpt.node_id.as_deref() == Some(middle.id.as_str())));
    assert!(!seeds
        .iter()
        .any(|excerpt| excerpt.node_id.as_deref() == Some(leaf.id.as_str())));
    let related = facts
        .related_excerpts(
            seeds,
            &mut catalog,
            &files,
            &[],
            &hashes,
            &mut sources,
            &mut gaps,
        )
        .unwrap();
    assert!(related
        .iter()
        .any(|excerpt| excerpt.node_id.as_deref() == Some(middle.id.as_str())));
    assert!(related
        .iter()
        .any(|excerpt| excerpt.node_id.as_deref() == Some(leaf.id.as_str())));
    assert_eq!(
        catalog.hydrated_rows, initial_hydrated_rows,
        "orientation and both related hops must reuse the complete snapshot"
    );
    assert_eq!(initial_hydrated_rows, all.len());

    for budget in [2_000, 24_000, 32_000] {
        let options = || ExploreOptions {
            max_bytes: Some(budget),
            ..Default::default()
        };
        assert_eq!(
            facts.explore(options()).unwrap(),
            facts.explore_full_store_oracle(options()).unwrap(),
            "orientation budget {budget}"
        );
    }
}

#[test]
fn hydration_matches_full_store_for_nested_owners_markdown_and_deferred_cards() {
    let (_root, _state, facts) = fixture(&[
        ("entry.ts", "export class Retry {\n  // jitter reconnect outer\n  reconnect() {\n    // jitter reconnect inner\n    function nested() { return 'jitter reconnect'; }\n    return nested();\n  }\n}\nexport function sibling() { return 'jitter reconnect'; }\n"),
        ("guide.md", "# Jitter reconnect\nOverview jitter reconnect.\n## Nested jitter reconnect\nExact nested heading evidence.\n### Child jitter reconnect\n中文 jitter reconnect evidence.\n"),
        ("retry.test.ts", "export function testReconnect() { return 'jitter reconnect'; }\n"),
    ]);
    assert_public_parity(&facts, "jitter reconnect", None);
    assert_public_parity(&facts, "jitter reconnect", Some("entry.ts"));
    for budget in [2_000, 24_000, 32_000] {
        assert_eq!(
            facts
                .explore(ExploreOptions {
                    max_bytes: Some(budget),
                    ..Default::default()
                })
                .unwrap(),
            facts
                .explore_full_store_oracle(ExploreOptions {
                    max_bytes: Some(budget),
                    ..Default::default()
                })
                .unwrap()
        );
    }
}

#[test]
fn hydration_keeps_deferred_owner_metadata_at_all_response_budgets() {
    let source = (0..48)
        .map(|i| format!("export function needle{i:02}() {{ return 'needle 中文 {i}'; }}\n"))
        .collect::<String>();
    let (_root, _state, facts) = fixture(&[("owners.ts", &source)]);
    assert_public_parity(&facts, "needle", None);
    let response = facts
        .explore(ExploreOptions {
            query: Some("needle"),
            max_bytes: Some(32_000),
            ..Default::default()
        })
        .unwrap();
    assert!(response.contains("implementation; deferred"), "{response}");
    assert!(!response.contains("SHA256:"));
    assert!(response.contains("symbol ranges cover full owners"));
}

#[test]
fn hydration_preserves_fallback_ties_two_hops_cycles_and_missing_targets() {
    let (_root, _state, facts) = fixture(&[
        ("entry.ts", "seed\nmember\nmember\nclass\n"),
        ("middle.ts", "middle\nleaf\n"),
        ("leaf.ts", "leaf\n"),
        ("noise.ts", "noise\n"),
    ]);
    let nodes = [
        node("seed", "seed", "entry.ts", NodeKind::Function, 1, 1),
        node("member-a", "member", "entry.ts", NodeKind::Method, 2, 2),
        node("member-b", "member", "entry.ts", NodeKind::Method, 3, 3),
        node("wrong-kind", "member", "entry.ts", NodeKind::Variable, 4, 4),
        node("middle", "middle", "middle.ts", NodeKind::Function, 1, 1),
        node("middle-member", "leaf", "middle.ts", NodeKind::Method, 2, 2),
        node("leaf", "leaf", "leaf.ts", NodeKind::Function, 1, 1),
    ];
    facts.store.upsert_nodes(&nodes).unwrap();
    facts
        .store
        .upsert_edges(&[
            call(
                "seed",
                "missing",
                "entry.ts",
                1,
                Some("unknown.member"),
                false,
            ),
            call("seed", "missing-nonmember", "entry.ts", 2, None, false),
            call(
                "seed",
                "wrong-kind",
                "entry.ts",
                1,
                Some("receiver.member"),
                false,
            ),
            call("seed", "middle", "entry.ts", 1, None, false),
            call("seed", "leaf", "entry.ts", 2, Some("receiver.member"), true),
            call("middle", "leaf", "middle.ts", 1, None, false),
            call(
                "middle",
                "missing-leaf",
                "middle.ts",
                1,
                Some("receiver.leaf"),
                false,
            ),
            call("member-a", "seed", "entry.ts", 2, None, false),
            call("leaf", "seed", "leaf.ts", 1, None, false),
        ])
        .unwrap();
    let files = BTreeSet::from([
        "entry.ts".into(),
        "middle.ts".into(),
        "leaf.ts".into(),
        "noise.ts".into(),
    ]);
    let (actual, catalog) = assert_related_parity(
        &facts,
        vec![node_excerpt(
            &nodes[0],
            "implementation; lexical candidate".into(),
        )],
        files,
        &[],
    );
    let ids: Vec<_> = actual.iter().filter_map(|e| e.node_id.as_deref()).collect();
    assert_eq!(
        ids,
        [
            "seed",
            "middle",
            "member-a",
            "member-b",
            "leaf",
            "middle-member"
        ]
    );
    assert!(actual
        .iter()
        .any(|e| e.reason.contains("receiver unresolved")));
    assert!(!catalog.loaded_files.contains("noise.ts"));
    assert!(catalog.loaded_files.contains("middle.ts"));
    assert!(!catalog.loaded_files.contains("leaf.ts"));
}

#[test]
fn hydration_keeps_top_three_before_scope_test_and_unavailable_filters() {
    let (root, _state, facts) = fixture(&[
        ("entry.ts", "seed\nfourth\n"),
        ("outside.ts", "outside\n"),
        ("target.test.ts", "test\n"),
        ("gone.ts", "gone\n"),
    ]);
    let nodes = [
        node("seed", "seed", "entry.ts", NodeKind::Function, 1, 1),
        node(
            "a-outside",
            "needle",
            "outside.ts",
            NodeKind::Function,
            1,
            1,
        ),
        node(
            "b-test",
            "needle",
            "target.test.ts",
            NodeKind::Function,
            1,
            1,
        ),
        node("c-gone", "needle", "gone.ts", NodeKind::Function, 1, 1),
        node("d-fourth", "fourth", "entry.ts", NodeKind::Function, 2, 2),
    ];
    facts.store.upsert_nodes(&nodes).unwrap();
    facts
        .store
        .upsert_edges(
            &nodes[1..]
                .iter()
                .map(|n| call("seed", &n.id, "entry.ts", 1, None, false))
                .collect::<Vec<_>>(),
        )
        .unwrap();
    fs::remove_file(root.path().join("gone.ts")).unwrap();
    let (actual, _) = assert_related_parity(
        &facts,
        vec![node_excerpt(
            &nodes[0],
            "implementation; lexical candidate".into(),
        )],
        BTreeSet::from(["entry.ts".into(), "target.test.ts".into(), "gone.ts".into()]),
        &["needle".into()],
    );
    assert_eq!(actual.len(), 1);
}

#[test]
fn hydration_ranks_all_high_fanout_targets_across_parameter_batches() {
    let fanout_source = (0..620)
        .map(|i| format!("target {i}\n"))
        .collect::<String>();
    let (_root, _state, facts) = fixture(&[("entry.ts", "seed\n"), ("targets.ts", &fanout_source)]);
    let seed = node("seed", "seed", "entry.ts", NodeKind::Function, 1, 1);
    let mut targets = (0..620)
        .map(|i| {
            let mut n = node(
                &format!("target-{i:04}"),
                if i >= 617 { "needle" } else { "target" },
                "targets.ts",
                NodeKind::Function,
                i + 1,
                i + 1,
            );
            n.body = Some(if i >= 617 { "needle" } else { "ordinary" }.into());
            n
        })
        .collect::<Vec<_>>();
    targets.push(seed.clone());
    facts.store.upsert_nodes(&targets).unwrap();
    facts
        .store
        .upsert_edges(
            &targets[..620]
                .iter()
                .map(|n| call("seed", &n.id, "entry.ts", 1, None, false))
                .collect::<Vec<_>>(),
        )
        .unwrap();
    let (actual, catalog) = assert_related_parity(
        &facts,
        vec![node_excerpt(
            &seed,
            "implementation; lexical candidate".into(),
        )],
        BTreeSet::from(["entry.ts".into(), "targets.ts".into()]),
        &["needle".into()],
    );
    assert_eq!(
        actual
            .iter()
            .filter_map(|e| e.node_id.as_deref())
            .collect::<Vec<_>>(),
        ["seed", "target-0617", "target-0618", "target-0619"]
    );
    assert!(catalog.nodes.len() >= 621);
}

#[test]
fn request_local_catalog_reports_rows_without_loading_unrelated_files() {
    let mut files = vec![
        (
            "entry.ts".to_string(),
            "export function needle() { return leaf(); }\n".to_string(),
        ),
        (
            "leaf.ts".into(),
            "export function leaf() { return 'done'; }\n".into(),
        ),
    ];
    files.extend((0..120).map(|i| {
        (
            format!("noise/{i}.ts"),
            format!("export function noise{i}() {{ return {i}; }}\n"),
        )
    }));
    let refs = files
        .iter()
        .map(|(path, text)| (path.as_str(), text.as_str()))
        .collect::<Vec<_>>();
    let (_root, _state, facts) = fixture(&refs);
    let all = facts.store.get_all_nodes().unwrap();
    let seed = all.iter().find(|n| n.name == "needle").unwrap();
    let leaf = all.iter().find(|n| n.name == "leaf").unwrap();
    facts
        .store
        .upsert_edges(&[call(&seed.id, &leaf.id, "entry.ts", 1, None, false)])
        .unwrap();
    let files = facts.store.get_file_hashes().unwrap().into_keys().collect();
    let (_, catalog) = assert_related_parity(
        &facts,
        vec![node_excerpt(
            seed,
            "implementation; lexical candidate".into(),
        )],
        files,
        &["needle".into()],
    );
    println!(
        "hydration rows={} unique={} full_store={} loaded_files={:?}",
        catalog.hydrated_rows,
        catalog.nodes.len(),
        all.len(),
        catalog.loaded_files
    );
    assert!(catalog.hydrated_rows < all.len());
    assert_eq!(
        catalog.loaded_files,
        HashSet::from(["entry.ts".into(), "leaf.ts".into()])
    );
    assert_public_parity(&facts, "needle", None);
}

impl CodeFacts {
    fn explore_full_store_oracle(&self, options: ExploreOptions<'_>) -> Result<String> {
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
            return Err(CodeFactsError::Mcp(explore_mode_conflict(&options)));
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
                return Err(CodeFactsError::Mcp(explore_mode_conflict(&options)));
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
        if let Some(reads) = options
            .reads
            .or_else(|| single_read.as_ref().map(std::slice::from_ref))
        {
            let mut excerpts = Vec::new();
            let mut eof_notes = Vec::new();
            for read in reads {
                let path = self.relative_path(&read.file_path)?;
                if !hashes.contains_key(&path) && !is_manifest(&path) {
                    return Err(CodeFactsError::Mcp(
                        "file_path must name indexed source or a package manifest".into(),
                    ));
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

        let nodes = self.store.get_all_nodes()?;
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
            self.task_excerpts(
                &hits,
                &terms,
                &query_identifiers(query),
                &nodes,
                &hashes,
                &mut sources,
                &mut gaps,
                &mut ranked_candidates,
            )?
        } else {
            self.orientation_excerpts(
                &nodes,
                &scoped_files,
                &hashes,
                &mut sources,
                &mut output,
                &mut gaps,
            )?
        };
        let excerpts = self.related_excerpts_full_store_oracle(
            excerpts,
            &nodes,
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
                &nodes,
                &query_terms(query),
                &sources,
                budget,
            )?;
        } else {
            render_excerpts(&mut output, excerpts, &sources, budget, true);
        }
        Ok(finish(output, budget))
    }

    #[allow(clippy::too_many_arguments)] // Shares one refreshed source snapshot and selection state.
    fn related_excerpts_full_store_oracle(
        &self,
        seeds: Vec<Excerpt>,
        nodes: &[CodeNode],
        files: &BTreeSet<String>,
        terms: &[String],
        hashes: &HashMap<String, String>,
        sources: &mut HashMap<String, Source>,
        gaps: &mut Vec<String>,
    ) -> Result<Vec<Excerpt>> {
        let by_id: HashMap<_, _> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();
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
            let mut next = Vec::new();
            for id in frontier {
                if selected.len() >= 12 {
                    break;
                }
                let Some(owner) = by_id.get(id.as_str()) else {
                    continue;
                };
                let mut neighbors = Vec::new();
                for edge in self
                    .store
                    .get_out_edges(&id, Some(EdgeKind::Calls.as_str()))?
                {
                    let heuristic = edge
                        .metadata
                        .as_ref()
                        .and_then(|m| m.get("confidence"))
                        .is_some_and(|c| c == "heuristic");
                    if !heuristic {
                        if let Some(node) = by_id.get(edge.target.as_str()).filter(|n| {
                            matches!(
                                n.kind,
                                NodeKind::Function | NodeKind::Method | NodeKind::Class
                            )
                        }) {
                            neighbors.push((
                                false,
                                edge.line,
                                *node,
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
                        for node in nodes.iter().filter(|n| {
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
}
