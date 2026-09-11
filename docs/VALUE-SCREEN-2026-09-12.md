# Bounded value screen — 2026-09-12

Status: completed. Protocol frozen in `aaacd53` before new agent runs; the
following execution and decision rules are unchanged. Results appear below.

## Decision and scope

The next investment decision is whether the current CodeFacts integration has
enough evidence to justify a larger comparison. The earlier three-arm pilot
used the pre-repair binary; subsequent cycles compared CodeFacts variants,
not the repaired binary against ordinary tools and CodeGraph at the same time.
Keep those campaigns separate. No product-code or tool-description change is
part of this screen.

First make reviewed results cheaply reproducible through an offline summary.
Then run six fresh navigation tasks: two pre-existing questions, one repetition
per arm. Select both the promising known-symbol transaction question and the
previously expensive extraction-failure question, rather than selecting only
the favorable case. This is a screening decision, not a stable product ranking,
held-out evaluation, or evidence of edit-and-test productivity.

## Frozen execution protocol

- Source: existing CodeFacts archive at
  `76bae6820c3032e952dbfb5aeb8560b949af185c`. Verify source hashes before and after.
- Questions: exact `transaction` and `extraction_failure` prompts from
  `benchmarks/agent-eval/manifest.example.json`.
- Grading: unchanged `benchmarks/agent-eval/pilot-rubric.md`, score at least 3
  to pass, including its material-error caps. Grade anonymous question/answer
  bundles against the source without efficiency metrics or arm mapping.
- Agent: pinned Codex CLI 0.153.4, `gpt-5.6-luna`, medium reasoning, fresh
  sessions, read-only source access, common existing conditional MCP guidance.
  Disable unrelated plugins, project instructions, web and nested agents.
- Arms: ordinary shell/search reads; the same plus the current repaired
  CodeFacts binary and its five workflows; the same plus the previously pinned
  `@colbymchenry/codegraph@1.6.0` `codegraph_explore` integration.
- Archive the CodeFacts executable and pin its hash, runner, rubric, manifest,
  source and CodeGraph package identity in a receipt before model execution.
  An unavailable pinned tool stops the screen rather than silently upgrading it.
- Use warm indexes outside the source snapshot. CodeFacts retains auto-LSP.
  Record setup separately; elapsed task time includes agent and MCP startup.
- Execute serially: transaction baseline → CodeFacts → CodeGraph, then
  extraction failure CodeGraph → CodeFacts → baseline. Host/cache effects
  remain a limitation even with serial execution and reversed order.
- Native MCP preflights must return substantive facts. Allow at most three
  small agent preflights, one per arm, each at most 60 seconds, checking normal
  source reads and the configured MCP. Preserve failures; do not retry them.
- At most six formal invocations, each at most 180 seconds. Before each launch,
  stop if completed formal invocations have consumed at least 3,000,000 total
  processed tokens. This is a between-run stopping threshold: the last running
  invocation may overshoot it, so it is not a hard token or financial ceiling.
- Stop on invalid environment, missing/conflicting usage, or exhausted call
  count. Preserve incomplete task triples and failures; never replace samples.
  A valid timeout remains a failed attempt with its known consumption recorded.
- Reconcile stdout usage with rollout counters; inspect actual calls for source
  writes, network, external agents and evaluation-artifact contamination.
  Configured-arm non-use remains in results and is reported explicitly.

## Frozen decision rule

Report correctness, all-attempt tokens and time per correct completion, raw
workload consumption, uncached input, cached input and output for each arm.
Matched-task savings require both answers to pass. Missing values remain unknown;
do not replace unmeasured billing, adoption or engineering cost with zero.

Escalate to a separately frozen, held-out repeated comparison only if all six
answers pass, CodeFacts uses at least 20% fewer workload tokens than **each**
comparator, and its workload elapsed time is no more than 10% higher than the
ordinary-tools arm. These are screening thresholds, not a significance test.
An escalation decision produces a concrete next protocol; it does not start
another batch within this six-run budget.

If that rule fails but a passing CodeFacts task beats both passing comparators
by at least 20%, retain that task family as a hypothesis for narrow validation.
Otherwise adopt limited maintenance and correctness fixes pending a new observed
consumer bottleneck. Neither branch authorizes another wording-only campaign.
An invalid/incomplete screen yields no efficiency decision.

## Engineering effort and evidence handling

Use one independent implementation worker for the offline summary, one bounded
execution worker, and one independent reviewer for grading and code review.
Pass only task-specific context; do arithmetic and report generation in scripts.
Avoid repeated full transcript reads and repeated ledger collection. Summarize
the root/worker provider usage once near completion, separately from evaluation
and preflight sessions; final reporting beyond the cutoff is additional.

Local Git commits record the frozen protocol, validated evaluation tooling and
reviewed results. Raw source-bearing transcripts remain outside the repository.
No automatic recurring task is needed for this bounded screen.

## Reviewed results

All six formal invocations completed, without replacement samples or timeouts.
The three agent preflights also passed source-read and substantive MCP checks.
The release executable was missing locally, so it was rebuilt from unchanged
product source matching `4a30e3f` and archived with SHA-256
`2e725c9b3947545aecce845ba7fdd41d58e8fd456743d0cd9da2d34355ce7576`.
The rebuild succeeded in 42.8 seconds; it is setup overhead, not a task saving.

The [portable reviewed data](../benchmarks/agent-eval/value-screen-results.json)
retains per-run usage, grades, wall time, adoption, source/binary hashes and the
decision. Raw automatic review status is preserved alongside the manual audit.

| Configured arm | Correct / attempted | All-attempt tokens | Tokens per correct completion | Seconds per correct completion |
| --- | ---: | ---: | ---: | ---: |
| Ordinary reads/search | 2 / 2 | 1,057,572 | 528,786 | 79.3 |
| + CodeFacts | 1 / 2 | 556,488 | 556,488 | 117.7 |
| + CodeGraph 1.6.0 | 2 / 2 | 699,930 | 349,965 | 69.1 |

Cached input is a subset of input and is counted only once in total processing:

| Arm | Input tokens | Cached input | Uncached input | Output tokens |
| --- | ---: | ---: | ---: | ---: |
| Ordinary reads/search | 1,052,204 | 941,312 | 110,892 | 5,368 |
| + CodeFacts | 552,617 | 477,184 | 75,433 | 3,871 |
| + CodeGraph 1.6.0 | 695,470 | 620,544 | 74,926 | 4,460 |

| Task | Ordinary tools: tokens / score | CodeFacts: tokens / score | CodeGraph: tokens / score |
| --- | ---: | ---: | ---: |
| Known-symbol transaction behavior | 171,933 / 4 | 94,614 / 4 | 238,829 / 4 |
| Extraction-failure investigation | 885,639 / 3 | 461,874 / 1 (fail) | 461,101 / 3 |

CodeFacts used 44.97% fewer tokens than ordinary tools and 60.38% fewer than
CodeGraph on the passing transaction task. Its one context search was followed
by one source-reading call; the ordinary and CodeGraph arms made four and five
source-reading calls respectively. This is a promising observation, not yet a
repeatable advantage: the earlier pilot's CodeGraph transaction answer was
cheaper than CodeFacts, and that pilot used a different CodeFacts binary.

On failure investigation, CodeFacts searched `relationship extraction`, received
an empty result, then made nine shell calls. Its answer first asserted a normal
`partial` result and later correctly qualified the Pass-2 error. The contradictory
main claim triggers the frozen rubric's material-error cap. The parent verified
the actual answer and `pipeline.rs:326-373` / `service.rs:257-274`; the failed
answer is not evidence that CodeFacts returned a false structural fact.

Because one answer failed, CodeFacts' lower raw workload consumption does not
establish a quality-preserving gain. Its tokens per correct completion are
5.24% higher than ordinary tools and 59.01% higher than CodeGraph in this screen.
These ratios retain the failed attempt's cost. Both configured MCP arms used
their tools on both questions. Independent grading was blind to arm and cost.

## Implemented investment decision

**Do not expand general product investment or launch the larger campaign.**
The all-six-pass screening gate failed. Retain known-symbol lookup as the sole
qualifying task-family hypothesis under the predeclared fallback rule.

Keep the repaired product and five-tool contract, continue maintenance and
source-backed correctness fixes, and retain the offline summary improvement.
Before another model batch, require a concrete consumer lookup task from a
different repository, a source-backed held-out rubric, and a separately frozen
small budget. A passing repeat must beat both comparator integrations at the
same quality before broadening this task family. There is no additional model
batch, product wording change, release or recurring automation in this screen.

The immediate next action on real usage is to record whether an already known
identifier plus its relationships avoids source reads; use the same correctness,
time and token metrics. Open-ended failure investigation remains a measured
weakness to investigate only when a specific retrieval or fact defect is shown.

## Audit and evaluation overhead

All six formal and three preflight usage records reconcile component by
component with their rollouts. The parent inspected every nested call: source
inspection stayed in the snapshot, with no observed writes, external agents,
network access or evaluation-answer access. One baseline Git history/status
attempt returned `not a git repository`; no history was exposed. All 97 tested
CodeFacts source files remained byte-identical to their archive after the runs.

An initial preflight audit compared whole usage objects, incorrectly treating
the rollout's additional total field as a mismatch. It was repaired offline by
comparing the five common counters; no model task was rerun. Escaped path text
also produced a heuristic outside-root flag; actual calls established their
snapshot scope. Manual judgments remain separate from automatic flags. Task
time comes from agent launch-to-exit timing, with runner overhead retained in
a separate field.

The offline summary is committed as `34accfd`; 14 summary/runner tests pass and
an independent reviewer checked it. A local run processed the three original
reviewed artifacts in about 9 ms inside an already launched Node process,
reducing 128,608 input bytes to 35,129 output bytes, with zero model calls.
That artifact-size reduction is not a measured agent token-saving percentage.

Formal evaluations processed 2,313,990 tokens; readiness preflights processed
261,779. Their sum is 2,575,769. This smaller six-run scope cannot be compared to
the previous twenty-run campaign as an equal-work productivity improvement.
Engineering usage is recorded separately below; actual billing remains unknown.

At the single ledger collection cutoff **2026-09-11 17:10:58 UTC**:

| Work | Processed tokens | Uncached input tokens |
| --- | ---: | ---: |
| Six formal task invocations | 2,313,990 | 261,251 |
| Three readiness preflights | 261,779 | 76,837 |
| Engineering, orchestration and review | 41,386,794 | 867,780 |
| Observed total through engineering cutoffs | 43,962,563 | 1,205,868 |

Engineering comprises 41,273,412 input tokens (40,405,632 cached) and 113,382
output tokens. Its breakdown is 9,562,817 for the parent, 3,127,337 for summary
implementation, 26,832,397 for evaluation operation, and 1,864,243 for review.
The ledger sums each distinct response's `token_usage_record.payload.usage`
after the user request at 16:37:52 UTC, separately in the four engineering
sessions. It excludes the nine separately counted evaluated/preflight sessions
and does not sum cumulative thread/turn counters again. Per-session cutoffs
are retained in the portable data; reporting after those cutoffs is additional.

**This cycle did not demonstrate improved engineering token efficiency.**
The engineering snapshot exceeds cycle 2's 38,308,588 processed tokens despite
running fewer formal tasks. The lower combined total comes from the smaller
evaluation workload, not demonstrated orchestration savings. Cache dominates
input, so this is not a billing comparison. The concentration in evaluation
operation and repeated inspection makes a further ad hoc campaign hard to
justify; retain the scripts and offline summaries and stop this campaign.
