# Repair retention and release decision

Date: 2026-10-16. Retain the repaired native 0.2.1 fact-extraction and partial
refresh behavior. Publish the patch after the required candidate experiment
and source/package checks close; verify public bytes and installed hosts
after publication. The [validation record](../../POST-DELIVERY-REPAIR-2026-10-16.md)
owns the observations and their source/artifact boundaries.

The type-use capture path was demonstrably missing facts in five existing
extractors. Independent reviews and real native/MCP red-to-green cases verify
the repair, declaration exclusions and safe unresolved identities. The
partial-index fix prevents persistent omissions from forcing repeated full
rebuilding, while preserving omission visibility and removing unverifiable
old-version facts atomically.

Restoring facts has a measured cost. On the frozen Go corpus, references rise
from 15 to 32,839, while existing nodes, calls, imports and containment counts
are preserved. Three fresh pairs observed +13.22% main DB allocation and
+17.03% first-map median on a contended shared host. The latter is a bounded
observation, not a controlled timing attribution. An existing index needs one
extraction-9-to-10 rebuild, then returns to zero-file no-change refresh.

Accept that observed cost for the correctness repair. Do not market this patch
as a cold-index or disk reduction. Preserve the measured numbers, failures
and original thresholds; no rerun is used to replace an unfavorable result.
The prior public 0.2.0 result remains 53/57 gates passed, overall FAIL, with
its four accepted exceptions. The new measurements answer distinct questions
and establish no new all-repository performance pass.

Keep the three default MCP workflows and the opt-in seven/one profiles.
Actual model-visible menus are verified, but the bounded familiar-task study
cannot establish an optimal menu or general productivity benefit. Its grades
and independently audited traces must be frozen before efficiency reporting.

Public native and plugin acceptance remain separate from the candidate:
release tag/workflow, actual GitHub assets, all six npm identities and
provenance, isolated Windows installation, and fresh Codex/Claude plugin
queries must identify the actual published artifact. A source-built executable
or a Registry metadata file is insufficient evidence for those claims.
