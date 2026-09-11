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
