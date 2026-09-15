# OpenSession edit-and-test pilot

This campaign tests whether adding CodeFacts helps an agent deliver an actual
maintenance patch. The independently reported consumer task is
[AgentSession issue #1](https://github.com/Guanzhw/AgentSession/issues/1).
It is a new task on a previously used repository, not a new held-out repository.

## Frozen task and decision

Source: `Guanzhw/AgentSession` at
`420688e01c736b0db709ce3ba5525ef757e0ec5a`. The live working tree contains
uncommitted reader work. All experiments use independent clean clones; their
tracked source hashes match before task execution.

The bounded task repairs seven test fixtures in `test/core.test.mjs` and
`test/codex-provider.test.mjs`: token statistics, startup configuration,
runtime logs, runtime extensions, instruction files, compressed Codex rollouts,
and the decompressed-size limit. Each currently passes but leaves its own
temporary directory. The controller reproduced all seven individually on
Windows; both full files passed 162 tests. The SEA binary smoke lifecycle and
historical system TEMP cleanup remain separate upstream work.

Each arm receives identical requirements: preserve assertions and behavior,
close owned handles, remove only its own directory on success and setup/assertion
failure, preserve environment restoration, keep cleanup errors visible, and run
the existing two test files. The agent can freely choose ordinary shell tools
and any configured code-navigation MCP. This measures natural tool choice;
formal tasks do not require an MCP call.

One task, one attempt per arm, 12 minutes per formal process. Freeze the order
before formal execution. Failed or incomplete attempts remain in workload cost;
do not tune prompts, retry a valid failure, or change grading after results.
Readiness failures stop dispatch until corrected and remain separate overhead.

The decision this pilot can change is whether to investigate a specific observed
retrieval/usefulness failure or test a different independently sourced task.
One task cannot justify broad product expansion or a general savings claim.
If no reproducible product defect emerges, retain limited maintenance.

## Configuration and quality gate

- Agent: Codex CLI `0.154.0-alpha.6.2`, complete installed runtime;
  `gpt-6-astra`, high reasoning, workspace-write, approval never.
- Arms: ordinary tools; the same plus released CodeFacts `0.1.14` (five tools);
  the same plus CodeGraph `1.6.0` (its exposed `codegraph_explore` MCP workflow).
- Windows Node `26.5.1`; dependencies and build prepared identically outside
  task timing. Each arm has its own source and temporary root. Warm tool indexes;
  cold indexing and native readiness are recorded separately.
- Unrelated apps, plugins, memory, host skills, web, and nested agents disabled.
  The first baseline readiness exposed account plugin metadata despite disabling
  plugins. Its 108,577 processed tokens are excluded preparation overhead; the
  corrected configuration also disables the separate apps integration.
- The final task, manifests, tool schemas, source hashes, runtime hashes, timing,
  raw outputs, provider usage and query evidence are retained under the local
  ignored `target/temp-cleanup-pilot-20260916/` directory.

The independent [rubric](../benchmarks/agent-eval/temp-cleanup-rubric.md)
assigns four required binary criteria. Only **4/4** is a correct completion:

1. Original semantics and scoped edits preserved; both test files pass and
   unrelated sentinel files survive.
2. Two normal rounds observe all seven directories created and then removed.
3. Assertion failures in all seven fixtures still clean up; runtime environment
   restoration is checked with both a missing and preexisting value.
4. SQLite writer setup failure and configuration-file write failure still clean
   up. The exact writer handle must close before directory deletion.

Evaluator-only preload probes intercept existing fallible operations; they do
not add production fault switches. Before any formal run, the baseline probes
triggered the expected errors and recorded retained directories, including the
unclosed writer. The full probe runner and hashes are frozen locally. Anonymous
patch review is conducted without efficiency figures. A missing verification is
unverified rather than a passing point.

Token definitions follow [EVALUATION.md](EVALUATION.md): input plus output;
cached input is a subset, and uncached input is input minus cached input.
Both matched patches must pass and execution must be comparable before a token
or time savings percentage is reported. Preparation, evaluator work, and engineering usage are separate.
Subscription token counts do not establish an API bill.

The runner uses documented [Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode)
and the separate [apps feature setting](https://learn.chatgpt.com/docs/config-file/config-reference).
Live readiness, not the configuration alone, establishes actual source reading,
temporary-file writing, runtime APIs, and MCP connectivity.

## Results

The pilot is **closed with a verified maintenance patch and no demonstrated
retrieval-efficiency gain**. All three patches passed the frozen 4/4 quality
gate. Both configured MCP arms chose shell tools throughout the formal task.
CodeFacts also experienced two real command-launch policy rejections, so the
three-arm run cannot support a clean efficiency comparison.

The [reviewed results](../benchmarks/agent-eval/temp-cleanup-results.json) keep
quality, execution eligibility, usage, and the investment decision separate.
They use this campaign's strict four-required-criteria schema; the older
`summarize.mjs` format permits 3/4 and does not aggregate this campaign.

| Arm | Quality | Input | Cached input | Uncached input | Output | Total tokens | Wall time | Formal MCP calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ordinary tools | 4/4 | 522,391 | 464,000 | 58,391 | 6,866 | 529,257 | 308.792 s | 0 |
| + CodeGraph 1.6.0 | 4/4 | 565,972 | 515,200 | 50,772 | 9,648 | 575,620 | 368.659 s | 0 |
| + CodeFacts 0.1.14 | 4/4 | 729,588 | 680,832 | 48,756 | 8,276 | 737,864 | 339.517 s | 0 |

These are recorded costs, not a ranking of tool efficiency. CodeFacts has the
lowest uncached input and highest total in this sample, but neither observation
establishes a retrieval benefit or penalty. No formal query consumed facts from
either MCP. Successful readiness queries establish availability; natural non-use
is the adoption observation for this one task. Earlier query/answer campaigns
remain separate, and this is a new task on a previously used repository.

### Execution audit and cost

All formal attempts completed within the frozen 12-minute limit, with no model
reruns. Their cumulative CLI usage matches the saved provider rollouts. The
randomized order was frozen as ordinary, CodeGraph, then CodeFacts.

The original parser labeled all three `invalid-environment`. Independent
inspection cleared the ordinary and CodeGraph arms: successful commands emitted
optional global Git ignore permission warnings, and test-title strings about
OpenCode triggered an external-agent heuristic. Source reads, edits, builds and
tests were available. Failed agent-authored helper commands and their corrections
remain part of each attempt and its cost; an ordinary-arm internal stream retry
also remains included.

The CodeFacts arm had **two confirmed `CreateProcess ... blocked by policy`
rejections**, separate from its benign Git warnings. One combined validation
setup/execution/cleanup command and one later cleanup command were rejected
before launch. Later rewritten commands completed, but that recovery does not
remove the interference. All arms used the same execution policy. The logs do
not identify the rejecting rule or establish a CodeFacts-specific policy or MCP
failure. This arm remains `environment-interfered` and ineligible for a clean
efficiency comparison even though its patch passed quality review. Original
flags and logs are retained without changing the parser after the freeze.

There were 15, 14 and 15 emitted shell execution events respectively; the
CodeFacts transcript additionally records its two rejected shell attempts
(17 attempts). Logged shell output was 206,184, 292,346 and 279,388 bytes. These
are shell-specific counts; edit-tool calls are separate, and output bytes may
precede model-visible truncation.

Formal usage totals **1,842,741 tokens**. The three clean readiness runs cost
153,179 tokens; the earlier excluded readiness cost 108,577. Thus recorded agent
usage including readiness is **2,104,497 tokens**. Installation, build and native
readiness receipts are retained separately. Controller, reviewer and evaluator
engineering usage has not been aggregated at this cutoff, and actual billing is
unknown. This measured subset does not establish total project cost or ROI.

### Patch acceptance and delivery

The independent reviewer received anonymous patches and acceptance evidence
without arm identities or efficiency figures. All three passed Q1-Q4 after
source review, inspection of all 72 Windows probe records, and verification of
each patch's complete 162-test run. This checks actual owned removals, matching
writer-close events, expected injected failures and unchanged sentinels; it does
not rely on an agent's final answer or the automatic summary alone.

The CodeFacts and CodeGraph patches were byte-identical. Both register `t.after`
immediately after each owned temporary directory is created and protect the
SQLite writer with an inner `finally`. Existing reader closure, environment
restoration and test assertions remain. The ordinary patch also passed, using
broader `try/finally` wrapping with more indentation changes. The reviewer
recommended the identical smaller patches on maintainability grounds.

The selected patch also passed **24 probes and all 162 tests on Linux / Node
24.16.0**. Windows used Node 26.5.1. The OpenSession delivery worktree passed
`npm run review`, `npm run build`, the two complete test files,
`npm run pre-push`, and `git diff --check`.

The repair is committed in the OpenSession repository:

- Branch: `codex/test-fixture-cleanup`
- Commit: `d4d9ae36e9c8d75bd01e04afdc5f31c6b93fab92`
- Files: `test/core.test.mjs`, `test/codex-provider.test.mjs`
- Delivery: independent, clean worktree; local commit, not pushed or merged.

All 48 preexisting dirty OpenSession files retain their initial hashes, and its
working-tree status is unchanged. The patch passes `git apply --check` against
that live tree. This delivery addresses the seven frozen fixtures; the issue's
SEA smoke lifecycle and historical TEMP files were not part of this acceptance.

To repeat deterministic acceptance, use a separate installed/built OpenSession
checkout containing the repair and a fresh output directory. No model calls are
needed:

```powershell
node benchmarks/agent-eval/temp-cleanup/acceptance.mjs `
  D:/Eval/opensession-patched D:/Eval/temp-cleanup-check
```

The evaluator uses Node preload probes and requires the target's existing tests
and built output. Run it on a disposable checkout, not a live development tree.
Preserve existing result directories as evidence.

## Keep/stop decision

Retain **limited maintenance** of CodeFacts and stop this campaign. The work
delivered a real OpenSession fix and made the evaluation runner support isolated
edit-and-test tasks, explicit model/reasoning settings, and per-arm temporary
roots. It also fixed the observed account-app catalog isolation gap. The runner
change passed 15 tests and independent review in commit `687a8fb`.

This task exposed no queried retrieval defect and supplies no evidence for
expanding the five-tool product surface. A later investment should start from a
reproducible correctness, freshness, installation or retrieval failure, or new
independently sourced consumer work with a frozen decision and acceptance gate.
Reusing these deterministic fixtures is appropriate; rerunning this model task
with stronger MCP instructions would be a different experiment, not a repair of
the current result.
