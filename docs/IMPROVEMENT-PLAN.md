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

The [H05/H06 follow-up](ANSWER-QUALITY-FOLLOWUP-2026-09-20.md) found that the
decisive implementation facts were already visible: the errors occurred in the
answers, with a comment/implementation mismatch in H05. It supplies no new
ranking or larger-output requirement. The same boundary audit independently
reproduced and fixed single-line source excerpts falsely reporting
`truncated=false` after the 4 KiB limit. All 16 native boundary checks now pass,
with unchanged source excerpts. Subsequent model comparisons need an independent
task or new failure evidence, frozen quality criteria, and a stopping rule; the
completed 36-run campaign stays closed.

The 2026-10-16 follow-up requirements, design, and delivery tasks are tracked in
[requirements](specs/post-delivery-fixes-20261016/requirements.md),
[design](specs/post-delivery-fixes-20261016/design.md), and
[tasks](specs/post-delivery-fixes-20261016/tasks.md).
Improve correctness and completeness while tracking token cost, reducing repeated
reads and redundant evidence where that preserves the quality gain. Judge the
benefit and its cost together, with effectiveness taking priority.

The [Markdown acceptance](MARKDOWN-ACCEPTANCE-2026-09-20.md) adds opt-in text
presentation for 0.1.15 while keeping compact JSON as default. Complete native
queries preserve 285 relationship rows with 27.9% fewer encoding-proxy body
tokens. Four Luna/medium attempts are closed with every cost and failure
retained; no pair met the frozen strict completeness gate, so there is no
quality-gated end-to-end savings claim. Both formats exposed long-cursor copy
errors, supplying a concrete future usability issue without proving that
Markdown caused it.

| Priority | Work | Evidence and completion condition | Status |
| --- | --- | --- | --- |
| 1 | Implement explicit member-query ranking | Native Top-1 improved 7/12 to 10/12 on earlier cases and 9/12 to 12/12 on a third repository; regression tests preserve pagination, filters and context. | Complete; retained in `5a88820`. [Results and cost](MEMBER-RANKING-IMPLEMENTATION-2026-09-13.md). |
| 2 | Verify usefulness during real repository work | The earlier diagnosis scored 2/4 in all arms. A new edit-and-test task delivered a real fix with all patches passing 4/4, but both MCP arms made zero formal calls and CodeFacts had execution-policy interference. No retrieval-efficiency gain was established. | Both campaigns closed; limited maintenance retained. [Diagnosis](ISSUE1-RUNTIME-RECOVERY-2026-09-13.md), [edit-and-test pilot](TEMP-CLEANUP-PILOT-2026-09-16.md). |
| 3 | Improve real-use output and navigation failures | Fixed: callback locals no longer enter top_level; compact MCP responses share hashes/anchors; expand has a 16 KiB page budget and snapshot-bound continuation. Two real expand cases retain equivalent facts with 44.2% / 44.8% fewer response bytes including continuation. | Complete; native 0.2.0 and plugin 0.2.1 are released and verified in fresh Codex and Claude hosts. [Implementation and acceptance](COMPACT-RESPONSES-2026-09-20.md), [original audit](OPENSESSION-HISTORY-AUDIT-2026-09-20.md), [delivery record](V020-DELIVERY-2026-10-16.md). |
| 4 | Compare real-history workflows with actual tool use | Six source-backed tasks, three arms, two repetitions, all evaluated with Luna/medium. All 24 tool attempts made relevant MCP calls. Initial and adjudicated scores, every attempt's cost, answers, and runtime hashes are retained. | Complete; campaign closed. Investment interpretation corrected to reflect the owner's original effectiveness-and-efficiency objective. [Results and decision](LUNA-OPENSESSION-EVAL-2026-09-20.md), [reusable corpus](../benchmarks/agent-eval/opensession-corpus/README.md). |
| 5 | Diagnose incomplete or inaccurate task answers | H05/H06 decisive source was already visible; no retrieval defect explains the omissions. Independently reproduced and fixed false completeness metadata for long single-line definitions. Native checks improved 8/16 to 16/16 with identical excerpts; 762 Rust tests passed. | Complete; [diagnosis and repair](ANSWER-QUALITY-FOLLOWUP-2026-09-20.md). End-to-end answer gains remain unmeasured. |
| 6 | Add optional Markdown and measure output/task cost separately | Five-tool protocol and native continuation unions preserve facts; 774 Rust and 23 npm tests pass. Four Luna attempts retain original scores, actual usage and failures. | Complete for the 0.1.15 release scope; [acceptance and limitations](MARKDOWN-ACCEPTANCE-2026-09-20.md). |
| Complete | Reduce observed cursor-consumption errors | Long cursor copy errors occurred in both JSON and Markdown. Native 0.2.0 snapshot cursors are at most 128 ASCII characters and clients can pass the returned cursor programmatically; legacy v1 cursors remain accepted while their snapshots are current. | Complete since native 0.1.16; shorter cursors remain delivered in native 0.2.0, and the earlier cursor-error observations and task results remain historical. [Delivery record](V020-DELIVERY-2026-10-16.md), [current cursor guidance](../README.md#response-formats). |
| 7 (P1) | Repair type-reference extraction | Same-match captures, declaration exclusions, type-only resolution and qualified incremental rebinding are repaired in Go, Rust, Java, C and C++. Actual native and MCP red/green checks retain source spans and explicit unresolved identities. | Candidate verified with 916 Rust tests, independent review and Flash reproduction; public delivery pending. [Repair validation](POST-DELIVERY-REPAIR-2026-10-16.md). |
| 8 (P1) | Explain partial omissions and reuse unchanged files | Default text reports real omission reasons within its byte budget. A forced extraction pass completes safely despite omissions; repeated partial queries reuse successful unchanged files, and recovery indexes only the recovered path. | Candidate real MCP checks passed; public delivery pending. [Repair validation](POST-DELIVERY-REPAIR-2026-10-16.md). |
| 9 (P1 evidence) | Observe actual menus and measure tool choice | The frozen 72-task study remains unchanged. Three current-runtime canaries prove actual menus/calls; nine candidate native prerequisites passed. The preregistered 18 attempts all passed the source-answer rubric but made zero MCP calls after observed menu exposure, with independent blind grading and trace audit. | Exposure/non-adoption diagnostic complete. Keep three default tools; no optimal-menu or product-benefit claim. [Results, tokens and limits](POST-DELIVERY-REPAIR-2026-10-16.md#model-visible-menus-and-tool-choice). |
| 10 (P2) | Measure upgrade and repaired-fact costs | Three private old-state copies measure released-0.2.0 schema migration separately from the candidate's extraction-9-to-10 rebuild. Three fresh pairs measure added facts, disk and process memory under recorded shared-host load. | Measured and independently recomputed; added references increase fresh disk and observed cold time. [Results and limits](POST-DELIVERY-REPAIR-2026-10-16.md#upgrade-and-storage-measurement). |
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
The [four-run client acceptance](CLIENT-ACCEPTANCE-2026-09-20.md) verified answer
criteria, cursor use, evidence interpretation, and all six CI jobs. Compact
avoided MCP output truncation, but total tokens rose 42.0% and 3.6% in the two
pairs; elapsed time was mixed. This guided n=1 comparison required a continuation
page and did not equalize retrieved facts or source reads. Retain the 16 KiB
initial budget for bounded output, make no end-to-end savings claim, and close
this campaign without replacement runs. The formerly pending plugin/client
delivery was completed as native 0.2.0 and plugin 0.2.1; see the [delivery
record](V020-DELIVERY-2026-10-16.md).

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

Keep the seven read-only MCP workflows and verifiable local fact store described
in the project instructions. Native 0.2.0 defaults to `explore`, `impact`, and
`expand`; `--tools all` enables all seven, and `--tools explore` enables one.
Direct CLI retains all ten query names. See the [v0.2.0 delivery record](V020-DELIVERY-2026-10-16.md).
Source/SQLite facts own relationships; the model owns task reasoning. Existing [performance benchmarks](PERFORMANCE.md) own
index/query costs, and [EVALUATION.md](EVALUATION.md) owns agent outcomes.
Installation or release work follows the existing packaging and CI checks;
local tests do not imply published-package verification.
