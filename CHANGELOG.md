# Changelog

## 0.2.0 — 2026-10-16

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
- The actual published Windows comparison observed 9.6467% lower Go cold
  median and a 19.0488% smaller fresh closed Go database. **53/57 native
  gates passed, overall FAIL**: the 10% cold target and three globset warm
  P95 targets were missed (map +10.1385%, outline +17.6143%, context search
  +33.0579%). A new public-artifact decision accepts those four exceptions.
  Historical CI4 remains separately recorded as 56/57 FAIL. See
  [performance details](docs/PERFORMANCE.md) and the
  [delivery record](docs/V020-DELIVERY-2026-10-16.md).

- A fixed 72-attempt navigation study completed with 69 accepted and 49 fully
  correct answers, zero critical errors, and zero observed MCP calls. Its
  7/3/1 profile results describe source-command navigation; they do not
  establish MCP-use benefits or an optimal menu. Full quality, token and
  exposure details are in the
  [validation record](docs/MCP-SIMPLIFICATION-VALIDATION-2026-10-16.md).

GitHub and all six npm packages are published; registry signatures and
provenance passed for all six. Fresh isolated Windows installation passed
262 runtime checks. Plugin 0.2.1 is merged and verified in fresh Codex and
Claude hosts using native package 0.2.0; the delivery record preserves the
accepted Claude call-count deviation and original failed assertion.
