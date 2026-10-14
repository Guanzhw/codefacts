# CodeGraph feature delivery

This phase delivers usable source-backed exploration and static change-impact
workflows in the published native CodeFacts runtime. The user explicitly
requested CodeGraph-like commands; the initial five-workflow release scope now
expands to seven MCP workflows and direct CLI entry points.

## Required behavior

1. Preserve `map`, `search`, `outline`, `expand`, and `path`, including cursor,
   freshness, bounded output, source hashes, and Markdown heading discovery.
2. Deliver `explore`: repository orientation, lexical task-to-source discovery,
   direct static call neighborhoods, and explicit exact source-range reads.
   Reuse the preserved C09 implementation and its verified batched hydration.
   State lexical matching and static uncertainty; return current source hashes.
3. Deliver `impact`: resolve one confirmed symbol by ID/name and optional file,
   then traverse incoming static dependency edges by shortest graph distance,
   including calls, references, inheritance, interface implementation and
   confirmed imports. Expand stored container/member relationships. Return
   affected symbols, source-backed witness edges, and reachable test-associated
   symbols. Identify ambiguity, unresolved/heuristic limits, depth, node/output
   and traversal limits explicitly. A result never claims complete runtime impact.
4. Deliver direct CLI commands `node`, `callers`, `callees`, `explore`, and
   `impact`, plus the existing overview/search/outline/path workflows. CLI
   operations use the same service behavior as MCP, default to readable text,
   and offer JSON for consumers. An explicit root selects the project; direct
   CLI use may default to the current directory. MCP root selection is unchanged.
5. Keep a single native binary, external index state, offline static operation,
   and source-backed confidence. Same-name symbols remain distinct and require
   disambiguation when an exact single-symbol command cannot choose uniquely.

## Correctness acceptance

- Exact definitions/line ranges and witness edges for Go and mixed-code fixtures.
- Reverse dependency chains, container/member paths, branching, cycles, repeated calls, disconnected nodes,
  ambiguous names, file/ID selection, heuristic/missing endpoints, test-associated
  symbols, depth and high-fanout truncation are covered by meaningful fixtures.
- MCP legacy and modern protocols exercise the advertised seven tools. CLI
  executes real queries, errors, ambiguity and text/JSON output. A source edit,
  including same-size/same-mtime replacement, changes facts and invalidates old
  cursors; no-change calls preserve generation.
- Exploration range bytes, source hashes, budgets and existing hydration parity
  remain valid. Report static extraction gaps rather than inventing Go semantics.

## Performance acceptance

Before measuring the final candidate, pin binaries, corpus commits/manifests,
query workloads and runs. Compare published v0.1.17, the final feature candidate
and pinned official CodeGraph 1.6.2. Record differences in indexed scope and
freshness semantics. Use isolated external state and preserved corpus copies.

- Real small, medium and Go-heavy/dependency repositories: cold index wall/
  pipeline time, disk bytes, sampled peak memory, no-change and one-file refresh,
  and warm MCP query P50/P95. Exclude ignored dependency trees by default.
- At least three cold repetitions, 20 warm samples per applicable query case,
  and 30 paired edit/restore samples for the final medium and Go-heavy gates.
- Existing common warm-query and changed-file wall P95 may increase at most
  10% against v0.1.17. Report failed conditions and fix owning causes before
  rerunning changed candidates; preserve each attempted campaign.
- New explore/impact queries must finish with bounded output and truthful
  completeness on the large Go corpus; warm P95 target is <=1 second on this
  machine. Performance comparisons retain actual tool/freshness differences.
- Native correctness and useful workflows justify delivery. Previous agent
  token/quality experiments remain recorded; this phase makes no general agent
  productivity or token-saving claim without new matched evidence.

## Release acceptance

Independent design and implementation review; root diff inspection; full source,
format/lint, dependency-license and launcher checks; platform CI/native protocol
checks; versioned release, five binary assets, six npm packages, plugin update,
fresh installed MCP/CLI execution and source/hash verification. Report each
deliverable against current evidence. Keep missing work visible until delivered.
