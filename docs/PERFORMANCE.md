# Performance measurement

CodeFacts does not publish universal timing claims. Index speed depends on the
repository, storage, CPU, operating system, and filesystem cache state. This
repository ships a reproducible development-only runner for the metrics in the
v1 contract; it is not part of the deployed MCP binary.

For agent task correctness, token efficiency, cross-tool comparisons, and
continued-investment criteria, use the [product evaluation scorecard](EVALUATION.md).

## Published v0.2.0 Windows measurements

The actual published Windows executable passed **53 of 57 native gates;
overall native acceptance remains FAIL**. Go cold process-wall median changed
from 5,459.0683 to 4,932.4502 ms, an observed **9.6467%** improvement that
missed the predeclared 10% target by 19.27073 ms. Fresh closed Go SQLite state
changed from 192,663,552 to 155,963,392 bytes, **19.0488% smaller**.
The release accepts these four measured performance misses through a separate
[public-artifact decision](specs/mcp-simplification-20261015/published-release-decision-20261016.md):

| Failed target | Published v0.1.18 | Public v0.2.0 | Ratio | Required ratio |
| --- | ---: | ---: | ---: | ---: |
| Go cold process-wall median | 5,459.0683 ms | 4,932.4502 ms | 0.9035333374 | <=0.90 |
| globset map P95 | 13.0009 ms | 14.3190 ms | 1.1013852887 | <=1.10 |
| globset outline P95 | 8.0696 ms | 9.4910 ms | 1.1761425597 | <=1.10 |
| globset search with context P95 | 8.8360 ms | 11.7570 ms | 1.3305794477 | <=1.10 |

The other 53 numerical gates passed: fresh Go disk, the other three cold
comparisons, four peak-memory comparisons, 36 of 39 warm comparisons, seven
Go absolute warm-latency checks and both paired-refresh comparisons.
The three globset P95 regressions are 1.3181, 1.4214 and 2.9210 ms. Their cause
is unverified; the retained distributions do not establish a noise explanation.

This single public campaign used the same four fixed corpora, three cold
observations per arm, 20 warm observations per case and paired edit/restore
method as CI4. OS caches were not purged. All 24 cold sessions, 1,560 warm
samples, 120 edits and 120 restores completed. Contract/source evidence and
12 continuation chains passed; six root-dependent full-response cursor hashes
remained different, with validated cursor facts and actual same-root
continuation passing separately.

The public executable SHA-256 is
`fb3cc546ff1f77489f8807c5aba5bfcc932ab34dbb9ea40014558cb56a0d32e7`,
from official [run 38793433061](https://github.com/Guanzhw/codefacts/actions/runs/38793433061),
compiled source `b17bbbcc2a03f8822ce12152f20145526eed7fa8`, Rust 1.99.1;
Cargo's version was not logged. Its bytes differ from CI4. The historical
CI4 measurements and exception below remain separate. See the
[delivery record](V020-DELIVERY-2026-10-16.md) for public provenance and
installed-runtime evidence. Fresh-state size does not establish automatic
shrinkage of an existing database file.

## Historical CI4 prepublication measurements

The frozen Windows comparison against published v0.1.18 passed **56 of 57
native gates; overall native acceptance remains FAIL**. Go cold process-wall
median changed from 5,429.6271 to 4,895.5632 ms, an observed **9.8361%**
improvement. Its ratio, 0.9016389358, missed the predeclared <=0.90 target by
8.89881 ms. The fresh, closed Go SQLite database changed from 192,663,552 to
155,963,392 bytes, **19.05% smaller**. That candidate received an explicit
[Go cold target engineering exception](specs/mcp-simplification-20261015/release-decision-20261016.md);
the original threshold and failed result remain recorded. The exception is
specific to CI4 and does not authorize the public artifact's four misses.

| Corpus | v0.1.18 cold median ms | Candidate cold median ms | v0.1.18 fresh closed DB bytes | Candidate fresh closed DB bytes |
| --- | ---: | ---: | ---: | ---: |
| router | 346.4546 | 325.6548 | 5,967,872 | 4,931,584 |
| globset | 785.7139 | 749.5075 | 19,546,112 | 15,114,240 |
| CodeFacts | 727.7975 | 669.5608 | 20,377,600 | 15,777,792 |
| ghcli (Go) | 5,429.6271 | 4,895.5632 | 192,663,552 | 155,963,392 |

All 39 warm relative comparisons, four sampled peak-memory comparisons, the
other three cold comparisons, both paired edit/restore comparisons, and seven
Go absolute warm-latency checks passed. Paired one-file refresh P95 changed
from 168.3040 to 144.7592 ms for CodeFacts and 553.5011 to 420.6162 ms for Go.
Go cold sampled peak memory changed from 533,245,952 to 507,506,688 bytes.

These observations describe one Windows machine and four fixed source corpora:
three interleaved cold rounds, 20 warm samples per case and 30 paired
edit/restore samples per medium/Go arm. Cold wall time includes MCP startup;
OS filesystem caches were not purged. The candidate was the prepublication
CI artifact from run [38781654271](https://github.com/Guanzhw/codefacts/actions/runs/38781654271),
source `48eb0d0407dbb0183af60f14b56e44ff6c63cecd`, Windows executable SHA-256
`23673b24ad16f4714734fb29e62bc38dd8cc6fb815d22c4d9f574842e314d892`.
Its compiler was Rust 1.99.1; Cargo's version was not emitted. Source and
compiler both changed since the preceding CI candidate, so this product
comparison does not isolate the borrowing edit's effect.

The changes remove duplicated typed edge locations and node body prefixes,
retire a redundant source-only edge index, and borrow immutable node data
during indexing. Existing database migration preserves legacy rows and makes
freed pages reusable; it does not automatically shrink the existing file.
The [validation record](MCP-SIMPLIFICATION-VALIDATION-2026-10-16.md) separates
fact parity, private retrieval-cache identity, runtime checks, actual agent
tasks and publication status. Native timings alone do not establish task
quality or token savings.
The separate 72-attempt profile study completed entirely through source
commands, with zero observed CodeFacts MCP calls. Its quality and token totals
describe configured navigation profiles, not MCP-use efficiency.

## Run the benchmark

Build the server, then point the runner at the release binary and a repository.
Choose an output path outside that repository if you want to retain the JSON
report.

```powershell
cargo build --release --locked
cargo run --release --example repository_metrics -- `
  --root D:\WorkSpace\some-repository `
  --codefacts-bin D:\WorkSpace\codefacts\target\release\codefacts.exe `
  --samples 20 `
  --output D:\CodeFactsState\benchmark.json
```

The default query set is in `benchmarks/queries.json`. Supply `--queries
<file>` to use a repository-specific JSON file with the same schema:

```json
{
  "schema_version": 1,
  "queries": [{ "name": "narrow_symbol", "query": "AuthService" }]
}
```

Run the command separately for a small repository, a medium repository, and a
dependency-heavy repository. The runner respects ignore files and known output
directories when it creates its disposable copy for the one-file scenario.
The example explicitly launches MCP with `--tools all` because its measured
`search` workflow is outside the default three-tool profile. Its direct
index/refresh/memory measurements use the locally linked example library;
its MCP measurements use the executable supplied by `--codefacts-bin`.

## Report contract

The report has schema version 1 and includes:

| Field | Meaning |
| --- | --- |
| `cold_index` | New external SQLite state per sample. OS filesystem caches are not forcibly dropped. |
| `no_change_refresh` | Incremental hash check with no source modification. |
| `one_file_refresh` | A source edit in a temporary copy. It records copied regular files, indexable-file candidates, and indexed files after the change. CodeFacts reparses only the changed files, rebinds affected static relationships in SQLite, and re-resolves derived imports without reparsing unchanged source. |
| `sqlite_after_cold_index` | Size of the SQLite database and its WAL/SHM sidecars after the first cold sample. |
| `peak_process_memory` | Sampled resident memory for the benchmark process while it indexes directly. The separate spawned MCP process is excluded. |
| `mcp_search` | First-request latency including initial indexing, plus per-query P95 warm stdio request latency. Warm requests deliberately include CodeFacts' required no-change refresh. |

P95 uses the nearest-rank definition. The runner never writes to or modifies the
target repository: its SQLite state and the source-change copy are
`tempfile::TempDir` resources and are removed automatically.
