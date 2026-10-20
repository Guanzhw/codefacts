# Portable operational control source

This staging package supplies the existing two-worker SWE wave and rolling protocols for a new configured run. The original project framework supplies campaign execution, official grading, preparation, DSH transport, WSL leases and cleanup. Keep the complete `task-benchmark` source tree: generated suite imports include parent `rpc.mjs`.

The first actual execution surface remains Windows/WSL. Pure Node synthetic tests can run on other operating systems; this does not establish full Linux DSH execution. Actual benchmark execution with the relocated package remains unverified.

## Configure and build

Place this directory under the existing community framework as `community/execution`. Fill `controller.template.json` and save it as a new configuration file. Each of the six path fields is required. Paths resolve once against the configuration file directory. Pass an absolute configuration filename as the first CLI pair. The supplied template uses paths relative to this directory: `frameworkDir=".."`, `guardModule="./guard.mjs"`, and a newly prepared `./new-run/suite.json`. Its `new-run` parent must already exist before sidecar creation. Select the intended runtime/evidence capacity roots explicitly before planning. The template uses `.` for both roles; these need not be separate physical volumes. There is no environment discovery or historical-path fallback.

`suitePath` identifies a newly prepared suite. `frameworkDir` is its original project community directory. `guardModule` points to this package's `guard.mjs`. `sidecarBuildDir` names a new directory whose parent already exists. `runtimeVolumePath` and `evidenceVolumePath` explicitly select filesystem paths on the two capacity roles. Receipts retain `c`/`d` role keys: runtime reserve C20 GiB; SWE per-cell evidence D28 GiB; Context D22 GiB; parallel aggregate D36 GiB. These keys describe configured roles and need not be literal C/D drive letters.

Before controller checks load, the configured build directory is created exclusively and the sidecar is mechanically regenerated from `frameworkDir/suite.mjs`. Relative imports become URLs resolved against that source; `import.meta.url` retains that source's URL. Existing build directories must contain the exact sidecar and matching source/transform receipt. Controllers and children verify these bytes. Keep the generated build directory with the new run; do not copy a historical generated sidecar into it.

The configured framework JavaScript loads before run-decision authorization, as the historical static sidecar did. Configuration therefore selects trusted source code. The new configuration checks do not sandbox arbitrary JavaScript.

## New run CLI

The following commands are recipes. They were not executed against any real suite during staging:

```text
node parallel-suite-controller-v2/controller.mjs --config ABS/controller.json --plan ABS/ledger.json swe pilot
node parallel-suite-controller-v2/controller.mjs --config ABS/controller.json --plan ABS/ledger.json swe confirmation_holdout ABS/pilot-review.json
node parallel-suite-controller-v2/controller.mjs --config ABS/controller.json --run ABS/root-decision.json
node rolling-suite-controller-v3/controller.mjs --config ABS/controller.json --plan ABS/ledger.json ABS/pilot-review.json
node rolling-suite-controller-v3/controller.mjs --config ABS/controller.json --run ABS/root-decision.json
```

Planning needs an all-closed boundary. A decision must preserve the returned candidate and bind its `configIdentity`, raw config hash, configuration-module hash, resolved paths, exact artifacts, suite freeze, ledger, starting boundary, capacity and amendment. Configuration changes require a new plan and approval. Child argv starts with the same `--config` pair as its parent. Configuration or source drift fails before any new slot allocation or child spawn.

V2 retains the exact serial-to-wave transition and approved original serial identities, selects at most two distinct campaigns in frozen order, and audits after all children close. It does not resume a prior parallel phase. V3 retains fresh full SWE confirmation48, exact pilot review, two active distinct campaigns, close-and-validate before replenishment, eight-campaign global begin/end verification and no retry/resume. The suite host lock stays owned through drain. Original campaign dispatch locks stay effective. Original executor, grader, evidence pins, namespaces and receipt schemas continue to own their existing contracts.

Ledger handling remains the V1 contract: root-approved supplement and exact frozen identity are required, including when `knownInfraCells` is empty. This package does not synthesize historical failure approvals.

## Source provenance

`SOURCE-MAPPING.json` retains 13 logical historical source identities, original raw hashes, accepted portable hashes and change flags. Its privateDerivation fields pin the original private mapping and patch. The mapped portable sources are byte-identical to the accepted portable package. See `../ORIGIN.md` for the source lineage and publication scope. Historical originals and private derivation evidence are not distributed; their original hashes are retained provenance assertions, not fresh consumer verification.

The public template, this README, logical mapping, historical-availability test and membership inventory have new source identities. New runs require their own freeze/approval. No historical freeze is changed by integration.

## Source verification

Run from this directory using Node.js 22 or later:

```text
node --test relocation.test.mjs
node --test parallel-suite-controller-v2/scheduler.test.mjs parallel-suite-controller-v2/worker-process.test.mjs rolling-suite-controller-v3/offline.test.mjs
node source-inventory.mjs --verify INDEPENDENT_SOURCE_INVENTORY_RAW_SHA256
```

Retain the independently supplied SOURCE-INVENTORY.json raw hash. The verifier checks exact delivered source membership and bytes, excluding generated validation/synthetic and rolling-suite-controller-v3/synthetic-fixtures directories. The focused suite always verifies all 13 mapped portable hashes; its historical-original test explicitly reports SKIP/N/A and verifies no historical originals.

The tests generate isolated synthetic frameworks and worker processes. They check configuration, relocated controller imports, sidecar bindings, invalid CLI identities, guards, process close, overlap, cleanup and drain. They do not execute actual model/DSH/WSL/Docker suites or official grading. Actual configured benchmark CLI execution remains unverified by these checks. Generated fixtures and validation logs are local evidence, excluded from publication.
