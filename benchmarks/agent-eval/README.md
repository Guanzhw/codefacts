# Agent task evaluation

Development-only collection for the [product scorecard](../../docs/EVALUATION.md).
The initial runner evaluates a fixed Codex CLI agent (`gpt-5.6-luna`, medium
reasoning) with ordinary shell reads and configurable MCP arms. The metrics can
be used for other tools; another agent/provider needs its own usage adapter.

## Run a controlled comparison

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

## Artifacts and accounting

Each run retains `request.json`, `stdout.jsonl`, `stderr`, `answer.md`,
`timing.json`, `metrics.json`, and `transcript-tools.json`. Repeated invocation
allocates another attempt directory instead of overwriting the first attempt.
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

The eight regression cases cover observed accounting and configuration failures.
The [pilot rubric](pilot-rubric.md) applies only to its pinned snapshots, and the
[pilot report](../../docs/EVALUATION-PILOT-2026-09-11.md) records the actual limits
of the initial experiment. Freeze new rubrics before testing other repositories.

The [first improvement cycle](../../docs/IMPROVEMENT-CYCLE-1.md) reuses those
pinned questions for two before/after repetitions. Its portable
[reviewed results](cycle-1-results.json) include usage, grades, queries, hashes,
and the missed primary target. Source-bearing transcripts remain local.
