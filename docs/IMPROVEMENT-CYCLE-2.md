# Improvement cycle 2 — selective discovery context

## Objective and fixed experiment design

Follow [cycle 1](IMPROVEMENT-CYCLE-1.md) and the
[product scorecard](EVALUATION.md). Investigate the actual failure-task traces,
then evaluate one narrow change while holding the version-4 resolver fixed.
The cycle completes with a validated implementation, measured results, and an
implemented keep/revert decision; reaching a performance target is an outcome
to test, not a reason to keep sampling indefinitely.

Cycle-1 implementation and evaluation are committed as `4a30e3f`. Its archived
candidate binary is the new before arm (SHA256
`d5ab0c4304ce185c0fffce040a3367ea5bb704ff9a3bc22014ba6c712787e1ab`).
Both arms use the original archived CodeFacts and OpenSession task sources,
not the live worktree. This isolates the tool change from repository changes.

The design below is fixed before candidate task execution:

- Three original questions retain their exact pilot prompts and source rubric.
  Two new discovery questions are selected and source-verified by a separate
  reviewer who does not inspect candidate guidance or efficiency results.
- Five tasks × two arms × two repetitions = **20 task invocations maximum**.
  Each invocation has a 240-second process timeout: at most 80 agent-minutes
  of scheduled task execution. Up to two separate source/MCP agent preflight
  invocations have 90-second limits each. Invalid preflights and any partial
  campaign remain explicit; there are no automatic replacement samples.
- Fresh Codex CLI 0.153.4 sessions, `gpt-5.6-luna`, medium reasoning, the same
  read-only base tools, conditional MCP-first guidance and required five-tool
  MCP surface. Ignore user config, project instructions, unrelated plugins,
  web, and nested agents. Warm isolated indexes; default optional LSP behavior
  is unchanged. Freeze executable, runner, task and rubric hashes before runs.
- Run one task/repetition pair at a time, with at most two agents concurrent.
  Launch before then after in repetition 1, after then before in repetition 2.
  Checkpoint every pair and preserve actual launch/finish times and run IDs.
- A separate reviewer grades anonymized answers against the frozen source
  rubric without token/timing data or arm labels. Review raw calls and source
  hashes independently before admitting results to the comparison.

## Acceptance and stopping conditions

The primary performance target is **at least 20% lower cumulative-token median
on the original extraction-failure question**, with all answers passing the
rubric. Investigate greater-than-10% median regressions on every other task,
including held-out questions. Compare within-task medians and individual pairs,
not only the total workload. Two repeats are a bounded local experiment, not
proof of a general or statistically stable advantage.

Keep the candidate only if quality passes and the primary target is met, with
other-task regressions explained and acceptable. Otherwise revert this cycle's
candidate and retain the cycle-1 correctness baseline. Record the failure and
limit further investment rather than adding favorable samples. A factual
resolver regression is disqualifying regardless of token results.

Report cached input as a subset of input, uncached input, output, total tokens,
per-correct-completion cost including failures, and descriptive wall time.
Billing remains unknown. Record goal/engineering-agent usage separately from
evaluated task usage; never add overlapping counters or treat serialized bytes
as model-visible tokens. Count preflight overhead separately. The invocation
and time caps above bound the experiment; they are not a token or dollar cap.

## Trace evidence and frozen intervention

The cycle-1 failure traces substantiate redundant discovery context. In after
run 1, MCP text content totaled 45,467 UTF-8 bytes, including 6,913 source-excerpt
bytes. Searches for `parse_failed` and `extract_failed` each returned the same
three excerpts (1,215 bytes per occurrence): `src/indexer/pipeline.rs:106-112`,
`:123-127`, and `src/service.rs:1385-1405`. The broad `relationships` search
returned three contextual candidates before eight shell calls totaling
203,768 raw output bytes. After run 2 had 38,310 MCP text bytes followed by
117,602 shell-output bytes across eleven calls. These are logged payloads,
not provider token estimates or exact post-truncation model-visible sizes.
Repeated source line matching is a diagnostic approximation, not proof that
every later read was unnecessary. The portable trace artifact retains methods
and raw-log hashes.

The single intervention revises the `search` tool description: use
`detail=facts` for discovery, then use `detail=context` for a known or selected
symbol, beginning with `context_limit=1` and known kind/path/scope filters.
The README mirrors that guidance. A known identifier may still request context
immediately. Results, ranking, defaults, schema, freshness and resolver logic
remain identical; there is no per-symbol call prohibition or payload removal.

The two held-out prompts and source rubric are frozen in
[cycle-2-heldout-tasks.json](../benchmarks/agent-eval/cycle-2-heldout-tasks.json)
and [cycle-2-rubric.md](../benchmarks/agent-eval/cycle-2-rubric.md). Their initial
SHA256 values are respectively
`9167af34f90efea11c946c68b90c6b0d6bca49ef53f18cb133b7cbe9230eff3e` and
`fbc78e2cba9f61287880375fecb9e4fbcf15e6b9fb304974ab0cec984d21d0ad`.
Candidate execution must wait for the binary, source, runner and manifest hash
receipt and independent review. Hashes are recorded in the evaluation freeze
receipt before the first task invocation.

## Completed experiment and independent grades

The [freeze receipt](../benchmarks/agent-eval/cycle-2-freeze.json) was committed
in `ab498ee` before task execution. Candidate `9cd6554` passed independent
source review, formatting, 28 MCP protocol tests, a release build, and a live
`tools/list` comparison showing only `search.description` changed. Both agent
preflights actually called MCP and read source successfully.

All 20 scheduled invocations completed, with no retries or timeouts. The
[portable results](../benchmarks/agent-eval/cycle-2-results.json) retain every
run, component usage, actual MCP calls, grades, source identities and raw-log
hashes. The grader received 20 randomly named answer files containing only
questions and answers, without arm/repetition labels or efficiency values.

| Task | Before median tokens | Candidate median tokens | Raw change | Passing answers, before / candidate |
| --- | ---: | ---: | ---: | --- |
| Known-symbol transaction behavior | 126,632 | 185,214 | +46.26% | 2/2 / 2/2 |
| Relationship-extraction failure | 591,539 | 739,518.5 | +25.02% | 1/2 / 2/2 |
| Provider contract tracing | 385,107.5 | 419,269 | +8.87% | 2/2 / 2/2 |
| Q4: changed definition excerpt | 163,543 | 239,049 | +46.17% | 2/2 / 2/2 |
| Q5: provider-missing Trash management | 660,369 | 442,246 | -33.03% | 1/2 / 2/2 |

**These medians include failed answers and are not full equal-quality
comparisons.** Baseline passed 8/10; candidate passed 10/10. The parent checked
both failing baseline answers against the source: one conflated Pass-2 edge
extraction failure with a successful partial response; the other claimed that
restoring metadata returns a vanished provider session to the main list.
The candidate's observed quality improvement must remain visible.

Total tokens increased from 3,854,381 to 4,050,593 (+5.09%). Including the cost
of failed attempts, tokens per correct completion **decreased** from 481,797.6
to 405,059.3 (-15.93%). Uncached input increased from 515,031 to 544,910
(+5.80%). These measure different outcomes; none establishes actual billed
cost. The source-backed grading and per-correct-completion calculation take
precedence over interpreting a cheaper incorrect answer as efficiency.

For the primary failure question, only repetition 1 has two passing answers;
its candidate used 24.48% fewer tokens. Repetition 2 has a failing baseline,
so its raw token ratio is not credited as a quality-gated efficiency comparison.
The full repeated, passing comparison required by the frozen 20% median target
was not obtained. Two repeats cannot establish a stable quality advantage.

## Regression investigation and implemented decision

The greater-than-10% regression investigations covered both known-symbol
lookup and Q4. Their answers all passed, so their raw regressions also describe
comparisons at the same rubric score:

- Known-symbol lookup: candidate repetition 1 searched both `GraphStore` and
  `with_transaction` with three context entries, versus one baseline search.
  Repetition 2 still requested three context entries and made two source reads
  versus one. The instruction to begin with one entry was not adopted.
- Q4: candidate repetition 1 made no MCP calls and eight shell calls. Retain
  this as an intention-to-use observation, not evidence of an actual MCP query
  benefit. Candidate repetition 2 used facts then `expand`, followed by three
  shell calls; it did not eliminate the implementation/regression reads.
  Baseline repetition 2 used more MCP calls but fewer tokens, illustrating why
  tool-call count alone is not a success metric.
- Failure investigation: candidate repetition 2 did adopt facts discovery,
  but made five searches, three expansions and thirteen shell calls. It was
  correct while the baseline answer was not; the additional consumption cannot
  simply be labeled wasted work. The selected guidance did not demonstrate the
  intended reliable reduction in discovery and reading effort.

**Revert this cycle's candidate according to the frozen acceptance rule.**
Reversion `a89b472` restores the cycle-1 search guidance and README. The full
`src` tree, README and protocol tests match `4a30e3f`; the version-4 receiver
correctness repair remains intact. The rebuilt binary's live tool definitions
also match the baseline with no differences, and formatting passes. The exact
tested candidate binary remains archived separately for reproducibility.

The result is mixed, not proof that the candidate is uniformly worse: observed
answer quality and tokens per correct completion improved, while the primary
target and two other same-score task comparisons did not support retention.
There are no additional samples or third-cycle changes. Further investment
should start from repeatable consumer evidence and a predeclared priority among
quality and cost outcomes; it must not retroactively change this campaign's
acceptance rule or treat a single positive metric as a product-wide advantage.

## Audit and cost of the improvement process

All 20 stdout usage records reconcile with saved rollout cumulative usage.
Manual direct/nested-call inspection found no writes, network/external-agent
calls or evaluation-artifact access. One baseline Git history/status attempt
returned `not a git repository` and exposed no history. Archive verification
found zero changed files across 97 CodeFacts and 307 OpenSession files. All
raw automatic review flags remain separate from manual eligibility and grades.

At the engineering ledger collection time, **2026-09-11 13:09:21 UTC**:

| Work | Cumulative processed tokens | Uncached input tokens |
| --- | ---: | ---: |
| 20 evaluated task invocations | 7,904,974 | 1,059,941 |
| Two agent preflights | 124,454 | 15,860 |
| Engineering, orchestration and review snapshot | 38,308,588 | 941,156 |
| Observed total through engineering cutoffs | 46,338,016 | 2,016,957 |

Engineering usage sums incremental provider counters from the root and three
engineering agents after goal creation, detects counter resets, and excludes
the separately counted evaluated CLI/preflight sessions. Of its 38,167,012
input tokens, 37,225,856 were cached; output was 141,576. Per-agent timestamps
are retained in the results. This is a pre-completion snapshot: final reporting
after those cutoffs is additional, and provider processing is not the app's
quota gauge or an actual bill.

This cost is part of the investment decision. The candidate was reverted, so
this cycle establishes no deployed token saving to amortize its engineering
and evaluation cost. The retained value is the failure evidence, held-out
rubrics, measured quality/cost tradeoff, and a verified baseline. Future work
should reduce orchestration and broad-context overhead as well as product
query cost; repeating large campaigns for wording alone needs stronger evidence.
