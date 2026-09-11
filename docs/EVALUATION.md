# Product value and continuous improvement

CodeFacts earns continued investment by helping agents complete repository tasks
correctly with less time and token consumption. Measure that outcome against
ordinary file/search tools and a relevant code-intelligence alternative.

This scorecard separates product value from index speed. The repository-level
latency and resource runner remains documented in [PERFORMANCE.md](PERFORMANCE.md).
Thresholds below are initial decision targets, not measured product claims.

## Basis and cross-tool applicability

These are task-outcome metrics, with tool-specific diagnostics underneath:

- Correctness and task completion come from this product's source-backed fact
  contract and a source-verified task rubric. They are not inferred from tool
  output size or an LLM's confidence.
- Token components follow the evaluated provider's accounting. For the initial
  Codex runner, see [non-interactive JSON usage](https://developers.openai.com/codex/noninteractive)
  and retain the raw per-run usage rather than estimating tokens as characters/4.
- The distinction between cumulative token processing and retained context is
  also demonstrated in CodeGraph's [residual context occupancy evaluation](https://github.com/colbymchenry/codegraph/blob/main/docs/benchmarks/residual-context-occupancy.md).
  Its published measurements describe its own experiment, not CodeFacts gains.
- The percentage and adoption targets are provisional project investment
  criteria. Adjust them to user workload and maintenance cost before a campaign;
  never select a favorable threshold after seeing results.

| Comparison layer | Comparable across tools | Conditions |
| --- | --- | --- |
| User task | Correct completion, total tokens, wall-clock, actual cost, follow-up quality | Same source revision, task, model/effort, acceptance criteria, and allowed base tools; record prompt and integration differences. |
| Returned evidence | Relation precision/recall, source-citation accuracy | Same labeled cases, relation semantics, scope, and capability coverage; preserve unknown states. |
| Tool implementation | Index latency, resident memory, query latency, output size | Same files and environment; report different index coverage and included work. These explain outcomes rather than rank the whole product. |
| Adoption and maintenance | Continued meaningful use, engineering/support effort | Same observation window and definition of useful activity; compare personal and external usage separately. |

An MCP add-on comparison holds the agent constant and changes the tool. Comparing
complete agents changes the intervention: even with the same underlying model,
different system prompts, editing loops, and caching belong to the whole-agent
result. Label those studies separately. Compare tools on shared supported tasks
and also show coverage on the full intended workload; do not silently exclude a
competitor's strengths or a tool's unsupported cases.

## Primary outcome

Track **correct task completion rate together with tokens and elapsed time per
correct completion**. Every task has source-backed acceptance criteria fixed
before running the arms. A material false structural claim fails the task even
when the response is otherwise plausible or inexpensive.

For each arm, report:

- Correct completions / all attempted tasks, including errors and timeouts.
- Total processed tokens = input tokens + output tokens across model requests.
  Cached input is a subset when reported that way by the provider; do not add it
  again. Retain cache-read, cache-write, and reasoning fields separately with the
  provider's semantics. Do not add reasoning twice when it is part of output.
- Tokens per correct completion = tokens spent on **all attempts**, including
  failed attempts, divided by correct completions. Report undefined when no task
  passes. Run the analogous calculation for time and actual billed cost.
- Matched-task token and time differences, medians, spread, and task-level
  confidence intervals. Show failures separately; avoid ranking only the easy
  tasks both tools happened to solve.

The observation unit is one arm × task × repetition. Token savings against
baseline are `1 - tool_tokens / baseline_tokens` for a matched pair of correct
completions. Report nonpassing pairs as failures rather than a savings percentage.
Aggregate within task first, then across the fixed task mix. Also
report total workload consumption so one expensive task is visible. Negative
savings are regressions. Cached tokens affect price and latency differently;
report actual billed cost only when available rather than pricing subscription
usage as an API bill.

## Scorecard

| Dimension | Measure | Initial improvement target / constraint |
| --- | --- | --- |
| Evaluation validity | Required tools connected; source reads permitted; uncontaminated runs; complete usage accounting | Pass the environment preflight before comparing task efficiency. A completed process is not a correct answer. |
| Task correctness | Acceptance pass rate; unsupported structural claims; citation correctness | No material accuracy regression against baseline. Zero unsupported confirmed edges in the fixed adversarial regression set. |
| Fact quality | Edge precision and recall against labeled source cases, split by language and relation kind; unresolved/heuristic proportions | Improve precision without hiding lost recall. Never count parse support as proof of semantic resolution support. |
| Task token efficiency | Total tokens; uncached input; output; tokens per correct completion | Target at least 20% lower median task tokens on the intended task mix, with correctness preserved. |
| Task time efficiency | End-to-end completion time; timeouts; time per correct completion | Target at least 20% lower median completion time, or a demonstrated token advantage without a material time penalty. |
| Multi-turn context | Final and peak request input tokens; compactions; retrieval bytes still resident if directly attributable | Reduce retained context without losing follow-up answer quality. Total processed tokens and occupied context are separate metrics. |
| Retrieval usefulness | MCP adoption per eligible task; repeated query rate; file rereads; tool-output bytes; relevant evidence returned and used | Diagnose why task outcomes improve or regress. Tool-call count and short output are not standalone success criteria. |
| Runtime cost | Cold index, no-change/one-file refresh, warm query P50/P95, process memory, SQLite size, startup failures | Track by repository and platform; prevent regressions beyond measurement noise. Include optional LSP startup separately. |
| Continued use | Weekly meaningful uses; four-week retention; tasks solved; user-reported avoided work | For external product investment, seek at least five independent users completing useful work in three of four weeks. Treat this as a discovery target. |
| Maintenance return | Engineering hours per measured improvement; regression/support load; developer time saved | Expand effort only when useful outcomes outweigh ongoing maintenance. Separate personal utility from external product demand. |

An eligible task is one for which the specified code tool supports the required
language and workflow. Still report unsupported tasks in the full workload;
publish eligibility before testing to avoid selecting only favorable cases.
Usage can initially be recorded manually or from opt-in local evaluation logs.
npm downloads, stars, installs, and synthetic tests are not retained users.

## Comparison protocol

1. Freeze source revisions, questions, expected facts, grading rubric, tool
   versions, model, reasoning effort, prompts, and output requirements.
2. Compare three arms: base read/search tools; the same base plus CodeFacts; the
   same base plus a named alternative. All arms keep normal source-reading
   access. Record tool-specific startup instructions and schema overhead.
3. Use isolated source snapshots. Disable unrelated plugins, memory, nested
   agents, web access, and project instructions for the controlled experiment.
   Do not permit reading evaluation answers, previous runs, or another arm's
   index via the shell. Audit actual tool calls for contamination.
4. Verify each MCP connects and can answer a substantive query. A failed startup
   is an availability result, not a completed comparison without the tool. If
   an agent chooses not to use an available tool, retain that intention-to-use
   result and report non-use explicitly.
5. Separate cold installation/index setup from warm task execution. Include both
   in first-use economics. Randomize or interleave arm order; keep concurrent
   resource pressure comparable and document cache effects.
6. Start with a small pilot to validate the harness. For an investment decision,
   use at least 12 tasks across three repositories and three repeats per arm;
   include known-symbol lookup, natural-language discovery, cross-file chains,
   change investigation, ambiguity, and absent relationships. Hold out some
   tasks from tuning, and cover the languages of actual users.
7. Include at least four three-turn sessions and some real edit-and-test tasks
   before claiming coding productivity or multi-turn context improvement.
   Repository question answering alone establishes navigation efficiency.
8. Grade anonymized answers against the frozen source rubric. A second reviewer
   checks material claims and ambiguous cases. Retain raw output, tool calls,
   provider usage, failures, and run metadata; report missing fields as unknown.

The initial 20% target is a practical investment hurdle. A pilot cannot establish
a universal percentage. Report confidence intervals over tasks for the larger
campaign and distinguish a promising point estimate from a stable advantage.

Record timing boundaries explicitly: setup runs from install/index start to
readiness; a warm task runs from agent process launch through its final answer
(including MCP startup); first-use time is setup plus that task, without counting
indexing twice. Measure tool-service latency separately. An environment preflight
failure invalidates the matched experiment; keep its diagnostics and accounting
as harness overhead, not as evidence of a product's token savings.

## Improvement loop

For each proposed change, record one hypothesis and its observed failure case:

| Field | Required content |
| --- | --- |
| Problem | Real task/query, source revision, observed failure or excess cost |
| Primary metric | Which outcome should improve, baseline, and desired change |
| Quality constraints | Facts and completeness that must remain correct |
| Narrow change | Owning extractor, resolver, query, or response field |
| Validation | Regression fixture plus matched before/after task runs |
| Decision | Keep, revise, or revert based on measured results |

Prioritize the largest measured loss. For example: fix unsupported target
binding before expanding transitive impact; reduce repeated evidence payloads
when they measurably inflate request context; improve discovery when empty or
poorly ranked results force repeated searches. Add a workflow only when these
measurements identify an unmet consumer need.

Run focused correctness checks on each change. Run matched task evaluations for
changes to extraction, resolution, ranking, result shape, or tool guidance.
Review the scorecard after each improvement cycle and before expanding scope;
reserve the larger cross-tool campaign for a release or an investment decision.
Protocol, source-span, and existing release checks remain required independently.

## Investment decisions

- **Continue focused improvement:** quality constraints pass and at least one
  meaningful efficiency target is met reproducibly; users repeat the workflow.
- **Investigate another bounded cycle:** evidence is incomplete or savings have
  high variance, but failure analysis identifies a concrete fix. Name the next
  experiment and its stopping condition.
- **Maintain with limited expansion:** successive matched campaigns show little
  benefit, an alternative dominates relevant tasks, or maintenance exceeds the
  time saved. A useful personal tool can remain worthwhile at this level.
- **Prioritize correctness repair:** a confirmed-relationship claim lacks binding
  evidence. Speed gains do not offset this defect.

Keep correctness, efficiency, and adoption visible separately; an averaged
composite score would conceal a failed correctness constraint.

## Initial evidence (2026-09-11)

- The 2026-09-10 Windows smoke established working source-backed queries and
  millisecond-scale warm search on two local repositories. It did not measure
  agent task savings.
- A two-file TypeScript case linked `client.charge()` on an `any` receiver to an
  unrelated uniquely named local `charge()` as a `static` edge; `path` returned
  it as a successful path in v0.1.13. The working-tree repair and version-4
  extraction migration are verified in [improvement cycle 1](IMPROVEMENT-CYCLE-1.md).
- The [three-arm navigation pilot](EVALUATION-PILOT-2026-09-11.md) found mixed
  task-token results, including a regression on failure investigation and MCP
  non-use on one question. It does not establish repeatable savings.
- [Improvement cycle 1](IMPROVEMENT-CYCLE-1.md) compared old/new binaries on
  three questions twice per arm. All 12 answers passed; workload tokens fell
  15.34%, but failure-investigation median tokens rose 5.31%, missing its
  preselected 20% reduction target. Uncached input rose 3.89%; billing remains
  unknown. This supports bounded investigation rather than a general claim.
- [Improvement cycle 2](IMPROVEMENT-CYCLE-2.md) completed 20 frozen runs and
  anonymous independent grading. Candidate quality rose from 8/10 to 10/10,
  and tokens per correct completion fell 15.93%; raw workload tokens rose
  5.09%. The complete passing comparison required by its primary target was
  unavailable, and two same-score task medians regressed about 46%. The
  description-only candidate was reverted under the frozen rule. Engineering
  and evaluation consumption are recorded separately; no deployed savings or
  stable product advantage is claimed.
- The [bounded value screen](VALUE-SCREEN-2026-09-12.md) compared the repaired
  binary with ordinary tools and pinned CodeGraph on two questions. CodeFacts
  passed 1/2 versus 2/2 for each comparator. Known-symbol lookup passed and used
  44.97% / 60.38% fewer tokens respectively, while failure investigation failed
  the frozen rubric. The implemented decision is limited maintenance and narrow
  lookup validation, without a larger campaign. An offline summary now reuses
  reviewed results without model calls.
- Multi-turn retention, external user retention, and maintenance return remain
  unmeasured. Do not report them as zero or assume a benefit from bounded results.

The [development runner](../benchmarks/agent-eval/README.md) retains provider
usage and raw task evidence. Keep each campaign separate from these stable
metric definitions so subsequent campaigns can replace the baseline.
