# Portable worker regressions

Require Node.js 24 or newer. Controlled platforms are Windows and Linux; the test modules fail explicitly on unsupported versions/platforms. `node:module.registerHooks` supplies provider-free test dependency wiring to the real worker entry. No npm install, DSH/SDK install, credentials, model calls, repository dataset, or private manifest is required.

From the repository root, after worker integration and portability changes are applied:

```sh
node --test benchmarks/agent-eval/task-benchmark/community/usability-screen/run.test.mjs benchmarks/agent-eval/task-benchmark/community/usability-screen/build-manifest.test.mjs benchmarks/agent-eval/task-benchmark/community/usability-screen/worker-process.test.mjs benchmarks/agent-eval/task-benchmark/community/usability-screen/worker-integration.test.mjs
```

All 19 checks must pass, with zero skips. `worker-process.test.mjs` alone runs the seven portable supervisor checks. `worker-integration.test.mjs` runs the four real-entry integration checks. Both print their synthetic evidence directory under the host temporary directory; those receipts remain available for inspection until host temporary-file cleanup.

The hooks replace only the runner's preparation/provider entry imports with synthetic fixtures. Actual runner, worker entry, process supervisor, campaign audit and declaration parser remain repository-relative production imports. Each fixture source has one tiny Rust file. The fixture model call returns an explicit failed attempt with null exact usage and durations, and a known token lower bound.

The lifecycle checks preserve blocking-worker isolation, parent timer/sibling progress, actual-close admission barriers, explicit exit-7/spawn failure, owned-tree timeout and unrelated process survival, split-credential redaction and bounded logs, dead-root retained-pipe timeout, exclusive worker identity, and unchanged deadline arithmetic. Integration checks preserve failed attempts/null metrics, namespace refusal without overwrite, preparation failure, and malformed partial cell bytes while a slow admitted sibling drains.

`fixtures/schedule.json` freezes the synthetic four-task/three-model/four-arm order. It is a portable schedule regression fixture; historical v1 private-manifest parity remains the separately retained reviewed evidence. These tests use short synthetic deadlines and do not validate provider latency, full repository indexing/copying, resource admission, the full 48-cell campaign, the full 21.5-minute deadline, or macOS. The escaped detached pipe holder deliberately survives supervisor cleanup and is removed by fixture cleanup; the receipt must expose that limitation.
