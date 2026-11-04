# Optional LSP acceptance

CodeFacts supplies static facts and optional query-scoped semantic reference
locations. Test these separately from an independent type checker. A command
found on PATH or a zero-error type-check run is not evidence that references or
call targets were resolved correctly.

## Freeze inputs

Record the CodeFacts version/commit and binary SHA256, provider command/version,
OS, repository commit or complete fixture hashes, language environment and
configuration. Keep the original source and a snapshot of the external SQLite
state. Record original requests, stdout/stderr, exit status, actual response
budgets, elapsed time and the definition of measured memory; unknown values stay
unknown. A mock server proves protocol behavior, not real language support.

## Independent gates

1. **Static facts:** definition locations and hashes are accurate; ordinary
   callers/callees, confidence/resolution, test associations and static impact
   remain correct with LSP off or unavailable. Same-name receiver candidates
   retain uncertainty. Associated tests are not execution/coverage evidence.
2. **Detection:** distinguish a registered provider from a discovered command,
   an unavailable command and a failed probe. Unsupported languages remain
   explicit. Discovery alone cannot pass the next gate.
3. **Protocol:** a real server initializes, negotiates UTF-16 positions and
   supports references. Configuration requests receive bounded read-only
   answers; edits are rejected. Missing/false capabilities, malformed messages,
   errors, hung writes and timeouts must not become successful empty results.
4. **References:** use cross-file fixtures with at least two known non-declaration
   references and a same-name negative case. Check actual locations against
   source, including Unicode/CRLF and same-line definitions. Keep UTF-16 columns
   separate from Tree-sitter UTF-8 byte columns. Empty success is meaningful only
   after capability and position correctness are established. Record the indexed
   documents opened by the client, document/byte caps and omissions. A provider's
   own indexing may see additional project files; bounded document priming does
   not certify complete project references. Check readiness events where the
   provider requires them. Verify returned indexed source hashes and UTF-16 range
   boundaries, including surrogate pairs, before accepting semantic evidence.
5. **State and lifecycle:** repeat queries with an existing index; canonical
   facts and generation stay stable without source changes. Compare project
   files/hashes before and after provider use. Providers are independently
   installed; there is no automatic installation or project configuration edit.
   Isolate external server cache/configuration directories in acceptance runs and
   record any host-file writes separately; third-party cache or telemetry behavior
   is not controlled by a successful references response.
   A failed session leaves no provider process tree and static queries continue.
6. **Type checking:** run pyright or another checker independently with its own
   pinned environment/configuration and record diagnostics/exit. Do not convert
   its zero diagnostics into confirmed call edges, runtime reachability or
   coverage claims.

## Release evidence

Every advertised built-in provider requires real installed-server reference
acceptance on the recorded host in addition to protocol fixtures and native
MCP tests. Platform-native package CI and Linux real-provider evidence describe
different coverage. Keep failed attempts and capability limits, and do not
claim Windows/macOS real-server acceptance from a Linux result.

The default MCP catalog stays `explore`, `impact`, `expand`; structured clients
request `format: "full"` or `"compact"`. No model campaign or agent task speed
claim follows from these engineering checks.
