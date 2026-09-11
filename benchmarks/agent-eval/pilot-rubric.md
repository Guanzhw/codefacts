# CodeFacts token-efficiency pilot — grading rubric

## Scope and snapshot identity

Grade only against the extracted, read-only repositories under `token-eval/repos/`.
They are the evaluated source snapshots represented by `codefacts.tar`
(`BBB1D466C77091BAE99414A5C8D646E28BE56587A29353CAD15EF527FC55E1EF`) and
`opensession.tar`
(`FD35C8A9127711A0D8AB08C5E0EA1EAF7E75DF78500C43AD15392AE8E9E8BE16`).
Do not treat agent-session transcripts, prior evaluations, repository history, or
documentation plans as answer evidence. A response may use its own reasoning,
but the cited evidence must resolve to these snapshots.

Each response is graded independently on a 0–4 scale. A response passes only
at 3 or 4 with no material false claim. An arm passes the pilot quality gate
only when every question response passes. Report the raw per-question scores,
pass/fail counts, and token metrics; aggregate failures separately rather than
letting a mean obscure them. Do not award an efficiency result to an arm that
fails the gate.

## Exact task prompts

### Q1 — known CodeFacts symbol

> In the CodeFacts snapshot, explain `GraphStore::with_transaction`'s success
> and error behavior. What happens when a store operation is called while a
> transaction is already active? Cite the implementation and regression
> coverage.

### Q2 — CodeFacts natural-language discovery

> After editing a source file, parsing succeeds but relationship extraction
> fails. Which previous facts remain queryable, and how does an MCP caller
> learn that the index is incomplete? Explain the behavior and cite source and
> regression coverage.

### Q3 — known OpenSession `ProviderAdapter`

> In the OpenSession snapshot, what is the `ProviderAdapter` contract for
> Session Protocol retrieval, what happens when its implementation throws or
> is unavailable, and where is a provider chosen? Cite the interface, runtime,
> and consumer or registry source.

Q3 is retained as written: all requested parts have direct source evidence.

## Essential facts and acceptable evidence

### Q1

An answer at full credit establishes all of the following.

1. `with_transaction` checks `conn.is_autocommit()`. If a transaction is
   already active, it calls the operation directly; it does not start or commit
   a nested transaction. This lets nested batch/store operations participate in
   the outer transaction. Evidence: `repos/codefacts/src/graph/store.rs:459-470`.
2. At the outer boundary it creates an unchecked transaction. If the operation
   returns `Ok`, it commits and returns that value. If it returns `Err`, it
   returns the error without calling `commit`; Rust `Transaction` drop supplies
   rollback semantics. Evidence: `repos/codefacts/src/graph/store.rs:470-477`.
3. The regression test injects an error after a node insert and generation
   advance, then verifies an error, unchanged generation, and no inserted node.
   Evidence: `repos/codefacts/src/graph/store.rs:2433-2448`.

Do not require the response to name SQLite transaction-mode internals. It is
fine to state rollback behavior as the tested outcome; it is not sufficient to
claim a literal explicit `ROLLBACK` call, because this implementation does not
make one.

### Q2

An answer at full credit establishes all of the following.

1. The stated failure is in Pass 2, not the recoverable per-file skip path.
   Pass 1 parses and extracts nodes; Pass 2 builds the cross-file node index
   and calls `Extractor::extract_edges`. An edge-extraction error is propagated
   by `?`, and collecting edge results is also propagated by `?`, before the
   SQLite persistence transaction begins. Evidence:
   `repos/codefacts/src/indexer/pipeline.rs:181-275` and
   `repos/codefacts/src/indexer/pipeline.rs:326-373`.
2. Therefore the source supports that the existing stored snapshot is not
   replaced, deleted, re-hashed, or generation-advanced by this failed refresh:
   none of the persistence mutations is reached. The closest transaction
   regression injects a later persistence failure and verifies that the old
   hashes, node/edge counts, `original` node, and `removed` node remain.
   Evidence: `repos/codefacts/src/indexer/pipeline.rs:1004-1082`.
   This is strong atomicity coverage, but it is not a direct regression test
   that injects a Pass-2 edge-extraction error; a full-credit answer must state
   that limit rather than inventing such coverage.
3. An MCP read workflow first calls `refresh()` and propagates its error with
   `?`; `map` is one example. Thus this exact Pass-2 failure produces a failed
   request, not a normal MCP answer whose `freshness.status` is `partial`.
   Evidence: `repos/codefacts/src/service.rs:257-274`.
4. `partial` is the separate successful-refresh path for skip-counted
   read/parse/node-extraction failures and oversized files. `files_failed`
   includes unreadable, parse, and node-extraction failures; a successful
   `IndexResult` returns those counts. Freshness becomes `partial` if
   `files_failed` or `files_too_large` is nonzero. Evidence:
   `repos/codefacts/src/indexer/pipeline.rs:105-126`,
   `repos/codefacts/src/indexer/pipeline.rs:453-465`, and
   `repos/codefacts/src/service.rs:55-86,1385-1403`.

Do not conflate the prompted Pass-2 `extract_edges` error with the Pass-1
`extract_nodes` error that increments `files_extract_failed` and returns a
successful partial `IndexResult`.

### Q3

An answer at full credit establishes all of the following.

1. `getSessionProtocol` is optional. When present it accepts a session ID and
   returns a standardized `SessionProtocol` or `null` for an unknown session;
   providers without native support must not implement it. Protocol
   capabilities may not claim a domain without the accessor, and unspecified
   domains default to `none`. Evidence:
   `repos/opensession/src/providers/interface.ts:130-143` and
   `repos/opensession/src/providers/kinds.ts:24-37`.
2. `getRuntimeProtocol` first obtains/validates the provider-owned session,
   rejects a missing or mismatched session as `session_not_found`, rejects a
   missing accessor as `protocol_unavailable`, and treats a null protocol as
   `session_not_found`. It caches only a resolved protocol keyed by
   provider/session revision; otherwise it finalizes an unfinalized result with
   provider, session, capabilities, and revision. Evidence:
   `repos/opensession/src/protocol-runtime.ts:85-134`.
3. The runtime function does not catch an exception from
   `adapter.getSessionProtocol(sessionId)`; that exception propagates to its
   consumer. Consumer behavior is intentionally contextual: session-list
   stats logs a failed lookup, does not cache it, and returns base statistics;
   the session-detail render catches errors and returns a partial empty runtime
   view with `runtimeError` (`runtime_unavailable` for an ordinary thrown
   error). Evidence:
   `repos/opensession/src/session-list-stats.ts:204-214` and
   `repos/opensession/src/routes/session-detail.ts:56-126`.
4. Provider selection has two relevant boundaries. The registry constructs
   `ALL_PROVIDERS`, filters it via `detect()`, and resolves an ID through
   `getProvider`; session history chooses by `SessionRef.provider`, then
   rejects an unregistered or unavailable provider. Evidence:
   `repos/opensession/src/providers/index.ts:11-34` and
   `repos/opensession/src/session-history.ts:379-404`.

Do not credit “throws are always converted to `protocol_unavailable`.” That is
false: only a missing accessor gets that `ProtocolRuntimeError`; a thrown
implementation is handled differently by different consumers.

## Scoring

| Score | Correctness and completeness standard |
| --- | --- |
| 4 | States every essential fact for the question, makes no material error, distinguishes implementation facts from test-backed observations, and gives at least two source citations that jointly cover the answer (including the required regression/consumer evidence). |
| 3 | Correct answer with the central mechanism and outcome, source-backed; may omit one secondary detail such as cache finalization, a named counter, or a particular consumer, but cannot omit the requested error/preservation/nesting result. |
| 2 | Partly correct and source-backed, but misses a central requested facet or gives only one side of a required distinction. Examples: says Q1 commits on success but omits nested behavior; says Q2 preserves old facts but fails to distinguish request failure from successful partial freshness; says Q3 has an optional accessor but not unavailable versus thrown behavior. |
| 1 | Has a relevant fragment or citation but substantially misstates behavior, relies mainly on unsupported generalization, or leaves most of the question unanswered. |
| 0 | No usable answer, no snapshot-grounded evidence, or a material error that reverses the result. |

### Material errors

Any of these caps the question at 1; if it is the main conclusion, score 0.

- Q1: claims nested calls open/commit an independent transaction; claims an
  error commits the mutations; or claims an explicit rollback call is shown.
- Q2: claims the prompted Pass-2 edge-extraction failure returns a normal
  `partial` MCP answer; claims it replaces/deletes old facts or advances the
  generation; claims a direct Pass-2 failure regression exists; claims
  `partial` only reflects `files_failed` while omitting size-limit partiality;
  or calls all skipped files failures.
- Q3: says `getSessionProtocol` is required; says null protocol is a success;
  says a thrown accessor is universally transformed into
  `protocol_unavailable`; or says registry presence alone makes a provider
  available without `detect()`.

### Evidence sufficiency rules

- Cite repository-relative snapshot paths and line numbers. Exact line ranges
  above are the grading key; nearby accurate citations are acceptable.
- A Q1 response needs implementation plus regression evidence. A Q2 response
  needs Pass-2 pipeline evidence, the service refresh boundary, and a clearly
  scoped regression citation; only an answer that discusses the separate
  `partial` path also needs service freshness evidence. A Q3 response needs
  interface/runtime evidence plus registry or consumer evidence.
- Tests validate the stated fixture outcome. They do not alone establish a
  broader production guarantee than the source implements.
- README prose, planning documents, agent transcripts, and unlinked web
  claims cannot substitute for the required source evidence.

## Product KPI framework and reporting notes

Measure an arm only after it completes the same task under the same evaluation
conditions. The primary efficiency number is the **quality-gated total token
cost**:

`total = input_tokens + output_tokens`

If the provider reports cached input separately, report it as a subset
diagnostic, but do not add it again to the total. Use the provider's accounted
total if it is available and reconcile the component definition before any
cross-arm comparison.

Report, for every arm and question:

- correctness score, completion/pass status, and citation sufficiency;
- total input, output, and total tokens; cached-input subset separately;
- completion cost (all tokens through the final valid answer), not merely the
  final response length;
- cold and warm results as separate conditions; and
- run count, median, range or distribution, and all failed/invalid runs.

Run repeated independent trials per arm. Keep multi-turn continuation or
residual-context effects in a separate experiment: report their extra turn(s),
carried context/cached subset, and incremental completion cost rather than
mixing them into single-turn cold/warm results. A small pilot can demonstrate
an observed result for these exact tasks, model, prompts, snapshots, tool
configuration, and run conditions. It cannot support a universal claim that
CodeFacts, MCP, or CodeGraph is always more token-efficient.
