# OpenSession temporary fixture cleanup: frozen acceptance

Prepared 2026-09-16 by an independent reviewer from Git objects at `420688e` and [AgentSession issue #1](https://github.com/Guanzhw/AgentSession/issues/1). Before formal execution the controller independently reproduced all seven successful-test leaks on Windows, ran both complete files (162 passing tests), and exercised the frozen failure probes. The reviewer authored and validated the probe instrumentation before seeing arm efficiency data.

## Recommended bounded task

Use the **seven fixtures in `test/core.test.mjs` and `test/codex-provider.test.mjs` that currently have no directory removal**, including their setup and assertion failure paths. Defer `scripts/smoke-sea.mjs` to a separate task. This is a concrete subset of the real maintenance issue, suitable for a first 12-minute-per-arm development pilot.

The issue asks for a wider audit and historical local TEMP cleanup. Passing this pilot does not close those remaining requirements. Also avoid wording such as "all fixture lifecycle gaps in these two files": other fixtures already have directory removal but may have separate setup/handle failure-path gaps, which would silently broaden this task.

### Frozen target inventory

Line numbers refer only to `420688e`.

| ID | File / original test start | Test | Temporary prefix | Source-confirmed gap |
|---|---|---|---|---|
| T1 | `test/core.test.mjs:893` | OpenCode token stats include child sessions exactly once | `agentsession-token-` | The outer finally only calls `closeDb(dbPath)`; it does not remove the directory. The fixture writer's `DatabaseSync` is only closed on the successful setup path at line 924. |
| T2 | `test/core.test.mjs:2260` | terminal launch is enabled by default and supports an explicit startup opt-out | `agentsession-config-` | No directory cleanup. |
| T3 | `test/core.test.mjs:2284` | runtime events write JSONL under meta logs with redaction | `agentsession-runtime-log-` | No directory cleanup. |
| T4 | `test/core.test.mjs:3565` | OpenCode runtime environment resolves project and user agent extensions | `agentsession-runtime-` | Finally restores `XDG_CONFIG_HOME` only; fixture setup and directory cleanup are not protected by a complete fixture lifecycle. |
| T5 | `test/core.test.mjs:3635` | provider runtime environments classify instruction files as runtime extensions | `agentsession-instructions-` | No directory cleanup. |
| T6 | `test/codex-provider.test.mjs:323` | Codex reads the official compressed rollout representation | `agentsession-codex-zst-` | No directory cleanup. |
| T7 | `test/codex-provider.test.mjs:362` | Codex rejects compressed rollouts over the provider-owned output bound | `agentsession-codex-zst-bound-` | No directory cleanup. |

The issue records an earlier Windows execution in which T1 and T2 passed and left `sessions.db` and `config.json`. The controller's new isolated baseline run reproduced all seven leaks before freezing this task. Evaluator probes also detected the retained directories on assertion/setup failures and the unclosed T1 writer after an injected `DatabaseSync.exec` failure.

## Suggested task prompt

> Fix the current test-fixture cleanup bug described by AgentSession issue #1 in this frozen checkout. For this task, scope the patch to the seven existing fixtures with prefixes `agentsession-token-`, `agentsession-config-`, `agentsession-runtime-log-`, `agentsession-runtime-`, `agentsession-instructions-`, `agentsession-codex-zst-`, and `agentsession-codex-zst-bound-` in `test/core.test.mjs` and `test/codex-provider.test.mjs`.
>
> Each fixture must release its own database or file resources and remove exactly its newly created directory after successful execution and after setup or assertion failures. Preserve the current tests' assertions and behavior, including `XDG_CONFIG_HOME` restoration and the Zstd size-bound check. Cleanup errors must remain visible. Keep the change small and use the project's existing style.
>
> Work only in this isolated checkout. Do not clean historical system TEMP data, change the SEA smoke script, modify provider behavior, or disable/skip/weaken tests. Use a dedicated temporary root for validation. Run the seven affected tests and the relevant existing test files, and report the patch and the validation actually obtained. Leave the patch available for independent review; do not push or publish it.

The runner should append the same exact prepared build/test commands, Node executable path, time limit, and writable temporary root to every arm. Do not give one arm a diagnosis or helper unavailable to the others. Discovery assistance by CodeFacts/CodeGraph is the experimental difference; automatic requirement of an MCP call would instead measure guided use and must be labeled that way.

## Preflight required before freezing

1. Record the exact full Git SHA, clean baseline source hashes, Node version, executable path, and prepared build/dependency state. Confirm all arms receive the same source and existing built output. The live OpenSession directory has separate work and is not an arm workspace.
2. Verify the chosen Node can import `node:sqlite` and `node:zlib`'s `zstdCompressSync`. Do not presume the documented minimum Node version proves this particular runtime supports Zstd. The size-bound test creates a source over 64 MiB, so allow the same resources in all arms.
3. Use a child-process environment to set `TEMP`, `TMP`, and `TMPDIR` to the dedicated absolute run root. This avoids mutating the controller's environment. Confirm `os.tmpdir()` in that child resolves to the intended root before running anything.
4. Place an outside-scope sentinel file and sibling directory in the run root. Record content hashes. Capture exact created fixture paths, not merely a broad prefix count; `agentsession-runtime-` is a prefix of `agentsession-runtime-log-`, and the two Zstd prefixes also overlap.
5. Run all seven selected tests on the baseline and record TAP outcome plus the remaining owned paths. A fresh directory for each pass makes leakage attributable. Baseline failures unrelated to cleanup must be resolved or the task re-scoped **before** formal arms start.
6. Prove the acceptance fault-injection mechanism triggers the intended sentinel failure on the baseline and distinguishes an unreleased fixture-writer database. Freeze the injection script and expected records before evaluating patches.

The following test-name pattern selects the seven targets without depending on line numbers:

```text
OpenCode token stats include child sessions exactly once|terminal launch is enabled by default and supports an explicit startup opt-out|runtime events write JSONL under meta logs with redaction|OpenCode runtime environment resolves project and user agent extensions|provider runtime environments classify instruction files as runtime extensions|Codex reads the official compressed rollout representation|Codex rejects compressed rollouts over the provider-owned output bound
```

Invoke through a structured argument vector, e.g. `node`, `--test`, `--test-name-pattern=<pattern>`, `test/core.test.mjs`, `test/codex-provider.test.mjs`. Do not mix build/install time into one arm's development time if those prerequisites are shared and prepared for all arms.

## Automatic acceptance after patch submission

### A. Preserve behavior and scoped change

- Apply each submitted patch to an independent clean checkout of the frozen source. Record apply failures explicitly.
- Run the seven tests and then both full existing test files against the same prepared build. Require successful exit and the original selected tests to execute, with none newly skipped/cancelled/todo. The reviewer checks that assertions, expected values, fixture payloads, and test names retain their meaning; additions are allowed.
- Reject edits to application behavior, blanket deletion of the temporary root, or a cleanup mechanism that swallows deletion failures. `force: true` alone is not evidence of suppressed Windows lock errors: assess actual error handling. It suppresses absent-path errors, not every removal error.
- Compare outside-scope sentinel files and sibling content hashes before and after every run.

### B. Successful-run cleanup

- Run the seven selected tests twice, with fresh isolated run roots and unchanged sentinels each time.
- After every successful child exit, require all exact directories created by T1–T7 to be absent. Report per-test observed creation and removal; an absence-only check can be gamed by deleting the fixture creation or skipping a test.
- For T1, verify both the direct fixture-writer SQLite handle and any application-cached handle are released before removal. Merely observing an empty root after process exit is insufficient proof of handle ordering, because process exit releases handles automatically and POSIX can unlink open files.

### C. Assertion failures

- In disposable verification copies only, force one deterministic failure in each selected test **after its first material resource/setup operation and before a normal assertion can complete**. Prefer replacing the first assertion with a sentinel throw, preserving fixture setup.
- Require a nonzero test result containing the expected sentinel, with exactly the intended selected test failing. Require its exact owned fixture directory to be removed and unrelated sentinels unchanged.
- For T4, inspect or instrument environment restoration in-process; child exit alone cannot prove `XDG_CONFIG_HOME` was restored. Exercise both an initially absent value and a preexisting sentinel value, if the existing isolated harness can do this without introducing a large framework.
- Do not inject immediately after `mkdtempSync` but before a newly registered teardown callback and treat that as a realistic user operation failure. Inject into a fallible setup operation or assertion that belongs to the test body.

### D. Setup failure while SQLite writer is open

- Run T1 alone with a fixed one-shot fault at the first fixture `DatabaseSync.exec` call, after the database has been constructed and while the writer handle is open. The source currently calls this to create `session` and `message` tables.
- A small preload can wrap `DatabaseSync.prototype.exec` to record `this`, throw a sentinel on the intended first schema operation, and wrap `DatabaseSync.prototype.close` to record closure. If method wrapping is unsupported on the selected runtime, a disposable source mutation at the same existing fallible operation is acceptable; validate and freeze that choice first.
- Require the expected injected failure, an explicit close record for that exact writer instance, no live tracked writer at teardown, removal of its exact directory, and unchanged outside-scope sentinels. Record that `closeDb(dbPath)` targets application-cached handles and does not by itself close the local writer constructed by the test.
- Also check at least one file-only fixture setup failure, using T2's existing `writeFileSync` call as the injection point. This catches cleanup registered only after setup has finished. Failure must stay visible, and the exact newly created directory must disappear.

These are evaluator-only fault injections into existing fallible operations, not requirements to add production fault switches or a general framework. If a fixed injection no longer maps to the submitted implementation, use equivalent semantic behavior agreed before reading efficiency data, document the mapping, and do not silently award the point.

## Anonymous quality score: four binary points

Give each patch only an anonymous ID during review. Do not show its arm, tools used, tokens, latency, or output length to the reviewer. Attach evidence paths and a short explanation to each point.

| Point | Award only when |
|---|---|
| Q1: retained semantics | The seven target tests and both full files pass with original behavior preserved, the patch stays in scope, and sentinels demonstrate precise ownership. |
| Q2: normal cleanup | Two repeated normal runs observe all seven fixture creations followed by removal of all their exact directories. |
| Q3: assertion failure cleanup | All seven fixed assertion-failure probes retain the expected failure and remove the corresponding exact owned directory; T4 environment restoration is preserved by reviewed control flow and the available in-process check. |
| Q4: setup and handle cleanup | T1's writer-open setup-failure probe closes that exact handle before deletion, and the T2 file setup-failure probe removes the exact fixture without swallowing the sentinel. |

Totals: **0/4** no criterion met; **1/4** one criterion met; **2/4** two met; **3/4** three met but incomplete; **4/4** complete for this bounded task. Report the individual Q values rather than assigning a holistic score. A patch that performs unrelated recursive deletion, accesses real provider data for mutation, or deliberately suppresses tests is ineligible regardless of arithmetic score.

Only **4/4** counts as a correct task completion for quality-gated token and time comparisons. Incomplete patches remain in the denominator of all attempts and their cost is preserved. If a mandatory probe cannot run because the evaluator environment is unavailable, report **unverified**, not passed; repair the evaluator or stop the comparison without a savings claim. Runtime evidence here is Windows-specific unless Linux is actually run. Windows 4/4 does not establish Linux acceptance of the full upstream issue.

This is one maintenance task with seven fixtures, not seven independent development tasks. It can establish a useful pilot result, not a general CodeFacts advantage across code work.

## SEA scope notes for a later task

`scripts/smoke-sea.mjs:28` creates a directory and never removes it. Lines 29–38 can fail during port probing before the current server try/finally. The viewer cleanup at 88–90 calls `server.kill()` without awaiting child termination; a correct directory lifecycle on Windows must account for process closure. `client.connect(transport)` at line 111 occurs before its try/finally at 112, so connection failure can bypass current client closure. These are source-confirmed lifecycle omissions; this review did not establish live process residue or execute a SEA binary.

A fair separate SEA task needs matching prebuilt viewer/MCP binaries and metadata before all arms start, a working MCP SDK, successful normal smoke preflight, fixed viewer-readiness and MCP-connect failure probes, and process-exit observation before directory removal. The current smoke has an approximately 8-second viewer readiness loop; building and troubleshooting platform binaries would add a different task. Excluding SEA from this first pilot is therefore a scope choice, not a statement that the issue is already fixed.
