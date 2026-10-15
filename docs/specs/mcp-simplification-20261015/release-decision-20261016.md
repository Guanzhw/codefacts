# Release decision: explicit Go cold target exception

Decision date: 2026-10-16. Owner: root. This records a release decision; the
frozen requirements, benchmark thresholds, raw observations and FAIL results
remain unchanged.

The Windows CI4 artifact is
`23673b24ad16f4714734fb29e62bc38dd8cc6fb815d22c4d9f574842e314d892`
(76,453,376 bytes), built by run 38781654271 from commit
`48eb0d0407dbb0183af60f14b56e44ff6c63cecd`, tree
`ca1fde8429daadcc20444a7a929be6f952d9b367`.
The actual compiler was Rust 1.99.1; Cargo's version was not logged.

Its complete frozen native campaign passed 56 of 57 gates. Overall native
acceptance remains **FAIL**. Go cold process-wall median was 5,429.6271 ms
for published v0.1.18 and 4,895.5632 ms for CI4: a 9.8361% observed
improvement, ratio 0.901638935756747. The required ratio was 0.90.
The observation missed that target by 8.89881 ms; it is not rounded to PASS,
and the cause of the shortfall is not established.

Root accepts an explicit engineering exception for this artifact's Go cold
benefit target only. The observed reduction of about 534 ms, 19.05% smaller
fresh closed Go database (192,663,552 to 155,963,392 bytes), and passing
warm-query, peak-memory and incremental-refresh gates justify continuing
delivery instead of creating candidates or repeating measurements solely
to cross the remaining threshold. This does not establish statistical
equivalence to the target or isolate a source-code effect: source and
compiler changed between CI3 and CI4.

All other correctness, source evidence, legacy-state compatibility, actual
7/3/1 task-quality review, package/provenance and installed-runtime checks
remain required. This exception grants no permission to hide a reproducible
capability loss, reinterpret a failed fact-equivalence check, or publish
before those checks finish. In particular, the actual72 comparison has not
yet been graded when this decision is recorded.

Earlier 52/57, 56/57 and 55/57 campaigns and this 56/57 FAIL remain separate
evidence. No extra confirmation study is adopted for this cold shortfall.
The original requirements remain the historical premeasurement contract;
this dated exception changes only the present release decision, not the
historical acceptance result or a future version's target.

Public performance statements for this artifact must give the observed
9.8361% cold improvement and 19.05% fresh-database reduction together with
the missed 10% cold target, 56/57 overall FAIL and this explicit exception.
The measurements describe one Windows machine and fixed corpora; OS caches
were not purged. Existing database-file shrinkage and agent productivity are
separate questions.

A public binary with the identical SHA can be bound to this evidence.
A different public binary requires its own provenance and actual-runtime
verification; this artifact-specific exception does not automatically
apply to it.

Evidence identities retained in the local delivery record:

- CI artifact receipt:
  `3de593f87c3e4280bd9b6f4b9ecd44d4a865660b48d4eaeff3ee662c5ff75836`.
- Exact-source snapshot receipt:
  `b9a97f3bd297464858941ce646e5bab3cdd0289ada18da1f5077464a299db4cd`.
- Actual runtime readiness receipt:
  `c788f7378f25b694002466fcffc95add5d127abed1242259db89d9fe421ab67e`.
- Driver freeze:
  `1eb935fa4abe6bd7945317860e17c764b32faf9840dcce77957eed5beb008fff`.
- Campaign tag: `v020-borrowed-ci-23673b24ad16-final1`.
- Independent decision review:
  `design-review/final-cold-target-decision-review.md` in the local delivery
  evidence directory.

