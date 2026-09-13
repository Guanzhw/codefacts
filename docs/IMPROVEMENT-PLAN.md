# CodeFacts improvement plan

Owner: the contributor advancing the current project goal. Update this page
when a milestone finishes or new real-use evidence changes the next priority.
The [evaluation scorecard](EVALUATION.md) owns metric definitions and comparison
rules; this page owns the active queue and investment decisions.

## Current priorities

| Priority | Work | Evidence and completion condition | Status |
| --- | --- | --- | --- |
| 1 | Implement explicit member-query ranking | Native Top-1 improved 7/12 to 10/12 on earlier cases and 9/12 to 12/12 on a third repository; regression tests preserve pagination, filters and context. | Complete; retained in `5a88820`. [Results and cost](MEMBER-RANKING-IMPLEMENTATION-2026-09-13.md). |
| 2 | Verify usefulness during real repository work | The complete-runtime follow-up ran all three arms; all answers scored 2/4 and no quality-gated savings were established. CodeFacts supplied the complete contract, but the final answer omitted required distinctions. | Complete; limited maintenance retained. [Results](ISSUE1-RUNTIME-RECOVERY-2026-09-13.md). |
| 3 | Resolve a demonstrated remaining retrieval defect | Container names can collide with document headings; explicit kind filters already exist. Require a concrete failed lookup and independent source-labeled cases before changing default ranking. | Evidence collection only. |
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

The next model-based campaign requires a named real task, frozen comparator
versions/configurations, correctness rubric, invocation and time limits, and
a concrete decision it can change. Native retrieval checks come first. Raw
output bytes describe tool behavior; only matched correct task outcomes can
establish a token-efficiency claim. External adoption and actual maintenance
effort are still needed before broad product investment.

## Product boundaries and evidence owners

Keep the five read-only workflows and verifiable local fact store described
in the project instructions. Source/SQLite facts own relationships; the model
owns task reasoning. Existing [performance benchmarks](PERFORMANCE.md) own
index/query costs, and [EVALUATION.md](EVALUATION.md) owns agent outcomes.
Installation or release work follows the existing packaging and CI checks;
local tests do not imply published-package verification.
