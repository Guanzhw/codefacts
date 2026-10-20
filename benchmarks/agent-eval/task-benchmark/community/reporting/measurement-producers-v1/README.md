# Fixed24 measurement producers

These three offline producers support independent repetitions of the same fixed24, four-model, three-arm protocol. Keep the fixed logical suiteId while freezing independent campaign/evidence/session identities and current binary/runtime pins. The executor, official graders, summary generation, and numeric/cold/quality exporters remain the existing foundation and source58 tools. Install this directory as `community/reporting/measurement-producers-v1` alongside them. This candidate has source/AST checks only; behavioral and closed-input validation are pending.

Use Node.js 18+ for metadata, Python 3.9+ standard library for native diagnostics, and PowerShell 7 on Windows for physical allocation. Producers require explicit absolute suite and output roots. Inputs remain read-only; generated artifacts are written under the selected output directory with unique names. Use `python -B` to avoid Python bytecode writes. Create distinct output directories for repeated verification and retain their raw hashes separately.

## Metadata audit required by quality export

From this directory, after the selected phase has closed:

```text
node metadata/audit.mjs --suite-root ABS_SUITE --output-dir ABS_AUDIT_OUTPUT --cohort all --split all
```

For the exact pre-model infrastructure exception already supported by this policy, add `--ledger ABS_APPROVED_LEDGER --ledger-sha256 EXACT_APPROVED_RAW_SHA256`. Without an exception, omit both flags. The audit never creates approval. An externally supplied digest must come from the owner's independent review.

The producer reads `suite.json`, `evidence/suite-freeze.json`, each selected campaign manifest, its `evidenceDir/freeze.json`, and grading config. It checks all selected `attempts/<slotId>/slot-meta.json` for closure before opening request, receipt, catalog or grading evidence. Normal terminal states are `attempt-completed` and `task-failed`. An incomplete selection returns `refused-incomplete-or-invalid-selection`. Subsequent checks bind frozen slots, source identity metadata, original namespaces, model/effort, transport, catalog, prediction/diagnostics, official result hashes and cleanup. DSH receipts are read only through their first 16384 bytes; a missing summary boundary fails.

It creates `<cohort>-<split>-<timestamp>-<UUID>.json` and a separate `.md` note. The stdout record has `status`, `totals`, `errors` (count), `output` (JSON path), and `report` (Markdown path). The JSON has `schemaVersion: 1`, `approvedBy: null`, `errors: []` on success, `cells[].id/metaPath`, and `inputHashes[metaPath]` containing exact raw metadata SHA-256. A successful result is `metadata-audit-passed-awaiting-root-review`. Its checks do not establish source inode independence, complete frozen source contents, native service success or final owner acceptance.

The quality exporter's separate owner-approved input lists each audit as `{path, sha256}` in `metadataAudits`; its cell bindings must match the audit's exact metadata paths and raw hashes. The existing exporter validates the passing status, empty errors, membership and hashes. Keep approval as an explicit subsequent owner action.

## Native attempt/error/response diagnostics

```text
python -B native/audit.py --suite-root ABS_SUITE --output-dir ABS_NATIVE_OUTPUT --cohort all --split all
```

The optional exception arguments are `--infra-ledger ABS_APPROVED_LEDGER --infra-ledger-sha256 EXACT_APPROVED_RAW_SHA256`. The producer preflights the whole selected metadata set, then joins DSH `tools.json`, numbered `inner-bridge/*-receipt.json`, Context trace diagnostics or SWE outer bridge events. It reads a bounded original DSH receipt header only when a terminal SWE timeout needs that evidence. Missing/malformed evidence remains an explicit gap, with strict totals null rather than silently zero.

Output is `audit-<UTC>-<UUID>.json`; stdout provides `status`, `output`, and `io`. Schema version 1 retains `cells`, `groups`, `inputHashes`, fixed288/native192 denominators, selected denominator, delivery observations, categories, and explicit infrastructure accounting. Successful status is `reconciled`, `reconciled-with-delivery-missing`, or `reconciled-with-infrastructure-outcome`; gaps/refusal produce exit code 2. Native non-error service responses do not establish useful facts or task quality.

`nativeAttempts` retains the existing declared-attempt definition: DSH calls and bridge/prebridge errors participate in reconciliation. It is not a native wire-request count. These declared attempts can end in an outer operation error before native wire dispatch: `nativeErrors` can include pre-native guard or outer rejections without an inner receipt, `nativeUnknown` preserves absent or contradictory service evidence, and `nativeNonError` requires a corroborating validated native service receipt. DSH delivery, outer response status, native trace status, and qualified terminal exec/poll cleanup remain separate observations. No new counter is introduced.

## Windows physical allocation

```text
pwsh -NoProfile -File physical/collect-physical-index.ps1 -Mode final -SuiteRoot ABS_SUITE -OutputDir ABS_PHYSICAL_OUTPUT
```

Optional filters are `-Cohort context|swe` and `-Split pilot|confirmation_holdout`. Optional admission flags are `-RootApprovedLedgerPath ABS_APPROVED_LEDGER -RootApprovedLedgerSha256 EXACT_APPROVED_RAW_SHA256`. `final` refuses any selected nonterminal cell except that exactly admitted exception. `current` is a snapshot and does not imply final closure. `plan-only` validates paths/metadata without enumerating index files.

The collector resolves `campaignId -> evidenceDir` once from the frozen suite's explicit campaign manifests and each campaign's frozen manifest. It also requires the supplied suite to equal its frozen copy and campaign slot membership to agree. Missing/inconsistent mappings fail explicitly. There is no old-directory-layout fallback. Canonical index locations are `<evidenceDir>/attempts/<slotId>/state.sqlite{,-wal,-shm}` or `source/.codegraph`; ordinary-arm trees are not measured.

Real allocation uses Windows `GetFileInformationByHandleEx` AllocationSize and volume/file identity, extended paths, reparse rejection and two matching inventories. Logical bytes are retained independently. File IDs deduplicate allocation across hard links and retained failure inventories. Missing, inaccessible or changing inventories remain missing/error/null. Linux measurements cannot stand in for this platform contract. Physical allocation values depend on the actual filesystem and measurement instant.

Final/current output is `physical-index-<mode>-<cohort-or-all-cohorts>-<split-or-all-splits>-<UTC>-<nonce>.json`; stdout includes `reportPath` and totals. Plan output is `plan-validation-<UUID>.json`. Schema version 2 preserves `slots`, `totals`, `failureInventories`, `allocationBuckets` (`successfulFormal`, `infrastructureFailureRetained`, `allRetained`), and `rootApprovedLedger`. `totals` exclude retained infrastructure failures; full totals stay null when relevant inventory gaps exist. Failure allocation never enters successful cold-index samples.

## Approval and fixed exception contract

All three preserve their existing exact exception policy for `gpt-context/ctx-mui__material-ui-34229-codegraph`. The ledger binds the original suite freeze, canonical metadata, supplement, failure evidence and three preparation cost references; metadata remains infrastructure-failed with pending/null grade and no model request. Native diagnostics additionally retain the original three named preparation phases. The physical helper retains its original requirement that historical cost-reference metadata lives below the suite root. These are explicit existing policy boundaries. A successful new repeat omits the exception; a different infrastructure failure requires a separately reviewed policy decision, not an invented approval string or changed golden fact.

## Verification commands and pending acceptance

Run only when the owner permits each stage. No commands below were behaviorally executed during this port. These commands start no models or graders.

For sequential metadata/native pure tests on the 768MiB/noSwap/CPU1 Linux verification target:

```sh
mkdir -p /tmp/fixed24-producer-checks/metadata /tmp/fixed24-producer-checks/native
node metadata/fixtures.mjs --output-dir /tmp/fixed24-producer-checks/metadata
cd native
PRODUCER_TEST_OUTPUT_DIR=/tmp/fixed24-producer-checks/native python -B -m unittest -v test_audit test_timeout_delivery test_poll_timeout_delivery
```

The native suite contains 45 pure test methods. The inherited 46th method is retained separately, with all historical expected numbers unchanged, because it consumes two operator-supplied cached inputs. Invoke it explicitly from this directory:

```text
python -B native/cached-pilot-golden.py --suite-root ABS_HISTORICAL_CACHED_SUITE
```

That root must provide `evidence/suite-freeze.json` and `reviews/context-pilot-tool-errors/audit.json`; neither cached artifact ships here. Missing inputs fail instead of being silently skipped or replaced by synthetic evidence. This historical check is not required to create a successful independent repeat.

After formal closure, run the real Windows filesystem fixtures:

```text
pwsh -NoProfile -File physical/verify.ps1 -OutputDir ABS_WINDOWS_TEST_OUTPUT
```

They synthesize the entire fixed288/192 schedule and 48 selected metadata files, retaining the original nine checks/expected allocation facts and adding nondefault/missing/inconsistent manifest-mapping checks. Outputs stay under the explicit test root. The fixture's exact 8192/12288/20480 allocation expectations require a filesystem with the matching allocation behavior; a mismatch is a failed check, not Linux coverage or permission to change expected facts.

Required subsequent acceptance: production CLI checks on small materialized fixtures in two independent paths including spaces; actual closed-data original/portable comparisons by cell/group/identity/hash/status/counter/null semantics; real Windows AllocationSize/FileID collection; and real consumption of a produced metadata audit by the existing quality exporter. Normalize only timestamps, generated filenames and output locations. Preserve input paths, identities, evidence hashes and all numeric/null facts. The source58 numeric/cold/quality pipeline and representative official regrade remain separate checks; this port does not require another 288-model run.

## Dependency and source inventory

Production metadata/native have standard-library dependencies only. Test relative imports resolve inside this package, including two bounded historical metadata reference modules. `physical/infra-ledger.ps1` is a required sibling of its collector. There is no dependency on old private auditor folders or validation logs.

The surrounding foundation must remain the complete `task-benchmark` tree: its `community/suite.mjs` and controllers import `../rpc.mjs`. The parent RPC source at foundation revision `ec1c7f7d788db8244388e200f5849de3b1564b21` is pinned to raw SHA-256 `b0c4736404f45c2963c7f1d6ee69ffd2a8b49923a5be899667cf0c26dac26a19`; it also defines the native receipt evidence consumed here. The producers themselves do not import it or start native services.

`SOURCE-INVENTORY.json` lists exactly 17 allowed package files, hashing the other 16 payloads. Preserve the inventory's independent raw SHA-256 outside the package. `SOURCE-MAPPING.json` records original and portable source pins and each boundary change. `ORIGIN.md` and `LICENSE` retain source/license attribution. Generated receipts, fixtures, test logs and review artifacts are outside this source-only inventory.
