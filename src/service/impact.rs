//! Bounded static dependency impact with shortest source-backed witnesses.

use std::collections::{HashSet, VecDeque};

use serde_json::{json, Value};

use super::{bounded_limit, CodeFacts, SymbolResolution};
use crate::error::{CodeFactsError, Result};
use crate::graph::store::{detect_is_test_node, ImpactFileSnapshot};
use crate::types::{CodeEdge, CodeNode, EdgeKind, NodeKind};

const DEFAULT_DEPTH: usize = 3;
const MAX_DEPTH: usize = 10;
const EDGE_WORK_LIMIT: usize = 5_000;

#[derive(Debug)]
pub struct ImpactOptions<'a> {
    pub symbol: &'a str,
    pub file_path: Option<&'a str>,
    pub max_depth: Option<usize>,
    pub limit: Option<usize>,
}

#[derive(Clone)]
enum ImpactEndpoint {
    Symbol(CodeNode),
    File(ImpactFileSnapshot),
}

impl ImpactEndpoint {
    fn id(&self) -> &str {
        match self {
            Self::Symbol(node) => &node.id,
            Self::File(snapshot) => &snapshot.id,
        }
    }

    fn include_members(&self) -> bool {
        matches!(self, Self::Symbol(node) if matches!(node.kind,
            NodeKind::Class | NodeKind::Struct | NodeKind::Interface | NodeKind::Trait
                | NodeKind::Module | NodeKind::Namespace | NodeKind::Enum))
    }

    fn is_test(&self) -> bool {
        matches!(self, Self::Symbol(node) if detect_is_test_node(node))
    }
}

impl CodeFacts {
    /// Find reverse static dependencies and forward container members. Every
    /// transition costs one hop and carries a deterministic shortest witness
    /// with the relationship's original direction and extraction confidence.
    pub fn impact(&self, options: ImpactOptions<'_>) -> Result<Value> {
        let max_depth = options.max_depth.unwrap_or(DEFAULT_DEPTH);
        if !(1..=MAX_DEPTH).contains(&max_depth) {
            return Err(CodeFactsError::Other(
                "'max_depth' must be an integer from 1 to 10".into(),
            ));
        }
        let freshness = self.refresh()?;
        let limit = bounded_limit(options.limit);
        let definition = match self.resolve_symbol(options.symbol, options.file_path)? {
            SymbolResolution::One(node) => node,
            SymbolResolution::NotFound => {
                return Ok(json!({
                    "freshness": freshness,
                    "status": "not_found",
                    "symbol": options.symbol,
                    "message": "No indexed symbol matches this identifier.",
                }));
            }
            SymbolResolution::Ambiguous(matches) => {
                return Ok(json!({
                    "freshness": freshness,
                    "status": "ambiguous",
                    "symbol": options.symbol,
                    "matches": matches,
                    "message": "Use an exact symbol id or add file_path; CodeFacts does not guess.",
                }));
            }
        };

        let mut queue = VecDeque::from([(ImpactEndpoint::Symbol(definition.clone()), 0)]);
        let mut visited = HashSet::from([definition.id.clone()]);
        let mut affected = Vec::new();
        let mut tests = Vec::new();
        let mut edges_examined = 0;
        let mut depth_limit_reached = false;
        let mut node_limit_reached = false;
        let mut edge_limit_reached = false;

        'traversal: while let Some((current, distance)) = queue.pop_front() {
            let remaining = EDGE_WORK_LIMIT - edges_examined;
            let edges = self.store.get_confirmed_impact_edges(
                current.id(),
                current.include_members(),
                remaining + 1,
            )?;
            let has_more_edges = edges.len() > remaining;
            for edge in edges.into_iter().take(remaining) {
                edges_examined += 1;
                let forward = edge.kind == EdgeKind::Contains;
                let next_id = if forward { &edge.target } else { &edge.source };
                if visited.contains(next_id) {
                    continue;
                }
                // Inspect the depth frontier too: reaching max_depth alone
                // does not prove that a deeper caller was omitted.
                if distance == max_depth {
                    depth_limit_reached = true;
                    continue;
                }
                // Filling the last output slot alone is not truncation. Only
                // an additional distinct reachable symbol proves a cutoff.
                if affected.len() == limit {
                    node_limit_reached = true;
                    break 'traversal;
                }
                let reached = self.impact_endpoint(next_id, edge.kind == EdgeKind::Imports)?;
                let (from, to) = if forward {
                    (&current, &reached)
                } else {
                    (&reached, &current)
                };
                let entry = json!({
                    "symbol": self.impact_endpoint_fact(&reached)?,
                    "distance": distance + 1,
                    "witness": self.impact_relationship_fact(&edge, from, to)?,
                    "witness_direction": if forward { "forward" } else { "reverse" },
                });
                if reached.is_test() {
                    tests.push(entry.clone());
                }
                affected.push(entry);
                visited.insert(reached.id().to_string());
                queue.push_back((reached, distance + 1));
            }
            if has_more_edges {
                edge_limit_reached = true;
                break;
            }
        }

        let exhausted = !depth_limit_reached && !node_limit_reached && !edge_limit_reached;
        Ok(json!({
            "freshness": freshness,
            "status": "ok",
            "definition": self.symbol_fact(&definition)?,
            "relationship_kinds": ["calls", "references", "extends", "implements", "imports", "contains"],
            "scope": {
                "reverse_dependencies": ["calls", "references", "extends", "implements", "imports"],
                "forward_container_members": "contains",
                "hop_cost": 1,
                "import_file_anchors": "indexed file snapshots; no inferred file-to-symbol membership",
            },
            "affected": affected,
            "tests": tests,
            "max_depth": max_depth,
            "bounded_by": limit,
            "truncated": !exhausted,
            "traversal": {
                "exhausted": exhausted,
                "depth_limit_reached": depth_limit_reached,
                "node_limit_reached": node_limit_reached,
                "edge_limit_reached": edge_limit_reached,
                "edges_examined": edges_examined,
                "edge_work_limit": EDGE_WORK_LIMIT,
            },
            "message": "Impact follows stored confirmed static dependencies in reverse and container membership forward, counting every transition as one hop. Imports can reach indexed file snapshots; file anchors continue over stored Imports edges and file-to-symbol membership is not inferred. Heuristic and unresolved bindings are excluded; extraction gaps and runtime dispatch can omit dependencies. Tests are reachable test-associated symbols, not a runnable-test list.",
        }))
    }

    fn impact_endpoint(&self, id: &str, import_endpoint: bool) -> Result<ImpactEndpoint> {
        if let Some(node) = self.store.get_node(id)? {
            return Ok(ImpactEndpoint::Symbol(node));
        }
        if import_endpoint {
            if let Some(snapshot) = self.store.get_impact_file_snapshot(id)? {
                return Ok(ImpactEndpoint::File(snapshot));
            }
        }
        Err(CodeFactsError::Other(format!(
            "impact endpoint is missing: {id}"
        )))
    }

    fn impact_endpoint_fact(&self, endpoint: &ImpactEndpoint) -> Result<Value> {
        match endpoint {
            ImpactEndpoint::Symbol(node) => Ok(serde_json::to_value(self.symbol_fact(node)?)?),
            ImpactEndpoint::File(snapshot) => Ok(json!({
                "id": snapshot.id, "name": snapshot.file_path, "qualified_name": null,
                "kind": "file", "language": snapshot.language,
                "evidence": {
                    "file_path": snapshot.file_path, "source_hash": snapshot.source_hash,
                    "extractor": "index-file-snapshot", "confidence": "confirmed",
                },
            })),
        }
    }

    fn impact_relationship_fact(
        &self,
        edge: &CodeEdge,
        from: &ImpactEndpoint,
        to: &ImpactEndpoint,
    ) -> Result<Value> {
        if matches!(
            (from, to),
            (ImpactEndpoint::Symbol(_), ImpactEndpoint::Symbol(_))
        ) {
            return Ok(serde_json::to_value(self.relationship_fact(edge)?)?);
        }
        let mut relationship = json!({
            "kind": edge.kind.as_str(), "from": self.impact_endpoint_fact(from)?,
            "to": self.impact_endpoint_fact(to)?, "evidence": self.edge_evidence(edge)?,
        });
        if let Some(resolution) = edge
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("resolution"))
        {
            relationship["resolution"] = json!(resolution);
        }
        Ok(relationship)
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, fs};

    use sha2::{Digest, Sha256};
    use tempfile::{tempdir, TempDir};

    use super::*;
    use crate::lsp::LspMode;
    use crate::types::{CodeEdge, CodeNode, Language};

    struct Fixture {
        repository: TempDir,
        _state: TempDir,
        facts: CodeFacts,
    }

    impl Fixture {
        fn new(files: &[(&str, &str)]) -> Self {
            let repository = tempdir().unwrap();
            let state = tempdir().unwrap();
            for (path, source) in files {
                fs::write(repository.path().join(path), source).unwrap();
            }
            let facts = CodeFacts::open_with_lsp(
                repository.path(),
                state.path().join("facts.sqlite"),
                LspMode::Off,
            )
            .unwrap();
            facts.refresh().unwrap();
            Self {
                repository,
                _state: state,
                facts,
            }
        }

        fn impact(&self, symbol: &str, depth: usize, limit: usize) -> Value {
            self.facts
                .impact(ImpactOptions {
                    symbol,
                    file_path: None,
                    max_depth: Some(depth),
                    limit: Some(limit),
                })
                .unwrap()
        }
    }

    fn names(result: &Value) -> Vec<&str> {
        result["affected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["symbol"]["name"].as_str().unwrap())
            .collect()
    }

    fn synthetic() -> Fixture {
        Fixture::new(&[
            ("fixture.go", "package fixture\n"),
            ("fixture_test.go", "package fixture\n"),
        ])
    }

    fn node(id: &str, kind: NodeKind, file: &str) -> CodeNode {
        CodeNode {
            id: id.into(),
            name: id.into(),
            qualified_name: None,
            kind,
            file_path: file.into(),
            start_line: 1,
            end_line: 1,
            start_column: 0,
            end_column: 1,
            language: Language::Go,
            body: None,
            documentation: None,
            exported: None,
            is_local: false,
        }
    }

    fn edge(source: &str, target: &str, kind: EdgeKind, line: u32) -> CodeEdge {
        CodeEdge {
            source: source.into(),
            target: target.into(),
            kind,
            file_path: "fixture.go".into(),
            line,
            target_name: None,
            metadata: None,
        }
    }

    fn seed(fixture: &Fixture, ids: &[&str], edges: &[CodeEdge]) {
        let nodes = ids
            .iter()
            .map(|id| node(id, NodeKind::Function, "fixture.go"))
            .collect::<Vec<_>>();
        fixture.facts.store.upsert_nodes(&nodes).unwrap();
        fixture.facts.store.upsert_edges(edges).unwrap();
    }

    #[test]
    fn impact_go_chain_branch_cycle_repeat_and_test_evidence() {
        let source = "package fixture\nfunc leaf() {}\nfunc middle() {\n leaf()\n leaf()\n}\nfunc branch() { leaf() }\nfunc entry() { middle(); branch() }\nfunc cycleA() { leaf(); cycleB() }\nfunc cycleB() { cycleA() }\nfunc disconnected() {}\n";
        let fixture = Fixture::new(&[
            ("fixture.go", source),
            (
                "fixture_test.go",
                "package fixture\nfunc helper() { entry() }\n",
            ),
        ]);
        let result = fixture.impact("leaf", 10, 50);
        let reached = names(&result);
        assert_eq!(reached.len(), 6);
        for name in ["middle", "branch", "entry", "cycleA", "cycleB", "helper"] {
            assert!(reached.contains(&name), "missing {name}: {result}");
        }
        assert!(!reached.contains(&"leaf"));
        assert!(!reached.contains(&"disconnected"));
        let middle = result["affected"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["symbol"]["name"] == "middle")
            .unwrap();
        assert_eq!(middle["distance"], 1);
        assert_eq!(middle["witness"]["from"]["name"], "middle");
        assert_eq!(middle["witness"]["to"]["name"], "leaf");
        assert_eq!(middle["witness_direction"], "reverse");
        assert_eq!(middle["witness"]["evidence"]["start_line"], 4);
        assert_eq!(
            middle["witness"]["evidence"]["source_hash"],
            hex::encode(Sha256::digest(source))
        );
        assert_eq!(result["tests"][0]["symbol"]["name"], "helper");
        assert_eq!(result["tests"][0]["distance"], 3);
        assert_eq!(result["traversal"]["exhausted"], true);
        assert_eq!(result["truncated"], false);
        assert_eq!(
            result["affected"],
            fixture.impact("leaf", 10, 50)["affected"]
        );
    }

    #[test]
    fn impact_resolves_same_method_names_by_file_and_exact_id() {
        let fixture = Fixture::new(&[
            (
                "left.go",
                "package fixture\ntype Left struct{}\nfunc (l Left) Run() {}\ntype Other struct{}\nfunc (o Other) Run() {}\n",
            ),
            (
                "right.go",
                "package fixture\ntype Right struct{}\nfunc (r Right) Run() {}\n",
            ),
        ]);
        let ambiguous = fixture.impact("Run", 3, 20);
        assert_eq!(ambiguous["status"], "ambiguous");
        assert_eq!(ambiguous["matches"].as_array().unwrap().len(), 3);
        let id = ambiguous["matches"][0]["id"].as_str().unwrap();
        let exact = fixture.impact(id, 3, 20);
        assert_eq!(exact["definition"]["id"], id);
        let by_file = fixture
            .facts
            .impact(ImpactOptions {
                symbol: "Run",
                file_path: Some("right.go"),
                max_depth: None,
                limit: None,
            })
            .unwrap();
        assert_eq!(by_file["definition"]["evidence"]["file_path"], "right.go");
        let same_file = fixture
            .facts
            .impact(ImpactOptions {
                symbol: "Run",
                file_path: Some("left.go"),
                max_depth: None,
                limit: None,
            })
            .unwrap();
        assert_eq!(same_file["status"], "ambiguous");
        assert_eq!(same_file["matches"].as_array().unwrap().len(), 2);
        assert_eq!(fixture.impact("missing", 3, 20)["status"], "not_found");
    }

    #[test]
    fn impact_includes_dependency_kinds_and_preserves_confidence() {
        let fixture = synthetic();
        let mut semantic = edge("ref", "seed", EdgeKind::References, 1);
        semantic.metadata = Some(HashMap::from([
            ("confidence".into(), "semantic".into()),
            ("extractor".into(), "lsp:fixture".into()),
        ]));
        seed(
            &fixture,
            &["seed", "ref", "extends", "implements", "imports", "calls"],
            &[
                semantic,
                edge("extends", "seed", EdgeKind::Extends, 1),
                edge("implements", "seed", EdgeKind::Implements, 1),
                edge("imports", "seed", EdgeKind::Imports, 1),
                edge("calls", "seed", EdgeKind::Calls, 1),
            ],
        );
        let result = fixture.impact("seed", 3, 20);
        assert_eq!(
            names(&result),
            vec!["calls", "extends", "implements", "imports", "ref"]
        );
        let reference = result["affected"].as_array().unwrap().last().unwrap();
        assert_eq!(reference["witness"]["kind"], "references");
        assert_eq!(reference["witness"]["evidence"]["confidence"], "semantic");
        assert_eq!(reference["witness"]["evidence"]["extractor"], "lsp:fixture");
        assert_eq!(result["traversal"]["exhausted"], true);
    }

    #[test]
    fn impact_typescript_inheritance_and_implementation_are_source_backed() {
        let source = "interface Contract { run(): void; }\nclass Base { work() {} }\nclass Derived extends Base implements Contract { run() {} }\nfunction consume(value: Contract) {}\n";
        let fixture = Fixture::new(&[("fixture.ts", source)]);
        let base = fixture.impact("Base", 3, 20);
        let derived = base["affected"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["symbol"]["name"] == "Derived")
            .unwrap();
        assert_eq!(derived["witness"]["kind"], "extends");
        assert_eq!(derived["witness"]["from"]["name"], "Derived");
        assert_eq!(derived["witness"]["to"]["name"], "Base");
        assert_eq!(derived["witness"]["evidence"]["start_line"], 3);
        assert_eq!(
            derived["witness"]["evidence"]["source_hash"],
            hex::encode(Sha256::digest(source))
        );
        let contract = fixture.impact("Contract", 3, 20);
        let implementor = contract["affected"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["symbol"]["name"] == "Derived")
            .unwrap();
        assert_eq!(implementor["witness"]["kind"], "implements");
        assert_eq!(implementor["witness"]["to"]["name"], "Contract");
        assert_eq!(implementor["witness_direction"], "reverse");
        assert!(names(&contract).contains(&"run"));
        let reference = contract["affected"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["symbol"]["name"] == "consume")
            .unwrap();
        assert_eq!(reference["witness"]["kind"], "references");
        assert_eq!(reference["witness"]["evidence"]["start_line"], 4);
    }

    #[test]
    fn impact_diamond_chooses_a_shortest_canonical_witness() {
        let fixture = synthetic();
        seed(
            &fixture,
            &["seed", "a", "b", "outer"],
            &[
                edge("b", "seed", EdgeKind::Calls, 3),
                edge("a", "seed", EdgeKind::Calls, 9),
                edge("a", "seed", EdgeKind::Calls, 2),
                edge("outer", "b", EdgeKind::Calls, 1),
                edge("outer", "a", EdgeKind::Calls, 8),
            ],
        );
        let result = fixture.impact("seed", 3, 20);
        assert_eq!(names(&result), vec!["a", "b", "outer"]);
        assert_eq!(
            result["affected"][0]["witness"]["evidence"]["start_line"],
            2
        );
        assert_eq!(result["affected"][2]["distance"], 2);
        assert_eq!(result["affected"][2]["witness"]["to"]["id"], "a");
    }

    #[test]
    fn impact_named_import_returns_private_current_file_snapshot() {
        let before = "import { leaf } from './a';\nexport function other() {}\n";
        let fixture = Fixture::new(&[
            ("a.ts", "export function leaf() {}\n"),
            ("b.ts", before),
            (
                "c.ts",
                "import { other } from './b';\nexport function outer() {}\n",
            ),
        ]);
        let indexed_stats = fixture.facts.store.get_stats().unwrap();
        let first = fixture.impact("leaf", 3, 20);
        assert_eq!(names(&first), vec!["b.ts"]);
        let reached = &first["affected"][0];
        assert_eq!(reached["symbol"]["id"], "file:b.ts");
        assert_eq!(reached["symbol"]["kind"], "file");
        assert_eq!(reached["symbol"]["language"], "typescript");
        assert_eq!(
            reached["symbol"]["evidence"]["extractor"],
            "index-file-snapshot"
        );
        assert!(reached["symbol"]["evidence"].get("start_line").is_none());
        assert!(reached["symbol"]["evidence"].get("end_line").is_none());
        assert_eq!(
            reached["symbol"]["evidence"]["source_hash"],
            hex::encode(Sha256::digest(before))
        );
        assert_eq!(reached["witness_direction"], "reverse");
        assert_eq!(reached["witness"]["kind"], "imports");
        assert_eq!(reached["witness"]["from"], reached["symbol"]);
        assert_eq!(reached["witness"]["to"]["name"], "leaf");
        assert_eq!(reached["witness"]["evidence"]["start_line"], 1);
        assert_eq!(
            reached["witness"]["evidence"]["source_hash"],
            hex::encode(Sha256::digest(before))
        );
        assert!(fixture.facts.store.get_node("file:b.ts").unwrap().is_none());
        assert!(fixture
            .facts
            .store
            .get_nodes_by_name("b.ts")
            .unwrap()
            .is_empty());
        assert_eq!(fixture.facts.store.get_stats().unwrap(), indexed_stats);
        assert!(first["tests"].as_array().unwrap().is_empty());
        let unchanged = fixture.impact("leaf", 3, 20);
        assert_eq!(first["affected"], unchanged["affected"]);
        assert_eq!(
            first["freshness"]["generation"],
            unchanged["freshness"]["generation"]
        );
        // c.ts imports a symbol in b.ts, not b.ts itself. No unstored
        // membership transition is invented from the reached file anchor.
        assert_eq!(first["traversal"]["exhausted"], true);
        let after = before.replace("other", "after");
        assert_eq!(before.len(), after.len());
        let path = fixture.repository.path().join("b.ts");
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, &after).unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        let refreshed = fixture.impact("leaf", 3, 20);
        assert_eq!(names(&refreshed), vec!["b.ts"]);
        assert_ne!(
            first["freshness"]["generation"],
            refreshed["freshness"]["generation"]
        );
        assert_eq!(
            refreshed["affected"][0]["symbol"]["evidence"]["source_hash"],
            hex::encode(Sha256::digest(&after))
        );
    }

    #[test]
    fn impact_stored_file_import_chain_preserves_snapshot_endpoints() {
        let fixture = Fixture::new(&[
            ("a.ts", "export function seed() {}\n"),
            ("b.ts", "export const value = 1;\n"),
            ("c_test.ts", "export const other = 2;\n"),
        ]);
        let seed_node = fixture
            .facts
            .store
            .get_nodes_by_name("seed")
            .unwrap()
            .remove(0);
        fixture
            .facts
            .store
            .upsert_edges(&[
                CodeEdge {
                    file_path: "b.ts".into(),
                    ..edge("file:b.ts", &seed_node.id, EdgeKind::Imports, 1)
                },
                CodeEdge {
                    file_path: "c_test.ts".into(),
                    ..edge("file:c_test.ts", "file:b.ts", EdgeKind::Imports, 1)
                },
            ])
            .unwrap();
        let result = fixture.impact("seed", 3, 20);
        assert_eq!(names(&result), vec!["b.ts", "c_test.ts"]);
        assert_eq!(result["affected"][1]["distance"], 2);
        assert_eq!(
            result["affected"][1]["witness"]["from"]["id"],
            "file:c_test.ts"
        );
        assert_eq!(result["affected"][1]["witness"]["to"]["id"], "file:b.ts");
        assert_eq!(
            result["affected"][1]["witness"]["to"]["evidence"]["source_hash"],
            hex::encode(Sha256::digest("export const value = 1;\n"))
        );
        assert!(result["tests"].as_array().unwrap().is_empty());
        assert_eq!(result["traversal"]["exhausted"], true);
        let cutoff = fixture.impact("seed", 1, 20);
        assert_eq!(names(&cutoff), vec!["b.ts"]);
        assert_eq!(cutoff["traversal"]["depth_limit_reached"], true);
    }

    #[test]
    fn impact_file_anchors_require_real_snapshot_and_import_relationship() {
        let fixture = synthetic();
        let mut heuristic = edge("file:fixture_test.go", "seed", EdgeKind::Imports, 1);
        heuristic.metadata = Some(HashMap::from([("confidence".into(), "heuristic".into())]));
        seed(
            &fixture,
            &["seed"],
            &[
                heuristic,
                edge("file:missing.go", "seed", EdgeKind::Imports, 1),
                edge("fake:fixture.go", "seed", EdgeKind::Imports, 1),
                edge("file:fixture.go", "seed", EdgeKind::Calls, 1),
                edge("file:fixture.go", "file:missing.go", EdgeKind::Imports, 1),
            ],
        );
        let result = fixture.impact("seed", 3, 20);
        assert!(names(&result).is_empty());
        assert_eq!(result["traversal"]["edges_examined"], 0);
        assert!(fixture
            .facts
            .store
            .get_confirmed_impact_edges("file:missing.go", false, 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn impact_container_members_cost_one_hop_with_forward_witness() {
        for kind in [
            NodeKind::Class,
            NodeKind::Struct,
            NodeKind::Interface,
            NodeKind::Trait,
            NodeKind::Module,
            NodeKind::Namespace,
            NodeKind::Enum,
        ] {
            let fixture = synthetic();
            seed(
                &fixture,
                &["member", "caller", "unrelated"],
                &[
                    edge("container", "member", EdgeKind::Contains, 1),
                    edge("caller", "member", EdgeKind::Calls, 2),
                ],
            );
            fixture
                .facts
                .store
                .upsert_node(&node("container", kind, "fixture.go"))
                .unwrap();
            let result = fixture.impact("container", 2, 20);
            assert_eq!(names(&result), vec!["member", "caller"]);
            assert_eq!(result["affected"][0]["distance"], 1);
            assert_eq!(result["affected"][0]["witness_direction"], "forward");
            assert_eq!(result["affected"][0]["witness"]["from"]["id"], "container");
            assert_eq!(result["affected"][0]["witness"]["to"]["id"], "member");
            assert_eq!(result["affected"][1]["distance"], 2);
            assert_eq!(result["affected"][1]["witness_direction"], "reverse");
            assert_eq!(result["traversal"]["exhausted"], true);
        }
    }

    #[test]
    fn impact_excludes_heuristics_missing_endpoints_and_noncontainer_contains() {
        let fixture = synthetic();
        let mut heuristic = edge("guess", "seed", EdgeKind::Calls, 1);
        heuristic.metadata = Some(HashMap::from([("confidence".into(), "heuristic".into())]));
        seed(
            &fixture,
            &["seed", "guess", "contained", "confirmed"],
            &[
                heuristic,
                edge("missing", "seed", EdgeKind::Calls, 1),
                edge("confirmed", "missing-target", EdgeKind::Calls, 1),
                edge("seed", "contained", EdgeKind::Contains, 1),
            ],
        );
        let result = fixture.impact("seed", 3, 20);
        assert!(names(&result).is_empty());
        assert_eq!(result["traversal"]["exhausted"], true);
        assert_eq!(result["traversal"]["edges_examined"], 0);
    }

    #[test]
    fn impact_depth_cutoff_requires_an_actual_unvisited_dependency() {
        let fixture = synthetic();
        seed(
            &fixture,
            &["seed", "a", "b"],
            &[
                edge("a", "seed", EdgeKind::Calls, 1),
                edge("b", "a", EdgeKind::Calls, 2),
            ],
        );
        let cutoff = fixture.impact("seed", 1, 20);
        assert_eq!(names(&cutoff), vec!["a"]);
        assert_eq!(cutoff["traversal"]["depth_limit_reached"], true);
        assert_eq!(cutoff["traversal"]["exhausted"], false);
        let exhausted = fixture.impact("seed", 2, 20);
        assert_eq!(exhausted["traversal"]["depth_limit_reached"], false);
        assert_eq!(exhausted["traversal"]["exhausted"], true);
        fixture
            .facts
            .store
            .upsert_edge(&edge("seed", "b", EdgeKind::Calls, 3))
            .unwrap();
        assert_eq!(
            fixture.impact("seed", 2, 20)["traversal"]["exhausted"],
            true
        );
    }

    #[test]
    fn impact_node_cutoff_requires_an_additional_distinct_symbol() {
        let fixture = synthetic();
        seed(
            &fixture,
            &["seed", "a", "b"],
            &[
                edge("a", "seed", EdgeKind::Calls, 1),
                edge("a", "seed", EdgeKind::Calls, 2),
            ],
        );
        let exact = fixture.impact("seed", 3, 1);
        assert_eq!(names(&exact), vec!["a"]);
        assert_eq!(exact["traversal"]["exhausted"], true);
        fixture
            .facts
            .store
            .upsert_edge(&edge("b", "seed", EdgeKind::Calls, 3))
            .unwrap();
        let cutoff = fixture.impact("seed", 3, 1);
        assert_eq!(names(&cutoff), vec!["a"]);
        assert_eq!(cutoff["traversal"]["node_limit_reached"], true);
        assert_eq!(cutoff["traversal"]["edges_examined"], 3);
        assert_eq!(cutoff["truncated"], true);
    }

    #[test]
    fn impact_edge_work_limit_bounds_repeated_occurrences_and_exact_exhaustion() {
        let fixture = synthetic();
        let edges = (1..=EDGE_WORK_LIMIT as u32)
            .map(|line| edge("a", "seed", EdgeKind::Calls, line))
            .collect::<Vec<_>>();
        seed(&fixture, &["seed", "a", "b"], &edges);
        let exact = fixture.impact("seed", 3, 20);
        assert_eq!(exact["traversal"]["edges_examined"], EDGE_WORK_LIMIT);
        assert_eq!(exact["traversal"]["exhausted"], true);
        fixture
            .facts
            .store
            .upsert_edge(&edge("b", "seed", EdgeKind::Calls, 1))
            .unwrap();
        assert_eq!(
            fixture
                .facts
                .store
                .get_confirmed_impact_edges("seed", false, 11)
                .unwrap()
                .len(),
            11
        );
        let cutoff = fixture.impact("seed", 3, 20);
        assert_eq!(names(&cutoff), vec!["a"]);
        assert_eq!(cutoff["traversal"]["edges_examined"], EDGE_WORK_LIMIT);
        assert_eq!(cutoff["traversal"]["edge_limit_reached"], true);
        assert_eq!(cutoff["traversal"]["exhausted"], false);
        assert_eq!(cutoff["traversal"]["node_limit_reached"], false);
    }

    #[test]
    fn impact_high_fanout_clamps_and_reports_output_limit() {
        let fixture = synthetic();
        let nodes = (0..100)
            .map(|i| node(&format!("caller{i:03}"), NodeKind::Function, "fixture.go"))
            .collect::<Vec<_>>();
        let edges = nodes
            .iter()
            .map(|node| edge(&node.id, "seed", EdgeKind::Calls, 1))
            .collect::<Vec<_>>();
        seed(&fixture, &["seed"], &[]);
        fixture.facts.store.upsert_nodes(&nodes).unwrap();
        fixture.facts.store.upsert_edges(&edges).unwrap();
        let result = fixture.impact("seed", 10, usize::MAX);
        assert_eq!(names(&result).len(), 50);
        assert_eq!(result["max_depth"], 10);
        assert_eq!(result["bounded_by"], 50);
        assert_eq!(result["traversal"]["node_limit_reached"], true);
        assert_eq!(result["traversal"]["edges_examined"], 51);
        let minimum = fixture.impact("seed", 1, 0);
        assert_eq!(minimum["max_depth"], 1);
        assert_eq!(minimum["bounded_by"], 1);
    }

    #[test]
    fn impact_rejects_invalid_depth_before_indexing_or_refresh() {
        let repository = tempdir().unwrap();
        let state = tempdir().unwrap();
        fs::write(
            repository.path().join("fixture.go"),
            "package fixture\nfunc seed() {}\n",
        )
        .unwrap();
        let facts = CodeFacts::open_with_lsp(
            repository.path(),
            state.path().join("facts.sqlite"),
            LspMode::Off,
        )
        .unwrap();
        let unopened_generation = facts.store.generation().unwrap();
        for depth in [0, 11] {
            let error = facts
                .impact(ImpactOptions {
                    symbol: "seed",
                    file_path: None,
                    max_depth: Some(depth),
                    limit: None,
                })
                .unwrap_err();
            assert_eq!(
                error.to_string(),
                "'max_depth' must be an integer from 1 to 10"
            );
            assert!(facts.store.get_file_hashes().unwrap().is_empty());
            assert!(facts.store.get_nodes_by_name("seed").unwrap().is_empty());
            assert_eq!(facts.store.generation().unwrap(), unopened_generation);
        }
        let first = facts
            .impact(ImpactOptions {
                symbol: "seed",
                file_path: None,
                max_depth: None,
                limit: None,
            })
            .unwrap();
        let original_hash = facts.store.get_file_hash("fixture.go").unwrap();
        fs::write(
            repository.path().join("fixture.go"),
            "package fixture\nfunc seed() {}\nfunc added() {}\n",
        )
        .unwrap();
        let error = facts
            .impact(ImpactOptions {
                symbol: "seed",
                file_path: None,
                max_depth: Some(11),
                limit: None,
            })
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "'max_depth' must be an integer from 1 to 10"
        );
        assert_eq!(
            facts.store.get_file_hash("fixture.go").unwrap(),
            original_hash
        );
        assert!(facts.store.get_nodes_by_name("added").unwrap().is_empty());
        assert_eq!(
            facts.store.generation().unwrap(),
            first["freshness"]["generation"].as_i64().unwrap()
        );
        let refreshed = facts
            .impact(ImpactOptions {
                symbol: "seed",
                file_path: None,
                max_depth: Some(1),
                limit: None,
            })
            .unwrap();
        assert!(
            refreshed["freshness"]["generation"].as_i64().unwrap()
                > first["freshness"]["generation"].as_i64().unwrap()
        );
    }

    #[test]
    fn impact_refreshes_changed_source_hash_and_reachable_symbols() {
        let before = "package fixture\nfunc leaf() {}\nfunc from() { leaf() }\n";
        let after = "package fixture\nfunc leaf() {}\nfunc from() { nope() }\n";
        assert_eq!(before.len(), after.len());
        let fixture = Fixture::new(&[("fixture.go", before)]);
        let first = fixture.impact("leaf", 3, 20);
        let unchanged = fixture.impact("leaf", 3, 20);
        assert_eq!(
            first["freshness"]["generation"],
            unchanged["freshness"]["generation"]
        );
        let path = fixture.repository.path().join("fixture.go");
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, after).unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        let second = fixture.impact("leaf", 3, 20);
        assert_eq!(names(&first), vec!["from"]);
        assert!(names(&second).is_empty());
        assert_ne!(
            first["freshness"]["generation"],
            second["freshness"]["generation"]
        );
        assert_eq!(
            second["definition"]["evidence"]["source_hash"],
            hex::encode(Sha256::digest(after))
        );
    }
}
