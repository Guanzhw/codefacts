# Agent navigation pilot — 2026-09-11

CodeFacts has not established a repeatable agent-efficiency advantage. This pilot
found a lower-token known-symbol answer and a higher-token failure investigation,
while the configured CodeFacts arm skipped MCP on the third question. All nine
answers passed source-based grading. The next investment should be a bounded
correctness/discovery improvement and repeated evaluation.

Use [EVALUATION.md](EVALUATION.md) for metric definitions and investment criteria.
The compact measurements are in
[pilot-results.json](../benchmarks/agent-eval/pilot-results.json); the
[runner](../benchmarks/agent-eval/README.md) and
[rubric](../benchmarks/agent-eval/pilot-rubric.md) support subsequent experiments.

## Conditions

- Windows, Codex CLI 0.153.4, `gpt-5.6-luna`, medium reasoning. Same base prompt,
  normal read/search tools, and approximately 250-word final-answer instruction.
- Three arms: ordinary tools; ordinary tools plus CodeFacts v0.1.13 built from
  `76bae6820c3032e952dbfb5aeb8560b949af185c`; ordinary tools plus
  `@colbymchenry/codegraph@1.6.0`, using its `codegraph_explore` MCP workflow.
  CodeFacts offered all five workflows with default auto-LSP; observed calls
  used `map`/`search`, with LSP servers deferred. This compares these configured
  integrations, not every possible mode of either product.
- Source archives: CodeFacts at the above revision; OpenSession at
  `994942690fe5d1854398017026ef3615b2fdd24f`. After execution, all 97 and 307
  archived files respectively remained byte-for-byte unchanged. Archive hashes
  and per-run raw-log hashes are retained with the measurements.
- Three single-turn questions, one repetition per arm, two repositories.
  These are source-reading questions, not edit-and-test tasks.
- Warm prebuilt indexes. Timings include agent process launch and MCP startup;
  installation/cold indexing is excluded. Some arms overlapped on the same host,
  with staggered starts. Cache and load were not controlled enough for a latency
  ranking. No actual dollar billing was measured.
- All arms received the same conditional instruction: use a configured
  code-navigation MCP for the first inspection, then ordinary reads as needed.
  The agent still chose shell-only navigation in one CodeFacts run.
- Unrelated plugins, project instructions, web tools, and nested agents were
  disabled. Source reads and MCP connectivity were preflighted. Earlier attempts
  with denied reads/approval failures were excluded as invalid environments,
  and their raw evidence retained locally as harness overhead.

## Observations

Tokens below are cumulative input plus output, including cached input once.
They are neither the final answer length nor the maximum context window.
Each cell is a single observation; differences have no confidence interval.

| Question | Ordinary tools | + CodeFacts | + CodeGraph | CodeFacts vs ordinary tools |
| --- | ---: | ---: | ---: | ---: |
| Transaction and nested operations | 240,434 | 171,251 | 132,877 | 28.8% fewer tokens |
| Relationship extraction failure | 460,988 | 694,458 | 478,681 | 50.6% more tokens |
| Provider contract and error handling | 471,637 | 387,420 | 348,084 | 17.9% fewer; CodeFacts unused |

Every answer scored 4/4 against the source-checked rubric. The independent
reviewer read answers and source evidence without token/timing measurements;
arm labels were visible, so grading was cost-blind rather than fully anonymized.
The primary investigator separately checked accounting and actual tool calls.
No evaluation-answer/index content was observed in the inspected retrievals;
all nine stdout usage records reconciled with final rollout cumulative usage.
These manual decisions are recorded separately from the runner's deliberately
pending automated audit status.

| Question | Seconds: ordinary / CF / CG | MCP calls: CF / CG | Final request input: ordinary / CF / CG |
| --- | --- | --- | --- |
| Transaction | 59.2 / 35.5 / 48.8 | 1 / 1 | 31,086 / 35,798 / 34,405 |
| Extraction failure | 89.9 / 110.2 / 95.9 | 4 / 1 | 56,866 / 71,229 / 53,595 |
| Provider contract | 72.7 / 66.8 / 71.3 | 0 / 1 | 64,645 / 56,823 / 51,916 |

The transaction case illustrates why processed tokens and occupied context need
separate metrics: CodeFacts used fewer cumulative tokens, yet its final request
had more input context than the ordinary-tools arm. Cached-input breakdowns are
in the JSON; these numbers alone cannot establish cheaper billing.

Across this fixed three-question workload, ordinary tools used 1,173,059 tokens,
the CodeFacts arm 1,253,129, and the CodeGraph arm 959,642. Each arm completed
three correct answers. CodeFacts therefore used 6.8% more total tokens than
ordinary tools and 30.6% more than CodeGraph in this workload. The median
task-pair saving against ordinary tools was 17.9%, showing how a median can hide
an expensive regression. The configured-arm totals retain the MCP non-use case;
they do not measure the causal effect of CodeFacts query execution.

## What the traces explain

- Transaction search returned `with_transaction`, its source, relationships,
  and the rollback test. The agent then made three source-reading commands,
  compared with six in the ordinary-tools arm. This is a promising lookup case.
- The failure task began with `map`, then two empty CodeFacts searches for
  `relationship extraction` and `incomplete index`. A third search for
  `extract failed` returned facts, followed by ten shell calls. The added
  discovery steps did not eliminate the broad source investigation. This trace
  motivates measuring discovery usefulness and repeated queries; it does not
  prove that those steps caused the entire token increase.
- CodeGraph used one MCP call per question and fewer total tokens than the
  CodeFacts arm on all three observations. This is a reason to investigate its
  discovery workflow, not a statistically established product ranking.
- In an earlier separate natural-choice transaction trial, both configured
  tool arms made zero MCP calls. All three answers passed. That trial informs
  adoption/guidance design and is not pooled with the guided condition.

## Next improvement cycle

1. Repair the separately reproduced unsupported `client.charge()` binding before
   adding relationship breadth. Gate on zero false confirmed/static bindings
   in that fixed adversarial case, and preserve known true-edge recall.
2. Investigate the observed empty discovery queries and the cost of repeating
   source inspection. Compare a narrow search/guidance change against the
   unchanged baseline; track correct completion, cumulative tokens, final
   context, and query usefulness together.
3. Run the preregistered larger task mix and held-out tasks in EVALUATION.md,
   including repeated trials and real code changes, before claiming a stable
   percentage improvement or expanding investment. Freeze thresholds before
   execution and include failures and non-use.

External retention and maintenance return are still unmeasured. The provisional
20% improvement and repeat-user targets remain investment criteria; this pilot
does not certify either target.
