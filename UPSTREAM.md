# Upstream provenance

CodeFacts began as a subtractive fork of [`suatkocar/codegraph`](https://github.com/suatkocar/codegraph), pinned to commit `856739a1a528cfae9f9232566ae5c043ef8cfaf5` (retrieved 2026-07-14).

The upstream project is MIT-licensed. Its copyright notice remains in [`LICENSE`](LICENSE): `Copyright (c) 2026 Suat Kocar`.

## Retained and adapted

- Native Tree-sitter parsers and language query fixtures in `queries/`.
- Symbol and edge extractors, two-pass incremental indexing pipeline, static import resolution, and the starting point for the fixed-fixture indexing benchmark (`benches/indexing_bench.rs`).
- SQLite graph schema, FTS triggers, row conversion, and graph store.

The retained code has been renamed and modified for the CodeFacts data model, external state location, deterministic path normalization, stale-file pruning, Markdown heading facts, heuristic endpoint facts, and the initial bounded five-tool MCP contract. The current navigation release adds exploration and static impact.

The experimental `explore` entry point (`src/service/explore.rs`) and its derived
source-chunk FTS index (`src/graph/retrieval.rs`) began as original CodeFacts code.
The 2026-10-11 comparison of other navigation tools informed the product decision.

## Official CodeGraph 1.6.2 adaptation

The query-mode node hydration in `src/service/explore.rs` and batched node store
lookups in `src/graph/store.rs` adapt the bounded SQL-batch mechanism in
[`colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph), pinned to
commit `6560052a6f856855d3f71eee838fd66ccfa4285d` (version 1.6.2, checked
2026-10-14). The implementation reference is `QueryBuilder.getNodesByIds` in
`src/db/queries.ts`, shipped as `lib/dist/db/queries.js:706`, and its traversal
consumer in `src/graph/traversal.ts`, shipped as `lib/dist/graph/traversal.js:85`.
CodeFacts uses SQL batches of at most 500 parameters and request-local lookup
state while preserving its existing source ownership, ranking and fact fields.

The pinned upstream [MIT license](https://github.com/colbymchenry/codegraph/blob/6560052a6f856855d3f71eee838fd66ccfa4285d/LICENSE)
records `Copyright (c) 2026 Colby Mchenry`; that notice is retained in `LICENSE`.

The native static impact implementation is original CodeFacts code. The same
pinned upstream's `src/graph/traversal.ts` (`lib/dist/graph/traversal.js:437-508`)
informs mixed reverse dependency traversal and container-member expansion.
CodeFacts records each transition as one graph hop, includes only confirmed
stored endpoints and file snapshots, and explicitly bounds output and edge work.

## Explicitly removed

- Vector search, embeddings, reranking, `sqlite-vec`, and model downloads.
- HTTP transport, asynchronous MCP framework, broad tool registry, tasks, and workflows outside repository navigation and static impact.
- Hooks, watchers, installers, generated agent configuration, prompt/context injection, background services, Docker/npm/Homebrew distribution helpers.
- Security scans, Git analytics, evaluations, dashboards/visualization, workspaces, configuration product surface, and their associated tests.

Before publishing a release, run a dependency-license audit for the exact release lockfile and retain this attribution record. The tagged release workflow runs `cargo deny check licenses` against `deny.toml`; local release preparation must run the same check.
