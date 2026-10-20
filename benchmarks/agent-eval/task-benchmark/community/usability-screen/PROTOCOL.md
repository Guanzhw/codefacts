# CodeFacts prospective usability screen v1

Status: prospective design frozen before model launch; runtime freeze waits for the candidate release executable. Campaign identity: `usability-screen-20261019-v1`. Historical public results remain immutable. This screen selects whether a narrow candidate merits a larger repair evaluation; it does not establish general productivity, statistical non-inferiority or SWE repair success.

## Candidate and attribution

Only two CodeFacts changes are admitted: complete feedback for mixed explore modes with concise examples of the existing three legal forms; and an expand `not_found` hint pointing to existing explore query/file routes. Preserve the default explore/expand/impact catalog, legal semantics, explicit rejection, exact symbol matching and truthful missing results. Public bridge job metadata is a separate shared harness change, pinned uniformly for all new arms; its savings are never credited to CodeFacts.

## Before models: deterministic mechanism admission

1. Replay the seven recorded GPT mixed requests (including duplicate requests) from independent-validation `EVIDENCE.json`, preserving arguments and raw source locators. They are a mechanism regression corpus, not seven independent task-benefit samples. Candidate feedback must explain all active mutually exclusive fields in one response and show a complete route to one legal mode. Keep three legal counterexamples: query, known file/window, and reads batch. Check returned source spans and catalog semantics against current CF.
2. Replay the observed Vue `expand(symbol="pluginScoped")` miss on its pinned source; retain `not_found` and transport success as separate fields. Candidate hint must direct a caller to explore, whose subsequent query/file route reaches the actual `scopedPlugin` definition within two navigation calls. Compare actual source and baseline; no invented aliases or silent fallback.
3. Validate the shared source_exec/source_poll job header through the actual client text projection for delayed execution, nonzero exit, incremental poll and truncation. These are harness-only checks, outside task benefit. The read-only task screen exposes no execution tools, so it cannot measure this repair's usability benefit.
4. Root's product tests and protocol/client checks must pass. Freeze candidate and baseline release binaries, three default tool schemas/descriptions, shared bridge and DSH/MCP SDK files. Do not spend model calls if source correctness or any legal counterexample changes unexpectedly.

## Independent task cells

Run 48 fresh cells: three pinned DSH routes × four community issues × four arms, one session per cell. Routes are `opencode-go/qwen3.8-flash`, `opencode-go/claude-haiku-5-5`, and `opencode-go/gpt-6-luna`, all `reasoningEffort=high`. Qwen/Claude had opposite historical cost directions; GPT is essential for the observed mixed-mode failure. Do not substitute model IDs after outcomes. Request headers must prove actual model, effort, output cap and complete menu; backend revision remains unknown unless returned by the provider. Existing credential inheritance and SDK initialization are owned by `runDshAttempt`; this runner adds no provider or credential implementation.

Arms: ordinary source tools; preserved released CF 0.2.2; candidate CF release executable; independent CodeGraph 1.6.2 product. Candidate maps only to the existing CF bridge contract. All arms receive identical task text and common read-only source tools. No forced native call, model hints, preloaded other-arm answers, cross-session continuation, automatic hooks or edits. Zero native calls is a retained outcome. CG owns a fresh native index in each fresh cell root.

The exact task prompts, source manifest hashes, commits, source hashes and checks are in `tasks.json` and `manifest.json`. They are adaptations of real ContextBench community issue records, with explicit investigation questions. No miniature synthetic task replaces the end-to-end task. Each requires connecting multiple production owners and a regression seam:

| Issue | Commit | Required connections |
|---|---|---|
| cli/cli #3608 | 026b07d1cfbf23a3ccb4d4703a2496d65e177fcc | command flags/options → API fork request → command tests, clone/remote preservation |
| nushell/nushell #12901 | 580c60bb821af25f838edafd8461bb206d3419f3 | hidden stack environment → string conversion → child process environment → regression design |
| sveltejs/svelte #3394 | bb9a9efec275084983117adee52718b5a35376b6 | script and template assignment paths → emitted invalidation → runtime dirty scheduling → computed-member fixture |
| mui/material-ui #34229 | fa62bf35e109ede215cb8cbae66ba4d6a30fef60 | Select display/wrapper width paths → Menu/Popover handoff → autoWidth/style/open-state tests |

These exclude the exact Clap2534/Svelte12509/Vue11899/Preact3010/CLI9794 mechanism cases. They reuse repositories and historically evaluated tasks, so they are a prospective diagnostic holdout from the chosen mechanisms, not an unseen benchmark or unbiased generalization sample. Every arm must first check whether the issue is present in the pinned snapshot. Svelte already contains member-expression handling; its criteria accept a source-backed already-supported/unchanged-code diagnosis. CLI's organization propagation is currently absent and must be described as a proposed necessary change. MUI is labeled TypeScript by the frozen community selection; this issue's owning Select/Menu files are JavaScript, so report its actual source mix and do not claim four parser-language coverage. The Svelte task likewise includes TypeScript compiler files. A subsequent larger repair evaluation must include Vue's existing official at-rule/comment-preservation gate and ordinary/CG controls; read-only answers cannot pass that SWE gate.

## Schedule, resources and isolation

Fixed seed `codefacts-usability-screen-20261019-v1`; sort the SHA256 of seed + newline + cell identity before launch. Preserve schedule and dispatch ordinals. Initial concurrency is 4, in admission-checked waves with at least 8 GiB free RAM and 12 GiB free disk before each wave. No heavy grading or speed comparison on the remote 2-vCPU/1.7-GiB host. Execute all timing arms on the same Windows host.

Each cell independently copies exact source bytes, creates a private Git boundary, indexes into private CF/CG state, and gets a new DSH_HOME/session ID. Freeze includes full installed DSH/SDK/provider package files, Node, rg, native artifacts, task manifests, and benchmark executable sources. Verify source bytes before freeze and after every cell. Model-visible read-only bridge fixes the root and excludes state/history/evaluator material. The gate file and other cells are not exposed as tools.

Timeout is 360 s per cell; output generation allowance is 16384 tokens per request through the existing adapter configuration. This is a per-request generation cap; total session tokens have no separate cap. At concurrency four, session wall-time allowances total at most 72 minutes plus preparation/indexing and process shutdown. Provider cutoff/failure and zero-use remain outcomes, without automatic retries. Stop after an infrastructure failure, preserve evidence, and investigate; no silent replacement cells. To continue a partial campaign, use an explicitly documented new identity/schedule and retained failure accounting. No resume/overwrite is implemented.

Source logical size is 169,867,091 bytes per four-task set, approximately 1.90 GiB across 48 independent cells, plus per-file allocation and fresh indexes. Per-wave disk admission limits growth. Preserve raw event/bridge traces, receipts, setup identities and source copies for source-grounded review; removal is a separately reviewed cleanup after archive verification. This runner performs no cleanup of historical data.

## Measurements and independent review

Preserve raw actual request headers/catalogs, initialization, tool calls/results, final answer, model completion, declaration status, setup/index wall time, model wall time, SDK process duration, total elapsed time and all provider token components. Model wall time is `turnEndedAtMs - promptedAtMs` only when both boundaries are finite; otherwise null. SDK process duration is the adapter's separate `durationMs`, or null when absent. Total cell elapsed includes preparation. Use adapter exact turn usage where available; lower bounds and unavailable counters remain distinct from zero. Do not equate totalTokens with invoice price, bytes with tokens, or empty source facts with successful navigation.

Record native adoption; input errors; domain `not_found`; nonempty correct facts; first valid recovery; repeated identical errors; source evidence reached within two calls of feedback; and subsequent visible use. A trace analyst must cite call IDs and source lines. Use final declared regions only as locators. `reviewEvidence` reports overlaps for reviewer convenience and always leaves semantic status pending. An independent reviewer, blinded to arm when practical, checks every frozen criterion against rationale, actual visible source and trace. Accept alternate correct loci only with explicit source reasoning; record pass/fail/unknown for each criterion. A task passes only when all criteria pass, cited ranges exist, and no unsupported causal explanation occurs. Unknown is not pass. Do not present localization overlap as task quality or official resolved.

## Predeclared practical decision gate

All of the following are necessary before a larger repair campaign:

1. Deterministic admission passes: seven mixed-mode responses cover the complete route; three legal forms preserve source facts; Vue miss stays truthful and reaches scopedPlugin in at most two subsequent native navigations; three-tool catalog stays intact; shared harness client checks pass.
2. No new known task-quality failure: for every matched model/task where current CF passes all frozen review criteria, candidate also passes. Any candidate-specific new failed criterion blocks selection until explained and fixed in a newly frozen screen. Missing review blocks the decision. This is a practical small-sample gate, not a non-inferiority claim.
3. For quality-passing candidate/current-CF pairs, at least three matched tasks in at least two models must be available. Each of those models must have candidate/current-CF median exact total-token ratio ≤0.90 and median model wall-time ratio ≤1.00; neither may have an individual quality-passing pair with either ratio >1.25. Report exact token components and setup-inclusive wall time alongside these directional thresholds. Missing exact usage makes that token pair unavailable; do not use a lower bound as a full counter.
4. Trace evidence must show the proposed recovery mechanism in at least two independent candidate sessions where that situation occurs, with fewer repeated invalid/miss-only calls than their matched current-CF cells. If ordinary task sessions never encounter either targeted situation, mechanism usability is inconclusive; deterministic replay alone cannot satisfy this agent-recovery gate. No post-hoc forced prompt is added to these cells.
5. Report candidate against ordinary and CG per matched model/task with the same quality constraints. A CF-only win is insufficient for a broad worth-it conclusion. If quality-matched evidence is sparse or direction disagrees, stop expansion and retain the uncertainty. Only a later real repair campaign with official grading can establish repair usefulness.

## Operator commands and launch prerequisites

See [`HANDOFF.md`](./HANDOFF.md) for the exact copy, configuration, build, plan and test commands.

Start with `manifest.example.json`, which contains the public frozen task text, gate criteria and hashes, commits, model routes, arms and limits. It is marked `templateOnly`; planning or building from it fails until you copy it, fill the local runtime and baseline executable paths, and set `templateOnly` to `false`. Do not place private campaign results in the example.

The source pack root contains one directory per `instanceId`, each with `source/` and `manifest.json`. The builder rebases task source paths and replaces candidate executable, evidence directory, campaign identity and seed from its explicit arguments. Choose a fresh output and evidence directory for each build:

```powershell
& 'ABS_NODE' ./benchmarks/agent-eval/task-benchmark/community/usability-screen/build-manifest.mjs `
  --source-manifest 'ABS_EXISTING_SCREEN_MANIFEST' `
  --sources-root 'ABS_COMMUNITY_SOURCE_PACK_ROOT' `
  --candidate-exe 'ABS_CANDIDATE_EXECUTABLE' `
  --evidence-dir 'ABS_NEW_EVIDENCE_DIRECTORY' `
  --output-dir 'ABS_NEW_MANIFEST_DIRECTORY' `
  --campaign-id 'NEW_CAMPAIGN_ID' `
  --seed 'NEW_RANDOMIZATION_SEED'
```

The builder verifies source identity, source entries and gate ranges before writing `tasks.json` and `manifest.json`. It refuses to overwrite either output. The new manifest preserves the template's task questions, routes, arms, resource limits and runtime pins while rebasing source paths and recording the supplied candidate and campaign identity.

Use the installed Node executable and absolute manifest path:

```powershell
& 'C:/Program Files/nodejs/node.exe' ./benchmarks/agent-eval/task-benchmark/community/usability-screen/run.mjs plan ABS_MANIFEST
& 'C:/Program Files/nodejs/node.exe' ./benchmarks/agent-eval/task-benchmark/community/usability-screen/run.mjs freeze ABS_MANIFEST
& 'C:/Program Files/nodejs/node.exe' ./benchmarks/agent-eval/task-benchmark/community/usability-screen/run.mjs run ABS_MANIFEST
```

`plan` reads metadata/source gates only and launches nothing. `freeze` verifies complete source snapshots and pins runtimes without provider calls. `run` starts models and must wait for root's go decision. Required before launch: candidate release build and exact hash; root's deterministic mechanism/client receipts; source-grounded independent review of the frozen gate criteria; installed route support validation (actual headers are subsequently audited); preserved model/runtime metadata; sufficient same-host resources. A dry-run or passing unit fixture is never a model result.
