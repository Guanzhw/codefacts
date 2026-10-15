# v0.2.0 MCP and storage validation

The candidate provides three default MCP workflows and preserves explicit
seven-tool/one-tool profiles and direct CLI navigation. Its final Windows
native campaign passed **56/57 gates, overall FAIL**, with a dated engineering
exception for the Go cold benefit target. All 72 actual task attempts completed
using source commands, with **zero observed CodeFacts MCP calls**; the results
describe navigation under configured profiles. Publication and fresh installed
acceptance remain pending. The [release decision](specs/mcp-simplification-20261015/release-decision-20261016.md)
preserves the frozen targets and all failed campaign results.

## Candidate identity and checks

| Material | Identity or observed result |
| --- | --- |
| Runtime source | `48eb0d0407dbb0183af60f14b56e44ff6c63cecd` |
| Source tree | `ca1fde8429daadcc20444a7a929be6f952d9b367` |
| CI | [38781654271](https://github.com/Guanzhw/codefacts/actions/runs/38781654271), workflow dispatch |
| Windows executable SHA-256 | `23673b24ad16f4714734fb29e62bc38dd8cc6fb815d22c4d9f574842e314d892` |
| Windows executable size | 76,453,376 bytes |
| CI compiler | Rust 1.99.1; Cargo version not logged |
| Independent final source review | PASS; no concrete P1/P2 findings |
| CI source checks | Windows, Linux and macOS test/Clippy/build checks passed |
| Package checks | npm launcher, version consistency, dependency-license audit and five platform builds passed; artifact archive digests and native/package binary match verified |
| Actual Windows runtime | 254 assertions passed across 36 MCP calls and nine CLI calls |
| Documented metrics example | 47 checks passed on a small Go/Markdown fixture |

The CI run's GitHub and npm publication jobs were skipped. These are
prepublication artifacts. Final published-binary identity and installed
runtime/plugin acceptance require separate receipts.

## MCP and CLI behavior

The actual ordered catalogs were:

| Selection | Catalog |
| --- | --- |
| omitted / `--tools default` | `explore`, `impact`, `expand` |
| `--tools all` | `explore`, `impact`, `map`, `search`, `outline`, `expand`, `path` |
| `--tools explore` | `explore` |

One allowlist governs discovery and calls across both protocol eras. Hidden
tool calls fail before selecting/indexing a repository. Existing MCP clients
using `map`, `search`, `outline`, or `path` should append `--tools all` and
restart the server. Direct CLI retains `explore`, `impact`, `map`, `search`,
`outline`, `expand`, `path`, `node`, `callers`, and `callees`; aliases select
the existing expand workflow or section.

Actual CI4 runtime checks exercised the selected catalogs, rejection behavior,
source hashes/spans, freshness and CLI output on a private fixture. Source
review independently verified profile enforcement, direct CLI selection of
the full service, source/cursor contracts and package/version consistency.

The `repository_metrics` example explicitly selects `--tools all` for MCP
search. Its real documented-command smoke used local Rust/Cargo 1.93.1,
offline dependencies and two child build jobs, 20 samples per measured mode,
two search queries and 20 warm samples per query, with the supplied CI4
executable. Direct indexing/refresh/memory came from the locally linked
example library; MCP search came from CI4. The first verifier incorrectly
compared Windows extended-length canonical path strings; its failure is
preserved. Directory device/inode identity confirmed the same existing
directory, and the retained report passed without rerunning timings.

## Storage and indexing

New typed edge writes set `location_in_columns` and store canonical file/line
values once. Hydration restores the complete metadata map, including its
string-valued location keys. `idx_edges_source` is removed; source-prefixed
indexes remain. New typed node writes set `body_in_signature` and retain the
full signature, omitting its duplicate metadata body. Hydration borrows
SQLite signature text and copies at most 4,096 bytes at a UTF-8 boundary.
`None` and empty text remain distinct. Both flags default to zero for old
rows, which keep their original JSON body/location interpretation.

Indexing name/file maps now borrow immutable `CodeNode` values. Source review
verified owner lifetimes, parsed-before-existing order, vector ordering,
same-file/exported/first-candidate priorities, explicit candidate sorts and
import resolution order.

Earlier production migration/writer replay and independent storage validation
covered **83,249 nodes, 396,053 complete edges and 360 FTS pages** across four
candidate states and a published-v0.1.18 Go state. Complete signatures,
hydrated bodies and metadata, legacy JSON, occurrence IDs, source hashes,
generation and FTS order were preserved. Native migration/no-change refresh
indexed zero files. These were correctness checks, with no upgrade latency
statistics collected.

For the published Go copy, migration retained 192,663,552 allocated bytes
with 3,648 reusable free pages. After typed replay it still occupied
192,663,552 bytes with 3,094 free pages. FTS update churn can increase other
existing replay files. These checks establish compatibility and reusable
capacity; the fresh-state size result below has its own measurement.

The final CI3-to-CI4 immutable database comparison established complete
canonical equality for **48,470 nodes, 218,484 edges, 1,336 source-hash rows
and one unresolved-reference row**. It compared full raw fields, IDs,
metadata, flags, signatures, generation and production read order. The
predeclared timestamp classification contained only 1,336 `indexed_at`
changes. All **360 production-order node FTS pages** passed, together with
360 raw rank pages and the complete ranked lists.

The predeclared **strict whole-state comparison remains FAIL**: 88,259 cells
in private retrieval-cache tables differed because insertion IDs/order
differed. Every file/chunk payload matched by its source key; 144 additional
production-shaped SourceMatch SQL cases matched returned path/lines/score
and ordering. The unchanged v0.1.18-to-CI4 cache source iterates a source-path
HashSet and lets SQLite assign insertion IDs. This explains a supported
mechanism, without a new empirical reproducibility experiment. The private
IDs are not returned in SourceMatch. Canonical fact and visible-result
parity does not turn the strict raw-state failure into a pass.

## Native performance

The final frozen Windows campaign used published v0.1.18 and CI4 on the four
fixed corpora, three interleaved cold rounds, 20 warm samples and 30 paired
edit/restore samples per medium/Go arm. OS caches were not purged.

Go cold process-wall median changed from **5,429.6271 to 4,895.5632 ms**,
ratio **0.9016389358**, an observed **9.8361%** improvement. It missed the
<=0.90 target by **8.89881 ms**. Fresh closed Go SQLite state changed from
**192,663,552 to 155,963,392 bytes**, **19.05% smaller**. All other 56 gates
passed: one fresh-disk check, 39 warm comparisons, four sampled peak-memory
comparisons, three other cold comparisons, two paired refresh comparisons and seven Go absolute
warm-latency checks. See [the performance table](PERFORMANCE.md).

Contract/source-evidence checks and actual continuation passed: 12 chains,
112 pages. Full response hashes differed in six root-scoped cursor cases;
validated cursor facts remained equal. Evidence audit checked 1,560 responses,
22,400 hashes and 87,600 lines with zero evidence errors. Earlier campaigns
remain separately recorded as 52/57, 56/57 and 55/57 FAIL.

Source and compiler changed between CI3 (Rust 1.99.0) and CI4 (Rust 1.99.1).
This comparison measures the artifact product and does not isolate one
source edit or establish a cause for the missed threshold. The explicit
exception applies only to this artifact's Go cold benefit target.

## Actual agent tasks

**All 72 formal attempts used source commands and made zero observed
CodeFacts MCP calls.** This is a descriptive comparison of navigation under
three configured profiles. It supplies no measurement of MCP-use benefits,
menu superiority or a menu-size-only causal effect. The three-tool default
implements the requested product/compatibility design; these results do not
establish an empirical optimum.

The fixed experiment used eight read-only tasks across Go, JavaScript, Rust
and CodeFacts/Markdown, three profiles and three balanced repetitions. Its
separate private executable SHA-256 was
`425b46b7ed57e303d17b27aabcca420fb3446eed61a89e7f83e4254930199c95`,
source `f02493da8c0fbf7616765cc2d459e16ba92998a2`, Rust 1.93.1, with
`gpt-6.1-sol` at medium reasoning. These quantitative results belong to that
candidate and runtime, separately from CI4.

Blind content grades were frozen at 2026-10-15 18:54:02.087 UTC before trace
audits and efficiency aggregation. All eight fresh DSH graders completed
with actual model `deepseek-v4.1-flash`; source cross-checks and adjudications
are retained. The four independent trace audits were frozen at
19:04:10.095 UTC. All 72 attempts were valid, clean and completed, with zero
timeouts and zero critical errors. The frozen rubric accepted 69/72 answers
and rated 49/72 fully correct.

| Configured profile | Accepted | Fully correct | Critical errors | Timeouts | Concrete shell / MCP calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| all7 | 23/24 | 15/24 | 0 | 0 | 92 / 0 |
| default3 | 23/24 | 17/24 | 0 | 0 | 92 / 0 |
| explore1 | 23/24 | 17/24 | 0 | 0 | 91 / 0 |

Predata actual-model MCP catalogs and successful calls were observed on the
earlier prototype `2bc81ad0`/v0.1.18. Candidate `425b46b7` had native
catalog/fact checks before formal execution; its complete tool descriptors,
schemas and annotations matched the prototype. All 72 actual request
configurations matched their setup profile after normalizing only binary,
source and state paths. The formal model-facing complete catalogs were not
observed, so exposure is **config-and-native-verified**. Zero invocation does
not establish that each model received or noticed the complete candidate
catalog and then deliberately declined it. The trace-audited zero selection
errors concern source-command choices and do not prove MCP menu quality.

Every formal attempt has complete provider usage. Tokens below include each
profile's failed acceptance attempt. Cached input is a subset of input;
reasoning is a subset of output and is not added twice.
An independent arithmetic/provenance check passed all 72 raw-usage links,
component totals, frozen-row links, eligible pairs and task-median calculations.

| Metric | all7 | default3 | explore1 |
| --- | ---: | ---: | ---: |
| Total input + output tokens | 2,346,983 | 2,267,181 | 2,372,059 |
| Input tokens | 2,325,796 | 2,246,021 | 2,350,258 |
| Cached input subset | 1,689,344 | 1,395,328 | 1,681,920 |
| Uncached input | 636,452 | 850,693 | 668,338 |
| Output tokens | 21,187 | 21,160 | 21,801 |
| Reasoning output subset | 281 | 238 | 317 |
| Tokens per accepted completion (all costs / 23) | 102,042.739 | 98,573.087 | 103,133.000 |
| Sum of attempt wall time, ms | 965,661 | 938,630 | 937,902 |

Total formal consumption was **6,986,223 tokens**: 6,922,075 input plus 64,148
output. Setup's **282,407 observed tokens** remain separate. Actual billed
cost is unknown. The default3 workload used 3.4002% fewer total tokens than
all7, while using **33.6618% more uncached input**; total-token differences
therefore do not establish billing savings.

The 2,842,193 ms total is the sum of individual attempt durations, including
startup diagnostics and excluding between-attempt maintenance pauses. It is
not the supervisor's end-to-end campaign duration. Model-list refresh timeout
warnings in five cases and a telemetry warning remain in the original
stderr. Auditors retained valid completed outcomes; elapsed comparisons are
descriptive, without reclassifying those warnings as environmental faults.

Acceptance-matched comparisons require both arms to be accepted for the same
task/repetition. Each covered task contributes its paired token-ratio median,
then the fixed eight-task macro takes the median of those task values.
Positive differences below mean fewer tokens for the named candidate.

| Baseline → candidate | Eligible pairs | Tasks covered | Task-median token difference | Task-median elapsed difference | Per-task token difference range |
| --- | ---: | ---: | ---: | ---: | ---: |
| all7 → default3 | 22/24 | 8/8 | 4.8821% | 2.0665% | -8.4552% to 25.8728% |
| all7 → explore1 | 22/24 | 8/8 | 3.5714% | 2.7487% | -12.9744% to 21.7924% |
| default3 → explore1 | 23/24 | 8/8 | -2.4599% | -1.1870% | -27.8260% to 10.8908% |

For full correctness, pair coverage is 15/24 across 5/8 tasks, 15/24 across
5/8 tasks and 16/24 across 6/8 tasks respectively. The fixed eight-task
full-correctness macro values are **null**. The available-task diagnostic
medians do not substitute for missing full-workload coverage. Exact task and
pair details remain in `REPORT.json`.

The small read-only task set, variation across tasks, source-command-only
execution and different available capabilities constrain interpretation.
Native profile/CLI correctness and native performance have their separate
checks above.

## Remaining delivery

Public release, fresh installed CLI/MCP checks and actual installed plugin
configuration remain pending. A public binary can inherit this native
artifact's measurements only after its SHA-256 identity is verified.

## Retained primary evidence

The local delivery evidence root is
`D:/WorkSpace/codefacts/target/mcp-simplification-20261015`. Paths below are
relative to that retained root:

- `ci-candidate/iteration4/ci-artifact-receipt.json`
- `ci-candidate/iteration4/runtime-readiness/runtime-readiness-receipt.json`
- `ci-candidate/iteration4/runtime-readiness/example-smoke/example-smoke-receipt.json`
- `design-review/final-integration-source-review.md`
- `design-review/final-cold-target-decision-review.md`
- `storage-review/iteration2/REPORT.md`
- `cold-storage-analysis/iteration2/REPORT.md`
- `source-validation/iteration4-parity/REPORT.md`
- `native-performance-preparation/iteration4-borrowed-ci/raw/v020-borrowed-ci-23673b24ad16-final1/REPORT.md`
- The same native directory's `comparison.json` and `FINAL-AUDIT.md`
- `agent-eval-preparation/formal72-v2/grading/REPORT.md` and `REPORT.json`
- The same grading directory's `REPORT-CONTEXT.md`, `grades.lock.json` and `audits.lock.json`
- `agent-eval-preparation/formal72-v2/grading/coordination/formal-zero-mcp-exposure-context.json`
- The same coordination directory's `audit-freeze-report-receipt.json`
- The same coordination directory's `formal-zero-mcp-descriptor-equivalence.json` and `independent-report-arithmetic.md`

Frozen actual-task evidence identities:

| Material | SHA-256 |
| --- | --- |
| Grades lock | `d4ba8316c96a2823b84ed48c62ed20a62709c70421403d7cae385cf8b7e91a56` |
| Trace-audit lock | `a499c3f8a01525b22e06bc20ea6d64234bdc148ed1bd166baf5e24d7a15af21e` |
| Aggregate `REPORT.json` | `abfac570f68671a41935a6f062c4fd040705494200e65e6c0f778e9e0162a8de` |
| Exposure context | `34827e8a82fa508b998c337ece7441cff890381a3de236107df8bb2d7ef98cc0` |
| Final audit/report receipt | `91654a0119a5d29f4f958df6f44003d74d1168bb1d874feba95146e53a5535fa` |
| Complete native descriptor comparison | `4eef327c02a11b8d764d2c2218dc8598f8a592f6c93977060378ad9deeae73bb` |
| Independent arithmetic/provenance review | `fcab1ec36157e224cf90049cf8b89f7441d0234c14c96484fbdfdff2d6696316` |
