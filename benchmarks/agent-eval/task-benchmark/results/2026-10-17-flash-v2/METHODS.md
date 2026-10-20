# Campaign evidence and interpretation

[REPORT.md](REPORT.md) contains generated tables, [results.json](results.json)
contains all 96 neutral answers with locked source-backed grades and per-run
measurements, and [validation.json](validation.json) records the final checks.
[Run the benchmark](../../README.md) to repeat the workflow with installed
prerequisites and the frozen source manifests.

## What was measured

The campaign used DSH 0.2.0-rc.2 with `opencode-go / deepseek-v4.1-flash`, high
reasoning and an 8192-token maximum for each generation. There was no task or
campaign token ceiling. All 96 scored attempts ran serially on Windows x64,
with fresh isolated DSH processes, private source copies and prepared indexes.
The recorded execution and analysis interpreter is Node v26.5.1.

Each arm had the same three bounded tools for ripgrep search, source reads and
file listing. The treatment arms added their real native MCP tools and literal
server instructions. CodeFacts 0.1.7 exposed five native tools, 0.2.2 its default
three, and CodeGraph 1.6.2 one. This controls source access while preserving the
native catalogs' actual context cost.

The CodeFacts executables were built from the exact
[0.1.7 source revision](https://github.com/Guanzhw/codefacts/tree/d1c4619a91fd5a3cda3b65356a41818166e1481f)
and [0.2.2 source revision](https://github.com/Guanzhw/codefacts/tree/9d2683e30fbddb2a15c8ceafdc38e9fab3b42066)
using identical Rust/Cargo 1.93.1 `--release --locked --bin codefacts -j 4`
settings. This is a source-build comparison. Both used `--lsp off`.
CodeGraph used its installed official Windows 1.6.2 runtime at the
[pinned revision](https://github.com/colbymchenry/codegraph/tree/6560052a6f856855d3f71eee838fd66ccfa4285d),
with daemon, downloads and telemetry disabled. Any generated state and hooks
remained in private evaluation copies; hooks were not executed.

Task wall time runs from DSH launch through process exit, including provider
delay, model requests and MCP/tool execution. Native index preparation is a
separate measured stage. The report labels reuse estimates explicitly;
installation, source materialization and readiness canaries are outside task
wall time. Provider totals include cached input; uncached input is also
reported. Missing cache/reasoning buckets remain unknown.

## Quality and trace review

Six independent reviewers (`gpt-6.1-sol`, high reasoning) graded anonymous
answers against the frozen four-criterion oracle and source. All 96 grades
were locked before efficiency aggregation. Three fresh reviewers checked
12 anonymously selected answers, covering 48 criterion judgments and their
critical-error flags. They upheld all grades. The unchanged answer for
`guided-use-ghcli-02-codefacts022-r3` uses a bare `(18-20)` for the external
error wrapper: the definition is `pkg/cmd/root/extension.go:18-20`, and its
conversion is `pkg/cmd/root/alias.go:34-38`. The answer also cites that conversion
correctly; the citation shorthand did not change the criterion judgment.

A separate auditor checked all 96 actual request headers, model-source events,
tool menus, declared calls, native versions and bridge/native output fidelity.
The auditor also rehashed every manifest file in the 96 private snapshots and
the three original corpora, checked exact file inventories, and verified that
owned processes had exited. All source and transport checks passed. Provider
failures had no assistant model message, so message-source identity is
unobserved for those three runs; their actual request identity is recorded.

One guided-use attempt, `guided-use-globset-02-codefacts022-r2`, queried `src`
instead of `crates/globset/src`. Its only native response contained no source
result. Its cost and answer remain in the workload, and it is excluded from
quality-gated efficiency pairs as nonadherent. Native use was optional in
natural-choice; CodeFacts 0.2.2 was used in 5 of its 6 attempts, the other
native arms in all 6.

## Failures and preserved pilot

Three natural-choice ordinary attempts (`router-01`, `router-02`, `ghcli-01`)
ended with upstream HTTP 400 `INVALID_REQUEST`: the endpoint rejected the
thinking request field. They made no source/tool calls and reported no positive
usage. Exact usage remains unknown; the SDK's synthetic zero counters do not
establish zero cost. No failed attempt was retried or replaced. Their times
remain in all-attempt medians. Consequently natural-choice ordinary timing is
not a successful-task latency comparison, its total token cost is a lower
bound, and cost per correct completion is withheld. The 72 guided-use attempts
all completed with exact usage. Across the campaign, 93 exact usages sum to
14,383,892 tokens; total workload usage is at least that amount.

An outcome-blind review found that three original v1 prompts omitted topics
required by their fourth criterion. The pilot was stopped after 16 completions
and an interrupted seventeenth. V2 clarified prompt scope without changing the
criteria or source anchors, then started a fresh freeze, four readiness
canaries and all 96 scored attempts. Pilot and readiness attempts are excluded
from the published comparison. The interrupted pilot has 7,095 observed
settled tokens as a lower bound; its exact total and unfinished request remain
unknown. Original raw events and the initial incomplete accounting receipt
are preserved alongside an explicit correction.

## What the result supports

In guided use, 0.2.2 passed all criteria in 8/18 attempts, ordinary tools in
9/18, 0.1.7 in 9/18, and CodeGraph in 6/18. For the six eligible 0.2.2/ordinary
pairs, median per-pair deltas were -24.58% time and -30.97% total tokens.
For six eligible 0.2.2/0.1.7 pairs they were -18.27% and -40.06%. Relative to
CodeGraph, six eligible 0.2.2 pairs used +17.48% time and +6.54% tokens.
These subsets differ; they do not form a common ranking of all tasks.

The measured 0.2.2 efficiency improvement over ordinary tools accompanies no
aggregate correctness improvement in this campaign. Six read-only tasks and
one model configuration provide a repeatable project baseline; repetitions
do not create additional independent repositories. Future improvement claims
should preserve the same quality gate and add separately frozen tasks for
broader workloads, including edit-and-test work.

## Verification

- 71 local framework tests passed, including the real installed DSH accounting
  helper and MCP bridge integration.
- The offline CI profile passed 57 tests; its optional installed-helper check
  was skipped. The existing agent-evaluation checks passed 28 tests.
- Official archive bootstrap succeeded for all 106 router, 237 globset and
  1,494 ghcli files, with exact frozen contents and no extra output files.
- Root independently checked all answer/grade bindings, eight group totals and
  medians, usage coverage and publication portability. A fresh reviewer
  recomputed all group statistics and twelve paired comparisons with no
  remaining blocker.
- CI replays this published baseline offline, checking the complete schedule,
  summary/report reproduction, answer bindings and recorded artifact contents.
- A fresh Git checkout with `core.autocrlf=true` passed the same offline CI
  profile. Benchmark files retain LF through repository attributes, preserving
  byte-bound evidence on Windows.

Raw SDK events, requests, native wire logs, private mapping, source copies and
full review evidence are retained in the operator's local campaign directory.
Published artifacts contain neutral answers and relative source citations.
