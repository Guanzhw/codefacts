# Unchanged-refresh performance acceptance

CodeFacts 0.1.17 returns from an incremental pass after complete source hashing
and deletion checks when there are no successfully parsed changes or removals.
It avoids reconstructing the stored cross-file node index and opening an empty
transaction. Changed and full passes retain their original processing path.
Same-size edits with the original modification time restored still reindex.

The local Windows x64 release candidate was compared with the published 0.1.16
asset on three frozen corpora: find-my-way (106 regular / 101 indexed files),
full ripgrep (237 / 137), and a CodeFacts working-tree snapshot (288 / 116).
Source roots and bytes are identical per pair; state is external and fresh per
campaign. AB, BA, AB order retains all samples. Warm queries use 20 calls per
case per pair; pooled n=60. Cold means fresh SQLite state with unpurged OS caches.

| Medium compact query | 0.1.16 pooled P50/P95 ms | 0.1.17 pooled P50/P95 ms |
|---|---:|---:|
| search | 64.79 / 79.48 | 15.61 / 16.13 |
| outline | 61.62 / 88.89 | 12.87 / 35.49 |

Each pair passes the declared >=25% P95 improvement threshold: search improves
78.7%–82.7%, outline 54.9%–69.4%. Cold-map medians change by +1.4%, +0.9% and
+0.3% for the three corpora. These measurements describe these inputs and this
machine; they are not a general task-token or large-repository scaling claim.

Single-file refresh is measured separately, without treating no-change speed
as changed-file speed. Three ten-edit campaigns per variant retain all changes
and restores. P95 uses nearest rank; the declared stop threshold is >10%.

| Condition | Whole-request P95 0.1.16 / 0.1.17 ms | Change |
|---|---:|---:|
| Fresh-state ripgrep, n30 edits | 501.69 / 536.85 | +7.01% |
| Fresh-state medium, n30 edits | 370.46 / 387.40 | +4.57% |
| Medium after six warm-query cases, n30 edits | 404.30 / 431.03 | +6.61% |

The warmed-condition follow-up was declared after the full campaign's n9 edit
samples showed +12.00% P95 and +15.82% median. It uses the same six warm query
cases before ten consecutive edits/restores in each process. Those earlier
samples remain visible. The follow-up's edit median rises 6.98%; restore
whole-request median rises 9.35%, while its internal index median rises 11.96%.
This passes the declared P95 gate and does not establish that every changed-file
metric improves. No causal explanation for these differences is asserted.

The three full pairs compare 945/945 responses exactly; the separate fresh tail
compares 126/126, and the warmed follow-up 441/441. Only elapsed `duration_ms` is
normalized. Continuation cursors, scope, generation, source hashes and all fact
fields remain exact. A separate native five-tool probe validates map, search
continuation, outline, expand and a direct static path on an owned JavaScript
fixture. The mature timed driver itself covers map/search/outline.

Source checks pass 778 Rust tests, 23 launcher tests, formatting, Clippy and the
exact-lockfile dependency-license audit. The default published surface remains
the five tools. Experimental C09 and CodeGraph query hydration are separate
development work: their earlier medium tail failures (+17.47% and +18.48%) are
retained, and this release does not establish their cause or repair them.

Reproduction and retained evidence are in the development checkout under
`target/fusion-performance-20261014/release-five-native/`, including PLAN/freeze,
native contract, every request/response, source manifests, state, process/CPU
preflights, raw samples, summary and warmed-refresh follow-up. The local old
asset SHA256 is `8450d5d779f4d38e5ee1a549506a49e28a7d2ca87dfd3b0eb79ff5bd7faf3e94`;
the local 0.1.17 candidate is `feaa4f886fce42897b7a4070c32204c034c026f3031de97356fa70d1f3b1c5cd`.
CI-produced assets and installed-runtime checks are distinct publication gates.
