# Frozen four-point task rubric

This is a client-format compatibility replication. Score anonymized answers without usage or arm labels. Each task is 0–4: every point below is binary. A result may be correct while protocol-ineligible; do not compare token usage until both paired results are 4/4 and pass all protocol gates.

## Protocol gates for every attempt

- **G1 actual relevant MCP use.** The first substantive CodeFacts call is the task-specified `expand`, with the target symbol/file and `limit=30`; the answer uses its evidence.
- **G2 actual format transport.** Proxy `server_request` shows every CodeFacts call carries the arm's `format`; it may add only a missing format while preserving original client requests, explicit values, and every response body. Markdown responses are text-only (`structuredContent` absent); compact responses retain both compact JSON text and `structuredContent`.
- **G3 continuation/truncation.** If the first expand returns `next.callees`, the client calls the returned cursor with the same symbol/file, `section=callees`, and the same format. The answer states any unread continuation; a missing continuation is coverage-not-obtained, not a rerun trigger.
- **G4 evidence fidelity and scope.** Evidence note gives the exact source hash from the actual result, retains relationship direction/confidence, labels heuristic candidates as uncertain, and uses only the frozen task source and approved read-only tools. Record a breach or failure; do not replace it.

## protocol-cache-review (four points)

1. **Cache identity/hit.** States the key combines `adapter.id` and `sessionId`, checks session/accessor before a hit, and notes an unchanged revision reuses and touches the cached protocol.
2. **Revision decision.** Identifies `getProtocolRevision(session.id)` as preferred over `getStatsRevision()` where available; protocol revision plus recorded update/message/token counts invalidate a changed entry, including a provider-only revision change.
3. **Receiver-aware direction.** Rejects `Router.get` as the dependency of `protocolCache.get`: the receiver is the native `Map` at `src/protocol-runtime.ts:30/110`; gives one real production caller→target and one confirmed target→callee with locations and confidence.
4. **Minimal regression plan.** Preserves/runs `test/protocol-artifact-revision.test.mjs:7-36` (v2/paired/native-v3, two builds on revision switch, zero stats reads) and one directly relevant identity/reuse check such as `test/protocol-runtime.test.mjs:63-74`; does not invent a production patch.

## reader-turn-plan (four points)

1. **Ordering/inclusion.** `deriveTurnBoundaries` is called at `deriveConversationView` line 600; it keeps existing `protocol.events` order, filters to same-session allowed runs/events and normalized boundary kinds, assigns first-seen display numbers, and preserves unknown timestamps as null.
2. **Production direction.** Traces `prepareReader` / `registerSessionDetail` in `src/routes/session-detail.ts:154-183` through `renderSessionReaderPane`, with `src/views/session.ts:1891-1909` as the consumer; gives a confirmed direct callee such as `deriveTurnBoundaries`.
3. **Receiver-aware uncertainty.** Explains `runIdsWithTask.add` and `seenOthers.add` use local `Set` receivers (`src/conversation-view-model.ts:345/347` and `513/523`), rather than the unrelated accumulator in `src/session-history.ts:474`; same-name relationship candidates are heuristic.
4. **Minimal regression plan.** Preserves/runs `test/conversation-p2b.test.mjs:316-358`: source order under timestamps `[300,100,50,400,null]`, display numbers `[1,1,2,2,3]`, and child exclusion. Rejects a timestamp-sort production change.

## Stop and reporting rule

Stop before the next undispatched formal attempt after an environment, source/binary/hash, transport, policy, or provider-usage failure. Retain and charge all started attempts. Report per attempt: the four correctness points, gates, provider total/cached/uncached input/output/reasoning usage, elapsed time, actual calls, failures, continuation/truncation, raw tool envelope/text/structured bytes, and grading evidence. Do not call a byte count a token count. Any optional tokenizer is reported as an encoding proxy with its name, not provider usage.
