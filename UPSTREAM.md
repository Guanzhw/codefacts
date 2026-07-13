# Upstream provenance

CodeFacts began as a subtractive fork of [`suatkocar/codegraph`](https://github.com/suatkocar/codegraph), pinned to commit `856739a1a528cfae9f9232566ae5c043ef8cfaf5` (retrieved 2026-07-14).

The upstream project is MIT-licensed. Its copyright notice remains in [`LICENSE`](LICENSE): `Copyright (c) 2026 Suat Kocar`.

## Retained and adapted

- Native Tree-sitter parsers and language query fixtures in `queries/`.
- Symbol and edge extractors, two-pass incremental indexing pipeline, and static import resolution.
- SQLite graph schema, FTS triggers, row conversion, and graph store.

The retained code has been renamed and modified for the CodeFacts data model, external state location, deterministic path normalization, stale-file pruning, Markdown heading facts, and the bounded five-tool MCP contract.

## Explicitly removed

- Vector search, embeddings, reranking, `sqlite-vec`, and model downloads.
- HTTP transport, asynchronous MCP framework, broad tool registry, tasks, and every MCP workflow outside `map`, `search`, `outline`, `expand`, and `path`.
- Hooks, watchers, installers, generated agent configuration, prompt/context injection, background services, Docker/npm/Homebrew distribution helpers.
- Security scans, Git analytics, evaluations, dashboards/visualization, workspaces, configuration product surface, and their associated tests.

Before publishing a release, run a dependency-license audit for the exact release lockfile and retain this attribution record.
