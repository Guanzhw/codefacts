# Real issue triage with the complete runtime

Status: frozen before readiness or formal model calls.

This separately authorized follow-up repairs the concrete prerequisite exposed
by the [closed failed campaign](ISSUE1-TRIAGE-RESULTS-2026-09-13.md): use the
installed Codex runtime with its adjacent host and sandbox helpers. Retain the
old failures and their cost. The repository question, source, model settings,
CodeFacts binary, CodeGraph integration and grading criteria stay unchanged.

## Frozen scope

- Use the exact task from [the original protocol](ISSUE1-TRIAGE-2026-09-13.md)
  and its [rubric](../benchmarks/agent-eval/issue1-triage-rubric.md).
  The unit is one read-only real issue diagnosis, one repetition per arm.
- Source: OpenSession `994942690fe5d1854398017026ef3615b2fdd24f`. Reuse the
  three existing isolated source roots, checking every file against archive
  `fd35c8a9127711a0d8ab08c5e0ea1eaf7e75df78500c43ad15392ae8e9e8be16`
  before and after. Only CodeGraph's declared `.codegraph` state is excluded
  from source equality in its own root.
- Agent: installed Codex CLI `0.154.0-alpha.6.2`, `gpt-5.6-luna`, medium effort.
  Verify the CLI, Code Mode host, command runner and Windows sandbox helper;
  hash the complete four-executable runtime in a launch receipt. Use its
  installed path throughout, without relocating only the main executable.
- Tools: ordinary source reads; the same plus CodeFacts from `5a88820`;
  the same plus `@colbymchenry/codegraph@1.6.0` explore. Preserve previous
  per-arm settings and identical MCP-first conditional guidance. Use existing
  warm indexes. Record setup separately; task time includes CLI/MCP startup.
- Reuse the repaired repository runner directly for both readiness and tasks.
  Preserve its read-only sandbox, disabled unrelated plugins/project
  instructions/web/nested agents, and normal source-reading access.
  Freeze manifests, runner, rubric, protocol and tool hashes before any model
  call; verify them again before each formal call and after the final call.

## Execution gates

Run readiness serially, baseline → CodeFacts → CodeGraph, once per arm, at most
60 seconds each. The shared readiness task requests a configured navigation
call for the unrelated `Router` target and an ordinary read of the first two
lines of `src/router.ts`. Require actual successful source reads, and substantive
correct-root facts from each configured MCP. Inspect structured startup errors,
actual calls and usage reconciliation before proceeding. Exit zero alone does
not pass. Stop immediately on the first invalid or incomplete readiness result.

Only after all readiness gates pass, run the unchanged formal task serially in
the same arm order, once per arm, at most 180 seconds each. Stop on invalid
environment, missing/conflicting usage or artifact drift. A valid timeout is
a failed task, not an environment failure. Before another formal launch, stop
if completed formal attempts used at least 1,500,000 processed tokens; the last
attempt may overshoot. Maximum model calls: three readiness plus three formal.
Do not retry or replace any sample in this campaign.

The parent executes and audits the serial calls; use an independent reviewer
for anonymous answer grading. Audit actual source access and tool use separately
from answer quality. Record all attempts, setup consumption and engineering
usage. The prior campaign's native facts remain setup evidence; new model
readiness supplies fresh substantive tool checks without another native loop.

## Decision and reporting

Use the original acceptance rule: all three answers pass; CodeFacts uses at
least 20% fewer total tokens than each comparator and no more than 10% extra
task time versus ordinary tools. Passing this single task supports only a
hypothesis for replication. Otherwise retain limited maintenance; an invalid
environment yields no efficiency comparison. Report quality, total/uncached/
cached/output tokens, time, tool calls, output volume and unknowns. Preserve
failed-task cost and require passing pairs before reporting token savings.
Fixed run order, shared-host caching and one task limit generalization.

## Results

Pending gated execution and independent grading.
