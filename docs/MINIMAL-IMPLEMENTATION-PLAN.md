# Minimal implementation plan

## Goal

Improve the usefulness and honesty of the existing five read-only MCP tools
without adding a new tool, a daemon, a repository configuration file, or a new
analysis subsystem.  A user-installed language server may be consumed as an
optional semantic extractor; CodeFacts neither installs nor configures it.

The plan is deliberately limited to four additive API changes:

1. Detect a usable, separately installed LSP and surface its availability in
   `map`; use it opportunistically for semantic references in `expand`.
2. Make known unresolved references visible from `map`.
3. Let `path` disambiguate its two endpoints by file path.
4. Let `search` and `outline` narrow or continue bounded result sets.

All existing calls and result fields remain valid.  The changes are additive;
clients that do not opt in receive the current behaviour plus any additive
result fields.

## Explicit non-goals

- No natural-language repository question answering, embeddings, reranking, or
  automatic context injection.
- No editing, Git analysis, HTTP service, watcher, dashboard, or agent memory.
- No LSP installation, bundled language server, automatic project
  configuration, editor/session attachment, background server, or persistent
  LSP cache. The user controls the executable and its normal project setup.
- No manifest-aware monorepo resolver, framework-specific endpoint expansion,
  transitive test inference, or source-body/signature API in this increment.
- No general filtering DSL, cursor framework, or new MCP workflow.

## Stage 0 — Freeze the existing contract

**Purpose:** make the maintenance work safe and preserve the five-tool
surface.

1. Add protocol-level regression assertions for the current `map`, `search`,
   `outline`, `expand`, and `path` request shapes.
2. Record that omitted optional arguments retain the current defaults:
   `limit = 20`, maximum `50`, and the current response ordering.
3. Use one small temporary TypeScript fixture with a missing relative import,
   duplicate function names in two files, and more than one page of symbols.

**Exit criteria:** the fixture exposes all four later behaviours while the
existing MCP protocol integration test remains green.

## Stage 1 — Optional user-installed LSP references

**User outcome:** when an agent environment already has a supported language
server, `expand` can supplement syntax-level facts with precise semantic
reference locations. A repository without an LSP remains fully usable with the
existing static facts.

**Ownership boundary:** CodeFacts only looks up a normal executable on `PATH`
and speaks the LSP protocol over stdio. It does not install a server, write a
settings file, read an agent's private LSP session, or assume it can attach to
Claude Code or another coding agent's process.

**Initial API additions:**

- Add `codefacts mcp --lsp auto|off`, defaulting to `auto`.
- Add an additive `lsp` object to `map`, reporting only the relevant supported
  server commands and whether CodeFacts could run their version probe.
- Add `references.semantic` to `expand`. It returns source-evidenced LSP
  locations only on a successful query; `disabled`, `unsupported`,
  `unavailable`, `not_applicable`, and `failed` states preserve and explain the
  static fallback.

The first implementation supports Rust through `rust-analyzer` and
TypeScript/JavaScript through `typescript-language-server --stdio`. It starts
an isolated, bounded stdio session only for the `expand` request, then exits;
there is no daemon or watcher. It asks for `textDocument/references` with the
declaration included, returns only locations inside the indexed repository,
and labels each result `extractor: lsp:<provider>` and
`confidence: semantic`.

LSP results are query-scoped evidence in this stage, rather than persisted
SQLite edges. Persisting them is intentionally deferred until their freshness,
server-version, and invalidation rules can be represented in the fact store.
They never replace existing static callers, callees, or references.

**Tests:** `--lsp off` has no process side effects; unsupported languages and
missing/broken executables return a truthful fallback state; JSON-RPC framing,
file-URI conversion, and UTF-16 positions are unit-tested; protocol tests
confirm the five-tool list and existing static result fields are unchanged.
When a real supported server is installed, manually verify one successful
`expand` result against a multi-file fixture before release.

**Exit criteria:** a broken `PATH` shim is reported as unavailable rather than
available; an LSP timeout or protocol error never fails an otherwise valid
`expand`; `--lsp off` prevents probing and launches.

## Stage 2 — Surface unresolved-reference evidence in `map`

**User outcome:** an agent can tell that an otherwise fresh index contains
known unresolved imports/references instead of mistaking an empty graph for a
complete graph.

**API addition:** add the following bounded field to `map`:

```json
"unresolved_references": {
  "count": 2,
  "samples": [
    {
      "specifier": "./missing-module",
      "kind": "import",
      "evidence": {
        "file_path": "src/app.ts",
        "start_line": 7,
        "end_line": 7,
        "source_hash": "...",
        "extractor": "tree-sitter",
        "confidence": "unresolved"
      }
    }
  ],
  "truncated": false
}
```

- Cap `samples` at 20 and order them by file path, line, then stable id.
- Reuse the existing `unresolved_refs` fact-store data; do not add a database
  migration or attempt new resolution heuristics.
- A sample is evidence of an unresolved static reference, never a claim that
  the target is absent at runtime.

**Tests:** missing import appears after indexing; resolving or deleting it
removes the sample after refresh; a result with more than 20 entries sets
`truncated`; legacy map fields are unchanged.

## Stage 3 — Disambiguate `path` endpoints

**User outcome:** callers can ask for a path between two common symbol names
without manually copying opaque symbol ids.

**API additions:** preserve `from` and `to` as strings and add optional,
repository-relative `from_file_path` and `to_file_path` strings:

```json
{
  "from": "handle",
  "from_file_path": "src/api/handler.ts",
  "to": "validate",
  "to_file_path": "src/auth/validate.ts"
}
```

- Exact symbol ids continue to take precedence and need no file path.
- Reuse `relative_path` validation so a path cannot escape the indexed root.
- Omitted file paths preserve the existing ambiguous/not-found behaviour.
- Update only the `path` schema, description, and resolution call; do not
  change the calls-only graph traversal semantics.

**Tests:** duplicate endpoint names resolve when each file path is provided;
one incorrect file path returns `not_found`; a parent-directory path is
rejected; existing id and unique-name queries retain their responses.

## Stage 4 — Narrow and continue discovery results

**User outcome:** large repositories remain navigable within the existing
50-item response bound.

**API additions:**

- `search`: optional `kind`, `path_prefix`, and non-negative `offset`.
- `outline`: optional non-negative `offset`.
- Both responses include `next_offset` when another page exists, otherwise
  `null`.

`kind` accepts the existing serialized node-kind vocabulary. `path_prefix` is
repository-relative and applies before the limit. Ordering remains the current
deterministic ordering, with the offset applied only after filtering.

Do not add boolean feature switches, arbitrary SQL/FTS syntax, generic facet
objects, or cursor tokens in this increment.

**Tests:** default calls return their current first page; filtering excludes
other kinds and paths; two adjacent offsets do not overlap; a final page has a
null `next_offset`; invalid kind, negative offset, and escaping path prefix
produce MCP argument errors.

## Delivery sequence and verification

Land each stage as a separate, independently releasable commit:

1. Stage 0 test fixture and contract guards.
2. Stage 1 optional LSP detection and query-scoped reference evidence.
3. Stage 2 unresolved-reference map evidence.
4. Stage 3 path endpoint disambiguation.
5. Stage 4 bounded discovery navigation.

For every stage, run:

```powershell
cargo fmt --check
cargo test --locked
```

Then run the stdio MCP integration tests against the temporary fixture and
manually inspect one JSON-RPC response for the new field or argument. Release
only after all five original workflows still pass unchanged when the new
arguments are omitted.

## Revisit after this plan

Reassess monorepo boundaries, language capability disclosure, signatures,
test reachability, and framework-specific endpoint facts only after the three
changes above have been used on real multi-file repositories. They remain
candidate improvements, not committed scope.
