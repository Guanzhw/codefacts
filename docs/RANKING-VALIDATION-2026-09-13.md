# Offline member-ranking validation

## Question and frozen prototype

The current exact-name search appends identifiers in query order
(`src/service.rs:859-892`). A query naming a container before its member can
therefore give the container the sole source context. This experiment tests
whether a narrow ordering change improves independently selected lookups.

The prototype only reorders the existing first five results. For a query with
exactly two whitespace-separated ASCII identifiers, it requires an exact first-token match of kind
class, struct, interface or trait, and an exact second-token match of kind
method or function in that page. It stably moves the second-token callable
matches first. All other orders remain unchanged. It adds no facts and makes
no assertion that the two symbols are structurally related. The source-selected
test cases establish their actual relationship independently.

This is a bounded offline ranking prototype. Global ordering, pagination and
production integration are outside the result it can establish.

## Cases and isolation

An independent source-only worker assessed five previously unused candidate
container/member pairs: three from the pinned OpenSession snapshot and two
from the pinned CodeFacts snapshot. Source verification retained three, as
recorded below. For each retained pair, four cases ask for the
member using container plus member, the member alone, the container alone,
and the container using wording that also mentions the member. The last
case checks that a callable preference does not override explicit container
intent. If the snapshot has fewer eligible pairs, retain the smaller count
and report the limitation instead of fabricating membership.

The parent adds four calibration/control cases from previously investigated
symbols. Calibration results are reported separately from the independent
cases. Expected symbols, source hashes, question intent and necessary evidence
spans are frozen before native searches. Case selection does not inspect rank.
The prototype rule is frozen before the case-selection output is read.

Source snapshots:

- CodeFacts: `76bae6820c3032e952dbfb5aeb8560b949af185c`.
- OpenSession: `994942690fe5d1854398017026ef3615b2fdd24f`.

The native baseline uses the archived CodeFacts binary with SHA-256
`2e725c9b3947545aecce845ba7fdd41d58e8fd456743d0cd9da2d34355ce7576`.
State and response archives are stored outside the source repositories.

## Measurements and decision rule

Run at most 24 searches and two map checks, once each, with `limit=5`,
`detail=context`, and `context_limit=1`. No model-answer evaluation, retry,
query reformulation or candidate adjustment follows the observed ranks.

Report first relevant rank, Top-1, reciprocal rank at five, Recall@5, control
regressions, and whether the first context contains the source span necessary
for the stated task. A relevant fact without its needed source does not count
as evidence coverage. Verify returned fact hashes and source excerpt bytes
against the pinned files. Audit snapshots before and after.

When the prototype selects a different first result, reuse that exact symbol's
context from another frozen query if available. Missing context remains
unknown. Compare baseline and hypothetical candidate payloads using identical
JSON serialization, and report actual native text-block bytes separately.
These are output-byte measurements, not agent input tokens or billing.

A positive result requires all of the following on independent cases:

1. At least two member queries improve to rank one with complete necessary
   source evidence, including an OpenSession case.
2. No formerly correct control loses rank-one relevance or necessary evidence.
3. Covered cases per total modeled payload KiB improve, with all missing
   candidate contexts reported and no source/hash mismatch.

This only qualifies the prototype for a separately scoped production design
and independent replication. It does not authorize an expanded agent campaign
or establish token savings. If the gate fails, retain current product ranking
and close this experiment without another rule variant.

## Engineering limits

Reuse the pinned source, binary and existing JSON-RPC conventions. Source
selection is bounded to six worker tool calls and harness implementation to
eight before review. Use one bounded independent review after results, with
the parent checking source and output. Record engineering usage separately at
an explicit cutoff; zero evaluated-model invocations does not mean zero model
resources spent preparing and reviewing the experiment.

## Source-selection audit before replay

Source verification retained three valid independent pairs: OpenSession
`Router.dispatch`, CodeFacts `CodeFacts.search_with_page_options`, and
`GraphStore.get_related_test_nodes`. Two proposed factory-returned object pairs
were removed because the proposed named container declarations did not exist
at the cited locations. The parent corrected declaration ranges and required
source spans before querying. The frozen set therefore contains 12 independent
cases and four calibration/control cases, totaling 16 native searches.
Cross-repository evidence is limited to one OpenSession pair; the three query
families are not a random sample of repositories or user tasks.

## Results

**The independent offline gate passed.** The narrow ordering prototype is
worth a separately scoped production design and further independent validation.
This experiment made no product changes and establishes no agent token saving.

The cases were frozen in `c816acd`, then the harness in `6f264d3`, before native
replay. Exactly 16 search requests and two map checks completed without retries
or evaluated-model invocations. Source hashes and excerpts matched the files;
97 CodeFacts files and 307 OpenSession files remained identical to their pinned
archives before and after. An independent reviewer verified the cases, native
results, measurement rules and acceptance calculation. Nine harness tests pass.

| Independent cases (12) | Native ordering | Offline prototype |
| --- | ---: | ---: |
| Relevant result first | 7/12 (58.3%) | 10/12 (83.3%) |
| Reciprocal rank at five, mean | 0.7431 | 0.8889 |
| Target in first five | 12/12 | 12/12 |
| Necessary evidence in first context | 8/12 | 10/12 |
| Modeled serialized output bytes | 69,650 | 77,261 |
| Covered cases per modeled output KiB | 0.1176 | 0.1325 |
| Newly regressed control cases | — | 0 |

The prototype increases modeled output bytes by **10.93%** while increasing
covered cases per KiB by **12.69%**. The numerator counts cases whose required
source span is present in the first context, not completed agent answers. These
byte-normalized measurements are a retrieval diagnostic and cannot be converted
into a token, latency or billing improvement percentage.

| Independent member query | Native rank → prototype rank | Source coverage before → after |
| --- | --- | --- |
| `Router dispatch` | 2 → 1 | yes → yes |
| `CodeFacts search_with_page_options` | 4 → 1 | no → yes |
| `GraphStore get_related_test_nodes` | 2 → 1 | no → yes |

The `Router` class excerpt already contained the method body. Promoting
`dispatch` improved target rank but did not add missing evidence in that case.
The two Rust cases gained necessary source coverage. All three satisfy the
frozen condition of an improved rank-one member with complete required source,
including an OpenSession case; the two coverage gains occur in CodeFacts.

The two `CodeFacts` container controls remain at rank three. Native search puts
the equally named README headings first. This pre-existing problem is visible
in the result and was not corrected by changing the frozen prototype. The
control criterion is no newly introduced regression, not universal correctness.

## Calibration and missing evidence

The four calibration/control queries remain separate from the acceptance gate.
`GraphStore with_transaction` moves from rank two to one, but the frozen replay
contains no other query returning that method's context. Its candidate context
therefore remains **unknown**. Portable results set that candidate payload size
and calibration-wide candidate byte efficiency to null; a shorter response with
missing context is not credited as a byte improvement.

`extract edges` still returns its production target fourth. The exact
`extract_edges` and `parse_and_extract_edges_file` controls remain first. This
confirms the prototype's narrow scope; it does not repair split-word ranking or
penalize explicitly requested test helpers.

## Decision and next boundary

The evidence supports exploring one bounded product change: prioritize an
explicitly named member in the two-identifier query shape. Production work must
preserve stable pagination, duplicate-name handling, explicit whole-name lookup,
filters and source context identity; this top-five simulation does not prove
those integration behaviors. A separate implementation should carry these
fixtures forward and add independent repository cases before broader claims.
The small, source-selected dataset—particularly its single external pair—does
not establish general user benefit or reopen the large agent-evaluation campaign.

The source-only case-selection draft initially included two invalid named
container pairs and several inaccurate ranges. Parent/source review corrected
these before native querying. Harness review also caught coverage-file identity,
missing-context and pre-launch validation errors before the recorded run.
These corrections are engineering work; they are not failed model-evaluation
samples or reasons to rerun the frozen queries.

## Artifacts and engineering cost

- [Frozen cases](../benchmarks/agent-eval/ranking-validation-cases.json).
- [Replay and prototype](../benchmarks/agent-eval/ranking-validation.mjs), with
  [tests](../benchmarks/agent-eval/ranking-validation.test.mjs).
- [Portable results](../benchmarks/agent-eval/ranking-validation-results.json),
  including per-query ranks, source coverage, byte counts, evidence checks and
  frozen artifact hashes. Local raw receipts and responses are retained in the
  session artifact directory's `ranking-validation-2026-09-13` folder.

At **2026-09-13 10:24:47 UTC** (18:24:47 Asia/Shanghai), engineering usage was
**7,232,430 processed tokens**: parent 3,209,499; source selection 1,790,137;
implementation 1,538,451; independent review 694,343. Input was 7,192,066,
including 6,855,680 cached tokens; uncached input was 336,386 and output 40,364.
Cached input is already included in input. The ledger sums unique per-response
usage records for the current parent turn and the three engineering sessions;
export completion and subsequent reporting/commit/final reply are excluded.

The native replay required zero evaluated-model calls. Engineering usage remains
substantial, and this cutoff quantity is neither monetary billing nor an
equal-work comparison with previous cycles. A separate current-checkout `map`
was ordinary engineering inspection and is not one of the two experiment maps.
No additional query or rule variant was run after seeing the results.
