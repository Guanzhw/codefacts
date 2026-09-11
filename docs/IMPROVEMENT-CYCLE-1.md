# Improvement cycle 1 — correctness and useful discovery

Plan frozen before the before/after task runs. This follows the
[initial pilot](EVALUATION-PILOT-2026-09-11.md) and uses its source snapshots and
grading rubric. It is a focused local improvement, not a release or a universal
efficiency claim.

## Hypotheses and acceptance

| Observed problem | Narrow intervention | Acceptance |
| --- | --- | --- |
| `client.charge()` on an unknown receiver becomes a static edge to an unrelated unique `charge()` definition | Preserve receiver uncertainty in extraction and rebinding; invalidate old persisted interpretation | Zero false static paths on the reproduced case; source-backed direct-call positive controls remain reachable; new/cached/incrementally updated indexes agree |
| Failure investigation used `map`, two empty multi-word searches, then broad source reads | State prefix-AND search semantics and encourage known identifiers, short terms, and contextual results in MCP descriptions | Compare empty/repeated queries, cumulative task tokens, and final context; preserve answer correctness |

The search implementation and five-tool interface remain unchanged in this
cycle. Retrieval is still exact/prefix FTS over indexed facts; broader query
semantics would require separate evidence and relevance evaluation.

Source review before the experiment found two related resolver defects: empty
callable sets could retain a raw edge to a same-named variable, and incremental
rebinding could retain old ambiguity/truncation metadata after candidates
changed. The repair covers these at the same candidate-materialization boundary,
with a scalar-variable negative case and an ambiguity-to-single-target positive
case. The efficiency thresholds and task questions remain unchanged.

## Task experiment

Run old and candidate binaries on the same three pinned questions and source
snapshots from the pilot, twice per arm (12 observations). Keep Codex CLI,
model/effort, base tools, conditional MCP-first guidance, and grading unchanged.
Use fresh agent sessions, warm tool indexes, and paired/interleaved scheduling.
Record the order and resource overlap. Required tools must connect, actual calls
must be reviewed, and usage must reconcile before an observation is eligible.

The main efficiency target is a 20% reduction in median tokens on the failure
investigation task, with all answers passing. Also report each other task and
total workload cost; investigate a greater-than-10% regression on the known-symbol
task. These are preselected local decision thresholds, not statistical proof.
Keep missing usage, timeouts, and non-use explicit. Grade answers independently
of their token/timing values. Billing and multi-turn savings remain unmeasured.

A correctness repair can be retained independently of token results. Retain
guidance only when the task traces support its utility; revise or remove it if
it introduces a measured regression. Record results and the decision below
after implementation and validation.

## Implemented correctness result

- Member-call candidates now carry `heuristic` confidence even when unique;
  one candidate is labeled `unresolved_receiver`, multiple candidates
  `polymorphic`. A missing callable becomes an unresolved target rather than a
  same-named scalar/variable edge.
- Rebinding replaces candidate-owned uncertainty/count/truncation metadata,
  allowing a formerly ambiguous direct call to become static once resolved.
- Fact extraction version 4 requests a source rebuild of existing version-3
  indexes. The SQLite schema shape and five-workflow interface are unchanged.
- MCP descriptions now explain prefix-AND query semantics, short identifier
  searches, contextual results, and when an overview is useful.

Independent Windows stdio verification used the old binary to create a database,
then opened that same database with the candidate. Unknown-receiver and
shadowed-class paths changed from `ok` to `no_static_path` (two false static
paths to zero in these two cases). The imported direct-call control stayed `ok`,
and all three unchanged source files were reindexed on upgrade. This is a
fixture result, not a population-wide accuracy percentage.

The full test suite passed: 720 library, 3 evaluation-fixture, 1 modern-protocol,
28 MCP-protocol, and 1 benchmark-example test. `cargo fmt --check`,
`cargo clippy --all-targets -- -D warnings`, and whitespace checks passed.
Receiver-type resolution remains outside this repair: some real dynamic method
calls are now visible only as candidates until a binding can be established.

## Measured task result (2026-09-11)

The [portable results](../benchmarks/agent-eval/cycle-1-results.json) contain all
12 observations, exact questions, source revisions, binary/source hashes, MCP
queries, token components, paired differences, and independent grades. The
candidate was built from the working tree on base revision
`76bae6820c3032e952dbfb5aeb8560b949af185c`. CodeFacts and OpenSession task sources
remain the same archived snapshots as the pilot, separate from this worktree.

| Task | Before median tokens | After median tokens | Change | Source-rubric score, before / after |
| --- | ---: | ---: | ---: | --- |
| Known-symbol transaction behavior | 151,348.5 | 150,086.5 | -0.83% | 4 / 4 |
| Relationship-extraction failure investigation | 609,092 | 641,453 | +5.31% | 3 / 3 |
| Provider interface and consumer tracing | 494,164 | 270,648.5 | -45.23% | 3 / 3 |

Each median contains two runs. All 12 answers pass the frozen rubric, with
identical task scores across repetitions and arms. Scores of 3 retain secondary
omissions: failure answers did not explicitly identify the absence of an exact
Pass-2 injected-failure regression, and provider answers omitted some contract
boundaries. Passing does not mean exhaustive coverage.

Across the fixed six-task workload per arm, cumulative tokens fell from
2,509,209 to 2,124,376 (15.34%). Tokens per correct completion fell from
418,201.5 to 354,062.7, including every attempted task. MCP calls fell from
21 to 13 and shell calls from 36 to 31. These are diagnostics of this workload;
individual paired changes range from a 35.77% increase to a 51.18% reduction.

Uncached input **increased** from 302,291 to 314,055 (+3.89%). Total tokens count
input plus output, with cached input included once. Actual billing is unknown;
the total-token reduction does not establish a fee reduction. Cold setup,
multi-turn context, real code changes, adoption, and competitor performance
were not measured in this cycle.

Each pair ran at most two agents concurrently. Repetition 1 launched before
then after; repetition 2 reversed that order. Source and MCP preflights passed,
all runs actually used MCP, and cumulative usage reconciled with saved rollouts.
Post-run archive checks found no changed files across 97 CodeFacts and 307
OpenSession files. Manual direct/nested-call review found no contamination or
blocked calls. One baseline run attempted Git history/status in an archive;
both returned `not a git repository`, so no history was exposed. Raw automatic
review flags remain unchanged; manual eligibility and grades are separate
fields in the portable results. Source-bearing raw logs remain local.

## Decision and next bounded improvement

**The primary 20% failure-investigation target was missed.** The known-symbol
10% regression threshold was not triggered. Retain the correctness repair based
on the reproduced false paths, migration check, and positive controls.

Provisionally retain the guidance adjustment because both provider runs used
one contextual search followed by ordinary source reads, whereas the old runs
added three or four `expand` calls; both new runs used fewer tokens at the same
grade. The failure-task regression remains a failed outcome, not a successful
guidance result. This supports a further bounded investigation, not expanded
product investment. Resolver and guidance changes were measured together, so
these observations cannot isolate the effect of the descriptions alone.

Failure traces explain the next hypothesis: shorter queries still returned
broad contextual candidate sets and led to repeated source reads. Fewer empty
searches did not lower total task tokens. Before changing retrieval semantics:

1. Identify repeated source spans and unused contextual payload in the retained
   failure traces; measure their bytes and repeated appearances separately from
   provider-reported tokens. Change only payload or guidance with observed
   waste and retain evidence locations and uncertainty.
2. Hold the version-4 resolver fixed. Compare the current guidance against one
   narrower discovery/context change, using the same failure question plus
   newly frozen held-out discovery questions and source rubrics.
3. Keep the 20% within-task median reduction target on the original failure
   question, require all quality checks to pass, and investigate any greater
   than 10% median regression on the other questions. Freeze repetitions and
   budget before running; do not add favorable samples after seeing results.
4. If the target is missed again or held-out quality regresses, revise or remove
   the guidance change and retain correctness maintenance. A larger cross-tool
   campaign is required before claiming an enduring productivity advantage.
