# Same-task agent benchmark

The product benchmark must measure whether an agent completes the same source
investigation correctly, how long it takes, and how many provider-reported
tokens it consumes. Native query latency and response bytes remain separate
engineering metrics.

## Required comparison

- Ordinary source search, file listing and source reads, with no CodeFacts or
  CodeGraph exposed or invoked.
- CodeFacts 0.1.7 plus the identical ordinary source tools.
- CodeFacts 0.2.2 plus the identical ordinary source tools.
- Pinned CodeGraph plus the identical ordinary source tools.

Use one fixed DSH runtime and `opencode-go / deepseek-v4.1-flash`, with identical
model settings. Freeze executable identities, corpus content, task prompts,
grading criteria, conditions and schedule before scored calls. Keep grading
material outside model-visible roots.

## Measures

Report complete task wall time, uncached input, cache reads/writes, full input
when available, output, reasoning when available, authoritative total tokens,
actual ordinary/native tool calls, completion and correctness. Preserve missing
usage as unknown and include unsuccessful attempts in workload cost.

Correctness requires all four source-backed task criteria and no critical false
claim. Compare paired time/token savings only when both answers pass. Report
the number of eligible pairs and cost per correct completion alongside total
workload cost.

## Durable acceptance

The repository contains a configurable runner, source-tool bridge, accounting
and summarization tests, frozen task/rubric suite, documented commands and a
reviewed result artifact. Raw source-bearing traces and machine paths stay in
the local campaign directory. Offline checks make no provider requests.

The initial suite covers six read-only investigations across JavaScript, Rust
and Go repositories. It measures source investigation rather than patch quality.
Future suites may add edit-and-test tasks under independently frozen acceptance
checks.
