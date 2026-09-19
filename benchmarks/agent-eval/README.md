# Agent task evaluation

Development-only collection for the [product scorecard](../../docs/EVALUATION.md).
The runner evaluates a Codex CLI agent with ordinary shell tools and
configurable MCP arms, for read-only questions or edit-and-test tasks. The
metrics can be used for other tools; another agent/provider needs its own usage
adapter. Older manifests retain `gpt-5.6-luna`, medium reasoning and read-only
execution. New campaigns should explicitly freeze their model, reasoning
effort and mode identically across arms.
Both modes disable account apps, memories and skill search, and skip host skill
discovery to keep account plugin catalogs and prior history out of the task.
These switches complement the existing plugin switches: disabling plugins
alone left the account app catalog visible in a Codex 0.154 readiness run.
Legacy mode/model defaults remain compatible; command arguments now include
this observed isolation fix.

## Run a controlled comparison

The [OpenSession history corpus](opensession-corpus/README.md) freezes six
real-history source questions, source-backed grading criteria, and a Luna
comparison of ordinary tools, CodeFacts, and CodeGraph. Its native preparation,
readiness, formal execution, and manual audit are separate steps.
Its [completed 36-attempt results](../../docs/LUNA-OPENSESSION-EVAL-2026-09-20.md)
retain both grading views, all attempt costs, executed tool counts, and the
limited-maintenance decision. Reuse those records before starting another run.

For an existing reviewed campaign, reuse its evidence before launching models:

```powershell
node benchmarks/agent-eval/summarize.mjs
node benchmarks/agent-eval/summarize.mjs --input D:/Eval/reviewed-results.json --pretty
node --test benchmarks/agent-eval/summarize.test.mjs
```

The offline summary defaults to the pilot and first two improvement cycles,
keeps campaigns separate, and makes no model calls. It accepts the reviewed
result formats used here, with the frozen 0–4 grading contract (3 or 4 passes).
It requires audit and usage evidence, rejects duplicate samples and contradictory
grades, includes failed attempts in completion cost, and preserves nonpassing
matched pairs as null savings. Unmeasured time/adoption remains unknown. A raw
runner `metrics.json` is not a reviewed campaign. Consult the original artifact
for tool versions, source hashes and the audit rather than treating the compact
summary as a substitute for its evidence.

The completed [bounded value screen](../../docs/VALUE-SCREEN-2026-09-12.md)
applies a smaller cross-tool screening budget and records a limited-investment
decision. Recompute its [reviewed results](value-screen-results.json) with
`node benchmarks/agent-eval/summarize.mjs --input benchmarks/agent-eval/value-screen-results.json`.

1. Create source snapshots outside the live repository. Freeze their revisions,
   questions, acceptance criteria, tool versions, and allowed tool surfaces.
   Keep the rubric and results outside the agent's source snapshot.
2. Copy `manifest.example.json` outside the snapshots and replace executable,
   repository, and package paths. The example represents the Windows pilot;
   match the sandbox configuration to the actual host. It enables only the
   named read-only MCP workflows. Installation and indexing are separate setup
   steps; the runner does not install tools or change global configuration.
3. Preflight real source reads and each required MCP. Verify that the agent can
   inspect source and execute an actual MCP query. Preserve failed preflights.
   Pin a complete usable Codex runtime: copying only `codex.exe` can omit its
   adjacent `codex-code-mode-host.exe`. Check required runtime files before
   spending model calls. Exit code zero alone is insufficient; the shared
   parser records the observed structured host-not-found error in `startupErrors`
   and classifies it as `invalid-environment`, retaining usage. Require actual
   source reads and substantive MCP facts, and stop before another invocation
   when readiness fails. Keep failed preflight data separate from task results.
4. Run one task/arm/repetition, then interleave or randomize the remaining arms:

   ```powershell
   node benchmarks/agent-eval/runner.mjs `
     --manifest D:/Eval/manifest.json --output-dir D:/Eval/results `
     --task transaction --arm codefacts --run 1
   ```

   Omitting selectors runs all manifest entries sequentially in manifest order;
   this does not randomize the campaign. `runs` controls repetitions.
5. Review actual calls for contamination, missing tools, and blocked reads.
   Grade answers against the frozen rubric independently of efficiency metrics.
   Record those decisions in a separate reviewed result file before aggregating.

The optional `guidance` string is identical across arms. The example asks for
MCP-first navigation when an MCP is configured. Remove the field for a separate
natural-choice condition. Preserve non-use as an adoption observation; do not
attribute savings to a query that never happened.

## Edit-and-test campaigns

Set manifest-level execution fields and an optional task-specific temporary
directory:

```json
{
  "mode": "edit",
  "model": "gpt-6-astra",
  "reasoningEffort": "high",
  "tasks": [{
    "id": "test-cleanup",
    "root": "D:/Eval/snapshots/ordinary-run-1",
    "tempDir": "D:/Eval/temp/ordinary-run-1",
    "prompt": "The independently sourced development task and allowed scope."
  }],
  "arms": [{ "id": "ordinary", "configOverrides": [] }],
  "runs": 1
}
```

`mode` accepts `readonly` (the compatibility default) or `edit`. Edit mode uses
the `workspace-write` sandbox and permits focused source changes and existing
build/test commands. Both shell and configured MCP tools remain optional.
The common prompt prohibits network access, dependency installation, other
snapshots, user configuration, evaluation answers, external agents, shell
invocations of CodeFacts/CodeGraph, commits and history rewrites.
Use a model/reasoning combination supported by the pinned CLI runtime; the
example is illustrative, not an experiment result or model recommendation.

Create a fresh source snapshot and temporary directory for every arm and
repetition before invoking the runner. `task.tempDir` must be an absolute path
to an existing directory; it supplies the child process's `TEMP`, `TMP` and
`TMPDIR` while preserving its other inherited environment. Only that path is
recorded, never the inherited environment. The runner does not create/reset
source snapshots or clean test artifacts. Reusing a modified snapshot changes
the experiment, so use separate manifests or update frozen per-run paths before
launching each arm. Record initial source hashes and tool/index preparation
costs outside the snapshots.

Freeze observable acceptance criteria before model calls. Grade the actual
patch, independent test results and any repeated-run or failure-path checks
before comparing usage. The agent's final answer and exit status alone cannot
establish a correct repair. The existing usage parser and manual review gate
apply to both modes.

The completed [OpenSession cleanup pilot](../../docs/TEMP-CLEANUP-PILOT-2026-09-16.md)
uses the frozen [four-required-criteria rubric](temp-cleanup-rubric.md).
Its [reviewed results](temp-cleanup-results.json) separate passing patches from
execution interference and natural MCP non-use. This stricter edit-pilot schema
is separate from the older `summarize.mjs` schema; do not aggregate it through
the older 3/4 pass threshold. Deterministic acceptance needs no model calls:

```powershell
node benchmarks/agent-eval/temp-cleanup/acceptance.mjs `
  D:/Eval/opensession-patched D:/Eval/temp-cleanup-check
```

Use a disposable checkout at the report's frozen source plus the accepted patch,
with dependencies and build already prepared, and a fresh output directory.

## Artifacts and accounting

Each run retains `request.json`, `stdout.jsonl`, `stderr`, `answer.md`,
`timing.json`, `metrics.json`, and `transcript-tools.json`. Repeated invocation
allocates another attempt directory instead of overwriting the first attempt.
`request.json` includes the resolved execution mode, model, reasoning effort,
sandbox, full CLI arguments and the selected temporary directory.
Keep raw logs local unless their source contents have been cleared for sharing.

- `turn.completed.usage` supplies cumulative input/output usage. Total tokens
  are input plus output; cached input and reasoning output are subsets.
- Saved rollout `total_token_usage` is a reconciliation source, while
  `last_token_usage.input_tokens` measures the final request's input context.
  It is not retrieval-attributable retained context or a multi-turn result.
- `stdoutToolCalls` counts direct CLI events. `rolloutToolCalls` describes
  wrapper-derived attempts. They are separate provenance streams and must not
  be added together. Logged output bytes can precede model-visible truncation
  and are not token counts or exact model-visible payload sizes.
- `executionCompleted` records process/turn completion. Correctness requires
  the external grade. Heuristic transcript checks leave the run
  `pending-manual-review`; usage conflicts and invalid environments are
  ineligible. Do not aggregate an unreviewed `metrics.json` as a product win.
- Wall time is process launch through exit, including MCP startup. The runner
  has a four-minute process timeout by default. Failed attempts belong in
  workload cost once the environment is valid. Invalid preflights are separate
  harness overhead. Actual billing remains unknown unless independently read.

The runner looks up recent rollouts in the local Codex sessions directory.
Use `--sessions-dir` for a different root or `--rollout` for a known file.
To repair accounting from retained raw evidence without rerunning the agent:

```powershell
node benchmarks/agent-eval/runner.mjs `
  --merge-run D:/Eval/results/transaction/codefacts/run-001 `
  --rollout D:/Eval/rollout.jsonl
node --test benchmarks/agent-eval/runner.test.mjs
```

The regression cases cover observed accounting and execution configuration
failures, including a real local child-process temporary-directory check.
The [pilot rubric](pilot-rubric.md) applies only to its pinned snapshots, and the
[pilot report](../../docs/EVALUATION-PILOT-2026-09-11.md) records the actual limits
of the initial experiment. Freeze new rubrics before testing other repositories.

The [first improvement cycle](../../docs/IMPROVEMENT-CYCLE-1.md) reuses those
pinned questions for two before/after repetitions. Its portable
[reviewed results](cycle-1-results.json) include usage, grades, queries, hashes,
and the missed primary target. Source-bearing transcripts remain local.

The [second cycle](../../docs/IMPROVEMENT-CYCLE-2.md) freezes five tasks and
twenty runs in [cycle-2-freeze.json](cycle-2-freeze.json), with an independent
[held-out rubric](cycle-2-rubric.md). Its [results](cycle-2-results.json) preserve
the quality improvement, raw-token regressions, one MCP non-use observation,
engineering overhead, and implemented reversion. Failed answers remain in
workload cost; a pair only gets quality-gated savings when both answers pass.

The [retrieval diagnosis](../../docs/RETRIEVAL-DIAGNOSIS-2026-09-12.md) replays
twelve frozen queries without evaluation-model calls. Its
[results](retrieval-replay-results.json) distinguish candidate ranking from
actual excerpt coverage. The investigator-selected
[evidence pack](failure-evidence-pack.md) is prepared for a future separately
controlled comprehension check and is not evidence of an agent improvement.

The [real issue runtime-recovery campaign](../../docs/ISSUE1-RUNTIME-RECOVERY-2026-09-13.md)
uses the complete CLI runtime and three substantive readiness gates. Its
[reviewed results](issue1-runtime-recovery-results.json) retain three valid
but incomplete diagnoses; no passing pair supports an efficiency claim.
