# OpenSession Luna comparison campaign

This directory defines a frozen, read-only comparison of ordinary repository inspection, CodeFacts, and CodeGraph on six OpenSession source questions. It runs `gpt-5.6-luna` at `medium` reasoning for two repetitions per arm and task: 6 tasks × 3 arms × 2 repetitions = 36 formal attempts.

`campaign.mjs` imports `runOne` from [`../runner.mjs`](../runner.mjs). It does not implement another Codex runner. `prepare`, `freeze`, `readonly`, `status`, and `summarize` never start Codex. Only the explicit `readiness` and `run` commands can do so.

## Fixed experiment

All arms read the same source path and receive the same task question, shared read-only base prompt, model, reasoning effort, timeout, sandbox, approval policy, disabled plugins/apps/memory/skills, and call-budget wording. The CodeFacts and CodeGraph arms have one additional instruction: first make at least one relevant call to their configured MCP, then use shell reads or other available tools freely. The ordinary arm receives no MCP configuration.

The 16 combined MCP-plus-shell-call target is an audit threshold, not a hard cap. Crossing it is recorded and does not terminate an attempt. A configured tool's non-use, an empty result, an irrelevant result, or a result that the answer did not use remains in the evidence and cost. `actualMcpCalls` only means a call occurred; `useRelevance` and `evidenceUsed` are external audit fields.

Each task uses a Latin rotation in repetition 1 and the reverse order in repetition 2. Across six tasks, every arm appears equally often in every position. Runs are strictly sequential. The harness never retries a failed attempt, substitutes a task, or changes a prompt after seeing results.

The fixed execution settings are:

- model `gpt-5.6-luna`, reasoning `medium`;
- read-only sandbox with `windows.sandbox="elevated"` and `-a never`;
- `project_doc_max_bytes=0` and existing runner plugin/app/memory/skill disabling;
- 240 seconds per attempt unless a different value is frozen explicitly;
- CodeFacts from the configured native `target/release/codefacts.exe`, using its default compact responses and no proxy;
- CodeGraph's native Node entry with daemon, telemetry, and downloads disabled;
- CodeFacts and CodeGraph MCP tools set to `required=true` with per-tool `approval_mode="approve"`.

## Machine-local config

Keep absolute machine paths in an ignored target directory, for example `target/luna-opensession-20260920/machine-config.json`. Do not put them in `tasks.json`.

```json
{
  "workRoot": "D:/.../target/luna-opensession-20260920",
  "sourceRoot": "D:/.../target/luna-opensession-20260920/source",
  "codexBin": "C:/.../codex.exe",
  "sessionsDir": "C:/.../.codex/sessions",
  "codefactsBin": "D:/.../target/release/codefacts.exe",
  "codegraph": {
    "nodeBin": "C:/.../node.exe",
    "entryJs": "C:/.../lib/dist/bin/codegraph.js"
  },
  "sourceRevision": "543e874e697523bf474f494bcf897a17f19587de"
}
```

The source must be a fresh archive under `workRoot`, without `.git` or `.codegraph`. The harness passes `GIT_CEILING_DIRECTORIES=workRoot` to native CodeGraph and Git checks so the archive cannot resolve the enclosing CodeFacts repository. It refuses CodeGraph initialization if Git still recognizes a worktree.

Create the source from the local repository by commit object. This does not depend on a remote named `origin`; inspect the configured remotes and verify that the selected local repository is the intended `Guanzhw/AgentSession` checkout before archiving:

```powershell
$sourceRepo = 'D:/WorkSpace/OpenSession'
$workRoot = 'D:/WorkSpace/codefacts/target/luna-opensession-20260920'
$commit = '543e874e697523bf474f494bcf897a17f19587de'
git -C $sourceRepo remote -v
git -C $sourceRepo cat-file -e "$commit^{commit}"
New-Item -ItemType Directory -Path "$workRoot/source"
git -C $sourceRepo archive --format=tar --output="$workRoot/source.tar" $commit
tar.exe -xf "$workRoot/source.tar" -C "$workRoot/source"
```

On the recorded machine the matching remote is named `opensession` and points to `Guanzhw/AgentSession`; the archive command itself resolves only the verified local commit. Before `prepare`, confirm that `source` is new and contains neither `.git` nor `.codegraph`.

## Preparation and freezing

Run from the repository root with the same config argument each time:

```powershell
node benchmarks/agent-eval/opensession-corpus/campaign.mjs prepare --config target/luna-opensession-20260920/machine-config.json
node benchmarks/agent-eval/opensession-corpus/campaign.mjs freeze --config target/luna-opensession-20260920/machine-config.json
node benchmarks/agent-eval/opensession-corpus/campaign.mjs readonly --config target/luna-opensession-20260920/machine-config.json
```

`prepare` performs native indexing only. It does not run a model or Codex preflight. It records binary versions and hashes, the full CodeGraph `lib/dist` digest plus package metadata, and actual MCP `tools/list` schemas. CodeGraph must expose only `codegraph_explore`; CodeFacts must expose its five read-only tools.

CodeFacts indexes before CodeGraph initialization into an external master SQLite file. After CodeGraph creates `.codegraph` inside the archive, CodeFacts maps the source again and preparation fails if the generated directory changes CodeFacts' indexed-file count. Source hashes before and after initialization must match. Preparation records cold index wall time and on-disk bytes separately for both tools.

Formal CodeFacts attempts copy the prepared master SQLite file to a distinct external state directory before starting their MCP session, so one run cannot overwrite another. At freeze, the harness copies and verifies complete source and toy CodeGraph index masters outside the source roots. Before each CodeGraph attempt it copies the relevant master to a hashed staging directory, renames the current `.codegraph` into a unique recoverable `index-snapshots/<slot>-before` directory, then renames the staged master to the same fixed source path. It never deletes a prior index. This gives every CodeGraph MCP process the same warm starting index and resets session-local deduplication while preserving any before/after database and WAL change for audit. Restore cost and both index digests are recorded separately from the runner's task wall time.

Live CodeGraph index bytes are allowed to change during a read session because the installed implementation opens SQLite in WAL mode and may perform maintenance. The live bytes are therefore recorded rather than treated as immutable; the frozen master is immutable and restored before the next CodeGraph run. Source files, tasks, rubric, provenance, README decision rules, runner, campaign, preparation receipt, config, binaries, CodeGraph implementation and masters, and the CodeFacts master index are immutable after freeze.

`freeze` also validates every rubric evidence record in `tasks.json`: each relative path must exist under the source root, its complete raw-file SHA-256 must match, and every comma-separated `N` or `N-M` closed line range must be valid and in bounds. It freezes randomized response labels before results exist.

## Readiness

Readiness uses one independent toy fixture and the same question for all three arms. It is outside the six-task corpus and its token/time cost stays separate. Run each command once:

```powershell
node benchmarks/agent-eval/opensession-corpus/campaign.mjs readiness --arm ordinary --config target/luna-opensession-20260920/machine-config.json
node benchmarks/agent-eval/opensession-corpus/campaign.mjs readiness --arm codefacts --config target/luna-opensession-20260920/machine-config.json
node benchmarks/agent-eval/opensession-corpus/campaign.mjs readiness --arm codegraph --config target/luna-opensession-20260920/machine-config.json
```

The ordinary attempt must complete cleanly. CodeFacts readiness must make at least one `search`, `outline`, `expand`, or `path` call; `map` alone is insufficient. CodeGraph must call `codegraph_explore`. A failed readiness receipt stops subsequent readiness and formal work. Diagnose it from the preserved raw result; do not rerun it in place.

### Superseded first readiness campaign

The first machine-local campaign at `target/luna-opensession-20260920` stopped during readiness and remains preserved as raw evidence. Its ordinary readiness completed with 50,311 tokens. CodeFacts then failed during MCP startup after 238 ms because the harness inserted a resolved Windows root containing backslashes into a TOML quoted array; TOML interpreted those backslashes as invalid escapes. No CodeFacts model task and no formal attempt ran.

The harness now binds the concrete root in `armFor` and converts it to forward slashes before `buildRunRequest` constructs the final `-c` arguments. Recovery uses a new work root, fresh prepare/freeze, and three new readiness attempts. It does not reuse or rewrite the stopped directory. The source commit, six questions, rubric, prompts, model, and decision rules remain unchanged.

## Formal run and status

The following explicit command starts the remaining attempts in frozen order:

```powershell
node benchmarks/agent-eval/opensession-corpus/campaign.mjs run --config target/luna-opensession-20260920/machine-config.json
```

For bounded supervision, `--max-attempts 1` runs exactly the next attempt. Repeating that command advances to the next frozen ordinal; it never reruns an existing ordinal. `status` is read-only:

```powershell
node benchmarks/agent-eval/opensession-corpus/campaign.mjs status --config target/luna-opensession-20260920/machine-config.json
```

A real runtime, MCP transport, policy, or environment fault is written to the attempt and stops later launches. Timeout, spawn/exit failure, required-server startup or disconnect failure, policy rejection, usage conflict, or transcript parse failure are stop conditions. Tool application responses with `isError: true` are counted and preserved but do not stop the campaign: a bad argument, unknown symbol, empty/unhelpful retrieval, wrong answer, task-level failure, tool non-use, or more than 16 calls remains an ordinary recorded outcome and does not cause replacement or rerun.

Every attempt has its own result directory with the runner's request, stdout JSONL, stderr, answer, timing, metrics, and transcript-tool audit. The campaign progress adds total/cached/uncached/output tokens, elapsed time, actual relevant MCP calls, non-use, call count, stop flags, and direct paths to those raw records.

## Blind grading and summary

First export randomized answers without grades:

```powershell
node benchmarks/agent-eval/opensession-corpus/campaign.mjs summarize --config target/luna-opensession-20260920/machine-config.json
```

Give the correctness grader only `target/.../grading-blind/index.json`, the referenced randomized Markdown answers, `RUBRIC.md`, and the generated `grades.template.json`. The index is sorted by randomized label and contains no arm, repetition, token, timing, MCP, or schedule-order mapping. The correctness grader fills only `correct` and notes.

Tool use and execution validity require a separate raw-transcript audit. `summarize` writes `target/.../tool-audit.template.json` outside the blind package with the arm, run, raw transcript, answer, actual MCP call count, runner policy flags, and runner validity state. A separate auditor fills `evaluationValid`, `useRelevance`, `evidenceUsed`, and notes after inspecting those raw records. An MCP invocation alone does not establish relevance or use in the answer. The runner's fixed `pending_manual_review` state is expected until this audit; it is preserved rather than automatically treated as valid or invalid.

Then generate the final summary with both independent inputs:

```powershell
node benchmarks/agent-eval/opensession-corpus/campaign.mjs summarize --config target/luna-opensession-20260920/machine-config.json --grades target/luna-opensession-20260920/grading-blind/grades.json --tool-audit target/luna-opensession-20260920/tool-audit.json
```

Token availability never stands in for correctness. Correctness is external. Cost-per-correct and matched-correct fields remain null until all 36 labels have boolean correctness grades and all 36 raw audits have `evaluationValid: true`. A false or missing validity audit does not remove its raw cost; it blocks the quality-matched efficiency conclusion and is shown explicitly.

## Preregistered analysis and decision

The primary table has one row per arm with an explicit denominator of 12 attempts:

1. correct completions / all attempts;
2. total tokens from all 12 attempts / correct completions, so failures still cost tokens;
3. uncached input tokens from all attempts / correct completions;
4. output tokens from all attempts / correct completions;
5. wall time from all attempts / correct completions.

If any metric is unavailable for an attempt, that aggregate is `null` with observed and expected counts. A stopped campaign retains all completed attempts and explicitly reports missing attempts; a partial campaign is never presented as the full 36-attempt comparison.

Matched-correct percentage differences are secondary. For each pair of arms, only the same task and repetition with both answers graded correct is matched. The two repetition differences are averaged within each task, then the median is taken across tasks. The summary reports how many repetitions and tasks contributed.

The existing `docs/EVALUATION.md` investment target is at least 20% lower task tokens or time without correctness regression. This six-task, single-machine campaign is only a local workflow screen and cannot support external adoption, broad product, or universal productivity claims.

The decision rules are frozen before results:

- If ordinary inspection has no lower correctness and no higher cost, do not add a code-navigation tool by default.
- If CodeGraph quality is no worse than CodeFacts and CodeFacts shows no clear efficiency or uniquely correct result, prefer the upstream tool and keep CodeFacts in limited maintenance.
- Continue focused CodeFacts investment only if its quality does not regress and it shows a reproducible, material advantage over both ordinary inspection and CodeGraph.
- Mixed or absent advantage means limited maintenance. Do not automatically add tasks, rerun failures, change prompts, or extend the campaign after seeing results.

Run the harness unit tests without starting any agent:

```powershell
node --test benchmarks/agent-eval/opensession-corpus/campaign.test.mjs
```
