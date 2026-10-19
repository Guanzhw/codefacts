# Portable usability screen handoff

`manifest.example.json` is the tracked bootstrap template. It contains the public four-task prompts, gate criteria and source hashes, pinned commits, three model routes, four arms, and fixed resource limits. Its `templateOnly: true` marker makes `plan` and `build-manifest.mjs` stop with a direct configuration error.

Copy the template to a new local input manifest. In that copy, replace the `ABS_*` placeholders for runtime and baseline paths with absolute paths on the host, then set `templateOnly` to `false`. Fill these fields:

- `runtime.dshRoot`, `runtime.node`, `runtime.sdkRoot`, `runtime.rg`, `runtime.wsl`, and `runtime.wslDistro`
- `arms` entry `codefacts022.executable`
- `arms` entry `codegraph.node` and `codegraph.cli`

If the MCP SDK resolves dependencies outside `runtime.sdkRoot`, list their absolute file paths in `evaluation.runtimeFiles`. The builder preserves this list; `plan` reports missing files and `freeze` pins their bytes alongside the SDK package. Capture the resolved dependency files before launching the campaign.

For a separately defined screen protocol, set `selectionFile` to its absolute path in the configured input manifest. The builder preserves it, `plan` reports it if missing, and `freeze` pins its bytes and rejects subsequent changes. Without this field, the runner uses the module's `PROTOCOL.md`.

The builder replaces the template's campaign identity, seed, evidence directory, candidate executable, source roots and source manifest paths. The source pack directory must contain `<instanceId>/source/` and `<instanceId>/manifest.json` for each of the four tasks. No source downloads occur.

Use PowerShell from the repository root. Replace every `ABS_*` argument with the matching local absolute path:

```powershell
Copy-Item -LiteralPath './benchmarks/agent-eval/task-benchmark/community/usability-screen/manifest.example.json' -Destination 'ABS_CONFIGURED_SCREEN_MANIFEST'

& 'ABS_NODE_EXE' './benchmarks/agent-eval/task-benchmark/community/usability-screen/build-manifest.mjs' `
  --source-manifest 'ABS_CONFIGURED_SCREEN_MANIFEST' `
  --sources-root 'ABS_COMMUNITY_SOURCE_PACK_ROOT' `
  --candidate-exe 'ABS_CANDIDATE_EXECUTABLE' `
  --evidence-dir 'ABS_NEW_EVIDENCE_DIRECTORY' `
  --output-dir 'ABS_NEW_MANIFEST_DIRECTORY' `
  --campaign-id 'NEW_CAMPAIGN_ID' `
  --seed 'codefacts-usability-screen-20261019-v1'

& 'ABS_NODE_EXE' './benchmarks/agent-eval/task-benchmark/community/usability-screen/run.mjs' plan 'ABS_NEW_MANIFEST_DIRECTORY/manifest.json'

& 'ABS_NODE_EXE' --test `
  './benchmarks/agent-eval/task-benchmark/community/usability-screen/run.test.mjs' `
  './benchmarks/agent-eval/task-benchmark/community/usability-screen/build-manifest.test.mjs'
```

Using the frozen v1 seed preserves its exact cell ordinals under the same prompt, task and route contract. Supplying a different explicit seed produces a different deterministic cell order with the same 48 task/model/arm assignments. `plan` starts no models; a missing candidate or runtime input is reported in its `missing` result.
