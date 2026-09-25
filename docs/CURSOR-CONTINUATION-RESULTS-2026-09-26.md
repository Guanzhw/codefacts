# Cursor continuation repair: acceptance results

The acceptance plan was [frozen before implementation](CURSOR-CONTINUATION-2026-09-26.md).
The v0.1.15 client acceptance run had encountered four copying errors with
230-character continuation cursors across compact JSON and Markdown. This
patch emits a versioned binary cursor encoded as unpadded standard Base64:
76 characters for source-only pages and 119 with a semantic snapshot. The
alphabet renders as a bare token in the existing Markdown presentation. The
decoder also accepts v1 JSON-hex cursors for an unchanged request and snapshot.

## Product verification

- `cargo test --all-targets --locked --offline -q`: 776 passed, 0 failed.
  `cargo fmt --check`, Clippy with `-D warnings`, `cargo deny check licenses`,
  and 23 npm tests passed. The npm tests used isolated empty npm config files
  because the machine's global `allow-scripts` setting blocks their packed
  install fixture. An intermediate packed-install attempt paired 0.1.16
  metadata with the still-built 0.1.15 local binary and failed its version
  check; rebuilding the 0.1.16 release binary made the focused and full npm
  runs pass. The first macOS CI run exposed a pre-existing test race: two
  separate refreshes could report 1 ms and 0 ms respectively, and compact
  omits zero counters. The Markdown equivalence test now excludes only the
  variable `freshness.duration_ms` field from its cross-call comparison.
- Real stdio MCP calls on a frozen OpenSession source snapshot completed all
  compact and Markdown continuation chains with no response error. Two dense
  queries returned the same ordered facts as v0.1.15: 10 callers, 83 callees,
  3 outbound references and 1 test for `getRuntimeProtocol`; 2 callers,
  182 callees, 3 outbound references and 1 test for
  `deriveConversationView`. Every compact/Markdown expand response stayed
  within 16 KiB. A real 230-character v1 cursor returned 30 callees and a
  76-character next cursor from the new binary.
- The v0.1.15 native cursors were 230–232 characters; the new source-only
  cursors were 76. Across the same fixed native call set, compact content text
  was 200,175 versus 198,672 bytes, and Markdown text was 125,836 versus
  124,292 bytes. These are output measurements, not task-token savings.

## Matched natural development task

One attempt per arm repaired this same cursor issue from identical v0.1.15
source snapshots. Both used Codex CLI 0.155.0-alpha.16.4 with
`gpt-6-luna/max`, the same prompt and 20-minute timeout. The CodeFacts arm
had the frozen v0.1.15 binary available and used it once; the ordinary arm
used shell/source tools only. Source and query archives were held identical.
An independent reviewer graded anonymized patches before seeing arm identity
or usage. Both passed pagination, mismatch/staleness and focused stdio checks,
but **both failed the predeclared Q1 contract**: the ordinary arm rejected
legacy v1 cursors; the CodeFacts arm emitted semantic cursors of at least
150 characters, above the 128-character limit. Neither is a correct completed
attempt under the frozen rubric.

| Formal attempt | Total input | Cached input | Uncached input | Output | Time | Executed calls | Command/MCP output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| CodeFacts available | 1,889,889 | 1,786,624 | 103,265 | 27,735 | 675 s | 34 shell + 1 MCP | 241,359 + 14,243 bytes |
| Ordinary tools | 2,073,496 | 1,960,448 | 113,048 | 26,595 | 659 s | 29 shell | 221,089 bytes |

The two readiness runs also consumed 59,809 input/805 output tokens and
29,145 input/232 output tokens respectively; the first included one MCP call
and its index refresh. The first preparation build failed because the source
archive omitted parser query files; both snapshots received the same query
archive before formal dispatch. The focused blind-grade builds each took about
one minute and may have overlapped the first client check. Snapshot creation,
main-agent implementation, and review time were not metered. Since neither
formal patch met the correctness gate, the table does not support a
cost-per-correct-task or agent-productivity improvement claim.

## Real Codex client continuation

Four read-only runs used the same frozen OpenSession source, model, prompt per
format and separate state databases. All four answers reported the correct
83 callee records, 10 distinct call-site positions, matching source hash,
no failed cursor request and no unread callee page. Actual tool logs show no
approval rejection, tool failure or parse error. The candidate's Markdown
agent reread two earlier pages before its programmatic sweep, accounting for
its extra calls and output.

| Format | Binary | Total input | Cached input | Uncached input | Output | Time | MCP calls | MCP output |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Compact | v0.1.15 | 83,170 | 61,440 | 21,730 | 3,166 | 115 s | 4 | 111,002 bytes |
| Compact | candidate | 178,753 | 136,704 | 42,049 | 2,602 | 70 s | 4 | 110,284 bytes |
| Markdown | v0.1.15 | 104,796 | 83,712 | 21,084 | 2,175 | 71 s | 3 | 31,561 bytes |
| Markdown | candidate | 105,472 | 85,760 | 19,712 | 4,580 | 94 s | 5 | 56,329 bytes |

This small client sample establishes successful consumption and complete
coverage for the new cursor. Neither format showed a consistent end-to-end
token or elapsed-time saving. The earlier four copying errors motivated the
repair; these four new runs had none on either binary.

Local raw manifests, protocol calls, transcripts, usage and blind-review
artifacts are under `D:\CodexEval\codefacts-cursor-20260926`.
