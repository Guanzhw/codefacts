# Real issue triage: frozen protocol

Status: closed as an invalid environment; zero formal tasks ran. The protocol
was committed before readiness in `b71aff7`. [Results and repair](ISSUE1-TRIAGE-RESULTS-2026-09-13.md)
record the failure, protocol deviations and retained cost.

## Maintenance question

Open [issue #1](https://github.com/Guanzhw/codefacts/issues/1) reports empty
conceptual searches and missing definition source in CodeFacts v0.1.9. A current
native inspection of the pinned OpenSession source finds `ProviderAdapter` with
context. The other reported subsystem was removed: the snapshot's
`docs/specs/runtime-protocol-workbench/tasks.md` records the completed removal of
Session Analysis. Source inspection must distinguish this from a retrieval bug.
The old report does not name an exact source commit, so this snapshot cannot
retroactively disprove its original observations.

This is a real maintenance-triage task, selected from the only open GitHub issue,
not another constructed ranking question. It measures read-only diagnosis;
edit-and-test productivity remains a separate evidence requirement.

## Frozen task

Use this exact prompt in all arms:

> A repository issue reported empty searches for `analysis lifecycle snapshot evidence validator manifest launch` and `ProviderAdapter interface detection capabilities resumeCommand` in an older AgentSession checkout. Triage that report against this pinned OpenSession checkout: determine whether the described code areas are present, locate the provider contract for detection, capabilities and resume-command behavior, and recommend what a maintainer should verify before changing retrieval behavior. Support your conclusion with current source and relevant repository migration records. Distinguish code declarations from mentions in documentation; do not infer a tool's performance or an implementation defect from an empty query alone.

## Execution and stopping rules

- Source: OpenSession archive at `994942690fe5d1854398017026ef3615b2fdd24f`,
  SHA-256 `fd35c8a9127711a0d8ab08c5e0ea1eaf7e75df78500c43ad15392ae8e9e8be16`.
  Extract a separate identical root per arm. Keep grading and run artifacts
  outside them. Verify source file bytes and file sets before and after.
- Reuse `benchmarks/agent-eval/runner.mjs` without changing its prompt or
  accounting. Use its identical conditional MCP-first guidance, normal source
  reads and read-only sandbox. Disable unrelated plugins, project instructions,
  web and nested agents. Each arm receives the same task and model settings.
- Codex CLI `0.154.0-alpha.6.2`, `gpt-5.6-luna`, medium reasoning. The older
  campaign binary is no longer installed; this version is selected and hashed
  before this campaign. Do not pool these results with earlier CLI campaigns.
- Arms, in serial order: ordinary tools; ordinary tools plus CodeFacts's five
  workflows; ordinary tools plus CodeGraph `codegraph_explore` from the pinned
  `@colbymchenry/codegraph@1.6.0` package. Freeze binaries, package identity,
  manifests, prompts, runner and rubric hashes in a local launch receipt.
- CodeFacts uses the verified member-ranking binary from source `5a88820`,
  SHA-256 `f43e6fd9a5d556e6ac7890a8a6840f04acb1216aab5f051b4dc1d862ff312386`.
  Its SQLite state is external. CodeGraph may create only its declared
  `.codegraph` state in its own arm root; that state is separately recorded and
  excluded from source equality checks. Agents may not read index files.
- Warm tool indexes through one native substantive query per configured tool
  on the unrelated `Router` target. At most one agent readiness invocation per
  arm, 60 seconds each, verifies a configured MCP call and ordinary source read.
  Setup and preflight consumption are separate from task consumption.
- At most three formal invocations, one per arm, 180 seconds each. No retries,
  replacements or prompt variants. Stop on an invalid environment, missing or
  conflicting usage, or unavailable pinned tool. Valid timeouts remain failures.
  Before launching another formal invocation, stop if completed formal runs
  have consumed at least 1,500,000 processed tokens; the last run may overshoot.
- Retain raw outputs, timing, tool calls and rollout usage. Audit actual calls
  for contamination and required-tool non-use. Missing evidence stays unknown.
  Grade anonymized answers before exposing efficiency totals to the reviewer.

## Decision

The [frozen rubric](../benchmarks/agent-eval/issue1-triage-rubric.md) owns quality.
Report all-attempt completion cost, total/uncached/cached/output tokens,
elapsed time, tool calls and output bytes; correct-pair savings require both
answers to pass. Account engineering separately at a stated cutoff.

If all three answers pass, CodeFacts uses at least 20% fewer total tokens than
each comparator, and its task time is no more than 10% above ordinary tools,
retain issue triage as a hypothesis for a future real-task replication. This
single task, fixed run order and shared-host caching cannot establish a general
benefit. Any other valid outcome keeps limited maintenance and requires new
consumer evidence before expansion. An invalid comparison yields no savings
decision. Do not change ranking merely to make this task pass.

Apply a product fix only for a reproduced current-source defect. If the triage
does not establish one, document the diagnosis and remaining evidence needed.
Update the project queue and commit the local results. No GitHub comment,
issue closure, package publication or global configuration change is part of
this task.

## Results

Three readiness invocations failed because the copied CLI lacked its Code Mode
host. Formal execution stopped; there are no grades or savings estimates.
The shared runner now explicitly classifies the observed startup failure in
`88c5cd1`. See the [results](ISSUE1-TRIAGE-RESULTS-2026-09-13.md).
