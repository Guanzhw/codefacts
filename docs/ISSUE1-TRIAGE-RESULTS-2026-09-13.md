# Issue #1 triage and readiness repair

The repository triage is complete. The three-arm efficiency comparison is
**invalid: zero formal tasks ran**. A copied Codex executable lacked its adjacent
Code Mode host. The resulting exit-zero startup failure exposed a missing
diagnostic classification in the evaluation runner, repaired in `88c5cd1`.
This cycle provides no new agent correctness score or token-saving estimate.

## Current-source diagnosis

[Issue #1](https://github.com/Guanzhw/codefacts/issues/1) describes an older
AgentSession checkout and CodeFacts v0.1.9 without pinning a source revision.
On OpenSession `994942690fe5d1854398017026ef3615b2fdd24f`, the tested CodeFacts
binary from `5a88820` behaves as follows:

| Reported query | Observed result | Maintenance implication |
| --- | --- | --- |
| `ProviderAdapter interface detection capabilities resumeCommand` | One interface result; complete 2,656-byte definition at `src/providers/interface.ts:123–176`, fresh index and matching source evidence. | This present-target example works with the tested binary and contextual search. |
| `analysis lifecycle snapshot evidence validator manifest launch` | No results. The snapshot's migration checklist explicitly records completed Session Analysis removal. | Recover the original revision or a present-target reproducer before attributing this empty result to a retrieval defect. |

The migration evidence is `docs/specs/runtime-protocol-workbench/tasks.md:99–107`.
Source inspection finds no current `runAnalysisValidator` definition. An
independent reviewer verified that the provider contract makes `resumeCommand`
and `capabilities` optional, while `detect(): boolean` is required. The source
and excerpts were independently checked; these are maintainer findings, not
evaluated-agent answers.

The lexical AND behavior remains a limitation for broad descriptions. Current
source absence neither disproves the historical report nor measures that
limitation's cost. No ranking or query fallback was changed from this evidence.
The GitHub issue remains open; no public reply or closure was performed.

## Invalid readiness and retained cost

The three source roots contain identical copies of the pinned archive: 307
files and 6,561,961 bytes each. Before/after records and a separate final check
match the archive. CodeGraph's four generated `.codegraph` files are separately
recorded in its own arm root.

All three readiness processes exited zero and emitted `turn.completed` usage,
but also emitted a structured error saying `codex-code-mode-host.exe` was
missing. The helper exists beside the installed CLI; copying only `codex.exe`
into the campaign's tools directory caused the failure. Attempts to inspect
available tools and read the source failed at that host boundary.

| Readiness arm | Total processed tokens | Cached input | Uncached input | Output | Wall time |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ordinary tools | 43,300 | 34,048 | 8,741 | 511 | 29.959 s |
| CodeFacts | 43,213 | 37,120 | 5,632 | 461 | 27.318 s |
| CodeGraph | 43,243 | 37,120 | 5,594 | 529 | 28.434 s |

Total readiness consumption is **129,756 tokens** and 85.711 seconds. Each
stdout/rollout usage pair reconciles exactly. Stdout reports zero tool calls;
each rollout records one attempted source command, which failed before running.
Neither stream establishes a successful source read or MCP call. These are
environment costs, not failed substantive answers or MCP adoption observations.

The setup also deviated from the frozen protocol:

- CodeGraph's first native response said the project was not indexed. Setup
  then indexed it and repeated both native probes: four setup query calls
  instead of the allowed two. Both response files are retained.
- The readiness helper checked process exit status alone and continued after
  the first invalid environment. All three failures are retained.
- A complete launch hash receipt was not produced before readiness. The saved
  post-failure hashes are forensic records, not a reconstructed pre-launch freeze.

The parent stopped formal execution. There were no replacement samples, no
answer grading, and no attempt to repair the environment and resume this
campaign under its original label.

## Delivered repair and verification

The shared runner now preserves the exact structured host-not-found diagnostic
as `startupErrors` and classifies the run as `invalid-environment`, even when
the CLI exits zero. It retains the process-completion fact and usage while
keeping evaluation/token eligibility false. Previously these saved logs were
`pending-manual-review`; they were not automatically accepted as correct answers.

Recognition is limited to the observed runtime error item. The same wording in
an assistant message and ordinary task error items retain their previous
behavior. Sixteen runner/summary tests pass, and offline replay of all three
real stdout logs produces the new classification with identical token counts.
An independent source review passed. Repair validation used no model calls.
Readiness documentation now requires a complete runtime and substantive tool
results rather than relying on exit code alone.

## Decision and evidence

Keep limited maintenance. The next evaluation step is to verify a complete
runtime and share the runner's readiness diagnostics, then freeze a new real-task
comparison only after its prerequisites pass. Reuse these failure records rather
than launching another wording or ranking variant. End-to-end benefit and
edit-and-test productivity remain unmeasured in this cycle.

[Portable results](../benchmarks/agent-eval/issue1-triage-results.json) retain
source audits, native findings, preflight usage, parser before/after results,
protocol deviations and artifact hashes. Full source-bearing logs remain in the
session artifact directory's `issue1-triage-2026-09-13` folder; the independent
native issue check is in `issue1-native-recheck-2026-09-13`.

At **2026-09-13 11:24:39 UTC** (19:24:39 Asia/Shanghai), engineering usage was
**14,697,083 processed tokens**: 14,629,260 input, including 14,213,248 cached
input; 416,012 uncached input; and 67,823 output. It sums unique per-response
usage for the current parent turn and four engineering sessions. The three
readiness sessions above, export completion and later reporting/commits/final
reply are excluded. Processed usage is not monetary billing.

This engineering overhead is high for an invalid comparison and a small parser
fix. It does not justify increased product investment. Future work should check
runtime prerequisites locally before spending model calls and reuse one shared
collector instead of duplicating exit-only readiness scripts.
