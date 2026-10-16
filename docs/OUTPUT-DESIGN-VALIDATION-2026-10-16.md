# Output design validation — 2026-10-16

The native 0.2.2 candidate implements the reviewed default presentation contract.
Independent source review and live CLI/MCP replays confirm the changes below.
Public 0.2.2 packages, release publication and installed-host acceptance remain
pending.

## Resulting contract

- MCP queries with omitted `format` return readable, text-only Markdown, matching
  direct CLI defaults. Consumers requiring `structuredContent` request explicit
  `compact` or `full`; their schemas, evidence hashes and dual transport remain.
- Default text removes generated source fingerprints and repeated fact objects.
  Relationship rows retain counterpart definitions, distinct call sites,
  direction, confidence and resolution. Impact test summaries reference affected
  entries instead of copying their witnesses; Search context references ranked
  results. Outline shares its file anchor and Path retains directed hops.
- Explore prints each owner locator once and admits complete small owners when
  they fit. Partial previews, omitted source and follow-up ranges stay explicit.
  Source literals containing hash-like text are preserved.
- Freshness, source verification, uncertainty, active cutoffs and section cursors
  remain. Internal source hashes, disk comparisons and cursor checks remain.
  Qualified labels retain an accepted raw selector when needed; ambiguous
  candidates retain exact IDs. The 3/default, 7/all and 1/explore catalogs remain.

## Independent review and checks

Evidence is preserved under
`D:/WorkSpace/codefacts/target/post-delivery-fixes-20261016` (paths below are
relative to that directory). The candidate receipt records committed source
`a36d85e2`, a clean source build and native version 0.2.2.

| Check | Obtained evidence |
| --- | --- |
| Full source/design audit | `output-redundancy-audit/source/SOURCE-AUDIT.md` and `output-design-review/REVIEW.md` cover all workflows, formats and CLI aliases. |
| Independent implementation review | `output-design-review/implementation/REVIEW.md` found one P2 selector issue. `CLOSURE-selector.md` closes it after inspecting the repair and real indexed-fixture regression. |
| Local Rust suite | `output-density-cargo-tests.log`: 931 tests passed **before** the selector repair; `output-density-presentation/selector-repair/README.md` records the subsequent 17 presentation and 11 protocol/CLI checks passing. |
| Lints and launcher | Root format and Clippy checks passed; `output-density-clippy.log` and `output-density-npm-tests.log` record Clippy and 23 passing npm tests. |
| Exact-source CI | [Run 38917633766](https://github.com/Guanzhw/codefacts/actions/runs/38917633766), attempt 1, succeeded on the candidate source: Windows/macOS/Ubuntu tests, Rust MSRV, formatting/lints and Node 18 launcher, all six jobs. Receipts: `output-density-ci-exact{,-jobs}.json`. |
| Relationship replay | `output-redundancy-audit/flash-relationships/green-v1/GREEN-REVIEW.md`: 35/35 checks passed within 24 invocations, including aliases, repeated call sites, heuristic resolution, ambiguity, paging and a consumed continuation. |
| Legacy replay | `output-redundancy-audit/flash-legacy/green-v1/GREEN-REVIEW.md`: 33/33 assertions passed within 24 calls across Map, Search, Outline and Path. Qualified method/heading selectors and exact ambiguity IDs were followable. |
| Explore replay | `output-redundancy-audit/flash-explore/green-v1/results.json`: 13 checks passed and one was not exercised, within 18 invocations. Actual captures cover orientation, owner cards, batched reads, UTF-8 clipping, source literals and the invalid-budget error. |
| Public delivery | **Pending:** separately versioned public packages, release and actual installed hosts. |

Explicit Compact/Full comparisons preserved schemas and facts; the only observed
raw value differences were `freshness.duration_ms`. Replays reused the same
fixture roots, used private candidate state and retained baseline evidence.

## Measured response bytes

These are actual captured UTF-8 bytes from preserved 0.2.1 baseline and native
0.2.2 candidate runs. Relationship baselines below explicitly requested Markdown;
legacy MCP baselines used the former Compact default. The latter comparisons
therefore include the default-format change. Text and wire envelope sizes are
separate measurements.

| Fixture request | Baseline text bytes | Candidate text bytes |
| --- | ---: | ---: |
| Expand Entry, Markdown | 2,987 | 1,242 |
| Impact Entry, Markdown | 5,689 | 1,542 |
| Search with context, MCP default | 2,327 | 983 |
| Outline, MCP default | 2,112 | 554 |
| Map, MCP default | 671 | 586 |
| Path, MCP default | 1,377 | 511 |
| Explore five small owners, 24,000-byte budget | 1,390 | 1,352 |

The five-owner result returns all four lines of each owner; captured source bytes
increase from 214 to 468. The same fixture at a 2,000-byte budget changes from
1,389 to 1,351 total bytes with the same source increase. These measurements are
in the Explore replay's `metrics.json`.

For Search with context the captured MCP result envelope changed from 5,037 to
1,101 bytes; Outline changed from 4,598 to 649 bytes. The new default carries one
text part instead of the former additional structured copy. Explicit JSON
formats retain both representations. These fixture measurements establish byte
costs; model tokens and productivity were not measured.

## Remaining observations and coverage

Impact still repeats immediate parent labels (5.7–7.8% of the two measured
responses). The generic renderer adds JSON quotes within some code spans, and
Expand retains empty relationship and semantic-disabled information. The replay
reports classify these as presentation observations, with no failed correctness
check.

The relationship fixture did not exercise contains-forward transitions, import
file anchors, clipped definition source, partial freshness or live semantic LSP
locations. Its exact-ID follow-up ran through the CLI after the MCP follow-up was
skipped within the invocation bound. Source checks and focused tests supplement
those bounded replays. The Explore no-source probe matched ordinary FTS terms
and returned candidates, so that branch was not measured by the replay; its
source and existing unit test were inspected. Installed distribution acceptance
remains a separate gate.
