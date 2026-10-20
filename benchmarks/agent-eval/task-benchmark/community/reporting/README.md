# Portable RESULTS toolkit

Numeric reports use Node.js 22 or later and built-in modules only. Run commands from this directory.
For captured quality replay, see [its README](quality-replay-sibling-infra-v1/README.md), including its additional Python/runtime prerequisites.
The sibling module directory names are part of the import layout: copy this
whole directory when relocating the toolkit.

This reporting package consumes explicitly supplied, already-closed and
root-approved full288 inputs. Root approval and trusted raw SHA-256 values
must be established before export. The exporter validates the pinned inputs
and provenance chain; it does not grant approval. Actual full288 integration
is pending. Synthetic tests manufacture fake288 objects and receipts entirely
from source code; passing them proves packaging and arithmetic behavior only.

## Export and verify

Replace each `ABS/...` with an absolute input/output path and each `HASH` with
the independently trusted raw SHA-256 for that file. The producer is the exact
bundled `final-aggregate-generator-infra-v2/aggregate.mjs`, whose accepted hash is
`274b786d8cb7f1cb540ff7327daadd1e2dd7f5de11086ff79ad6d3e41b7fd1c7`.
Use a new output directory with an existing parent. This is a single command;
line wrapping below is for readability.

```text
node timing-regime-reporting-infra-v2/export.mjs --report ABS/report.json --report-sha256 HASH --summary ABS/closed-suite-summary.json --summary-sha256 HASH --selection ABS/selection.json --selection-sha256 HASH --producer ABS/reporting/final-aggregate-generator-infra-v2/aggregate.mjs --producer-sha256 274b786d8cb7f1cb540ff7327daadd1e2dd7f5de11086ff79ad6d3e41b7fd1c7 --timing-inventory ABS/closed-timing-inventory.json --timing-inventory-sha256 HASH --output ABS/NEW-public
node ABS/NEW-public/verify.mjs --manifest ABS/NEW-public/manifest.json --sha256 MANIFEST_HASH
```

The exporter prints `manifestSha256`; independently retain/trust that value.
The public directory contains nine files plus `manifest.json`: `adapted.json`,
`PRIMARY.zh-CN.md`, `adapter.mjs`, `formatter.mjs`, `verify.mjs`,
`producer-core.mjs`, `common.mjs`, `statistics.mjs`, and `METHODS.md`.
Copying that directory alone preserves offline verification. Its verifier checks
file membership and raw hashes, recomputes arithmetic, and compares the Chinese
rendering. It proves reproduction of accepted inputs, not source approval.
Timing strata retain serial, wave, and rolling conditions and actual overlap.
See `timing-regime-reporting-infra-v2/METHODS.md` for the exact policies.

After verification succeeds, hash the exact public `adapted.json` and export
an appendix to a new directory beside the public directory:

```text
node cold-disk-appendix-infra-v2/export.mjs --input ABS/NEW-public/adapted.json --sha256 ADAPTED_HASH --output ABS/NEW-appendix
```

That sibling appendix contains `appendix.json` and `APPENDIX.zh-CN.md`.
It preserves the verified input bytes; its receipt reports both output hashes.
The appendix consumes the verified typed boundary and has no separate bundle
verification protocol. Keep it beside the public bundle and retain its receipt.

## Synthetic packaging checks

```text
node timing-regime-reporting-infra-v2/synthetic-tests.mjs
node cold-disk-appendix-infra-v2/synthetic-tests.mjs
```

The existing timing suite performs 61 checks, including relocated fake public
bundle verification with unreachable proxy settings; it writes a fresh
`timing-regime-reporting-infra-v2/runs/synthetic-*` directory. The existing cold
suite performs 35 checks and removes its own tiny temporary directory.
Only synthetic source generators are bundled. Generated test directories and
staging validation receipts are excluded from the deliverable source package.

The aggregate module and its closure dependency are byte-preserved sources:
the exporter extracts its pinned pure arithmetic, while synthetic fixtures import
its pure functions. The accepted aggregate CLI remains in that source; this
workflow starts from the root-approved report and does not invoke that CLI.
`public-results-infra-v1` supplies shared projection, statistics, verifier, and
fixture dependencies. No installation or network access is required.


## Project benchmark source installation

Install this reporting directory beside the full controller tree at
`community/execution`. Source modules under `COMMUNITY/execution` are distinct
from private `RUNROOT/execution` run receipts. The controller README and its own
inventory use this actual deployment path; no alias or rewritten source receipt
is needed. See [the fixed24 repeat recipe](fixed24-repeat-recipe-v1/RECIPE.md)
for the supported Context144 serial / SWE pilot46 serial plus50 V2 waves /
confirmation48 V3 rolling sequence and explicit owner approvals, and
[measurement producers](measurement-producers-v1/README.md) for independent
metadata/native/Windows physical evidence. Those dependencies go beyond the
numeric package's built-in-only runtime. No extra288 model run is required to
validate this delivery against the current closed study.

The aggregate source installed here is the separately accepted clean-repeat
schema2 candidate, producer raw SHA-256
`274b786d8cb7f1cb540ff7327daadd1e2dd7f5de11086ff79ad6d3e41b7fd1c7`.
Its17 clean/signed synthetic checks and producer33 metadata/45 native checks
plus two materialized CLI paths have prior ROOT evidence. New exact-tree remote
checks, real Windows allocation, actual historical parity, closed288 export and
official replay remain separate acceptance steps. Historical METHODS remain
unchanged as study records.


## Explicit quality JSONL serialization

The [quality replay recipe](quality-replay-sibling-infra-v1/recipe.md) requires
an explicit `derive-swe --jsonl-line-ending lf|crlf` choice. For the captured
Windows grading input use `crlf`; the native frozen exporter output is retained,
and a separate requested serialization must match its exact pinned raw SHA.
Only record separators change; patch/test-name/escaped string bytes and parsed
record identities remain unchanged. The new [standard-library source test](quality-replay-sibling-infra-v1/jsonl-line-ending-tests.py)
is run with `python -B jsonl-line-ending-tests.py` from that module directory.
This overlay is source-approved. Actual canonical CRLF retry is being verified
separately and is not claimed passed by this source assembly. ROOT separately
reports Context12 Gold and12 baseline reconstruction passed; full288 quality
export and official replay remain separate acceptance steps.
