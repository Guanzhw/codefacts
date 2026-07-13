# CodeFacts and CodeMapper comparison

This is an evidence snapshot from 2026-07-14, not a general performance
benchmark or a claim that raw symbol totals are interchangeable. Both tools
were run against local working copies on Windows. CodeFacts used a fresh,
external SQLite database under the system temporary directory for every cold
index; none of the repositories under test was modified. Follow-up MCP calls
reused those external databases only to verify the repaired behavior.

## Repositories

| Repository | Revision | Why it was selected |
| --- | --- | --- |
| `D:\WorkSpace\codefacts` | `c6827eb2524cfb31672e96403c0f2adb6b7aa584` plus the pointer-return fix documented below | Rust service with TypeScript fixtures and Markdown. |
| `D:\WorkSpace\codex-codemapper` | `6d3218e9562c24c2c0e9f02d125ca4dc2b78cf5c` | Small JavaScript MCP plugin and the direct comparison target. |
| `D:\WorkSpace\llama.cpp` | `0253fb21f595246f54c192fe8332f34173be251b` | Large mixed-language C/C++ repository with public C API definitions. |
| `D:\WorkSpace\zeroclaw` | `040747908f4c14bccdb8d85e2b0f2a27e2be7014` | Large Rust agent runtime with a real direct call path. |
| `D:\WorkSpace\lucebox-hub` | `1961e112c856b38ffe1b3cffc9a30113ed6f9a85` | Large mixed-language repository containing a local C++ call path. |

The comparison ran `map`, exact-symbol discovery, `outline`, `expand`, and
`path`. CodeMapper was called through its MCP tools with an explicit `root`.
CodeFacts was queried through its release stdio MCP binary. For CodeFacts,
an exact discovery is a result filtered by exact name and evidence path because
its deliberately small `search` tool provides FTS discovery rather than a
separate exact-search flag.

## Observed results

| Repository | CodeFacts `map` | CodeMapper `map` | Workflow evidence |
| --- | --- | --- | --- |
| `codefacts` | 37 files, 2,018 symbols, 3,502 relationships | 37 files, 738 symbols | Both found `expand` in `src/service.rs`; both traced `serve -> handle_request -> call_tool`. CodeFacts bounded the `outline` response to 50 symbols; CodeMapper listed 37. |
| `codex-codemapper` | 6 files, 87 symbols, 189 relationships | 6 files, 62 symbols | Both found and expanded `handleMessage` in `plugins/codex-codemapper/server/index.mjs`; both found `handleMessage -> callTool`. CodeFacts returned 20 indexed nodes for the file while CodeMapper listed 7. |
| `llama.cpp` | 1,350 files, 53,513 symbols, 80,472 relationships | 829 files, 17,510 symbols | CodeFacts found both the public prototype (`include/llama.h:484`) and definition (`src/llama.cpp:423`) of `llama_model_load_from_file`, outlined the source file, expanded the definition to one static callee, and found `llama_load_model_from_file -> llama_model_load_from_file` when given the returned source-symbol IDs. CodeMapper returned no exact symbol, rejected `src/llama.cpp` as an unsupported file for `outline`, and found no path. |
| `zeroclaw` | 871 files, 53,640 symbols, 84,071 relationships | 1,025 files, 25,513 symbols | Both found `agent_turn` in `crates/zeroclaw-runtime/src/agent/loop_.rs`, outlined the Rust file, expanded its `run_tool_call_loop` callee, and found `agent_turn -> run_tool_call_loop`. The final CodeFacts stdio-MCP check returned `agent_turn` as the first result of `search("agent_turn", limit=5)`. |
| `lucebox-hub` | 2,335 files, 98,597 symbols, 115,644 relationships | 1,836 files, 45,199 symbols | CodeFacts found `parse_kv_type` and `to_lower` in `dflash/src/kv_quant.cpp`, returned a complete 9-symbol outline, expanded `parse_kv_type` to `to_lower`, and found the path using source-symbol IDs. CodeMapper missed the source symbol, rejected the `.cpp` file for `outline` as unsupported, and returned no path. |

The counts are intentionally not scored against one another. The tools use
different symbol taxonomies, supported-file filters, output limits, and
relationship policies. In particular, CodeFacts retains only confirmed
symbol-to-symbol facts in `expand`, while CodeMapper can return external call
targets. A count difference is therefore not an accuracy score.

## C/C++ issue found and fixed

The `llama.cpp` sample exposed a real extraction gap inherited from the
initial CodeGraph query set. The C and C++ queries only matched function
declarators whose direct child was an identifier. Pointer-return definitions
such as:

```cpp
struct llama_model * llama_model_load_from_file(...)
```

place the `function_declarator` inside a `pointer_declarator`, so the symbol
was absent from CodeFacts before this comparison. The query additions in
`queries/c.scm` and `queries/cpp.scm` now cover one pointer-declarator layer
for C/C++ definitions and prototypes, including qualified C++ methods.

The behavior is covered at two levels:

- `extract_c_and_cpp_pointer_return_functions` verifies C definitions and
  prototypes plus qualified/template C++ functions.
- `public_workflows_find_cpp_pointer_return_definitions` verifies public
  `search`, `expand`, and `path` through the source-backed service.

The real `llama.cpp` re-index after the fix is the integration proof above.

## Exact-name issue found and fixed

The ZeroClaw sample exposed a second correctness gap: a bounded FTS-only
`search("agent_turn")` could fill all 50 response slots with broad matches in
comments, signatures, and paths before it reached the actual `agent_turn`
symbol. That violates the intended identifier-discovery workflow even though
`expand` and `path` could resolve the exact symbol separately.

`search` now returns exact `nodes.name` matches first, in deterministic source
order, and fills the remaining bounded slots with FTS matches while excluding
those already-returned exact names. One focused regression test creates one
exact symbol and 51 higher-ranking FTS-noise nodes; before the change,
`limit=1` returned `noise_0`, and after it returns `agent_turn`. A second
test verifies the remaining FTS slots are filled without returning the exact
symbol twice, even when the raw FTS ranking puts that exact symbol first.

The rebuilt release binary then verified the real MCP workflow on ZeroClaw:
`search("agent_turn", limit=5)` returned `agent_turn` from
`crates/zeroclaw-runtime/src/agent/loop_.rs` first; `expand` and `path` still
returned `agent_turn -> run_tool_call_loop`.

## What this comparison says

CodeFacts now has a verified advantage on this C++ pointer-return case and
returns its own SQLite-backed evidence with source hash, extractor, and
confidence. It is not a substitute for CodeMapper in every respect: CodeMapper
currently offers a larger and more permissive exploration surface, while
CodeFacts deliberately keeps five bounded read-only MCP tools. For overloaded
or prototype-plus-definition symbols, agents should pass the stable symbol IDs
returned by CodeFacts to `path`; symbol names alone correctly return
`ambiguous` rather than guessing.

No cross-tool latency conclusion is drawn here. Their `map` responses have
different payload sizes and file sets; CodeFacts' reproducible timing runner is
documented separately in [PERFORMANCE.md](PERFORMANCE.md).
