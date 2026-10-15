# Published v0.2.0 decision: four explicit performance exceptions

Decision date: 2026-10-16. Owner: root. Root accepts delivery of this
published artifact with the four numerical performance exceptions below.
Frozen native acceptance remains **FAIL: 53/57 gates passed**. The original
requirements, thresholds, samples and earlier failed campaigns remain intact.

This decision applies to Windows executable SHA-256
`fb3cc546ff1f77489f8807c5aba5bfcc932ab34dbb9ea40014558cb56a0d32e7`,
76,453,376 bytes, from official push run 38793433061, attempt 1. The annotated
v0.2.0 tag peels to compiled head/runtime core
`b17bbbcc2a03f8822ce12152f20145526eed7fa8`, tree
`92cde4def0b0467a2e6f133bdd9428b02289ed35`. Actual Rust was 1.99.1;
Cargo's version was not logged. The public executable differs from CI4;
the earlier CI4-only cold exception is a separate historical decision.

## Observed exceptions

Campaign: `v020-published-fb3cc546ff1f-final1`.

| Target | Published v0.1.18 | Public v0.2.0 | Observed change | Frozen ratio limit |
| --- | ---: | ---: | ---: | ---: |
| Go cold process-wall median | 5,459.0683 ms | 4,932.4502 ms | 9.6467% faster | <=0.90 |
| globset map P95 | 13.0009 ms | 14.3190 ms | 1.3181 ms slower, 10.1385% | <=1.10 |
| globset outline P95 | 8.0696 ms | 9.4910 ms | 1.4214 ms slower, 17.6143% | <=1.10 |
| globset context-search P95 | 8.8360 ms | 11.7570 ms | 2.9210 ms slower, 33.0579% | <=1.10 |

Go cold median missed the internal 10% benefit target by 19.27073 ms.
Fresh closed Go state fell from 192,663,552 to 155,963,392 bytes, a
19.0488% reduction. All other 53 numerical gates passed, including the
other cold comparisons, four peak-memory comparisons, 36/39 warm cases,
seven Go absolute-latency checks and both paired-refresh comparisons.

## Engineering judgment

The human requested cold-index/storage improvement and delivery of the
three-workflow default. The observed 526.6181 ms Go cold improvement and
19.0488% fresh-state reduction satisfy that qualitative improvement while
the three measured globset warm regressions remain explicit costs. Their
observed P95 values are below 15 ms. Root accepts those bounded costs for
this delivery; small absolute values do not convert failed targets to PASS.

Independent review recomputed all 120 relevant warm samples and the six Go
cold samples. Context search has multiple elevated samples. The cause is
unverified, and this decision does not attribute the misses to noise or
claim statistical equivalence. One Windows machine, fixed corpora, three
cold observations per arm and 20 warm observations per case delimit these
performance statements. OS caches were not purged.

The complete single campaign and its source/fact/cursor/continuation,
restore and material audits remain retained. Full response hashes differ
in six root-dependent cursor cases; separate validated facts and actual
same-root continuation passed. Existing allocated database files do not
automatically shrink to the fresh-state measurement.

All other correctness, legacy compatibility, package/license/provenance
and actual installed-plugin/host checks remain required. Public package
and fresh isolated runtime checks have passed; independent post-audit and
actual host/plugin acceptance still require their own closure at this
decision's recording time. No extra timing campaign or production change
is adopted solely to cross these four targets.

Public performance descriptions must pair the observed 9.6467% cold and
19.0488% fresh-state improvements with 53/57 overall FAIL and the three
measured warm regressions accepted here. The separate 72-attempt study
remains tied to candidate `425b46b7`; its zero observed MCP calls establish
no menu winner or productivity benefit for the public artifact.

Evidence is retained under
`D:/WorkSpace/codefacts/target/mcp-simplification-20261015`:

- `native-performance-preparation/published-v020/raw/v020-published-fb3cc546ff1f-final1/REPORT.md`, `comparison.json`, `FINAL-AUDIT.md` and `full-current-manifest.json`.
- `native-performance-preparation/published-v020/review/FINAL-REVIEW.md`.
- `design-review/published-acceptance-decision-review.md`.
- `publication/public-release-receipt.json` and `installed-020/final-receipt.json`.

This dated acceptance changes the release decision for this artifact.
Historical acceptance results and future versions' numerical targets keep
their original meaning.
