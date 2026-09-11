# Call-site continuation diagnostic

## Frozen question and intervention

This bounded follow-up tests use of an already returned production call site.
It does not test discovery, compare complete CodeFacts and CodeGraph sessions,
or reopen the larger investment campaign.

Both conditions receive the exact same archived text response from the
`extract_edges` search in the retrieval replay, followed by the original
`extraction_failure` question in `value-screen-results.json`. Both can read
only the pinned CodeFacts source snapshot using ordinary shell tools. No MCP
server is configured. The supplied response is source data, not instructions.
It includes the production caller at `src/indexer/pipeline.rs:341`.

Control A receives the runner's existing common instructions. Condition B adds
exactly this guidance:

> When a definition excerpt does not cover the needed behavior, use the returned
> production call-site locations to read a bounded source window and trace the
> result into its caller. Stop reading once the question and regression coverage
> are supported.

The question, initial facts, source, CLI, model and reasoning effort are identical.
No additional identifier, line number, correct answer or phase hint is supplied
to B. This isolates the continuation instruction conditional on successful
entry discovery; initial discovery and MCP schema/indexing costs are excluded.

## Limits and acceptance rule

- Four serial fresh runs: A1, B1, B2, A2, with no retries or replacement samples.
- Codex 0.153.4, `gpt-5.6-luna`, medium effort; existing `runner.mjs` settings.
- Each process has a 180-second timeout. Before each subsequent launch, stop
  if accumulated known evaluation tokens reach 1,500,000, usage is missing or
  conflicts, or a process fails. A final run can overshoot the token threshold;
  this is a launch gate, not an in-flight token limiter.
- No evaluation-model preflight and no extra task/model/wording combinations.
- Grade all answers using the existing pilot Q2 rubric, blinded to condition
  and token costs in an independent review. The main agent checks source and
  retains final judgment. Contradictory normal-partial/error claims remain a
  material error under the unchanged rubric.
- Report each score, input/cached/uncached/output/total tokens, process duration,
  source-tool output bytes and tool-call count; inspect whether line 341 and
  the subsequent error propagation were actually read.
- A provisional workflow signal requires B to pass both runs, A also to pass
  both runs for an equal-quality cost comparison, and B's median total tokens
  AND median source output bytes to improve by at least 10%. Otherwise retain
  existing guidance. Passing this small diagnostic warrants only an independent
  task replication, not a product-wide efficiency claim or product change.
- Retain failed/invalid attempts and report unknown costs explicitly. Do not
  use an old answer as a contemporaneous control.

## Engineering containment

Use one independent Luna worker for the minimal driver and execution and one
bounded Terra review. Reuse the existing runner without extending its API.
Preparation is limited to 12 worker tool calls; execution uses at most four
launches. Stop at the frozen result, including a negative or inconclusive result.
Record engineering model usage separately at an explicit cutoff, including
review and orchestration where available; zero new product code does not mean
zero engineering cost. This is an operational cap, not a goal token budget.

## Evidence and reproducibility

Source revision: `76bae6820c3032e952dbfb5aeb8560b949af185c`.
Archived CodeFacts binary SHA-256:
`2e725c9b3947545aecce845ba7fdd41d58e8fd456743d0cd9da2d34355ce7576`.
The response comes from that binary's previously verified replay; no new
CodeFacts request is needed. Freeze hashes of the shared response, question,
runner, CLI and source archive before launching. Audit snapshot files before
and after. Preserve local raw transcripts; commit portable aggregate evidence.

## Offline evidence sufficiency

The parent verified that the returned production edge points to line 341 and
its source hash matches the pinned `pipeline.rs` bytes. Lines 326–379 contain
54 lines / 2,741 bytes, including both error propagation operators and the
following persistence boundary. The whole definition, lines 145–467, contains
323 lines / 14,574 bytes. The selected window is 81.19% smaller in source bytes;
this is an investigator-selected coverage check, not a measured agent saving.
The call site is an entry point: service-level propagation and the regression
still require separate evidence. These selected ranges are not added to either
evaluated prompt.

## Results and decision

The frozen diagnostic completed four valid runs with no retries, timeouts or
evaluation-model preflights. The driver is committed as `d6603b9`; the protocol
was committed first as `3ba4aed`. All source files remained identical to their
archives (97 CodeFacts files and 307 OpenSession control files). All four usage
records reconcile between CLI stdout and session totals.

An independent reviewer received only anonymously ordered answers and the
unchanged Q2 rubric, without condition identities or costs. All four scored
**3/4 and passed**, confirmed by the parent. Each correctly distinguishes the
Pass-2 error from successful partial freshness. Each omits the closest later
persistence rollback regression at `pipeline.rs:1004-1082`, preventing full
credit. This is a shared regression-evidence gap, not a newly detected product
correctness defect.

| Run | Score | Total tokens | Command output bytes | Commands | Agent time (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| A1 control | 3 | 263,797 | 148,056 | 9 | 69,765 |
| B1 call-site guidance | 3 | 419,851 | 231,085 | 9 | 72,329 |
| B2 call-site guidance | 3 | 294,593 | 120,743 | 7 | 74,898 |
| A2 control | 3 | 371,438 | 129,941 | 13 | 89,845 |

| Median measure | Control A | Guidance B | B versus A |
| --- | ---: | ---: | ---: |
| Total tokens | 317,617.5 | 357,222 | +12.47% |
| Uncached input tokens | 48,445.5 | 46,495.5 | -4.03% |
| Command output bytes | 138,998.5 | 175,914 | +26.56% |
| Wrapper output bytes, separate diagnostic | 126,656.5 | 129,538 | +2.28% |
| Commands | 11 | 8 | -27.27% |
| Agent time (ms) | 79,805 | 73,613.5 | -7.76% |

Command output bytes count each completed command item once, including repeated
search results and reads. They are not unique source bytes or tokens. Wrapper
output is separately reported because direct commands can bypass wrappers;
the two byte measures must not be added. Fewer calls can still return more text
and consume more total tokens. Agent time excludes runner dispatch overhead.

| Condition totals | Input | Cached input (subset) | Uncached input | Output | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 629,115 | 532,224 | 96,891 | 6,120 | 635,235 |
| B | 708,927 | 615,936 | 92,991 | 5,517 | 714,444 |

The parent inspected all actual commands and checked that all four outputs
contained the extraction call, collected-error propagation and persistence
boundary. All four started with a broad `rg` search. B1 later read a 205-line
pipeline window, and B2 a 360-line window; the instruction did not reliably
produce the intended bounded continuation. B2 attempted Git history/status,
which returned `not a git repository`; no history was exposed. No network,
external-agent, out-of-snapshot source or evaluation-artifact access was observed.

**Keep the existing product and usage guidance.** Both cost gates fail despite
equal passing quality. No additional model run or product modification is
justified by this diagnostic. The result is conditional on supplied successful
discovery and this one previously diagnosed task. It does not establish that
the guidance always hurts, that CodeFacts repaired the earlier failure, or a
new advantage over ordinary tools or CodeGraph. If investment is reopened,
independent offline evidence of a specific retrieval defect should precede
another agent campaign.

## Actual cost and artifacts

Formal evaluation consumed **1,349,679 tokens**. Engineering accounting at
**2026-09-11 18:14:40 UTC** (2026-09-12 02:14:40 Asia/Shanghai) totals
**8,354,495 tokens**: parent 3,778,821; implementation worker 3,977,832; independent
reviewer 597,842. Engineering input is 8,315,253, of which 8,031,360 is cached;
uncached input is 283,893 and output 39,242. Cached input is already included
in input and is not added again. Engineering plus evaluation at that cutoff
is **9,704,174 tokens**. These are usage quantities, not monetary billing.

The engineering ledger sums unique per-response `token_usage_record.usage`
records for the current parent user turn and the two worker sessions. It excludes
the export invocation completion, subsequent report/commit verification and
final reply. It is therefore a cutoff measurement, not the full completed-turn
total. Engineering cost still exceeds formal evaluation cost by more than six
times; this run does not establish an efficient improvement process. The four
run cap was enforced, and the task stops at this negative result.

Portable [results](../benchmarks/agent-eval/callsite-diagnostic-results.json)
include answer texts, blind grades, all token components, byte measurements,
hash receipts, route audit, snapshot audit and the engineering ledger.
The [driver](../benchmarks/agent-eval/callsite-diagnostic.mjs) is a local pinned
experiment script; its paths intentionally identify the archived experiment
environment. Local raw artifacts are under the session artifact directory's
`callsite-diagnostic-2026-09-12-v3` folder. Preparation directories without the
suffix and with `-v2` contain setup artifacts only; neither launched a model.
Manifest validation and freeze-check defects were corrected before v3 launched.
The existing runner and summary tests passed 14/14; the runner API and product
source were unchanged.
