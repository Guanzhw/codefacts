# OpenSession history corpus provenance

This corpus is an independently rewritten, read-only task set derived from one
real local OpenSession task family. It stores only anonymous task/thread IDs,
tool event IDs, raw-event line numbers, and the minimum description needed to
audit selection. Original prompts, answers, user identity, paths outside the
workspace, and provider payloads remain in the ignored local audit directory.

## Frozen source

- Repository: OpenSession
- Commit: `543e874e697523bf474f494bcf897a17f19587de`
- Construction-time local source materialization:
  `target/history-audit-20260919/replay-source` (not a campaign runtime input)
- Local audit inputs: `calls.jsonl`, `priority-cases.json`,
  `thread-inventory.json`, `wrapper-candidates.jsonl`, and
  `source-snapshots.jsonl` under `target/history-audit-20260919/`
- Source evidence: every criterion in `tasks.json` records a repository-relative
  path, line span, and full-file SHA-256 from that materialization.

At evaluation time, the campaign's machine configuration supplies the sole
`sourceRoot`. The corpus does not pass the ignored audit path to the evaluated
agent.

The local audit source was collected through Codex's built-in task history and
read-only local rollout reads. AgentSession MCP was not used. Two built-in
`read_thread` checks were used to confirm the meaning of the reader-navigation
and Codex protocol-reuse tasks; their text is not reproduced here.

## Case lineage and exposure

| Task | Minimal lineage | Exposure |
| --- | --- | --- |
| OS-H01 | thread `01a0576a-98e2-7c31-a265-6d98d5fbff12`; event `exec-dd8fd4ad-59c1-4681-96ba-767794d7b364`; raw line 67828 | `audit-replay-exposed`; exact identifier was replayed, and the old CodeGraph exact query missed the target. |
| OS-H02 | thread `01a08cc3-75b8-71f2-aaad-022d7c3cf11c`; events `exec-92e7f2fc-0ac1-49bf-b2de-84c338c64ef0`, `exec-a84f6b5d-c894-44aa-b8ea-96bb399db911`; raw lines 339, 341 | `history-query-exposed`; the guessed name and recovery are known. |
| OS-H03 | thread `01a0812b-ede9-7ab3-92eb-3e51c0ac0466`; events `exec-1c4602ff-b399-4e28-aebf-23fdfd32e193`, `exec-b231fc1b-0f29-45cb-9253-34c1b6b59e45`; raw lines 322, 323 | `history-answer-exposed`; the static path was previously returned and cited. |
| OS-H04 | thread `01a07f66-75c8-7b61-bb90-db5802075499`; events `exec-5f5fc22a-e534-4063-802c-42b346247091`, `exec-ab6d66d8-485c-4955-91b7-aa34c0800b1d`; raw lines 74, 137 | `new-to-task-evaluation`; new negative-boundary synthesis from the same family. |
| OS-H05 | thread `01a0576a-98e2-7c31-a265-6d98d5fbff12`; events `exec-f766abd2-3271-4e4b-a54e-7343e11259f2`, `exec-d0abeac7-e08e-46aa-a06a-606e22fd0d1e`; raw lines 48868, 65169 | `new-to-task-evaluation`; new four-part ownership judgment from the original theme. |
| OS-H06 | thread `01a0ae4c-8a52-7860-a866-a31bf7affa59`; event `exec-e27687d3-e21d-4423-8374-d6793f79bcd4`; raw line 1688 | `new-to-task-evaluation`; stale-claim diagnosis rewritten from a real fix task. |

`new-to-task-evaluation` means only that the exact task/rubric was not used in
the earlier audit comparison. It does not make OS-H04–H06 statistically held
out from the task family or from the investigator's selection process.

## Selection limits

The six cases are purposefully balanced across direct lookup, fuzzy discovery,
cross-file tracing, provider boundaries, negative relationship judgment, and
change planning. They include normal successful paths, uncertain dispatch,
two false or partly stale reports, and a reproduced navigation difficulty.
They are not a random sample and cannot support a general retrieval win rate.

The set excludes the already evaluated `getRuntimeProtocol` and
`deriveConversationView` expansions and the repaired `renderSessions` ranking
case. OS-H01 remains exposed for a different reason and must be reported on its
own. No evaluation-model run or formal result was read or generated while
constructing these files.
