# Issue #1 triage rubric

Freeze before evaluated-agent execution. Source is OpenSession
`994942690fe5d1854398017026ef3615b2fdd24f`. Grade each criterion 0 or 1.
Pass requires at least 3/4, both A and B, and no material unsupported claim.

| Criterion | Required evidence |
| --- | --- |
| A: Analysis status | Correctly identifies Session Analysis as removed in this snapshot, using `docs/specs/runtime-protocol-workbench/tasks.md` S6 (lines 99–107) and/or equivalent explicit migration evidence, supported by current source inspection. Documentation mentions do not prove a current executable subsystem. |
| B: Provider contract | Locates `ProviderAdapter` in `src/providers/interface.ts` (123–176): `detect(): boolean` is required; `capabilities` and `resumeCommand` are optional. Explains these as contract fields rather than assuming all providers implement identical capabilities/resume behavior. |
| C: Source attribution | At least two accurate source/migration citations with line or symbol locations support the material findings; no invented file, symbol, line or body. |
| D: Maintenance decision | Separates a missing/retired target from inadequate retrieval and calls for the original revision or a current present-target reproducer before changing search. Does not declare the historical report false or infer runtime reachability, universal search accuracy, latency or token savings from source absence. |

Unsupported claims of an existing analysis implementation, mandatory optional
provider fields, or disproof of the historical report cap the score at 1.
An answer that omits exact line numbers can pass C with accurate symbol/section
locations. Claims about actual MCP calls must match the retained transcript;
ordinary-tools agents can complete the task through source and migration records.

The grading reviewer receives source access, this rubric and anonymous answers,
without arm identities or efficiency totals. Review tool-audit evidence separately.
