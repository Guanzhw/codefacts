# Changelog

## Unreleased

- Query exploration groups admitted Rust methods by their exact impl source
  range and pools only those members' source shares, returning fitting impls
  once or an explicit bounded preview with the original method anchor.
- Rust impl methods expose optional `rust_impl.owner_ref` in symbol facts.
  Its response-local key selects one record in the root `rust_impl_owners`
  dictionary, containing the file, exact receiver and trait spellings and actual
  syntactically complete impl block's half-open range (1-based lines,
  0-based UTF-8 byte columns).
  File plus impl range identifies one syntactic block; these spellings do not
  resolve types or dispatch. Method definition ranges, qualified names and
  existing IDs are preserved, including same-line collision disambiguation.
  These dictionary keys are not symbol selectors. Extraction shares each owner
  in memory; SQLite stores each owner once outside the symbol graph.
- Extraction version 11 triggers one full source reindex to populate membership
  for existing databases. The successful refresh advances the generation and
  invalidates earlier snapshot cursors; failed refreshes retain prior facts
  and the pending rebuild marker atomically.

## 0.2.2 — 2026-10-16

- MCP queries default to readable Markdown, matching direct CLI queries.
  Consumers needing JSON or `structuredContent` must request `format: "compact"`
  or `format: "full"`; those explicit machine formats retain their contracts.
- Default text removes source fingerprints, repeated symbol endpoints and
  routine metadata. Source verification, freshness, relationship uncertainty,
  precise locations, graph cutoffs and section continuations remain available.
- Exploration prints each candidate locator once and returns complete small
  definitions when they fit, using the remaining budget for useful source.
  Partial previews and source omissions remain explicit.
- Qualified method and heading labels retain an accepted selector; ambiguous
  symbols retain exact IDs for follow-up queries. Implementation and measured
  response bytes are recorded in the
  [output validation](docs/OUTPUT-DESIGN-VALIDATION-2026-10-16.md).

## 0.2.1 — 2026-10-16

- Restore static type-use references in Go, Rust, Java, C and C++ by fixing
  their per-match query capture contract. Real type uses retain source
  locations and enclosing owners; declaration names do not create references.
  Ambiguous types and external short names without indexed identity remain
  unresolved instead of selecting an arbitrary namesake.
  The extraction version advances to 10, so existing indexes make one full
  source pass to replace incomplete facts even when source files are unchanged.
- Default `explore` text reports partial-index omissions by reason, including
  too-large, unreadable, parse-failed and extract-failed files, within the
  existing response byte budget. Unchanged files are not omissions.
- Partial indexes return to incremental refresh after the forced extraction
  pass. Unchanged valid files are reused while omitted files are retried.
  Unverifiable old-version facts are removed atomically before completing a
  migration, so a persistent oversized file no longer forces every query to
  rebuild all valid source files.
- Active distribution and improvement documents describe the shipped
  three/default, seven/all and one/explore MCP profiles and completed 0.2.0
  delivery. Historical experiment and performance results retain their original
  outcomes and evidence boundaries.
- A follow-up 18-attempt study observed each actual 7/3/1 menu before free
  tool choice. All answers met the frozen source rubric and all navigation
  used ordinary source commands, so no optimal MCP menu or product-value gain
  is established. Restored type facts increased the candidate Go index's
  fresh disk use by 13.22%; bounded contended-host cold observations and the
  once-only extraction upgrade cost are retained in the
  [repair validation](docs/POST-DELIVERY-REPAIR-2026-10-16.md).

## 0.2.0 — 2026-10-16

- MCP startup exposes `explore`, `impact`, and `expand` by default.
  `--tools default` selects that same catalog, `--tools all` exposes all seven
  workflows, and `--tools explore` exposes one. Discovery and execution enforce
  the same profile. Configurations using `map`, `search`, `outline`, or `path`
  over MCP must add `--tools all` and restart the server.
- All ten direct CLI query names remain available, including `node`, `callers`,
  and `callees`. Native/npm help and configuration guidance describe the new
  default.
- Typed storage writes avoid duplicate edge location metadata and node body
  prefixes, while readers reconstruct the existing fact contract. Legacy
  metadata retains its original interpretation. A redundant edge index is
  removed, and indexing borrows immutable nodes while preserving order.
- The actual published Windows comparison observed 9.6467% lower Go cold
  median and a 19.0488% smaller fresh closed Go database. **53/57 native
  gates passed, overall FAIL**: the 10% cold target and three globset warm
  P95 targets were missed (map +10.1385%, outline +17.6143%, context search
  +33.0579%). A new public-artifact decision accepts those four exceptions.
  Historical CI4 remains separately recorded as 56/57 FAIL. See
  [performance details](docs/PERFORMANCE.md) and the
  [delivery record](docs/V020-DELIVERY-2026-10-16.md).

- A fixed 72-attempt navigation study completed with 69 accepted and 49 fully
  correct answers, zero critical errors, and zero observed MCP calls. Its
  7/3/1 profile results describe source-command navigation; they do not
  establish MCP-use benefits or an optimal menu. Full quality, token and
  exposure details are in the
  [validation record](docs/MCP-SIMPLIFICATION-VALIDATION-2026-10-16.md).

GitHub and all six npm packages are published; registry signatures and
provenance passed for all six. Fresh isolated Windows installation passed
262 runtime checks. Plugin 0.2.1 is merged and verified in fresh Codex and
Claude hosts using native package 0.2.0; the delivery record preserves the
accepted Claude call-count deviation and original failed assertion.
