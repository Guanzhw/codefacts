# Post-delivery correctness and evidence repair

The repaired native 0.2.1 candidate restores type-use facts in five existing
extractors, makes partial exploration explain source omissions, and stops
unchanged partial indexes from repeatedly rebuilding successful files.
The default MCP menu remains `explore`, `expand`, and `impact`; seven-tool
and one-tool profiles remain opt-in.

This is a candidate validation record. Public publication and installed-host
acceptance are recorded separately when obtained. The local evidence root is
`target/post-delivery-fixes-20261016/` in the original development checkout;
its diagnostic failures and earlier candidates are retained.

## Source and correctness

The frozen Windows candidate was built from
[`ea94c8cdd1addf79302222e405d786e0befd6b75`](https://github.com/Guanzhw/codefacts/commit/ea94c8cdd1addf79302222e405d786e0befd6b75),
tree `498e27354a8089cce3924240f3626b679f543b25`. Its executable SHA-256 is
`b2a731b29e8f5a5c0e63d34e373f76aa8aa414edb63367ecccf432566ac8c7ca`;
`candidate-v2/receipt.json` records the compiler, build and 60 runtime input
hashes. It is a source-built artifact, distinct from a later public build.

The type-reference queries in Go, Rust, Java, C and C++ previously captured
`@reference.type` without the same match's required `@name`, so that extraction
path returned early. The fix supplies the capture, excludes declaration
occurrences and retains genuine field, alias, bound and callable type uses
with source locations. Types can own these references. Type-only resolution
uses a unique local type or an exact unique qualified identity, including
incremental rebinding after qualified targets are added or removed.

Targets without sufficient identity evidence remain explicitly unresolved.
This includes unqualified external types, multiple local type namesakes,
and C tag/typedef pairs sharing a name. Rust union and trait-associated-type
definitions remain outside the existing query coverage, while their declaration
names no longer create false references. These are syntax-backed facts rather
than a language type checker's semantic graph.

Independent source review found declaration-position and qualification cases
that were fixed before freezing the candidate. A fresh native recheck passed
14 CLI calls and 16 named assertions. Independent DSH Flash review additionally
found opaque/guarded C/C++ declarations and Rust union/associated-type false
references; its final candidate recheck passed 31 assertions. The original red
records, first candidate and checker corrections remain available alongside
the final evidence. A separate Flash real stdio MCP check passed 186 assertions
across final-candidate behavior, retained old-candidate controls and one
extraction-version transition; its receipt keeps those phases distinct.

Every partial `explore` header now reports the actual omitted-file total and
`too_large`, `unreadable`, `parse_failed`, and `extract_failed` counts. Unchanged
files are excluded from omissions. The full extraction transition atomically
replaces successful facts, removes old-version facts whose source could not
be reprocessed, and clears the full-pass marker. Omitted sources remain partial
and are retried; successful unchanged files are reused. An ordinary incremental
failure retains the existing partial-snapshot contract.

Final-candidate real stdio MCP verification covers the omission line at 2,000
and 24,000 UTF-8 byte budgets, repeated partial refresh with zero successful
files reindexed and stable generation, then one-file recovery and a stable
following refresh. The earlier full matrix also covers unreadable UTF-8,
the exact size boundary and old extraction-state transition. Its byte-identical
pipeline/exploration inputs are bound separately rather than relabeled as
new candidate runs.

## Verification obtained

- Windows `cargo test --all-targets --locked --offline`: 916 passed, no failures
  or ignored tests. Clippy with warnings denied, formatting and diff checks pass.
- npm tests: 23 passed, including packed launcher installation and real MCP.
  The evaluation accounting runner's 22 tests and the new natural-study
  controller's 17 tests pass.
- Dependency license audit passes. Version checks align Cargo, npm, all five
  native dependency pins and `server.json` at 0.2.1.
- [Exact-source CI run 38902875744](https://github.com/Guanzhw/codefacts/actions/runs/38902875744)
  passed all six jobs, including Windows, Linux, macOS, Node 18 launcher and MSRV.
- Actual persisted DSH model records identify `opencode-go` /
  `deepseek-v4.1-flash`; task configuration alone is not used as that evidence.

## Upgrade and storage measurement

The previously missing published-0.2.0 migration measurement is now available
from three private copies of a genuine closed 0.1.18 Go index. The immutable
original SHA-256 remains
`311324139ccff18b542414d9e010f86920614417a297be62107b8430e8847f4a`.
Each copy passed 33 acceptance checks. No source was reparsed, extraction
version stayed 9, generation stayed 1, and logical facts, hashes and FTS were
preserved.

Median initialization/open was 30.7 ms, including the schema migration;
the first no-change map response was 61.5 ms and the next was 60.5 ms.
These are separately timed protocol operations, not additive estimates of
schema work. Allocation remained 192,663,552 bytes, with 3,648 reusable free
pages after migration. No automatic compaction was performed.

The repaired candidate changes extraction version 9 to 10 and requires one
full source pass even when source files are unchanged. Its re-extraction,
new type-reference storage and fresh-index cost are measured separately;
the old migration-only latency does not predict that cost. On three private
0.2.0 index copies, the first candidate map indexed all 982 files, advanced
generation 1 to 2 and cleared the full-pass marker; both following maps indexed
zero files and retained generation 2. Each copy passed 30 acceptance checks,
and the old generation's cursor was explicitly rejected as `stale_cursor`.
First-map median was 11,805.4 ms under shared-host contention. Existing main
DB allocation remained 192,663,552 bytes, using free pages for the added facts.

Three fresh pairs used separate nonexistent states in AB/BA/AB order, with
public 0.2.0 as A and the exact final candidate as B:

| Observation | Public 0.2.0 | Repaired candidate | Observed change |
| --- | --- | --- | --- |
| First map median | 6,502.8775 ms | 7,610.4838 ms | +17.03% |
| Returned pipeline-duration median | 6,194 ms | 7,346 ms | +18.60% |
| Closed main DB | 155,963,392 bytes | 176,586,752 bytes | +13.22% |
| Total disk with observed sidecars | 155,996,160 bytes | 176,619,520 bytes | +20,623,360 bytes |
| Reference relationships | 15 | 32,839 | +32,824 |
| Process peak working-set median | 487,718,912 bytes | 523,997,184 bytes | +36,278,272 bytes |

Nodes/FTS nodes remain 34,779, hashes remain 982, and calls/imports/contains
remain 168,591/8,702/261 in both arms. A stride sample found the recorded
spelling on the source line for 329/329 reference occurrences; this checks
occurrence evidence, not semantic target-resolution precision.

These single-host, three-pair diagnostics record substantial background load;
they establish the observed cost of the repaired fact set on this corpus,
not a controlled timing attribution. The memory figure is Windows process
`PeakWorkingSet64`, not total host memory. Earlier-candidate measurements retain
their own executable identity. An independent read-only review recomputed
the figures from raw receipts and found a stale summary arm label and
inconsistent hand-copied pipeline values. The operator corrected those
report issues from unchanged raw measurements, preserving the original
values and a correction record.

The immutable old DB and migration mother retain their hashes. The operator
disclosed two earlier-phase integrity-receipt rewrites and a sidecar timestamp
touch during v1 checks, so preservation claims apply to verified originals
and named frozen records rather than every intermediate evidence byte.

## Model-visible menus and tool choice

Three forced public-0.2.0 canaries established actual model-visible 7/3/1 menus,
substantive native MCP results and ordinary source reads on the frozen current
Codex runtime. Their 165,057 tokens are setup cost, separate from the new study.
The previous 72 shell-only attempts and their missing historical exposure
evidence are unchanged.

The repaired candidate independently passed nine native prerequisites across
three real corpora and all profiles, with exact menus and source-range/hash
checks. The natural-choice follow-up was frozen before model data: three
familiar source questions, three profiles and two repeats, 18 sequential
attempts, common model/effort and ordinary tools, immutable source and warm
index copies. Its execution-plan SHA-256 is
`2e7ed1ee01ac8538456591b775552d2928ac8b2ff6c016637d6422aa6cdebfd4`.

Each task first observes the real runtime menu, then freely chooses source
navigation. Quality grading uses fresh DSH Flash sessions and source citations;
separate sessions audit arm-aware traces. Grades are locked before costs are
joined. Answers leaking tool/profile identity remain in the 18-attempt
denominator with unknown blind quality. All 18 tasks completed once in order,
with exact actual menus, unchanged source and consistent raw usage records;
all 18 answers were eligible for blind export. Independent grades and trace
audits were frozen before the cost join. All 18 answers satisfy all four
criteria, have no critical error and have valid source citations under the
frozen rubric. Three fresh Flash source-only graders were independently
checked by a fresh native source reviewer. Two grader explanations incorrectly
called a test-only caller unique; their reasons/evidence were corrected before
locking, with every answer judgment and original grader output retained.

All 18 traces independently confirm actual menu exposure and **zero MCP
invocations**. The agents used ordinary source commands in every profile.
All task processes completed; one ordinary inspection command included a
missing test-file path and exited nonzero after returning other source. That
error and the agent's later recovery are retained; no task was retried.

| Profile | Fully correct answers | MCP queries | Ordinary source operations | Input tokens | Cached input | Output tokens | Median process wall time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Seven (`all`) | 6/6 | 0 | 23 | 572,547 | 396,160 | 5,120 | 68.8895 s |
| Three (`default`) | 6/6 | 0 | 22 | 555,712 | 394,880 | 5,218 | 69.9595 s |
| One (`explore`) | 6/6 | 0 | 23 | 600,708 | 465,792 | 5,179 | 68.1855 s |

All 18 token totals reconcile between stdout and raw rollout. Total processed
tokens are 1,744,484: 1,728,967 input plus 15,517 output. Cached input is
1,256,832 and is already included in input. The reported 336 reasoning-output
tokens are already included in output; reported cache-write input is zero.
No token total or blind grade is unknown. Sequential process wall time totals
1,244.340 seconds, including the inventory prelude; separate canary and native
preparation costs remain separate. The local `natural18-results-summary.json`
is derived from the frozen grade/audit/report locks and preserves per-attempt
outcomes and the nonzero command.

Keep three default tools as the engineering choice. This sample resolves
current catalog exposure versus non-adoption; its token/time differences
describe source-command workflows under the three profiles, and do not select
an optimal MCP menu. They are not evidence of MCP-use savings or a CodeFacts
answer-quality advantage.

This study measures tool choice after menu exposure. The familiar questions,
small sample, changed workflow capabilities and absence of ordinary-only or
CodeGraph arms prevent a general productivity or menu-size causal claim.

## Distribution and preserved boundaries

The public Registry detail lookup returned 404; a successful official Registry
search returned HTTP 200 with zero matching entries on 2026-10-16. This confirms
the observed listing state, independently of npm and `server.json` metadata.
Registry publication is a separate action.

The existing 0.2.0 public performance result remains 53/57 gates passed,
overall FAIL, with four explicitly accepted exceptions. Those measurements,
the prior task outcomes and the original checkout's 22 protected dirty files
are preserved. New repair measurements answer distinct extraction and upgrade
questions and do not replace the earlier results.
