# Offline member-ranking validation

## Question and frozen prototype

The current exact-name search appends identifiers in query order
(`src/service.rs:859-892`). A query naming a container before its member can
therefore give the container the sole source context. This experiment tests
whether a narrow ordering change improves independently selected lookups.

The prototype only reorders the existing first five results. For a query with
exactly two identifier tokens, it requires an exact first-token match of kind
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

Pending the frozen offline replay.
