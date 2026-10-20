# Measurement producer source lineage

This source-only package derives the existing CodeFacts fixed24 research helpers with owner-approved input/output boundary changes. It retains their fixed protocol, grading predicates, native declared-attempt semantics, exception policy and golden facts. The exact original-to-portable raw SHA-256 mapping is in `SOURCE-MAPPING.json`. Original sources remain untouched.

Production origins, relative to the historical suite root:

| Portable role | Original source | Original raw SHA-256 |
|---|---|---|
| metadata audit | `reviews/closed-phase-auditor-infra-v3/audit.mjs` | `49a36e1168fa62426ae980c857b5b3ef3ca0196d9bcd2e3ff58674d2752da27d` |
| native diagnostic audit | `reports/native-service-auditor-infra-v4/audit.py` | `f4ab5e87da098509cf714db1e031e14ba49ce5643388469dea13b81a4698e8bc` |
| physical collector | `reports/physical-index-collector-infra-v2/collect-physical-index.ps1` | `d37df9ad8bfb923ae43144cbe7451eed3e5fdab25237c722bb9e64630af362c9` |
| physical ledger dependency | `reports/physical-index-collector-infra-v2/infra-ledger.ps1` | `d6d09724c0fc6b51bf1db48e507161952e3b1f392aeddab25fc6dacea5d6ace4` |

Metadata fixtures derive the original `closed-phase-auditor-infra-v3/fixtures.mjs`. Its two test-only dependencies are bounded extractions: strict `acceptedGrade` and its constant from `reviews/closed-phase-auditor/audit.mjs` (raw `1ed367b30009dd0c58cfa1ef1142098ee9b7a708c4f7fa21d95dbf9847e11de9`); and only the invoked v2 audit/policy/ledger/infra functions with their dependencies from `reviews/closed-phase-auditor-infra-v2/audit.mjs` (raw `1d362e4df84c9c39d21c9a20b5513b9a3ce208c94397d1bba675601cda8ad696`). Their historical CLIs, artifact writers and implicit suite roots are omitted. Existing version-comparison assertions remain intact.

The three native test modules derive their same-named v4 sources. The actual cached pilot golden method moved unchanged in its numerical assertions to an explicit runner. Its two historical cached inputs are external operator inputs, not bundled data. Physical fixtures derive `physical-index-collector-infra-v2/verify.ps1`; its original real-suite schedule dependency is replaced by a self-contained synthetic schedule and explicit manifests.

The CodeFacts foundation is pinned to `ec1c7f7d788db8244388e200f5849de3b1564b21`. Full `task-benchmark` source is an external foundation dependency; `rpc.mjs` lives above `community`, with raw SHA-256 `b0c4736404f45c2963c7f1d6ee69ffd2a8b49923a5be899667cf0c26dac26a19`. There are no copied framework execution helpers in this package.

The root CodeFacts `LICENSE` is copied verbatim, preserving the MIT grant and copyright notices for Suat Kocar and Colby Mchenry. CodeFacts records its subtractive upstream origin at `suatkocar/codegraph` revision `856739a1a528cfae9f9232566ae5c043ef8cfaf5` and its official CodeGraph1.6.2 reference at `colbymchenry/codegraph` revision `6560052a6f856855d3f71eee838fd66ccfa4285d`. This package's benchmark helpers are CodeFacts project sources; retaining those notices does not invent dataset, model-provider, task-repository or container-image licenses. Those materials retain their own acquisition/attribution contracts in the surrounding foundation/replay recipe.

At assembly only source inventory, diffs and AST/syntax checks are available. Historical validation statements in private helper documentation were not copied as validation of these derivatives. Pure behavior, production CLI fixtures, real Windows measurement, actual closed-input comparisons and quality exporter consumption remain owner-coordinated acceptance steps. This source assembly neither changes the immutable source58 package nor authorizes a formal model run or publication.
