# OpenSession real-history evaluation with Luna

## Correction to the interpretation of the owner's objective

The owner's original objective was **better effectiveness while also controlling
token cost, with effectiveness taking priority**. On 2026-09-20, after this
campaign, we corrected our interpretation: treating token savings as a necessary
condition for continued work had overemphasized efficiency. The recommendation is bounded,
quality-focused investigation and improvement: retain CodeFacts and diagnose the
observed H05/H06 answer defects. A reproducible gain in correctness, completeness,
or useful capability can justify proportionate additional tokens. Measure and
reduce unnecessary token overhead in the same work; at comparable quality,
prefer the more efficient approach. Do not replace CodeFacts solely because
CodeGraph costs less.

The existing results do not prove that CodeFacts is more effective: 12/12 passes
coexist with 9/12 fully correct answers, versus ordinary inspection's 11/12 and
10/12, and CodeGraph's 11/12 and 11/12. The sample and grading sensitivity require
an explicit tradeoff rather than a new winner. The [scorecard](EVALUATION.md) and
[current plan](IMPROVEMENT-PLAN.md) now reflect the original objective explicitly.

All measurements, grades, frozen rules, and the original interpretation below
are preserved. This is a correction to our investment judgment, not a change in
the owner's goal, a rerun, or a retrospective change to the experiment's success criteria.

## Original interpretation under the frozen efficiency gate

The original recommendation was to keep CodeFacts in limited maintenance.
This campaign does not establish
a material, repeatable advantage over both ordinary source inspection and
CodeGraph. CodeGraph is the lower-token option in the aggregate, but its failed
deferred-field diagnosis prevents claiming that it strictly dominates CodeFacts.
Keep ordinary inspection as the baseline; do not require either MCP on every task.

All 36 planned attempts finished. The evaluated agent was `gpt-5.6-luna` with
medium reasoning in every attempt. Both tool arms actually used relevant MCP
queries in all 12 attempts; this resolves the non-use limitation of earlier pilots.

## Results

The primary rubric follows the frozen global business-equivalence rule: at least
3 of 4 source-backed criteria, without a material false claim. Passing does not
mean that every detail is correct. Costs below include **all attempts, including
failed answers**, divided by the number passing. Total tokens include cached input;
uncached input is also reported, and reasoning tokens are already part of output.

| Arm | Pass / attempts | Fully correct 4/4 | Criteria points / 48 | Total tokens / pass | Uncached input / pass | Output / pass | Seconds / pass |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ordinary `rg` / source reads | 11/12 | 10/12 | 45 | 384,287 | 61,149 | 2,673 | 84.6 |
| CodeFacts | 12/12 | 9/12 | 45 | 400,423 | 65,348 | 2,061 | 69.1 |
| CodeGraph | 11/12 | 11/12 | 46 | 329,216 | 60,535 | 2,255 | 75.0 |

CodeFacts costs 4.2% more total tokens per passing task than ordinary inspection
and 21.6% more than CodeGraph. It is 18.2% faster per pass than ordinary inspection
and 7.8% faster than CodeGraph. Its one additional passing answer is accompanied
by fewer fully correct answers. These are descriptive results from six tasks,
not estimated population differences or evidence of statistical significance.

The preregistered secondary comparison matches only passing answers for the same
task and repetition, averages repetition differences within a task, then takes
the median across tasks. Positive values mean the left arm costs more.

| Comparison | Total tokens | Uncached input | Wall time | Matched repetitions / tasks |
| --- | ---: | ---: | ---: | ---: |
| CodeFacts vs ordinary | +16.5% | +39.1% | -10.0% | 11 / 6 |
| CodeGraph vs ordinary | -8.3% | +6.6% | -15.6% | 10 / 6 |
| CodeFacts vs CodeGraph | +17.1% | +42.2% | +11.4% | 11 / 6 |

The latency ordering changes between aggregation methods. Neither tool establishes
a consistent 20% task-token or time improvement with no quality regression, the
local investment gate frozen before execution. CodeGraph's aggregate token
advantage is concentrated in some tasks; it should not be advertised as a
universal saving.

## Task-level results and selection

The corpus comes from actual local OpenSession task history, rewritten as six
read-only questions. Each has four criteria and raw-file hashes/source spans.
It covers discovery, cross-file tracing, provider boundaries, token ownership,
and a proposed performance change. It is not an edit-and-test benchmark.

Each cell shows **passes / 2; mean total tokens per attempt**. Failed attempts
remain in these means.

| Task | Ordinary | CodeFacts | CodeGraph |
| --- | ---: | ---: | ---: |
| H01 Codex reader capture and provider dispatch | 2; 242,597 | 2; 281,602 | 2; 286,306 |
| H02 Blank Runtime workbench investigation | 2; 356,348 | 2; 379,747 | 2; 312,487 |
| H03 Pi native v3 construction | 2; 268,051 | 2; 320,501 | 2; 363,924 |
| H04 OpenCode SQLite vs Codex JSONL boundary | 2; 470,112 | 2; 507,040 | 2; 202,420 |
| H05 Child-token ownership and duplicates | 1; 281,623 | 2; 454,639 | 2; 207,169 |
| H06 Deferred markup, retry, and search | 2; 494,850 | 2; 459,008 | 1; 438,382 |

H01 is explicitly exposed: an earlier native replay had shown an exact CodeGraph
query miss. In this agent campaign both CodeGraph answers passed after broader
exploration/source reads. H01–H03 were exposed to earlier history inspection;
H04–H06 are new to task evaluation but come from the same history family. Their
pass counts are respectively 6/6 for every arm, then ordinary 5/6, CodeFacts 6/6,
CodeGraph 5/6. The latter group is not a statistically held-out sample.

Two actual failures explain why cost cannot replace quality:

- H05 ordinary repetition 1 conflated the general copied-record prefix with the
  token-only fallback and narrowed adjacent duplicate detection to cross-format
  events. The token-only fallback needs two complete leading usage snapshots,
  without a replayed parent-metadata header. CodeFacts repeated the cross-format
  narrowing in both repetitions but still passed 3/4. The frozen parser's comment
  says cross-format while its implementation accepts same-format adjacency too
  (`src/providers/codex/parser.ts:272–304,322–355`). This is a plausible source of
  the error, not proof that a particular retrieval tool caused it.
- H06 CodeGraph repetition 1 shifted attention to the separate process placeholder
  and omitted the progressive field's client status lifecycle and ownership
  coupling. It correctly rejected the stale server-status claim but scored 2/4.
  CodeFacts repetition 1 incorrectly said status is created only on failure,
  omitting stale/empty artifact responses; it passed 3/4. These partial answers
  show why a pass should not be described as a flawless answer.

## Tool behavior and operational evidence

| Arm | All-attempt total tokens | MCP executions | Shell executions | Visible shell-error calls | Output-truncated calls | Model-visible wrapper output bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Ordinary | 4,227,157 | 0 | 108 | 12 | 19 | 1,600,655 |
| CodeFacts | 4,805,072 | 25 | 81 | 5 | 21 | 1,999,822 |
| CodeGraph | 3,621,374 | 12 | 74 | 7 | 12 | 1,638,254 |

All tool attempts made substantive related queries. Whether a particular fact
contributed incrementally to the answer is often unknown because source reads
repeated the retrieved information. Invocation is not treated as proof of causal
usefulness. Shell-error counts are observed command-level failures, not retry
counts; one CodeGraph error suppressed stderr. Nonzero shell exits are recorded
separately because a no-match search can also return nonzero.

CodeFacts's 25 executed calls requested `full` seven times, `compact` nine times,
and omitted the format nine times. Full calls occurred in H01 and H05. Agents
frequently printed the whole MCP object, including both text content and
structured content; CodeGraph agents printed text content. Both tools were
usually followed by source inspection. CodeFacts therefore reduced shell calls
without reducing total output/context cost. This campaign measures the actual
guided workflow, not an isolated compact-format treatment.

The frozen harness's rollout heuristic counted static call sites and undercounted
loop/`Promise.all` executions in attempts 16 and 30. Published executed counts
come from `stdout.jsonl` `item.completed` MCP/command events; the original 17-call
CodeFacts heuristic and per-attempt counters are retained separately. This
postprocessing correction changes no token, time, answer, or grading observation.
No attempt exceeded the 16-call audit threshold after recounting.

Seven detector stops (17,18,20–24) were false positives: the old regular expression
mistook `/pi ` or `/opencode ` source-directory arguments for external agent
invocations. Every command was reviewed, original progress snapshots and
reviewer-attributed receipts were retained, and only stop/status was cleared. No completed
attempt was rerun. No actual formal environment failure, transport failure, tool
non-use, or source mutation was found. The repeated CLI `error` event was the
unchanged under-development-feature warning for disabled skill discovery.

## Scoring sensitivity

Initial graders inconsistently interpreted compound criteria as requiring every
internal parameter/cache field, despite the frozen global rule accepting business
equivalence and not requiring hidden implementation terms. A second independent
grader applied that global rule to all 36 answers without arm/cost metadata; root
reviewed disputed source semantics. In H05, root challenged an overly generous
copied-prefix interpretation and the adjudicator revised it to a failure.

Both score sets are published; no prompt, question, pass threshold, source, or
answer was changed. Initial-pass counts were ordinary **6/12**, CodeFacts **7/12**,
CodeGraph **8/12**; corresponding all-cost tokens/pass were **704,526**, **686,439**,
and **452,672**. These are a sensitivity view of grader ambiguity, not a second
experiment. The exact quality ranking is scoring-sensitive. The decision to avoid
major CodeFacts investment remains the same under both views; an unconditional
CodeGraph replacement recommendation would not be robust.

Grading removed arm, repetition, and cost metadata, but preserved answer text.
One H01 answer explicitly mentioned CodeFacts, so this was not complete double
blinding. Evaluated agents were Luna; grading/review assistants were separate
engineering work and are not included in evaluated-agent usage.

## Reproduction and cost

Use the [corpus README](../benchmarks/agent-eval/opensession-corpus/README.md),
[tasks and source evidence](../benchmarks/agent-eval/opensession-corpus/tasks.json),
[rubric](../benchmarks/agent-eval/opensession-corpus/RUBRIC.md), and
[history lineage](../benchmarks/agent-eval/opensession-corpus/PROVENANCE.md).
The [published results](../benchmarks/agent-eval/opensession-corpus/results/2026-09-20/results.json)
contain all 36 per-attempt metrics, initial/adjudicated criteria, raw-file hashes,
and runtime identities. The [recorded answers](../benchmarks/agent-eval/opensession-corpus/results/2026-09-20/answers.md)
preserve answer prose while mapping local source links to the frozen commit.

- OpenSession commit: `543e874e697523bf474f494bcf897a17f19587de`, 446 unchanged
  source files. Corpus construction validated 31 evidence spans in 17 files.
- Harness commit: `f060988dc44b8a9bdebf9045a36afb90220787a8`; freeze:
  `2026-09-19T17:57:01.639Z`. Reproduce historical hashes from that revision.
- CodeFacts source `30217876d5ebdaf73462205e51c0bf4dd7b28822`, package 0.1.14 plus
  the unreleased compact branch; binary SHA-256
  `66cae60808c437998a43eb9006908e9bdc62fa219feb404f88269caa77c1e5c7`.
- CodeGraph 1.6.0, upstream revision `dfccdf62547fcd76d343344d823a0e1998d3a89f`;
  bundled Node 24.16, complete distribution digest retained in results.
- Codex 0.155.0-alpha.9.2, full native runtime. All attempts used Luna/medium,
  240 seconds, the same read-only source path, and disabled automatic project
  instructions/plugins/apps/memory/skills. Tool arms first made a relevant MCP
  call, then freely chose subsequent reads. This measures guided use, not adoption.
- Two repetitions per task/arm, Latin rotation and reverse order, serial execution.
  Source, tools, schemas, prompts, rubric, and runtime hashes were checked at the
  end. Warm index masters were restored per tool attempt; their copy/setup time is
  separately recorded. Re-running reproduces the protocol, not identical stochastic
  model answers or server-side cache/latency conditions.

Cold native preparation was CodeFacts **4.009 s / 92,532,736 bytes / 308 indexed
files**, CodeGraph **3.371 s / 24,572,133 bytes / 242 indexed files**. Coverage differs,
so index sizes are not an equal-content compression comparison. These costs are
outside task latency.

Formal usage totaled **12,653,603 tokens**, including **2,122,694 uncached input**.
Readiness adds **265,367 recorded tokens**: 215,056 in this campaign plus 50,311
from the superseded initial campaign. The initial CodeFacts readiness failed
before model startup because of Windows TOML path escaping; its usage is
unavailable, and the failed directory is preserved. The fix was committed before
this independent campaign was frozen.

Parent engineering usage at `2026-09-19T19:00:41.398Z` was **26,760,119 processed
tokens**: 25,998,080 cached input, 676,064 uncached input, and 85,975 output.
This is a reporting cutoff and a lower bound on engineering cost: delegated
engineering usage is not aggregated, and it excludes the separately measured
formal/readiness agents. The substantial preparation and adjudication effort is
another reason to reuse this corpus rather than automatically start more campaigns.

Local raw logs, frozen indexes, initial campaign, manual-stop receipts, and all
grading versions remain under ignored `target/luna-opensession-20260920*`.
The committed publication contains no raw private task history. Twenty-two
harness/runner tests and all six CI jobs passed on the frozen harness revision.

## Original investment action (superseded by the update above)

Close this campaign. Preserve the bounded-response and correctness fixes already
implemented, but pause broad feature expansion and token-saving claims. A new
CodeFacts investment should require an independently reported consumer failure
or a capability with a measurable advantage; avoid another prompt-tuning round
on these six questions. CodeGraph is a reasonable optional navigation tool,
especially for the H04/H05 workflows, with the H06 failure retained as a guardrail.
This decision does not change installed tools or release the draft compact branch.
