# Same-task source-investigation benchmark

This runner compares correctness, complete task time and provider tokens for
six read-only source investigations: two each in find-my-way (JavaScript),
globset (Rust) and GitHub CLI (Go). The
[reviewed 96-attempt v2 baseline](results/2026-10-17-flash-v2/REPORT.md)
contains 93 completed attempts and three upstream HTTP 400 failures, retained
without reruns. All 72 guided-use attempts completed. Exact usage covers 93/96
attempts; the three failures are in the ordinary natural-choice arm, whose
workload tokens remain a lower bound.

The [campaign methods and review](results/2026-10-17-flash-v2/METHODS.md)
explain build identities, failures, pilot exclusion and validation evidence.

Correctness comes first: guided-use fully correct answers were ordinary 9/18,
CodeFacts 0.1.7 9/18, CodeFacts 0.2.2 8/18 and CodeGraph 6/18. On the six
eligible guided-use pairs for CodeFacts 0.2.2 versus ordinary tools, median task
time was 24.58% lower and authoritative tokens were 30.97% lower. Those paired
efficiency results do not establish a blanket quality gain or a universal
causal effect beyond this fixed suite and runtime.

The default suite is [source-investigation-v2](suites/source-investigation-v2/tasks.json).
An outcome-blind review found three v1 prompts omitted scope required by their
fourth criterion. The v1 pilot stopped after 16 completed attempts and an
interrupted seventeenth; its raw evidence remains in local `campaign-v2` as
pilot evidence. The preserved v1 suite remains unchanged. V2 makes every
required criterion component explicit in the prompts and retains the oracle
criteria and source anchors. Local `campaign-v3` used a new freeze, passed four
readiness canaries and executed its own 96-attempt schedule; pilot attempts
are excluded from the published baseline. Corpus metadata and source manifests are
shared from `source-investigation-v1`.

The four ordered arms are `ordinary`, source-built CodeFacts `0.1.7`
(`codefacts017`), source-built CodeFacts `0.2.2` (`codefacts022`) and pinned
CodeGraph `1.6.2` (`codegraph`). All use the same DSH runtime,
`opencode-go / deepseek-v4.1-flash`, high reasoning, 8192 maximum output tokens
per generation and a ten-minute attempt timeout. There is no task or campaign
token ceiling. Scored attempts run serially, with deterministic arm rotation.
Three `guided-use` repetitions produce 72 attempts; one `natural-choice`
repetition produces 24. Keep the two conditions separate in every report.

## Tool exposure and correctness

Every arm has the same bounded `source_list`, `source_read` and `source_search`
tools. Ordinary starts no native server. The treatment menus are:

| Arm | Native tools (model names add `mcp__repo__`) |
| --- | --- |
| `codefacts017` | `codefacts_map`, `codefacts_search`, `codefacts_outline`, `codefacts_expand`, `codefacts_path` |
| `codefacts022` | `codefacts_explore`, `codefacts_expand`, `codefacts_impact` |
| `codegraph` | `codegraph_explore` |

The bridge preserves native descriptions and payloads, binds root selectors to
the assigned source copy and forwards literal server instructions through MCP
initialization. Catalogs, instructions and actual model request headers are
evidence; their token cost belongs to the task. DSH's isolated profile exposes
only these tools. Each attempt owns a fresh process, home, session, source copy
and native index. Keep the oracle and evaluation evidence outside model-visible
source roots.

In guided use, the first assistant step containing source inspection must
include a native call when one is provided, and a successful native result must
contain a location in the frozen source inventory. Parallel calls in that first
step are allowed. Ordinary must inspect source with its common tools. Natural
choice permits native non-use; report that as adoption evidence. Trace adherence
is audited separately from answer quality.

Answers are limited to 300 words, cite relative paths and precise source lines,
and distinguish existing test definitions from executed tests. A fully correct
answer passes all four task criteria (`C1` through `C4`) and makes no critical
false claim. This suite measures source investigation; it does not exercise
patch quality. See [requirements](../../../docs/specs/agent-task-benchmark-20261017/requirements.md)
and [design](../../../docs/specs/agent-task-benchmark-20261017/design.md).

## Prerequisites and source bootstrap

Use existing installations of Node.js, DSH with its `sdk-minimal` profile and
token-meter modules, the MCP JavaScript SDK (including its Ajv dependency),
ripgrep, both source-built CodeFacts executables, and CodeGraph 1.6.2 with its
required native packages already available. CodeGraph preparation disables
downloads, telemetry and the daemon. These commands install no runtime packages.
The DSH adapter requires `OPENCODE_API_KEY` in the operator environment for model
calls; keep credentials out of manifests and committed artifacts.

For a Responses endpoint that accepts the tool-definition `strict` field, set
`model.supportsStrictMode: true` in a new campaign manifest (or on the selected
entry in a screen's `models` array). The adapter forwards this boolean to DSH's
`providers[provider].models[].compat.supportsStrictMode`. With the supported
pi-ai serializer, this emits `strict:false` for ordinary JSON-schema tools and
preserves their optional arguments. Leave the option unset for protocols that
do not support it. Explicit `false` is preserved and disables emission of the
wire field. The selected model setting applies equally to every arm, including
ordinary source tools; freeze and verify the resulting requests before scoring.

Replace every `X:/ABSOLUTE/...` placeholder below and in
[manifest.example.json](manifest.example.json) with an absolute local path.
On POSIX, use `/absolute/...` paths and the corresponding executable names.
The private campaign parent must already exist. Run these PowerShell commands
from the CodeFacts checkout; use a new bootstrap directory:

```powershell
$node = 'X:/ABSOLUTE/EXISTING/node.exe'
$campaign = 'X:/ABSOLUTE/PRIVATE-CAMPAIGN'
& $node benchmarks/agent-eval/task-benchmark/fetch-corpora.mjs --output "$campaign/bootstrap"
# If tar is not on PATH, append: --tar 'X:/ABSOLUTE/EXISTING/tar.exe'
Copy-Item benchmarks/agent-eval/task-benchmark/manifest.example.json "$campaign/manifest.json"
```

Edit the copied manifest before freezing. The bootstrap downloads pinned
upstream archives using Node fetch and existing `tar`, records archive hashes
and verifies each source file against tracked manifests. Its output roots are
`bootstrap/corpora/router`, `bootstrap/corpora/globset` and
`bootstrap/corpora/ghcli`. Source identities and licenses are in
[corpora.json](suites/source-investigation-v1/corpora.json).
`manifestSha256` is the SHA-256 of canonical sorted `{path, bytes, sha256}`
entries, not the manifest file's raw byte hash. The sample includes those
canonical hashes. Freeze separately pins the manifest file bytes.

When the archive host uses a certificate issuer trusted by the operating system,
but absent from Node's bundled trust store, use Node's `--use-system-ca` flag
before the script path. This requires an existing OS trust configuration.

## Freeze, canary and execution

Finish review of the suite/oracle and runtime identities before any readiness
model calls. Stop concurrent preparation workloads before timing model attempts.

```powershell
$manifest = "$campaign/manifest.json"
& $node benchmarks/agent-eval/task-benchmark/campaign.mjs --manifest $manifest --mode freeze
& $node benchmarks/agent-eval/task-benchmark/campaign.mjs --manifest $manifest --mode canary
& $node benchmarks/agent-eval/task-benchmark/campaign.mjs --manifest $manifest --mode run
```

Freeze makes no model calls. It verifies sources and records input hashes,
runtime files, framework files and the full schedule in `evidence/freeze.json`.
Canary prepares private indexes without a model, then performs four separate
model readiness attempts; its costs stay outside scored totals. Each scored
slot likewise prepares and measures its own index before launching DSH.
`prepare.mjs` exports `prepareSlot` for separate zero-model readiness checks;
it has no standalone CLI.

Rerunning `run` reuses completed compatible slots and continues serially. An
allocated incomplete slot or infrastructure failure stops dispatch. Preserve
that evidence and diagnose the failure. `--slot ID` (or ordinal) can execute the
next slot only after all preceding slots are reusable; it cannot skip work.
Changing pinned inputs requires a new campaign identity/evidence directory.

## Blind grading and collection

Export available answers without grades first:

```powershell
& $node benchmarks/agent-eval/task-benchmark/collect.mjs --manifest $manifest --output "$campaign/evaluation"
```

Give independent graders only `evaluation/blind/<task-id>/`, its `rubric.json`
and the corresponding frozen source. Random answer filenames hide arm identity;
the grading view neutralizes explicit tool names and absolute source roots.
Keep `unblinded-map.json`, raw traces, `review-input.json`, timing and usage away
from graders. Review residual clues before distribution. Lock grades before
opening efficiency aggregates.

Create one `grades/<task-id>.json` per task. Each observed anonymous answer must
have a record in `samples`, including empty/failed answers. Example record:

```json
{
  "samples": [{
    "id": "sample-REPLACE-WITH-EXPORTED-UUID",
    "answerSha256": "REPLACE-WITH-SHA256-OF-EXPORTED-ANSWER-BYTES",
    "grade": {
      "locked": true,
      "reviewer": "independent-reviewer",
      "criteria": [
        { "id": "C1", "pass": true },
        { "id": "C2", "pass": true },
        { "id": "C3", "pass": false },
        { "id": "C4", "pass": true }
      ],
      "criticalFalseClaim": false,
      "fullyCorrect": false
    }
  }]
}
```

Compute `answerSha256` over the exact exported `.md` bytes, for example with
`(Get-FileHash -Algorithm SHA256 $answerFile).Hash.ToLowerInvariant()`.
Collection rejects grades bound to a different answer hash; summary requires
locked grades and rejects contradictory `fullyCorrect`. Preserve the locked
grade files as review evidence.

```powershell
& $node benchmarks/agent-eval/task-benchmark/collect.mjs --manifest $manifest --output "$campaign/evaluation" --grades "$campaign/grades"
# Offline re-aggregation after a successful graded collection:
& $node benchmarks/agent-eval/task-benchmark/summary.mjs --input "$campaign/evaluation/reviewed-results.json" --output "$campaign/evaluation/summary.json" --pretty
```

Collection reports observed/planned/graded counts and `summaryAvailable`. A
pending schedule produces `review-input.json` and blind exports only. Once all
slots have receipts and all grades validate, collection emits
`reviewed-results.json` and `summary.json`. It rechecks frozen input identity.
Collection and summary make no provider calls.

## Portable publication

After complete collection and locked grading, export the reviewed campaign:

```powershell
$suite = 'X:/ABSOLUTE/CODEFACTS/benchmarks/agent-eval/task-benchmark/suites/source-investigation-v2/tasks.json'
& $node benchmarks/agent-eval/task-benchmark/publish.mjs --input "$campaign/evaluation/reviewed-results.json" --blind "$campaign/evaluation/blind" --suite $suite --output "$campaign/publication"
# For a mapping stored elsewhere, append: --mapping 'X:/ABSOLUTE/PRIVATE-CAMPAIGN/unblinded-map.json'
```

All arguments require absolute paths. The output directory must be new or
empty. By default, the mapping is `unblinded-map.json` beside the input file.
Publication checks suite identity, complete scheduled cells and locked grades,
then binds each anonymous answer's exact bytes to the collected
`gradingAnswerSha256`. A missing or changed answer fails publication. It writes
`results.json` with the bound neutral answers and their hashes, `summary.json`
and `REPORT.md`. Machine-local receipt and slot paths become portable evidence
placeholders; raw traces and the private mapping remain local. This offline
export makes no provider calls.

## Reading the measurements

`wallMs` measures fresh DSH process launch through exit, including MCP startup,
model/tool execution, provider delays and SDK startup (roughly five seconds in
the observed readiness environment; use recorded timings for each run).
`executionOnlyMs` is prompted-to-turn-end diagnostic time. Index preparation is
separate `setupMs`; source-copy preparation remains in setup receipts. Summaries
include reuse-count amortized estimates for 1, 10 and 100 uses. These are stage
cost estimates, not measured cold-model runs.

Provider `totalTokens` is authoritative. `uncachedInputTokens` excludes cache
read/write tokens; retain cache buckets, output and reasoning separately. Do not
add cached input or reasoning to an already authoritative total. The adapter
uses DSH's turn accounting to reconcile attempt/message events, preserving raw
events and request headers for audit. Failed, interrupted or zero-counter
settlements retain unknown exact usage and any known lower bound. Never replace
unknown usage with zero or count duplicate event representations as new calls.

Report correctness, completion, trace validity/adherence, coverage, actual tool
calls and all-attempt workload cost before efficiency. Wrong and unsuccessful
attempts remain in workload totals. Paired time/token comparisons require both
matched answers to be completed, fully correct, trace-valid/adherent and have
exact usage; report eligible pair counts and exclusions. Cost per correct
completion is withheld when exact usage coverage is incomplete. Interpret
natural-choice adoption separately and keep conclusions bounded to this suite,
model, runtime and observed provider cache behavior.

## Offline verification

CI runs the offline core test files listed in the workflow, including replay of
the published 96-attempt baseline, its report and answer bindings. The full local
suite also includes `bridge.test.mjs`, which needs existing absolute paths for
the MCP JavaScript SDK and ripgrep; it downloads nothing. In PowerShell, set
those paths and run:

```powershell
$env:TASK_BENCHMARK_SDK_ROOT = 'X:/ABSOLUTE/EXISTING/mcp-sdk'
$env:TASK_BENCHMARK_RG_COMMAND = 'X:/ABSOLUTE/EXISTING/rg.exe'
node --test benchmarks/agent-eval/task-benchmark/*.test.mjs
```

Interrupted-turn analysis also recovers settled request usage from raw events.
These values remain labeled lower bounds, with request lifecycle provenance and
unknown remaining usage. The collector's CLI loads the pinned DSH accounting
helper; programmatic callers can inject it as `deriveTurnTokenUsage`.
Run the optional installed-helper fixture with `DSH_TURN_USAGE_MODULE` pointing
to the existing `dsh-token-meter/lib/types/turn-usage.js`. Offline CI exercises
the deterministic recovery fixtures without a DSH installation.
