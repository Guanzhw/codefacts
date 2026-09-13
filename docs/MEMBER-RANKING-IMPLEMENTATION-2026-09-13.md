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

**Retain the implementation.** Source commit `5a88820` passes the frozen
ordering gate, including all three earlier member queries and all three new
member queries. Each now returns the intended method first with complete
necessary source. Independent review confirmed the decision from the saved
manifest and results.

| Frozen cohort | Queries | Top-1, old → new | Necessary source covered, old → new | Native text bytes, old → new |
| --- | ---: | ---: | ---: | ---: |
| Earlier independent cases | 12 | 7 → 10 | 8 → 10 | 69,962 → 77,573 (+10.88%) |
| Third-repository held-out cases | 12 | 9 → 12 | 10 → 12 | 89,237 → 90,268 (+1.16%) |
| Calibration and helper controls | 4 | 2 → 3 | 2 → 3 | 40,274 → 46,175 (+14.65%) |

Recall@5 stays 100% in every cohort and arm. No control rank or coverage
regressed, no symbol kind mismatched, and all returned source hashes and
excerpts matched the frozen source. There are no unknown coverage values.
The held-out group contains three method/container pairs and their controls,
including repeated container queries; it is a source-selected diagnostic,
not twelve independent user tasks.

The new member queries were `PiRpcProcess rejectPending`, `PiService getSession`
and `PiService listSessions`. All move from rank two to one; the first and third
gain missing method bodies. Native output also resolves the earlier offline
unknown for `GraphStore with_transaction`: rank two becomes one with complete
source. The existing `CodeFacts`/README heading collisions remain at rank three,
and `extract edges` still ranks its target fourth.

The change orders candidates before pagination, preserves exact whole-query
names, and excludes selected IDs from FTS in SQL before its limit/offset.
This retains other same-name results without repeatedly fetching earlier FTS
pages. Regression coverage checks same-name methods, functions and variables,
lowercase members, existing snake-case anchors, kind/path filtering, context
identity and cursor pages without missing or repeated items. A named container
activates the ordering; it does not prove that a same-named callable belongs to
that container.

Local Windows validation passed: 754 Rust tests, formatting, Clippy with warnings
denied, the release build, 23 npm launcher/package/protocol tests and ten
evaluation-harness tests. A final fixture addition preserving a same-name
snake-case variable passed its targeted regression, followed by a rebuilt
release binary. No production logic changed after the full Rust test run.

The native comparison completed 56 searches and six maps, with no query retries
or evaluated-model invocations. The first preflight rejected reused directories
containing previous `.codegraph` index artifacts before any MCP call or launch
receipt. Both original archives were then extracted to new directories; the
cases and binaries stayed unchanged. File bytes and the complete file set
matched each archive before and after the successful run. This failed preflight
is retained alongside the successful run, rather than counted as a query sample.

## Investment decision and artifacts

This supports a narrow retrieval-quality improvement. Larger evidence responses
make a token-saving claim premature: correct task completion, total/uncached
tokens, latency and tool calls still require a matched real-task comparison.
The three source snapshots do not establish adoption or broad product ROI.
The next priority is the real-use evidence gate in [IMPROVEMENT-PLAN.md](IMPROVEMENT-PLAN.md).

- [Native driver](../benchmarks/agent-eval/member-ranking-native.mjs) and
  [snapshot audit regression](../benchmarks/agent-eval/member-ranking-native.test.mjs).
- [Held-out cases](../benchmarks/agent-eval/member-ranking-heldout.json) and
  [earlier cases](../benchmarks/agent-eval/ranking-validation-cases.json).
- [Portable results](../benchmarks/agent-eval/member-ranking-native-results.json)
  include paired metrics, acceptance checks, engineering usage, source revisions,
  archive hashes and raw artifact hashes. Full launch receipts, native responses
  and preflight records remain in the session artifact directory's
  `member-ranking-production-2026-09-13` folder.

The pinned baseline binary SHA-256 is
`2e725c9b3947545aecce845ba7fdd41d58e8fd456743d0cd9da2d34355ce7576`;
the source-commit candidate is
`f43e6fd9a5d556e6ac7890a8a6840f04acb1216aab5f051b4dc1d862ff312386`.
Local verification is complete; package publication and remote platform CI have
not been performed in this milestone.

At **2026-09-13 10:50:14 UTC** (18:50:14 Asia/Shanghai), engineering usage was
**11,573,666 processed tokens**: parent 6,299,773; implementation 3,555,378;
native harness 518,611; independent review 1,199,904. Input was 11,505,860,
including 10,951,424 cached tokens; uncached input was 554,436 and output 67,806.
The ledger sums unique per-response usage for this parent turn and its three
engineering sessions. Export completion, later reporting/commits and the final
reply are excluded. These are processed tokens, not a monetary bill or tokens
used by an evaluated agent.

Engineering overhead remains high despite zero evaluated-model calls. This
milestone does not demonstrate a cheaper development workflow. The next cycle
should reuse the existing driver and evidence, limit repeated review to concrete
changed code or failures, and justify its cost with a named real task before
starting another comparison.
