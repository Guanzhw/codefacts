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

## Results

Pending the four-run diagnostic; no improvement claimed.
