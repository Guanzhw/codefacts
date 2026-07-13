# Performance measurement

CodeFacts does not publish universal timing claims. Index speed depends on the
repository, storage, CPU, operating system, and filesystem cache state. This
repository ships a reproducible development-only runner for the metrics in the
v1 contract; it is not part of the deployed MCP binary.

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

## Report contract

The report has schema version 1 and includes:

| Field | Meaning |
| --- | --- |
| `cold_index` | New external SQLite state per sample. OS filesystem caches are not forcibly dropped. |
| `no_change_refresh` | Incremental hash check with no source modification. |
| `one_file_refresh` | A source edit in a temporary copy. It records copied regular files, indexable-file candidates, and indexed files after the change, then explicitly records that CodeFacts rebuilds the complete static relationship snapshot to avoid partially resolved cross-file facts. |
| `sqlite_after_cold_index` | Size of the SQLite database and its WAL/SHM sidecars after the first cold sample. |
| `peak_process_memory` | Sampled resident memory for the benchmark process while it indexes directly. The separate spawned MCP process is excluded. |
| `mcp_search` | First-request latency including initial indexing, plus per-query P95 warm stdio request latency. Warm requests deliberately include CodeFacts' required no-change refresh. |

P95 uses the nearest-rank definition. The runner never writes to or modifies the
target repository: its SQLite state and the source-change copy are
`tempfile::TempDir` resources and are removed automatically.
