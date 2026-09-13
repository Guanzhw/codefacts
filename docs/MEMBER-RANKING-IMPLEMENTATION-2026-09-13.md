# Production member ranking: frozen verification

The goal is to implement the narrow query ordering supported by
[offline validation](RANKING-VALIDATION-2026-09-13.md), preserving complete
ordering before pagination and ensuring the returned source belongs to the
first result. Exact whole-query names retain priority. A two-identifier query
is a discovery hint; it does not assert ownership between same-named symbols.

## Acceptance before implementation results

- Focused fixtures cover lowercase and mixed-case members, whole-query exact
  names, same-name candidates, kind/path filters, stable cursor pagination,
  and source context identity. Keep existing exact/helper/container queries.
- Run the required Rust checks and full tests once after the final source fix,
  followed by native MCP checks against the release build on Windows.
- Compare the pinned baseline binary against the new binary on all 16 existing
  frozen ranking cases and 12 source-selected cases from `pi-local-mcp` commit
  `779bf77b111f300d354a009875a040da4c7aea44`. The third snapshot includes three
  method lookups across two classes, with exact/member/container controls.
- Freeze new cases and source hashes before any native search. Run each arm
  once: at most 56 search calls and six map checks. No evaluated-model calls
  or candidate tuning based on held-out results.
- Retain the implementation only if all three earlier independent member
  queries and at least two of three held-out member queries return the target
  first with complete necessary source, with no newly regressed controls,
  source mismatch, duplicate/lost page items, or failed required check.
- Report native text bytes, rank, coverage and unknowns separately. Larger
  returned evidence may be justified by coverage, but it is not token savings.
  Full-answer comparisons with ordinary tools and CodeGraph remain governed
  by [EVALUATION.md](EVALUATION.md).

This records an implementation milestone. The next project priorities live in
[IMPROVEMENT-PLAN.md](IMPROVEMENT-PLAN.md). Product release and registry delivery
remain separate work from local implementation and verification.

## Results

Pending source implementation and native verification.
