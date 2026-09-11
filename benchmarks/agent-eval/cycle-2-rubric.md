# CodeFacts token-efficiency cycle 2 — held-out grading rubric

## Scope and frozen task set

Grade these two additions only against the read-only source snapshots under
`token-eval/repos/`. They are the same snapshots frozen for the pilot:

- `codefacts.tar` SHA-256:
  `BBB1D466C77091BAE99414A5C8D646E28BE56587A29353CAD15EF527FC55E1EF`
- `opensession.tar` SHA-256:
  `FD35C8A9127711A0D8AB08C5E0EA1EAF7E75DF78500C43AD15392AE8E9E8BE16`

Do not use repository history, agent transcripts, plans, prior evaluations, or
external material as answer evidence. The pilot's Q1–Q3 and their rubric in
`pilot-rubric.md` remain unchanged; this document freezes only new held-out
Q4 and Q5.

Each response is independently scored from 0 to 4. It passes only with a 3 or
4 and no material false claim. Report raw per-question scores, pass/fail, and
citation sufficiency. Do not use an average to hide a failed question.

## Exact task prompts

### Q4 — CodeFacts natural-language discovery

> In the CodeFacts snapshot, an `expand` request has refreshed and resolved a
> symbol, but the definition file changes before its source excerpt is
> returned. What result does CodeFacts return for the overall expansion and
> for the excerpt, why does it refuse to return the changed bytes, and what
> should the caller do? Cite implementation and regression coverage.

### Q5 — OpenSession natural-language discovery

> In the OpenSession snapshot, a locally managed session was sent to Trash and
> then disappears from its provider. For a trusted per-session management
> request, which actions remain allowed and which return `Session not found`?
> Explain the metadata written by restore and permanent delete, and how those
> flags affect Trash and main-list filtering. Cite implementation and
> regression coverage.

## Essential facts and acceptable evidence

### Q4

An answer at full credit establishes all of the following.

1. `expand` refreshes first, resolves the symbol, and then obtains the
   definition source. Its top-level response remains `status: "ok"`; the
   definition source result is a nested `source` field. Evidence:
   `repos/codefacts/src/service.rs:630-685`.
2. `definition_source` reads the indexed file, retrieves the stored source
   hash, and hashes the bytes it just read. If they differ, it returns
   `source.status: "changed_during_query"` with a retry message, rather than
   `text`. It does not return the newly changed contents as evidence for the
   older fact snapshot. Evidence:
   `repos/codefacts/src/service.rs:1167-1209`.
3. The caller should retry so a refresh can establish an excerpt matching the
   current fact evidence. The message names that action; it is not a claim
   that the result silently reindexes during the current excerpt projection.
   Evidence: `repos/codefacts/src/service.rs:1203-1208`.
4. The regression seeds a fact snapshot, changes the source from `1` to `2`,
   then verifies `changed_during_query` and absence of `text`. Evidence:
   `repos/codefacts/src/service.rs:1683-1705`.

Do not require a response to describe every other `source.status`. The
question is specifically about a readable file whose bytes changed after the
fact snapshot.

### Q5

An answer at full credit establishes all of the following.

1. After the trusted-local and `localManagement` gates, the per-session route
   permits a source-missing session only for `restore` or `permanent-delete`,
   and only when its existing metadata says it is deleted. For the same
   source-missing session, `star`, `rename`, and ordinary `delete` take the
   `Session not found` 404 path. Evidence:
   `repos/opensession/src/routes/mutations.ts:105-123`.
2. `restore` sets `deleted = 0` and clears `time_deleted`; `permanentDelete`
   sets both `deleted = 1` and `permanent = 1`. These are viewer metadata
   writes, not deletions or restorations of the provider's source session.
   Evidence: `repos/opensession/src/meta.ts:126-143` and
   `repos/opensession/src/routes/mutations.ts:160-180`.
3. Trash selects only `deleted = 1 AND permanent = 0`; main-session filtering
   excludes `deleted = 1 OR permanent = 1`. Thus a restored, formerly
   soft-deleted session is neither in Trash nor excluded by this metadata;
   a permanently deleted session is excluded from the main list and is not a
   Trash candidate. The source-missing session still cannot be made visible by
   metadata alone, because its provider no longer supplies a session record.
   Evidence: `repos/opensession/src/meta.ts:93-106`,
   `repos/opensession/src/routes/sessions.ts:41-55`, and
   `repos/opensession/src/routes/trash.ts:21-27`.
4. The management regression creates a permanent deletion for an ID with no
   source record and verifies that it is excluded; it also verifies that the
   soft-deleted fixture is the Trash ID. This supports the metadata/list
   outcome. It is not a direct regression that exercises the single-session
   route's source-missing exception. Evidence:
   `repos/opensession/test/management.test.mjs:85-108,227-229`.

Do not require an answer to claim that restore recreates a vanished provider
session. That is neither implemented nor supported by the evidence.

## Scoring

| Score | Correctness and completeness standard |
| --- | --- |
| 4 | States every essential fact, makes no material error, distinguishes source behavior from the scoped regression observation, and gives at least two source citations that jointly cover implementation and regression evidence. |
| 3 | Correct and source-backed central mechanism and outcome; may omit one secondary detail, such as Q4's top-level status or Q5's precise `time_deleted` update, but cannot omit the central changed-byte or source-missing action distinction. |
| 2 | A relevant, source-backed fragment that misses a central requested distinction. Examples: says Q4 detects a changed file but says the whole call fails; says Q5 restore works but does not distinguish it from permanent delete or the 404 actions. |
| 1 | Has a relevant fragment or citation but substantially misstates the behavior, relies mainly on unsupported generalization, or leaves most of the question unanswered. |
| 0 | No usable answer, no snapshot-grounded evidence, or a material error that reverses the result. |

## Material failures

Any listed claim caps the response at 1; if it is the answer's main
conclusion, score 0.

- Q4: says changed bytes are returned as the indexed excerpt; says the changed
  file produces a top-level `expand` failure or a normal source `ok` result;
  says CodeFacts silently refreshes the excerpt after detecting the mismatch;
  or claims the test returns the changed text.
- Q5: says all actions are allowed for a source-missing soft-deleted session;
  says ordinary `delete`, `star`, or `rename` is allowed in that state; says
  restore recreates provider source data; says permanent delete remains a
  Trash entry; or says a restored soft deletion remains excluded solely due to
  its former deleted state.

## Evidence sufficiency rules

- Cite repository-relative snapshot paths and line numbers. Nearby accurate
  citations are acceptable.
- Q4 requires the `expand` projection, changed-hash implementation, and the
  changed-byte regression evidence.
- Q5 requires route-gate/action evidence, metadata/filter evidence, and the
  scoped management regression evidence. Do not present the latter as a
  single-route source-missing test.
- Tests confirm their fixture outcome. They do not establish behavior beyond
  the implementation paths they exercise.
- README prose, planning documents, agent transcripts, and web claims cannot
  substitute for required source evidence.
