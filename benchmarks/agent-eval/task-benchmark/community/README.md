# Community task benchmark

Compare ordinary source tools, CodeFacts 0.2.2, and CodeGraph 1.6.2 using the
same DSH `opencode-go/deepseek-v4.1-flash`, high reasoning, and 32,768 output
tokens per generation. Native navigation is optional. There is no campaign
token budget; each attempt has a 20-minute execution timeout.

The two cohorts answer different questions:

| Cohort | Task | Primary quality measurement |
| --- | --- | --- |
| ContextBench | Read-only issue localization | Official file, symbol, span and line coverage/precision on explicitly declared regions |
| SWE-bench Multilingual | Edit, test and submit a repair | Official per-instance `resolved` |

ContextBench uses an **adapted read-only protocol**. Actual exposed source also
feeds official trajectory metrics. Empty model patches cannot consume the
reference patch; EditLoc is unavailable. These results do not reproduce the
original complete-repair ContextBench protocol.

Each cohort has two pilot tasks and one confirmation task per language, across
Go, Rust, JavaScript and TypeScript. Report pilot and confirmation separately.
Four confirmation tasks per cohort support descriptive comparisons. The
selection file and all failed or unavailable attempts remain in the report.

## Prepare

1. Obtain the original datasets and pinned official scorer trees listed in
   [the design](../../../../docs/specs/community-benchmark-20261017/design.md).
   Verify the downloaded files against their official release metadata.
2. Freeze the deterministic selection before inspecting model outcomes. Export
   only issue text, repository identity and base commit to model inputs.
3. Use `downloadCommunitySources` from `prepare.mjs` to inspect and export the
   fixed GitHub archives. Preserve source bytes, modes and symlink targets.
4. On this Windows host, `runtime.symlinkStrategy="wsl-lx"`, `runtime.wsl` and
   `runtime.wslDistro` enable real Linux symlink creation and Git operations
   through WSL. Windows native tools still run on the same source tree. Windows
   source readers cannot follow LX symlinks; report this platform limitation.
5. Prepare separate private Context grading clones with `prepareCommunitySlot`
   using the ordinary arm. Record the actual synthetic commit and source
   manifest. These clones stay outside the model attempt and archive trees.
   `runtime.contextSourceMode="hardlink"` shares immutable file bytes for
   read-only localization; Git metadata and indexes stay private. Repair
   attempts always copy independent bytes.
   Read-only model attempts can use `runtime.contextGitMode="boundary-only"`
   to avoid creating source commits for every arm. Official grading bases and
   repair attempts retain full Git repositories.
6. Prepare SWE images and run official gold/empty controls for each admitted
   repair task. The agent image removes embedded upstream history, evaluator
   material and task build artifacts. Retain the original image for grading.

The benchmark uses Docker and Python only for its evaluation environment.
CodeFacts itself remains a native local binary.

## Freeze and run

The operator manifest supplies absolute runtime paths, the three arms, 12 tasks
for one cohort (or all 24), and `evaluation.inputFiles`, `upstreamRoots` and
`runtimeFiles`. Include the original data, grading config, full official scorer
trees, environment receipts, and the complete shared SDK `node_modules` tree:
dependencies such as Ajv can be hoisted outside the SDK package itself.

```powershell
node community/campaign.mjs --manifest C:\eval\manifest.json --mode freeze
node community/campaign.mjs --manifest C:\eval\manifest.json --mode run --split pilot
node community/grade-campaign.mjs --manifest C:\eval\manifest.json --config C:\eval\grading.json --split pilot
node community/summary.mjs --evidence C:\eval\campaign
```

Commands above run from `benchmarks/agent-eval/task-benchmark`. Review the pilot
before running `--split confirmation_holdout`. A configuration change requires
a new campaign identity; it cannot reuse the previous freeze. `--slot ID` runs
one allocated slot. A failed grading retry requires `--retry` and creates a new
directory, preserving the earlier failure.

`grade-campaign.mjs` also exports `createSlotGrader` for the runner's `grade`
callback. Its operator config contains:

```json
{
  "grading": {
    "context": {
      "python": "/task/context-venv/bin/python",
      "officialRoot": "C:/eval/ContextBench",
      "datasetPath": "C:/eval/context.parquet",
      "repoCache": "C:/eval/context-worktrees"
    },
    "swe": {
      "python": "/task/swe-venv/bin/python",
      "officialRoot": "C:/eval/SWE-bench",
      "datasetPath": "C:/eval/private-swe.jsonl"
    }
  },
  "contextBases": {
    "ctx-INSTANCE": {
      "repoRoot": "C:/eval/private-base/source",
      "gradingCommit": "ACTUAL_PRIVATE_COMMIT",
      "sourceManifestPath": "C:/eval/source-manifest.json"
    }
  }
}
```

Official scoring runs in task-local WSL environments. Windows drive paths are
translated to `/mnt/...`; WSL launches use `--exec`. SWE commands run in a
network-disabled container with a writable source mount and a nested read-only
`.git` mount. The runner owns container deadlines and cleanup.

## Evidence and interpretation

Keep the raw DSH headers, catalogs, calls, results and provider usage. Startup
probes are distinct from successful provider calls. Missing cache fields and
failed-call usage stay unavailable; known lower bounds are retained. A
generation cutoff is a task failure with partial output, rather than an answer.

Source ranges count as explored only when actual returned source lines can be
verified. Owner locators alone do not imply that the owner body was read.
Truncated line fragments and ambiguous output remain explicit diagnostics.

Report all planned attempts, valid quality reports, model failures, grading
failures and missing measurements. Separate source preparation, index time and
disk, model time, grading time, and actual native adoption. Compare resources
over the fixed task pairs; do not select only jointly correct attempts for the
headline. Provider tokens are not a monetary cost estimate.

The previous six-question benchmark and its frozen executor modules remain an
independent regression experiment.
