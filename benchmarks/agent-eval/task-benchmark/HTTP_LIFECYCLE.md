# Benchmark HTTP lifecycle method

Select `runtime.bridgeTransport: "streamable-http"` for the Context usability
runner, or pass `bridgeTransport: "streamable-http"` to community `runDshAttempt`.
Use a new campaign/evidence namespace and freeze the new runtime sources. The
default remains the existing stdio method. This option applies uniformly to
ordinary, CodeFacts parent/candidate, and CodeGraph cells using the base
`task-benchmark/bridge.mjs` contract.

The worker directly spawns one `http-bridge.mjs` child, waits for its IPC
readiness message, and gives DSH the supported `streamable-http` URL config.
Each cell listens on `127.0.0.1`, assigned port zero, with a unique endpoint path.
MCP SDK HTTP negotiation happens in place. Every HTTP session gets its own
public SDK server transport and the same tools, descriptions, instructions,
argument adaptation, and results as the stdio bridge. Session deletion and
reconnect reuse the bridge's persistent native connection.

CodeFacts preparation in this method copies/verifies source and writes config;
it starts no native MCP process and performs no map/preindex call. CodeGraph
retains its required CLI init. Bridge readiness eagerly starts the single native
stdio backend and performs initialize/tools-list only. The first real native
tool call retains responsibility for cold semantic indexing. Include preparation,
bridge bootstrap/readiness, DSH startup, HTTP sessions, and teardown in any new
full-workflow measurement. `durationMs` stays the existing DSH process duration;
`workflowWithHttpMs` additionally observes bridge startup and closure but starts
after source preparation and is not a qualified primary metric.

## Receipts and closure scope

`lifecycle.mjs` creates one exclusive UUID JSONL file before each instrumented
spawn. Each event has its parent UUID, role, context, per-writer sequence,
wall-clock attribution, and local monotonic time. PID is an attribute; no OS
CreationDate is fabricated. Aggregate all relevant lifecycle directories,
including the worker's, preparation's, and attempt's, when evaluating parent
integrity. Supply independently expected UUIDs to `evaluateLifecycle`; missing
instances, parents, actual close, HTTP quiescence, and explicit unresolved
descendants remain UNKNOWN. Recorded failures remain FAIL. The evaluator checks
ordering within an instance; monotonic clocks from different processes are not
comparable.

| Boundary | Owned evidence |
| --- | --- |
| Worker | Controller's direct ChildProcess start/exit/close, cleanup request/result, forced pipe closure |
| CodeGraph CLI init | Preparation owner's direct ChildProcess start/exit/close, timeout kill request |
| HTTP bridge | Worker's direct ChildProcess start/exit/close, IPC ready, shutdown/kill requests and results |
| DSH | Worker's direct ChildProcess start/exit/close and shutdown/kill request |
| ripgrep | Bridge's direct ChildProcess start/exit/close, truncation/timeout/shutdown kill request |
| Native stdio | Public SDK start/PID and actual `transport.onclose`; code, signal, and hidden escalation remain null |
| HTTP | Request start/end, initialized session start/close, admission stop and zero active session/handler quiescence |

Native close requests are idempotent and separately await the public close event
within an explicit teardown allowance. SDK `close()` return alone never qualifies
native closure. HTTP disconnect does not close the backend process. Shutdown
stops HTTP admission, closes sessions, awaits HTTP handlers/listener and backend
calls, then closes the native backend; the worker separately awaits the bridge's
actual process close. Startup failures still run that owned teardown path.

PASS covers recorded owned direct children and HTTP quiescence. It does not
establish graceful native termination, native exit status, or every OS descendant.
Unknown descendants and forced pipe destruction must be preserved explicitly.
Bounded ripgrep output can intentionally request termination; that request stays
in `forcedCleanup`. A completed direct-child close still satisfies its lifecycle
boundary. Output truncation alone does not imply a surviving process.
If a primary measurement requires native exit code or proof of no forced SDK
escalation, a benchmark-owned direct stdio transport/supervisor is still required;
the public SDK event cannot provide those fields. No SDK private fields or
installed transport/plugin code are patched.

Existing cohorts and UNKNOWN rows keep their original methods/results. New DSH
and provider acceptance, independent quality review, and separately defined
metric eligibility are still required before a new benchmark cohort.

## Local synthetic verification

Use existing absolute installation paths; no dependency install is performed:

```powershell
$env:TASK_BENCHMARK_SDK_ROOT = 'C:/Users/QQ110/.dsh/profiles/web/node_modules/@modelcontextprotocol/sdk'
$env:TASK_BENCHMARK_MCP_CLIENT_ROOT = 'D:/npm/node_global/node_modules/@deepseek-ai/dsh/node_modules/@modelcontextprotocol/client'
$env:TASK_BENCHMARK_RG_COMMAND = (Get-Command rg -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
node --test benchmarks/agent-eval/task-benchmark/lifecycle.test.mjs benchmarks/agent-eval/task-benchmark/rpc-lifecycle.test.mjs benchmarks/agent-eval/task-benchmark/http-bridge.test.mjs
```

Set `TASK_BENCHMARK_CALIBRATION_DIR` to an existing fresh artifact directory to
retain synthetic receipt files. The tests use Node fixture children, ripgrep,
and SDK clients/servers only. They cover short-lived grandchildren, inherited
pipes versus process exit, forced pipe uncertainty, startup failure, missing
native close event, two-cell isolation, in-place MCP client 2 auto negotiation,
session disposal/reconnect with one synthetic native process, and parity with
the stdio bridge. Real DSH/provider/product-native acceptance is a separate gate.

CI runs the protocol-only HTTP tests with the existing SDK fixture. The real
ripgrep helper test runs when `TASK_BENCHMARK_RG_COMMAND` is supplied and
otherwise explicitly reports unavailable/skipped. Protocol-only fixtures use an
unused absolute Node executable path for the required rg config slot and never
call a source-list/search tool. The installed MCP client 2 calibration runs when
`TASK_BENCHMARK_MCP_CLIENT_ROOT` is supplied; otherwise that one test explicitly
reports unavailable/skipped. The existing CI fixture installation supplies SDK 1.
