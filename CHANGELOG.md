# Changelog

## 0.2.0 — candidate

- MCP startup exposes `explore`, `impact`, and `expand` by default.
  `--tools default` selects that same catalog, `--tools all` exposes all seven
  workflows, and `--tools explore` exposes one. Discovery and execution enforce
  the same profile. Configurations using `map`, `search`, `outline`, or `path`
  over MCP must add `--tools all` and restart the server.
- All ten direct CLI query names remain available, including `node`, `callers`,
  and `callees`. Native/npm help and configuration guidance describe the new
  default.
- Typed storage writes avoid duplicate edge location metadata and node body
  prefixes, while readers reconstruct the existing fact contract. Legacy
  metadata retains its original interpretation. A redundant edge index is
  removed, and indexing borrows immutable nodes while preserving order.
- The fixed Windows comparison observed 9.8361% lower Go cold median and a
  19.05% smaller fresh closed Go database. The 10% cold target was missed:
  **56/57 native gates passed, overall FAIL**, with an explicit engineering
  exception for that target. See [performance details](docs/PERFORMANCE.md)
  and the [validation record](docs/MCP-SIMPLIFICATION-VALIDATION-2026-10-16.md).

- A fixed 72-attempt navigation study completed with 69 accepted and 49 fully
  correct answers, zero critical errors, and zero observed MCP calls. Its
  7/3/1 profile results describe source-command navigation; they do not
  establish MCP-use benefits or an optimal menu. Full quality, token and
  exposure details are in the validation record above.

Publication and fresh installed runtime/plugin acceptance remain pending in
this candidate record.
