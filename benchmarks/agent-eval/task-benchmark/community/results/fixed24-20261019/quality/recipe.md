# Captured quality replay from public acquisitions

The pinned package reproduces captured artifact identity. Quality regrading
requires recorded public acquisitions and operator runtime roots. Actual layers,
captured per-cell image identity, synthetic commit reconstruction and official
regrades remain unverified until ROOT obtains that evidence after full closure.

1. Run `node verify.mjs ABS_MANIFEST SHA256` using an independently obtained ROOT
   manifest hash. Inspect all 288 identities/statuses/nulls and explicit gaps.
2. Run `node replay.mjs assets ABS_MANIFEST SHA256 NEW_LAYOUT`. It materializes
   exact historical helper/official.py/selection layout, public Context manifests,
   runtime recipes, identity-only public-tasks.jsonl and bridge-plan.json. It
   performs no Parquet loading, archive extraction or scoring.
3. Acquire revision-pinned canonical Parquets, complete scorer trees and Context
   source archives from assets.json; verify their raw hashes. Retain upstream
   notices. Attribution preserves observed SWE MIT/ContextBench source Apache
   notices; no separate Context dataset grant is inferred from its source license.
4. Reconstruct the version-pinned environments from recipe requirements and exact
   scorer revisions at operator roots. Context records Python 3.11.15, SWE
   3.12.13. Package artifact hashes and historical private-root equality are not
   established. These are reconstruction recipes, not immutable venv downloads.
5. Write a private mapping outside the public package:

   ```json
   {
     "cohort": "context",
     "python": "/operator/context/bin/python",
     "officialRoot": "/operator/frozen-ContextBench",
     "assetLayout": "/operator/NEW_LAYOUT",
     "datasetPath": "/operator/full.parquet",
     "repoRoot": "/operator/reconstructed/ctx-ORIGINAL_ID/source",
     "repoCache": "/operator/fresh-context-cache",
     "assets": { "RAW_SHA256": "/operator/acquired-blob" }
   }
   ```

   Map all required canonical blob hashes, not generated manifests' private hashes.
   For SWE select its Python/upstream root and the derived JSONL below; repoRoot
   and repoCache are Context-only. Use fresh namespaces throughout.
6. With recorded Python/PyArrow run
   `python -B NEW_LAYOUT/prepare-inputs.py derive-swe --plan ABS_PLAN --mapping ABS_MAPPING --out NEW_DERIVATION --jsonl-line-ending crlf`.
   The exact frozen exporter takes both canonical Parquets, verifies its own fixed
   pins/selection, preserves Arrow schema/order and writes
   `NEW_DERIVATION/private-grading/private-selected-swe-records.jsonl`. These native
   helper bytes remain unchanged. The explicit required flag chooses only record
   separators for a separate binary-written file
   `NEW_DERIVATION/private-grading/private-selected-swe-records.requested-crlf.jsonl`.
   Captured Windows JSONL uses CRLF and retains raw SHA `654f487c93addfabd8bd6071a03dc1277b37229503b0b9955c7f1e03ce09d486`;
   native Linux helper output uses LF and has a different raw identity. The wrapper
   verifies the requested file against the existing expected raw SHA and emits
   separate native/serialized provenance plus named record hashes. Set SWE
   datasetPath to the requested-crlf file. `--jsonl-line-ending lf` explicitly
   produces requested-lf.jsonl when that is the accepted raw pin; there is no
   default or hash-based format selection. Canonical, native helper, serialized
   grader-input raw and record hashes retain their separate meanings.
7. Context retains canonical full.parquet as datasetPath. Run
   `python -B NEW_LAYOUT/prepare-inputs.py inspect-context --plan ABS_PLAN --mapping ABS_MAPPING`.
   This uses the frozen official GoldLoader, verifies original IDs/repo/base/schema
   and emits named Gold representation hashes, not gold content. ROOT approves
   these pins before actual export; the source handoff supplies a static bootstrap
   plan for that step. Renaming/raw JSON parsing does not replace the loader.
8. After ROOT authorizes source reconstruction on native Linux disk, run
   `python -B NEW_LAYOUT/prepare-inputs.py prepare-baselines --plan ABS_PLAN --mapping ABS_MAPPING --out NEW_BASES`.
   Canonical archive links/public manifests go to exact prepare-context-bases.py,
   which requires root and an output parent on native /tmp's filesystem. It fixes
   Git identity/date/message and disables hooks/filters/text conversion. The
   wrapper then requires captured gradingCommit HEAD, clean status, original base,
   complete bytes/link inventory and filesystem/Git modes. Prediction.commit is
   preserved. Public sourceManifestPath uses the projected manifest; private and
   public hashes remain separate. Never choose a new commit merely to pass.
9. For SWE the explicit task baseline is
   `{policy:"official-prebuilt-image",upstreamBaseCommit:CANONICAL_BASE,gradingCommit:null}`.
   Its canonical base is record/task metadata; the actual grading base is the
   prebuilt image plus canonical record/eval_script. The frozen harness does not
   check out base_commit, and no observed historical container HEAD is claimed.
   Do not copy Context's original/synthetic policy or manufacture a gradingCommit.
   Context retains its real Git baseline/manifest checks from step8. Acquire the
   original SWE immutable platform image and verify index/tag/config
   identity separately from the model image. Global acquisition metadata cannot
   fill absent historical per-cell execution binding. Acquire/pull the immutable
   platform image and, if needed, explicitly tag that same local image with the
   unchanged dataset tag before running. These are operator actions; the runner
   never pulls, tags or builds an alternative. Missing historical binding stays
   in provenanceGaps and does not prevent a new fixed-image regrade. Layer/image
   availability and Docker execution remain operator prerequisites.
10. For a cell with no operational gaps run
    `node replay.mjs prepare ABS_MANIFEST SHA256 CELL_ID ABS_MAPPING NEW_RUN`.
    It binds materialized plan/helpers to the package, checks dataset/record pins,
    runtime versions and Context HEAD/modes. It restores only local repo_url while
    retaining final spans, ordered pred_steps, SWE patch and test bytes. pred_steps
    is tool-derived source exploration. This creates a configuration and runner
    without grading. Under the frozen offline environment execute
    `node NEW_RUN/run.mjs`; it uses unchanged historical grade.mjs:runOfficialGrade
    and official.py with captured timeout/options. For SWE it first uses the
    existing Docker SDK to inspect current tag, immutable platform RepoDigest,
    config/local ID and linux/amd64 binding. Failure writes a rejected environment
    receipt and prevents the official call; success writes replay-environment.json.
    This is current pre-grader evidence, not proof of the historical image/runtime.
11. Run `node replay.mjs compare ABS_MANIFEST SHA256 CELL_ID OBSERVED_STATUS ABS_RESULT [ABS_REPLAY_ENVIRONMENT_RECEIPT]`.
    It compares retained Context final metrics, num_steps, ordered per-step
    coverage, AUC and redundancy, or SWE flags (including patch_is_None) and
    test lists. Unavailable results only admit labeled status-only comparison.
    Investigate mismatches without changing captured results. ROOT must retain
    representative SWE+Context official regrade receipts before claiming actual
    independent quality replay coverage. Output reports current environment
    verification (or missing receipt), provenanceGaps and historical environment
    equality unverified even when retained metrics match exactly.

The numeric package reproduces captured arithmetic; this path regrades captured
outputs with official adapters. Future stochastic model generation is a separate
experiment. Typed public projections exclude receipts, provider config/env,
headers, rationale and sessions. Required source literals/test names survive;
ROOT withholds actual sensitive scoring bytes explicitly with original hashes
and unavailable gaps instead of silently censoring them.
