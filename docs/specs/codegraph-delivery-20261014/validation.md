# Native delivery validation

The feature candidate at commit `960932cb3c2aa2d16df686bbfa6c6b312e79ec60`
passes the frozen correctness and performance checks. Publication and installed
runtime acceptance are tracked separately in the delivery tasks.

## Source and workflow evidence

The native runtime exposes seven MCP workflows and direct CLI commands, including
`node`, `callers`, `callees`, `explore` and `impact`. Existing cursor, source-hash,
generation and Markdown-heading contracts remain covered. Static impact returns
confirmed witness relationships and explicit limits; receiver uncertainty remains
visible. Confirmed import file anchors use stored file snapshots without invented
symbol spans. Extraction version 9 repairs demonstrated Go declaration ranges
and AST ownership/receiver evidence.

Local all-target validation passed 864 Rust tests, formatting, Clippy with
warnings denied, dependency-license checks and 23 packed npm tests with zero
skips. Independent reviews reproduced and verified five extraction/import fixes,
then reviewed the performance changes. An additional 233 old/new MCP comparisons
preserved full map/outline values, formats, source hashes, ranking and pagination.
The source CI run [38599439602](https://github.com/Guanzhw/codefacts/actions/runs/38599439602)
passed all three operating systems, Rust MSRV and Node 18 launcher checks.

## Frozen performance evidence

Candidate SHA256:
`BEDB7D092ED1876A83F61651ECD4AB4CA6FCB6BF0457576CA7E8F4F41ABAF3C8`.
The local Windows build used Rust 1.93.1. A source receipt records all 184 tracked
file hashes. Published v0.1.17 and official CodeGraph 1.6.2 are independently
pinned. The large Go corpus is GitHub CLI commit
`2c153f50dad5bc14d49fa0813b2c35fb0fd05103`, with 1494 preserved regular files and
an explicitly omitted ZIP fixture. Corpus coverage and freshness semantics differ
between products; raw counts and results retain those differences.

The complete final campaign ran from 2026-10-14T16:37:31Z to 16:44:28Z. It records
36 fresh-state cold operations, 1180 CodeFacts warm queries, 400 CodeGraph warm
queries, 80 CodeGraph no-change sync operations, 120 paired modifications and
120 immediate restores. Common queries have 20 samples per case; the medium/Go
refresh gates each have 30 paired samples per arm. OS caches were not purged.

All frozen gates passed: 20/20 common-query P95 ratios <=1.10, 2/2 changed-file
P95 ratios <=1.10, and 7/7 new Go P95 targets <=1000 ms.

| Workload | v0.1.17 P95 ms | Candidate P95 ms |
|---|---:|---:|
| Router outline | 5.01 | 4.41 |
| Go repository map | 257.21 | 109.40 |
| Go symbol context search | 126.9 | 67.3 |
| Go definition expansion | 126.2 | 69.3 |
| Medium changed-file refresh | 395.35 | 244.04 |
| Go changed-file refresh | 919.28 | 776.24 |

New Go exploration P95 was 797.8 ms for orientation, 159.2 ms for lexical
discovery and 67.8 ms for exact reads; the four impact cases were 65.8-67.1 ms.
The larger receiver candidate graph has a measured cost: Go cold wall median
was 6.86 s versus v0.1.17's 4.26 s, and state disk median was 183.74 MiB versus
90.72 MiB. The CodeGraph cold wall median was 9.85 s and state disk 76.79 MiB;
its round-1 indexing pipeline was 3.19 s versus the candidate's 7.21 s. CodeGraph
snapshot queries and full sync are measured separately, whereas each CodeFacts
query includes source-hash reconciliation. These values do not imply equal
coverage or a general product speed ranking.

The final audit verified 3080 source hashes and 43800 displayed lines across
380 feature responses, all 240 exploration byte budgets, the original corpora
and 36 private copies. Paired work used cloned state so four round-1 databases
retained their initial hashes. Two earlier failed candidates and all raw
distributions remain preserved. No successful sample was replaced to seek a pass.

The reproducible local evidence is under
`target/codegraph-delivery-20261014/performance/`: `frozen-plan.json`, the original
and separately hashed derivative drivers, pinned source/binary receipts, and
`raw/candidate-018-20261015-bedb7d092ed1/{REPORT.md,comparison.json,completeness.json,full-current-manifest.json}`.
This measures native tools and source-backed workflows, not general agent
productivity or token savings.
