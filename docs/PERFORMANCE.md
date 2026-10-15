# Performance measurement

CodeFacts does not publish universal timing claims. Index speed depends on the
repository, storage, CPU, operating system, and filesystem cache state. This
repository ships a reproducible development-only runner for the metrics in the
v1 contract; it is not part of the deployed MCP binary.

For agent task correctness, token efficiency, cross-tool comparisons, and
continued-investment criteria, use the [product evaluation scorecard](EVALUATION.md).

## v0.2.0 Windows candidate measurements

The frozen Windows comparison against published v0.1.18 passed **56 of 57
native gates; overall native acceptance remains FAIL**. Go cold process-wall
median changed from 5,429.6271 to 4,895.5632 ms, an observed **9.8361%**
improvement. Its ratio, 0.9016389358, missed the predeclared <=0.90 target by
8.89881 ms. The fresh, closed Go SQLite database changed from 192,663,552 to
155,963,392 bytes, **19.05% smaller**. Delivery uses the explicit
[Go cold target engineering exception](specs/mcp-simplification-20261015/release-decision-20261016.md);
the original threshold and failed result remain recorded.

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
