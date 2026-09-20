# CodeFacts improvement plan

Owner: the contributor advancing the current project goal. Update this page
when a milestone finishes or new real-use evidence changes the next priority.
The [evaluation scorecard](EVALUATION.md) owns metric definitions and comparison
rules; this page owns the active queue and investment decisions.

## Current priorities

The owner's original objective is better effectiveness while also controlling
token cost, with effectiveness taking priority. On 2026-09-20 we corrected our
overemphasis on token savings as an investment prerequisite. Continue bounded
investigation and improvement of task quality, measuring and limiting token
overhead in the same work; failure to save tokens alone is not a reason to stop. The completed
[36-attempt Luna/OpenSession evaluation](LUNA-OPENSESSION-EVAL-2026-09-20.md)
remains unchanged: CodeFacts passed 12/12, versus 11/12 for each alternative, but
had 9 fully correct answers versus ordinary inspection's 10 and CodeGraph's 11.
These mixed, scoring-sensitive results establish neither an overall quality win
nor a reason to replace CodeFacts merely because CodeGraph uses fewer tokens.

The next priority is to diagnose the known H05 duplicate-usage and H06 status
lifecycle omissions using the existing evidence. Determine whether relevant
implementation facts were missing, obscured by result presentation, contradicted
by comments, or misinterpreted by the agent. Change CodeFacts only when its own
boundary is implicated. Any subsequent model comparison must freeze its quality
criteria and stopping rule first; the completed 36-run campaign stays closed.
Improve correctness and completeness while tracking token cost, reducing repeated
reads and redundant evidence where that preserves the quality gain. Judge the
benefit and its cost together, with effectiveness taking priority.

| Priority | Work | Evidence and completion condition | Status |
| --- | --- | --- | --- |
| 1 | Implement explicit member-query ranking | Native Top-1 improved 7/12 to 10/12 on earlier cases and 9/12 to 12/12 on a third repository; regression tests preserve pagination, filters and context. | Complete; retained in `5a88820`. [Results and cost](MEMBER-RANKING-IMPLEMENTATION-2026-09-13.md). |
| 2 | Verify usefulness during real repository work | The earlier diagnosis scored 2/4 in all arms. A new edit-and-test task delivered a real fix with all patches passing 4/4, but both MCP arms made zero formal calls and CodeFacts had execution-policy interference. No retrieval-efficiency gain was established. | Both campaigns closed; limited maintenance retained. [Diagnosis](ISSUE1-RUNTIME-RECOVERY-2026-09-13.md), [edit-and-test pilot](TEMP-CLEANUP-PILOT-2026-09-16.md). |
| 3 | Improve real-use output and navigation failures | Fixed: callback locals no longer enter top_level; compact MCP responses share hashes/anchors; expand has a 16 KiB page budget and snapshot-bound continuation. Two real expand cases retain equivalent facts with 44.2% / 44.8% fewer response bytes including continuation. | Implemented and verified locally; release/client update pending. Plugin source guidance is updated separately in agent-plugins. [Implementation and acceptance](COMPACT-RESPONSES-2026-09-20.md), [original audit](OPENSESSION-HISTORY-AUDIT-2026-09-20.md). |
| 4 | Compare real-history workflows with actual tool use | Six source-backed tasks, three arms, two repetitions, all evaluated with Luna/medium. All 24 tool attempts made relevant MCP calls. Initial and adjudicated scores, every attempt's cost, answers, and runtime hashes are retained. | Complete; campaign closed. Investment interpretation corrected to reflect the owner's original effectiveness-and-efficiency objective. [Results and decision](LUNA-OPENSESSION-EVAL-2026-09-20.md), [reusable corpus](../benchmarks/agent-eval/opensession-corpus/README.md). |
| Next | Diagnose incomplete or inaccurate task answers | Start from H05/H06 source, actual returned facts, and answers; distinguish a tool defect from misleading source comments or reasoning errors. A future change needs a source-backed quality acceptance case, not a token-saving prerequisite. | Planned; reuse existing evidence before new model runs. |
| Continuous | Maintain source correctness, freshness, and installation reliability | Reproduce a reported failure, fix its owning boundary, add the smallest meaningful regression and verify the affected native/protocol/platform surface. | Triggered by failures. |

## Delivery and investment loop

Advance one product change at a time: concrete failure or lookup evidence,
frozen acceptance cases, implementation, independent review, required checks,
native verification, then a scoped commit and measured keep/revert decision.
Use existing test runners and stored evidence. A result that fails its gate
closes that variant; reopen it only with new evidence, not another prompt tweak.

Recent cycles exposed costly repeated inspection, incorrect manually selected
source spans and fragile one-off evaluation scripts. Verify case spans against
source before running a comparison; have deterministic scripts capture native
responses and summarize results in one pass. Review the implementation and
owning evidence once, then revisit only concrete failures or changed code.
Record engineering usage separately from evaluated-agent usage at an explicit
cutoff. Fewer evaluation runs alone do not prove cheaper engineering.

The completed member-ranking milestone consumed 11,573,666 processed engineering
tokens at its reporting cutoff (10,951,424 cached input; 554,436 uncached input;
67,806 output). Its retrieval gate passed, but cheaper engineering and end-to-end
agent token savings remain unproven. Reuse its native driver and fixtures before
adding evaluation infrastructure or repeating review work.

The issue-triage cycle also failed its environment gate: three exit-zero
readiness runs could not start the tool host, costing 129,756 tokens; no formal
tasks ran. Runner repair `88c5cd1` identifies that failure explicitly. Its
14,697,083 processed engineering tokens at cutoff show that preparation overhead
still needs control. The separately frozen complete-runtime follow-up passed
readiness and produced three valid attempts, all failing the frozen quality
gate. It consumed 1,491,607 formal tokens plus 279,493 readiness tokens. Its
source audit found complete provider-contract evidence in the CodeFacts
response, so the answer omission does not establish a ranking defect. Keep both
campaigns closed; another model run needs a new independently sourced consumer
task or changed failure evidence, not a prompt tweak or relaxed scoring.

The subsequent temporary-fixture cleanup pilot met that new-task gate and is
now closed. All three patches passed four required quality criteria, with 24
failure/success probes and 162 existing tests per patch. The selected OpenSession
repair also passed Linux acceptance and was committed on an isolated branch.
Formal usage was 1,842,741 tokens plus 261,756 readiness tokens; unaggregated
engineering cost remains unknown. Both MCP arms chose ordinary tools, and two
real policy rejections interfered with the CodeFacts attempt. Retain the repair
and reusable edit-mode runner, preserve the raw costs, and make no tool-savings
claim from this campaign. That pilot alone supplies no demonstrated retrieval
defect; the subsequent history audit below supplies new, separate evidence.

The 2026-09-20 audit reviewed one actual OpenSession task family: 129 task files,
79 with CodeFacts use, 899 executed MCP calls including two maps of a temporary
upstream checkout. A source-backed path was explicitly used in a review conclusion.
The same history shows oversized output, retries with lossy manual projection,
unconsumed pagination and unnecessary fixed overview steps. Six bounded native
query comparisons reproduce current failures and mixed CodeGraph outcomes; they
do not measure end-to-end agent token savings. Prioritize these specific fixes
before another model campaign. Keep CodeFacts for now: CodeGraph helped some
discovery queries but missed another exact target and retained same-name noise.
The [history audit](OPENSESSION-HISTORY-AUDIT-2026-09-20.md) separates measured
findings, loaded-version evidence and proposed completion conditions.

The subsequent [compact-response implementation](COMPACT-RESPONSES-2026-09-20.md)
passed the frozen native cases and preserves evidence across continuation pages.
The release work would update the separately maintained plugin
pin/guidance and verify a new client's loaded schema; it remains pending after
the subsequent Luna investment decision. Further relation-ranking
changes still require their own correctness evidence. Native byte reductions
are measured. Real-client comprehension and three-OS CI were then exercised in the
[four-run client acceptance](CLIENT-ACCEPTANCE-2026-09-20.md): all answers passed
their four correctness criteria, both compact runs followed actual cursors and
preserved evidence interpretation, and all six existing CI jobs passed. Compact
avoided MCP output truncation, but total tokens rose 42.0% and 3.6% in the two
pairs; elapsed time was mixed. This guided n=1 comparison required a continuation
page and did not equalize retrieved facts or source reads. Retain the 16 KiB
initial budget for bounded output, make no end-to-end savings claim, and close
this campaign without replacement runs. Plugin release/install verification is
still outstanding.

The two native cases needed two calls instead of one; their recorded cumulative
tool time did not decrease. Treat 16 KiB as an initial budget, and choose any later
adjustment by correct-task total cost rather than response size alone.

The next model-based campaign requires a named real task, frozen comparator
versions/configurations, correctness rubric, invocation and time limits, and
a concrete decision it can change. Native retrieval checks come first. Raw
output bytes describe tool behavior; matched correct task outcomes are required
before evaluating a token-efficiency claim. External adoption and actual maintenance
effort are still needed before broad product investment.

## Product boundaries and evidence owners

Keep the five read-only workflows and verifiable local fact store described
in the project instructions. Source/SQLite facts own relationships; the model
owns task reasoning. Existing [performance benchmarks](PERFORMANCE.md) own
index/query costs, and [EVALUATION.md](EVALUATION.md) owns agent outcomes.
Installation or release work follows the existing packaging and CI checks;
local tests do not imply published-package verification.
