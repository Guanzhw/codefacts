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
Both matched patches must pass before a token or time savings percentage is
reported. Preparation, evaluator work, and engineering usage are separate.
Subscription token counts do not establish an API bill.

The runner uses documented [Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode)
and the separate [apps feature setting](https://learn.chatgpt.com/docs/config-file/config-reference).
Live readiness, not the configuration alone, establishes actual source reading,
temporary-file writing, runtime APIs, and MCP connectivity.

## Results

Pending formal execution and independent review.
