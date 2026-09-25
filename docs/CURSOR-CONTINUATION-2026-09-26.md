# Cursor continuation repair and task comparison: frozen plan

Frozen on 2026-09-26 before implementation or formal agent runs. The source
baseline is `6b241d127e8db4338cc2e7fc26ca9543a434b3e8` (v0.1.15).
The real failure is recorded in [Markdown acceptance](MARKDOWN-ACCEPTANCE-2026-09-20.md):
four client attempts encountered long-cursor copying errors in both response
formats before successful continuation. The current emitted cursor is 230 ASCII
characters in those attempts. This is a cursor-usability repair, not a claim
that Markdown caused the errors.

## Product acceptance

1. New search, outline, and expand cursors, including semantic continuations,
   are at most 128 ASCII characters. The old v1 hex-JSON cursors remain accepted
   for an unchanged snapshot; newly emitted cursors use a distinct version.
2. Complete programmatic pagination returns the same ordered fact IDs and
   relationships without missing or duplicate entries or cursor loops. Compact
   and Markdown expand pages stay within their 16 KiB rendered-text budget.
3. Request-scope checks still reject a cursor for another repository, query,
   file, symbol, or section. A changed index generation or semantic-reference
   result produces `stale_cursor`. Invalid encoding and a nonzero offset used
   with a cursor fail explicitly. Format is not part of the existing cursor
   scope, so this repair does not add a format-mismatch rejection.
4. Focused tests, full Rust checks, npm launcher/protocol tests, and real stdio
   MCP calls pass before a release decision. A real Codex client must follow at
   least one dense continuation in compact and Markdown and report actual
   cursor errors, retries, covered facts, total/uncached tokens, elapsed time,
   executed calls, and output volume. Compare those observations with v0.1.15
   under the same client task; a single pair is diagnostic, not a general saving.

## Natural development-task comparison

The current user-requested cursor repair is the task. Two isolated source
snapshots are made from the v0.1.15 Git objects, excluding earlier evaluation
reports and answers. They have identical file content and prepared dependencies.
One agent receives ordinary shell/search/file/edit/test tools; the other also
has the frozen v0.1.15 CodeFacts MCP. Tool choice is natural: no mandatory MCP
call or MCP-first guidance. Both receive the same prompt, model, reasoning
effort, time limit, and source snapshot. The tool arm's MCP indexes only its own
snapshot. Non-use is recorded as non-use, without a replacement run.

Task prompt:

> Repair CodeFacts continuation cursors that are excessively long and prone to
> copying errors during agent use. Make emitted cursors materially shorter
> while preserving complete pagination and the existing request-scope,
> repository, freshness-generation, and semantic-snapshot validity checks.
> Cover search, outline, and expand continuations, including compact JSON and
> Markdown output. Keep the existing five-tool API and make a focused patch.
> Verify the change with the repository's tests and real stdio MCP calls.
> Report the implementation, verification, and any remaining limitation.

Exactly one formal attempt per arm, with a 20-minute process timeout. Arm order
is CodeFacts then ordinary, fixed before execution. Each arm may have one
short readiness run; failed readiness stops formal dispatch until the
environment is repaired. Failed starts and retries remain in the preparation
cost. No attempt is replaced to improve a result. Source snapshots and grading
rules remain outside the agents' workspaces.

Frozen local inputs: the two source manifests each contain 95 matching files;
their manifest SHA-256 is
`3bf3b43ffb88203ca7a7f65c2114cde2620e39209a2444e3619782a3aa36d178`.
The main source archive SHA-256 is
`01afe2debf02f9275f70e83602624e0372cd6e2c0ca51dacd2bc68647c6d60d7`;
the separately archived required parser queries are
`ba8415b0778a14245e691800efb4da79f2cf9ca806434885601a1cb793e0494b`.
The v0.1.15 tool binary SHA-256 is
`d57e7cac25e1d7b045e3a9fd528539f9141adaf540ae46bfe2f98474fb2c4850d`.
The client is Codex CLI `0.155.0-alpha.16.4`, model `gpt-6-luna` at `max`
reasoning for both arms. The first preparation build failed because the source
archive omitted `queries/`; both snapshots received the same required files
before successful `cargo test --all-targets --locked --offline --no-run`.

Grade each patch anonymously, before inspecting arm identity or usage. All four
criteria are required for correct completion:

- Q1: newly emitted cursor length is at most 128 ASCII characters for search,
  outline, expand, and semantic cases; legacy v1 is accepted.
- Q2: full pagination preserves fact identity, order, and completeness, with
  the compact/Markdown 16 KiB expand budget intact.
- Q3: wrong request scope is rejected, changed source/semantic snapshot is
  stale, and malformed/offset-conflicting cursors fail explicitly.
- Q4: the focused patch passes independently run relevant tests and actual
  stdio MCP calls; its report matches the evidence.

Record every attempt's total input, cached input, noncached input, output and
reasoning tokens, elapsed time, actual MCP/shell calls, failed/retried calls,
and output bytes. Record readiness, indexing, build, grading, and preparation
separately. Compare token/time cost only when both arms score 4/4. One matched
task cannot establish an overall agent-productivity benefit.

## Release decision

Publish only if the product acceptance checks pass and the installed-client
continuation works without lost facts. The development-task comparison is
reported as evidence, not used to select favorable attempts or retroactively
alter the implementation. If the product check fails, keep the patch unreleased
and report the concrete blocker.
