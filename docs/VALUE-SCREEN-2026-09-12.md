# Bounded value screen — 2026-09-12

Status: protocol frozen before new agent runs; results will be appended below.

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
