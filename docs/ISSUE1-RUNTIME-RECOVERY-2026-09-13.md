# Real issue triage with the complete runtime

Status: complete. All three environments passed; all three answers failed the
frozen quality gate. Retain limited maintenance. Protocol frozen in `3b82085`.

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

All three readiness checks returned real source reads; the configured MCP arms
returned substantive MCP results. Each formal task ran once and finished within 180 seconds. All
usage records reconcile with retained rollouts. The 1,139 frozen artifacts and
all three 307-file source roots matched before every formal launch and after
the final run. There were no retries or replacement samples.

| Arm | Quality | Total tokens | Cached input | Uncached input | Output | Seconds | MCP / shell calls |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 2/4, fail | 497,451 | 414,208 | 79,853 | 3,390 | 107.514 | 0 / 8 |
| codefacts | 2/4, fail | 423,634 | 366,080 | 54,223 | 3,331 | 98.432 | 2 / 6 |
| codegraph | 2/4, fail | 570,522 | 503,808 | 63,098 | 3,616 | 112.931 | 1 / 9 |

Total tokens are input plus output; cached input is already included in input.
Time covers process launch through exit, including CLI/MCP startup.

The independent reviewer received opaque answer filenames, the frozen rubric
and common source, without arm identities or efficiency figures. Only absolute
snapshot-root prefixes were removed from answers. Every answer earned A and C:
it correctly identified removed Session Analysis and cited the provider contract.
Every answer missed B and D: the required/optional contract distinction was
incomplete, and general checkout checks did not clearly require the original
revision or a current present-target reproducer before changing retrieval.
These are completeness failures, not evidence that all answers invented facts.
The parent checked the source and retained the independent grades unchanged.

CodeFacts actually returned `ProviderAdapter` as its first context at
`src/providers/interface.ts:123–176`, including `detect(): boolean`,
`capabilities?:` and `resumeCommand?:`. The returned source text matched the
snapshot; all 21 hash/context checks across its two calls passed. This observed
miss occurred between available evidence and the final answer. It does not
justify changing ranking or adding a sixth tool. The two other arms also had
the contract available in source/tool output and omitted required distinctions.

| Arm | Logged shell output bytes | Logged MCP result bytes |
| --- | ---: | ---: |
| baseline | 249,733 | 0 |
| codefacts | 86,260 | 37,060 |
| codegraph | 308,106 | 21,771 |

These volumes describe retained logs, which may precede truncation or duplicate
structured/text content. They are not token counts or exact model-visible sizes.
Actual calls stayed in their assigned source roots; the parent inspected every
nested input. Baseline referenced a nonexistent `src/providers/registry.ts` and
emitted one unlocated sandbox warning, while source results remained available.
CodeGraph logged a model-catalog refresh timeout, but its selected-model turn and
tools completed. Neither condition blocked requested source access or produced
a structured startup failure; both remain recorded in the audit.

## Decision and next trigger

No passing pair exists, so quality-gated token savings and tokens per correct
completion are unavailable. Raw CodeFacts consumption was 14.84% below ordinary
tools and 25.75% below CodeGraph, with 8.45% less task time than ordinary tools.
Those are differences between failed answers. Even ignoring quality, the frozen
20% token reduction versus each comparator was not met.

Keep the earlier source-verified member-ranking change and the repaired runner.
Continue limited maintenance; this campaign supplies no basis for broader
feature investment. The next product change requires a reproducible failed
lookup for a symbol that exists in its pinned source. A further agent comparison
requires a new independently sourced consumer task and a decision it can change;
do not rerun this task with a tuned prompt or relax its rubric. Preserve the
five-tool surface. Installation, first-use indexing, real edit outcomes and
external adoption still need their own evidence before expanding investment.

## Cost and retained evidence

Formal evaluated-agent cost was 1,491,607 processed tokens. Readiness added
279,493, for 1,771,100 combined; readiness is not a successful task outcome.
Existing warm indexes and binaries were reused, so first-use installation and
indexing economics were not measured again. Actual billing is unknown.

Engineering usage through 2026-09-13T11:51:25.423628+00:00 was
6,546,818 processed tokens: 6,157,824 cached input,
348,965 uncached input and 40,029 output. This
counts the current parent user turn plus runtime audit and independent review
agent sessions, excluding readiness/formal calls and subsequent final reporting
and commit. The portable result records deduplication, per-session totals and
source-prefix hashes. This is a separate workload from earlier campaigns;
its lower total alone would not demonstrate improved engineering efficiency.

[Reviewed results](../benchmarks/agent-eval/issue1-runtime-recovery-results.json)
retain all grades, usage, timing, calls, freeze checks, audit notes and hashes.
The existing offline summarizer validates the result without another model run:

```powershell
node benchmarks/agent-eval/summarize.mjs --input benchmarks/agent-eval/issue1-runtime-recovery-results.json --pretty
```

Raw source-bearing answers, stdout, rollouts, manifests, the full hash receipt,
source/call audits and anonymous grades remain in the local campaign directory
`issue1-runtime-recovery-2026-09-13` under this task's artifact directory. The
[earlier failed campaign](ISSUE1-TRIAGE-RESULTS-2026-09-13.md) remains closed with
its original failures and cost. No source runtime code or published package was
changed by this follow-up.
