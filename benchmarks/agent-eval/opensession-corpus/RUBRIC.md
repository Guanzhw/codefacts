# OpenSession history corpus rubric

Grade only against the frozen OpenSession source at commit
`543e874e697523bf474f494bcf897a17f19587de`, materialized at the campaign's
`machine-config.sourceRoot`. Do not use task history, prior
answers, evaluation artifacts, or external sources as answer evidence.

Each task has four binary criteria in `tasks.json`. Award one point for each
criterion whose business conclusion is correct and supported by a relevant
snapshot citation. Equivalent wording and nearby accurate line citations are
accepted. Do not require hidden implementation terms, a particular tool, or a
particular investigation order unless the prompt asks for that behavior.

The intended answer budget is about 250 words per task. A concise answer can
earn 4/4. Score each task independently:

| Score | Result |
| ---: | --- |
| 4 | All four requested business points are correct and source-backed. |
| 3 | Three points are correct and source-backed, with no material false claim. |
| 2 | Two points are correct, or a central requested distinction is missing. |
| 1 | One usable point, or a material false claim reverses the main conclusion. |
| 0 | No snapshot-grounded answer. |

Passing is 3/4 with no material false claim. Report raw criteria, total, and
citation sufficiency. Do not average away a failed task. Report OS-H01
separately because its exact query was exposed and CodeGraph previously missed
that target. Also separate OS-H01–H03 from OS-H04–H06; the latter are
`new-to-task-evaluation`, not statistically held out from the history family.

## OS-H01 — Codex reader snapshot boundary

- **H01-C1:** `getSessionReaderSnapshot` delegates to `captureCodexReader`.
- **H01-C2:** the capture reads one session snapshot, resolves its records and
  messages, combines the session and memory revisions, and exposes inherited
  context only when inherited messages exist.
- **H01-C3:** `getProtocolSnapshots` derives finalized v2 and v3 from the same
  captured input/revision.
- **H01-C4:** session-detail calls an optional `ProviderAdapter` method. For a
  Codex adapter this dispatch reaches the Codex implementation at runtime, but
  the route is not a statically direct call to `captureCodexReader`.

Material error: claiming the route directly imports/calls the Codex capture
function, or claiming v2 and v3 necessarily reread independent source states.

## OS-H02 — Runtime workbench discovery path

- **H02-C1:** the server renderer is `renderRuntimeWorkbench(RuntimeData, ...)`.
- **H02-C2:** session-detail passes `reader.runtime`, provider, and session ID
  into that renderer when building the page.
- **H02-C3:** the server/client handoff is the `data-runtime-root` section plus
  embedded JSON evidence and its availability marker.
- **H02-C4:** browser startup calls `initRuntimeWorkbench`, which requires the
  root and parses its evidence. A valid minimal inspection order distinguishes
  route/runtime data, rendered root/evidence, and app bootstrap.

Material error: treating the guessed `buildRuntimeWorkbench` name as the real
entry, or recommending a source change before distinguishing the three layers.

## OS-H03 — Pi native v3 construction chain

- **H03-C1:** the generic runtime prefers native `getSessionProtocolV3` and
  calls it on a native-cache miss.
- **H03-C2:** Pi's adapter entry delegates to its v3 builder.
- **H03-C3:** the builder loads one Pi entry, obtains finalized v2, then builds
  v3 from that base plus session, records, and messages.
- **H03-C4:** the shared finalizer clones and normalizes the domains, sets
  version 3, validates completeness, and freezes by default.

Material error: omitting the v2 base, claiming the shared finalizer reads Pi
storage, or presenting an uncertain same-name edge as part of the chain.

## OS-H04 — OpenCode provider boundary check

- **H04-C1:** the report is false: OpenCode uses its SQLite adapter and
  configured/default `opencode.db`, not the Codex JSONL capture path.
- **H04-C2:** sessions/messages and their parts are loaded from SQLite and
  normalized by the OpenCode adapter.
- **H04-C3:** OpenCode's tree wrapper uses the shared SQLite tree builder,
  which recursively attaches child sessions through task-part IDs and retains
  unattached children separately.
- **H04-C4:** v2/v3 are built from that OpenCode tree and DB revision. The
  frozen source supplies no reason to merge this path into Codex, so no change
  is warranted from the report alone.

Material error: saying OpenCode reads Codex rollout JSONL, or treating shared
tree/protocol types as proof that provider storage is shared.

## OS-H05 — Codex child-token ownership diagnosis

- **H05-C1:** `parent_id` alone does not authorize subtraction; parent records
  are needed only when a child has no explicit task envelope.
- **H05-C2:** with `NEW_TASK`, records before the envelope are inherited and
  the envelope starts session-owned history.
- **H05-C3:** the legacy no-envelope fallback requires at least two complete
  matching leading token snapshots against the declared parent transcript.
- **H05-C4:** duplicate usage requires the same recorded response ID plus an
  equal snapshot, or adjacent equal snapshots with no conflicting recorded
  response IDs; cross-format adjacency is one supported case, not a required
  condition. Downstream usage accepts only records marked session-owned.
  Broad parent-based subtraction is therefore unwarranted.

Material error: deduplicating every child from labels/parent ID, or saying all
equal cumulative totals prove separate requests.

## OS-H06 — Deferred field markup diagnosis

- **H06-C1:** deferred nonempty content still gets a `.progressive` container
  and load button with part/field/scope/initial-load identity.
- **H06-C2:** reasoning, tool input, and tool output request this deferred form.
- **H06-C3:** the empty-status claim is stale. Initial server markup has no
  status node; the client creates one only for stale, empty, or failed results
  and removes prior status when retrying.
- **H06-C4:** accept either an evidence-based decision to keep the wrapper
  until measured benefit justifies the coupled change, or a bounded reduction
  plan. The answer must identify the server markup/client
  `closest('.progressive')` coupling and preserve identity, retry status, and
  search/content-update behavior. It must not re-fix already-conditional
  status behavior.

Material error: claiming the frozen server emits an empty status per field, or
removing the wrapper without accounting for the client ownership contract.
