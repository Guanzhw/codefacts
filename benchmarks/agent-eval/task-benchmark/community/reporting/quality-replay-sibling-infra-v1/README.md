# Quality replay sibling infrastructure v1

Staged source and synthetic validation only. ROOT must independently review this
source and accept closed full288 inputs before any real export. The approved
nine-file results toolkit is unchanged. Actual image availability and independent
official quality regrading remain unverified until ROOT exercises representative
captured SWE and Context cells after closure.

`export.mjs` reuses the existing toolkit's `projectInputs`, `deriveCore` and
`verifyData`, including its accepted producer hash, 288-cell identity validation,
numeric comparison and signed infrastructure closure boundary. It never searches
attempt directories. `core.mjs`, `verify.mjs`, `replay.mjs` and `recipe.md` form
the portable public helper; no scoring implementation is added. `replay.mjs`
prepares the historical adapter and compares results. Its generated runner calls
the historical `grade.mjs:runOfficialGrade` and `official.py` unchanged.

## Exact accepted input contract

CLI: `node export.mjs ROOT_APPROVAL.json ROOT_APPROVAL_RAW_SHA256 NEW_OUTPUT`.
Supply the approval hash from the ROOT review record, independently from the file
being exported. A status string in an untrusted JSON is not ROOT authorization.
`NEW_OUTPUT` must not exist. Every source file read is explicitly pinned, and all
read bytes are rechecked before any output is written. Export failures preserve
their inputs; the CLI prints a generic failure without leaking private paths.
The module API throws a specific boundary label for operator diagnosis.

Types below describe the fields consumed; unknown private input fields never
enter the public projection. Every `ref` means exactly `{path, sha256}`, with
`path` an explicit private local filename and `sha256` its lowercase 64-hex raw
byte hash. `meta` refs must have exactly these two fields. `objectHash` means the
existing `rpc.mjs` contract: SHA-256 of `JSON.stringify(value)`.

```text
approval = {
  schemaVersion: 1,
  kind: "closed-full288-quality-replay-approval",
  status: "root-approved", approvedBy: "root",
  acceptedNumericManifestSha256: RAW_SHA256,
  inputs: {summary: ref, report: ref, selection: ref, producer: ref},
  publicAssets: ref,
  metadataAudits: [ref, ...],
  campaigns: [campaignBinding x 8],
  tasks: [taskBinding x 24],
  cells: [cellBinding x 288]
}
campaignBinding = {
  campaignId: PUBLIC_TOKEN, freeze: ref,
  sources: [{path, sha256, role}, ...],
  upstream: [acquisition, ...]
}
taskBinding = {
  cohort: "swe" | "context", taskId: PUBLIC_TOKEN,
  acquisitions: [acquisition, ...],
  datasetInput: {canonicalSha256, canonicalFormat: "parquet",
                 graderSha256, graderFormat: "parquet" | "jsonl",
                 recordRepresentation, recordSha256},
  baseline: {
    policy: "original-upstream-commit" |
            "archive-identical-synthetic-baseline" |
            "official-prebuilt-image" | "unavailable",
    upstreamBaseCommit?: HEX40, gradingCommit?: HEX40 | null,
    sourceManifestSha256?: RAW_SHA256, archiveSha256?: RAW_SHA256
  },
  gradingOptions: {
    timeoutMs?: POSITIVE_INTEGER, timeoutSeconds?: POSITIVE_INTEGER,
    maxWorkers?: POSITIVE_INTEGER, openFileLimit?: POSITIVE_INTEGER,
    split?: PUBLIC_TOKEN, emptyPatchControl?: BOOLEAN
  },
}
acquisition = {
  kind: "dataset" | "source" | "upstream-tree",
  repository: CREDENTIAL_FREE_HTTPS_URL_WITHOUT_QUERY_OR_FRAGMENT,
  revision: HEX40_TO_HEX64, path: SAFE_REPOSITORY_RELATIVE_PATH,
  sha256: RAW_CANONICAL_ACQUISITION_FILE_SHA256
}
cellBinding = {
  id: "campaignId/slotId", meta: ref,
  prediction?: {path, sha256, binding?: "grade-input" | "root-accepted-artifact"},
  diagnostics?: ref,
  report?: {path, sha256, binding?: "root-accepted-artifact"},
  imageExecution?: ref, // captured per-cell JSON, separately ROOT accepted
  withheld?: {reason: "root-withheld-sensitive-scoring-content",
              predictionSha256?: RAW_SHA256, reportSha256?: RAW_SHA256}
}
```

`PUBLIC_TOKEN` is 1–160 ASCII alphanumeric/underscore/dot/hyphen characters,
starting alphanumeric. Source-relative paths use `/`, with no absolute prefix,
backslash, colon, control character, empty/dot/parent component or `.git`.
Hashes and instance/model/source identities are checked at their owning input
boundaries. Source text, patches and test names are not keyword filtered.

The accepted aggregate report must be version `2.0.0-infra`, mode `full288`,
with all 288 cells accounted closed; summary has four models/eight campaigns,
and selection contains the fixed 24 tasks. Producer bytes must match the
already accepted toolkit producer hash. The numeric manifest digest is a ROOT
assertion linking this sibling to the separately verified numeric package; this
exporter does not inspect that package. ROOT must approve both from the same
summary/report/selection pins and retain their external manifest hashes.

Each metadata audit must have existing status
`metadata-audit-passed-awaiting-root-review`, `errors: []`, `cells[]` containing
`id` and `metaPath`, and `inputHashes[metaPath]`. Non-infrastructure cells must
match those exact metadata refs. Signed pre-model infrastructure cells instead
match the metadata hash in the accepted report's existing infrastructure closure.
ROOT approval of these exact audit pins remains mandatory despite their
awaiting-review status. Audit overlap is accepted only with identical refs.

Each freeze must contain `campaignId`, `manifest`, matching `manifestHash`,
`pins[]` with path/raw hash, and the complete 36-cell `schedule`. Metadata
`freezeHash` and any grade provenance freeze hash must equal `objectHash(freeze)`;
metadata slot/task/cohort/language/split/status/grade status/resolved must match
the selected frozen schedule and accepted summary. The exporter does not reread
unselected freeze paths, model receipts, provider state, answers, or transcripts.

Supported source roles are `official.py`, `grade.mjs`, `grade-campaign.mjs`,
`trace.mjs`, `rpc.mjs`. Their explicit raw refs must occur in the historical
freeze's pins. `official.py` and `grade.mjs` are necessary for the prepared
official replay recipe; missing roles become explicit replay gaps. Preserve the
historical source identity rather than substituting the current checkout.

Predictions are a one-element JSON array. Context requires a raw diagnostics
ref when a prediction is supplied. Default prediction binding recomputes
`objectHash({prediction, diagnostics, modelAttemptStatus: meta.status})` against
`meta.grade.provenance.inputHash`, with diagnostics `null` for SWE. The explicit
`root-accepted-artifact` alternative relies on ROOT's review of the exact raw
prediction/diagnostic hashes in this approval. An unaudited pathname is never
sufficient. Raw report hashes must match `meta.grade.receipt.resultSha256` when
present; otherwise they require the explicit ROOT artifact binding. Omitting a
receipt-pinned report is rejected unless ROOT withholds the exact hash for actual
sensitive scoring content. Missing references remain explicit unavailable cells.

The fixed24 selection requires canonical Parquets and the publicAssets/datasetInput
bridge, preserving separate canonical, derived raw and named record hashes. For
SWE that record must retain `instance_id`, `image`, `eval_script`, `log_parser`,
`eval_type`, `repo`, `version`, `FAIL_TO_PASS`, `PASS_TO_PASS`, plus all additional
fields consumed by the frozen official harness. Canonical acquisition avoids
publishing gold/source assets in this bundle. At preparation the whole dataset
raw hash, selected parsed-record hash and required SWE fields are checked.
Context also needs canonical source archives and packaged scoring manifests;
manifests retain file modes/symlinks. Synthetic baselines require original commit, grading
commit, source-manifest and archive pins. SWE official image tag/registry digest/
local identity are separate from the model image; availability remains external.
Context's original policy requires gradingCommit to equal upstreamBaseCommit;
its synthetic policy requires different commits, matching the frozen adapter
branch. Both commit policies are Context-only. SWE instead requires
`baseline:{policy:"official-prebuilt-image",upstreamBaseCommit:CANONICAL_BASE,
gradingCommit:null}` with no Context manifest/archive fields. CANONICAL_BASE is
the selected task's dataset metadata, not a claimed checked-out or observed
container HEAD. The frozen SWE TestSpec consumes the prebuilt record.image and
record.eval_script; it does not consume base_commit as a checkout instruction.
This policy is SWE-only and does not fill missing historical imageExecution or
runtime identity. Current tag/platform/config verification before official
grading remains mandatory. `unavailable` remains an operational replay gap for
either cohort; it is never silently promoted to an image or Git policy.
Each campaign needs an upstream-tree acquisition and the version-pinned runtime
recipe below. A recorded
`timeoutMs` is necessary; populate other captured options including defaults
from the frozen operator configuration. Missing identities/options become gaps.

## Output and privacy

For the canonical fixed24 selection, `publicAssets` pins JSON with consumed
roles: `schemaVersion:1`, `kind:fixed24-public-acquisition-bridge`,
`selection:ref`, `helpers:[ref+role]` for `official.py`,
`export-fixed-selection.py`, `prepare-context-bases.py`,
`runtimeRecipes:{context:ref,swe:ref}`, `datasets:{context:{canonical:acquisition},
swe:{canonical:acquisition,derivedSha256}}`, `contextManifests:[{original:ref,
publicSha256,gradingCommit,archive:acquisition}]`, `imageAcquisitions:ref` and
`attribution:ref`. Helpers/requirements/original manifests must occur in the
historical freeze pins. The exact fixed selection is shared with numeric inputs.
There are twelve Context manifest and twelve SWE image acquisition rows.

`assets.mjs` packages typed lineage and the public manifest projection. Generated
manifest/JSONL identity comes from content and derivation, not a remote URL.
Original/private SHA remains bound separately from the public SHA passed to the
scorer. Only `sourceRepresentation` is removed; entries, modes, symlink targets,
archive hash and entries digest remain unchanged. Canonical source archives are
identified separately; no task source archive is bundled.

Context uses canonical full.parquet both as acquired and grader-input bytes.
`recordRepresentation=contextbench.Gold._data-canonical-json-v1` means the frozen
GoldLoader's full normalized `_data` before official.py removes patch fallback
on a copy. `recordSha256` is SHA-256 of UTF-8 Python `json.dumps` with
`sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False`. The
wrapper checks original_inst_id, Gold.id, repo/base and nonempty gold schema.
It never reinterprets raw HF rows as Gold JSON. SWE uses canonical Parquet and
the exact packaged export-fixed-selection.py plus sibling selection to derive
JSONL. `derive-swe` requires `--jsonl-line-ending lf|crlf`. For the real captured
Windows input use `--jsonl-line-ending crlf`: the unchanged native helper file
`private-grading/private-selected-swe-records.jsonl` is retained, and a separate
`private-grading/private-selected-swe-records.requested-crlf.jsonl` contains the
explicitly requested record separators. Point SWE mapping.datasetPath to that
requested file. The LF choice writes requested-lf.jsonl. Binary writing makes the
choice independent of the current OS; JSON record bytes, including escaped
patch/test string newlines, are unchanged. The receipt separately names native
helper SHA/size/platform framing and requested serialization SHA/size/file.
Captured CRLF SHA `654f487c93addfabd8bd6071a03dc1277b37229503b0b9955c7f1e03ce09d486`
remains the real expected grader-input raw pin. Native Linux LF helper bytes have
a different raw identity; they are not claimed to equal captured Windows bytes.
There is no default format, hash-based selection or expected raw pin rewrite.
`graderSha256` binds the explicitly serialized grader-input bytes; its named
`selected-SWE-JSONL-record-canonical-json-v1` applies the same Python canonical
hash to the parsed selected row. These are separate from prior rpc.hash/property
order semantics. ROOT obtains named record pins after full closure before export.

Runtime recipe JSON carries cohort, pythonVersion, exact requirements text/raw
hash, environmentPinsSha256, upstream repository/revision,
`identity:version-pinned-reconstruction`, `packageArtifactHashes:not-recorded`,
`historicalRootIdentity:unverified`. Local editable installs use operator roots;
no immutable venv URL or equality with a historical private root is invented.
The wrapper checks interpreter and installed requirement versions.

Image acquisition rows carry official tag/index/platform/config digests,
linux/amd64 platform and provenance source hash. They establish metadata only.
`cellBinding.imageExecution` separately pins captured JSON with `id`,
`officialTag`, `registryManifestDigest` (platform digest), `localImageId` (config
identity) and separate `modelImageId` or null. Missing historical per-cell binding
is retained in provenanceGaps and never inferred from global admission/HEAD
receipts. It does not block a new fixed-image regrade of complete captured inputs.
Missing scoring inputs remain operational gaps and still block preparation.
Every cell reports historicalEnvironmentEquality:unverified, including the
version-reconstructed runtime's unverified historical root identity.

The prepared SWE runner calls prepare-inputs.py:verify-image immediately before
the official grader. Existing Docker SDK images.get performs read-only inspection
of the unchanged dataset tag, repository@platformDigest and config ID. All must
resolve to the expected config ID, linux/amd64 and the immutable RepoDigest. Pull,
acquire and tag are operator recipe actions, never automatic fallback. The runner
retains replay-environment.json with the current inspection identity or a failed
category and starts no grade on failure. It does not manufacture historical
evidence. Comparison accepts that receipt separately and reports current
verification plus preserved historical limitations; injected synthetic-client
receipts are explicitly labeled synthetic, not Docker proof.

The package additionally includes `assets.mjs`, `prepare-inputs.py`, `assets.json`
and content-addressed helper/selection/manifest/recipe/attribution assets.
`node replay.mjs assets MANIFEST SHA NEW_LAYOUT` materializes exact helper
filenames and sibling official.py/selection, twelve public manifests, minimal
identity-only public-tasks.jsonl and bridge-plan.json. It invokes no scorer.
See `recipe.md` for later derivation/Gold checks and baseline reconstruction.

`manifest.json` binds every public byte and the approval/input/numeric manifest
hashes. `cells.json` retains all 288 identities/statuses, task source/base,
provenance hashes, artifacts, canonical prerequisites and explicit gaps. Public
files are exactly `manifest.json`, `cells.json`, `assets.json`, `assets.mjs`,
`core.mjs`, `verify.mjs`, `replay.mjs`, `prepare-inputs.py`, `recipe.md` and the
content-addressed artifacts listed in manifest.files (manifest excludes itself).
Verification takes an independently pinned
manifest hash, rejects changed/missing/unlisted files, and works after relocation.

Context predictions retain final declared files/spans and every source-exposure
`pred_steps`; only private `repo_url` becomes an operator mapping token. Public
diagnostics retain declaration status and counters/reason counts. Rationale,
unmapped raw text, tool request bodies, headers and whole sessions are omitted.
Context expected results retain the official final metrics, `num_steps`, ordered
trajectory `steps` with their step numbers and file/symbol/span/line coverage,
plus AUC and redundancy numeric trees. Step count/order and finite coverage are
checked against the frozen evaluator's typed output contract;
private source-identity roots/configuration are excluded. SWE patch strings are
unchanged. Official SWE report fields/tests, including boolean `patch_is_None`,
are allowlisted; exact raw report
bytes survive when they contain only those fields. Additional arbitrary fields
produce a projected expected result, original/public hashes and an explicit raw
report gap. Public configuration is only a typed projection of grading options.

ROOT must identify actual sensitive content within necessary scoring bytes
before approval. Withhold that artifact with an explicit gap instead of editing
the historical prediction/report. Pattern matching cannot establish whether an
arbitrary source literal is secret, and this tool does not pretend otherwise.

## Validation

Runtime recipes are explicit ROOT-pinned reconstruction inputs. Their embedded
requirements SHA, exact versions and cohort remain checked; membership in the
historical campaign freeze is not claimed. Historical runtime-root equality
stays unverified. `node synthetic-tests.mjs --runtime-contract-only ABS_APPROVAL
APPROVAL_SHA` checks the actual eight frozen inventories and approved static
asset lineage without exporting a package or invoking Python/Docker. It accepts
the legitimate zero runtime-requirement membership case while rejecting a
cohort mismatch and a changed embedded requirements hash.

`node synthetic-tests.mjs --report-contract-only` runs the narrow report boundary
checks using Node only. It covers ordered/empty Context trajectories, count/order
and coverage rejection, both SWE patch flags, input immutability and exclusion of
private wrapper fields. The full synthetic fixture also checks that changed
per-step coverage or `patch_is_None` causes the existing comparator to reject.

After generating a fresh fixture with this sibling's synthetic-tests.mjs, run
`node baseline-policy-tests.mjs ABS_FIXTURE_ROOT` for the Context equality/source
guards and cohort-specific image policy. It rejects Context image-policy use,
SWE commit-policy use, non-null/missing gradingCommit and wrong canonical base.
The synthetic bridge suite also executes the generated SWE runner with an
explicit failing image-check command and a sentinel normalizer, proving that
image-check rejection stops before any official grading call. That fixture is
control-flow evidence only; image-client-checks.py uses an injected SDK mock and
neither fixture establishes actual Docker availability or historical identity.

The narrow standard-library command `python -B jsonl-line-ending-tests.py` covers
the four native/requested LF/CRLF combinations, escaped scoring strings, retained
native bytes, and production derive-swe/CLI wiring with only the frozen helper
subprocess mocked. It covers missing/invalid flags and expected raw-pin rejection.
This fixture does not establish real canonical derivation; an isolated actual
canonical retry with explicit crlf is separate evidence.

The native Linux integration command is `node synthetic-tests.mjs`. Set
QUALITY_BRIDGE_PYTHON to a test interpreter with PyArrow, QUALITY_CONTEXT_OFFICIAL_ROOT
to the frozen ContextBench source tree, and QUALITY_BRIDGE_COMMUNITY_SOURCE to a
source-only directory containing official.py, grade.mjs, grade-campaign.mjs,
trace.mjs, export-fixed-selection.py and prepare-context-bases.py. No daemon or
Docker is needed. synthetic-assets.py makes tiny genuine Parquets, uses the real
frozen GoldLoader and records a tiny native Git baseline. The fixture runtime
recipe matches the test interpreter/PyArrow only, not the historical environment.
Its test-authored SWE JSONL is not evidence that the immutable real canonical SWE
export helper accepted tiny inputs; that helper stays byte-identical and its real
derivation remains a post-closure check. The suite exercises the complete bridge,
relocation, prepare, failed pins/HEAD/record/helper and missing-historical-image
semantics, without executing the generated scorer runner. Windows can verify the
resulting portable package without running the native Linux fixture generator.

Then run `node baseline-policy-tests.mjs ABS_NEW_SYNTHETIC_ROOT` for fully rebound
policy checks against that migrated bridge fixture. Previous JSON-only test
evidence is retained as history; there is no no-bridge exporter/preparer route.


## Portable synthetic test commands

Run sequentially from this module directory on native Linux. Configure explicit
external source/runtime mappings; the source package does not copy a private
framework, frozen Context tree or Python environment into this directory.

```sh
export QUALITY_BRIDGE_PYTHON=/absolute/test-venv/bin/python
export QUALITY_CONTEXT_OFFICIAL_ROOT=/absolute/frozen-ContextBench-source
export QUALITY_BRIDGE_COMMUNITY_SOURCE=/absolute/source-only-community-helpers
node synthetic-tests.mjs
node baseline-policy-tests.mjs /ABS_ROOT_FROM_MAIN_VALIDATION
"$QUALITY_BRIDGE_PYTHON" -B image-client-checks.py
```

The community helper directory must supply official.py, grade.mjs,
grade-campaign.mjs, trace.mjs, export-fixed-selection.py and
prepare-context-bases.py. The existing tests require immutable helper hashes;
do not substitute stubs or edit those helpers. Preserve the frozen Context
package layout/notices and provide PyArrow, its pinned Context import dependencies
and setuptools in the configured test interpreter. The generated fixture runtime
matches that interpreter/PyArrow only, not a historical private environment.
The image test injects a read-only client and does not import Docker or exercise
a Docker daemon. These are source recipes; this assembled quality branch has not
yet passed independent source acceptance or behavioral validation. Actual
canonical SWE derivation, fixed-image execution and captured official regrading
remain post-closure acceptance work. Do not execute generated scoring runners as
part of these synthetic source tests.
