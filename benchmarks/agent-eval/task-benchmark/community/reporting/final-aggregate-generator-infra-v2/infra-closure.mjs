// ROOT supplies independently pinned raw hashes. No self-asserted authority,
// campaign discovery, or on-disk canonical metadata reads are trusted here.
import crypto from 'node:crypto';
import path from 'node:path';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const check = (ok, message) => { if (!ok) throw new Error(`ROOT closure: ${message}`); };
export const metadataPathKey = value => path.win32.normalize(value).toLowerCase();
export function validateClosure(summary, mode, inputSha256, selected, binding) {
  if (!binding) return { signedRows: new Set(), record: null };
  const { closureBytes, expectedClosureSha256, ledgerBytes, expectedLedgerSha256 } = binding;
  check(digest(expectedClosureSha256) && digest(expectedLedgerSha256), 'independently pinned receipt and ledger hashes required');
  check(hash(closureBytes) === expectedClosureSha256, 'closure receipt raw SHA-256 mismatch');
  check(hash(ledgerBytes) === expectedLedgerSha256, 'approved ledger raw SHA-256 mismatch');
  const receipt = JSON.parse(closureBytes), ledger = JSON.parse(ledgerBytes);
  check(receipt.schemaVersion === 1 && receipt.kind === 'closed-summary-root-approval' && receipt.approvedBy === 'root' && receipt.status === 'root-approved', 'receipt must be ROOT approved closed audit');
  check(ledger.schemaVersion === 1 && ledger.approvedBy === 'root' && ledger.status === 'root-approved', 'ledger is not ROOT approved');
  check(receipt.suiteId === summary.suiteId && ledger.suiteId === summary.suiteId && receipt.mode === mode, 'suite/mode binding differs');
  check(digest(inputSha256) && receipt.inputSummarySha256 === inputSha256, 'exact input summary hash differs');
  check(receipt.approvedLedgerSha256 === expectedLedgerSha256, 'receipt ledger binding differs');
  check(digest(receipt.metadataAuditSha256), 'metadata audit hash required');
  for (const key of ['suiteFreezeSha256', 'supplementSha256']) check(digest(ledger[key]) && receipt[key] === ledger[key], `${key} differs`);
  check(Array.isArray(receipt.selectedInfrastructure) && receipt.selectedInfrastructure.length > 0, 'explicit signed selected IDs required');
  check(Array.isArray(ledger.knownInfraCells), 'ledger cells required');
  check(new Set(ledger.knownInfraCells.map(e => e.id)).size === ledger.knownInfraCells.length, 'duplicate ledger ID');
  check(new Set(receipt.selectedInfrastructure.map(e => e.id)).size === receipt.selectedInfrastructure.length, 'duplicate signed selected ID');
  const joined = summary.models.flatMap(model => model.campaigns.flatMap(campaign => campaign.attempts.map(row => ({ id: `${campaign.campaignId}/${row.slotId}`, row }))));
  check(new Set(joined.map(e => e.id)).size === joined.length, 'duplicate parent campaign/slot identity');
  const applicableIds = ledger.knownInfraCells.filter(entry => joined.some(e => e.id === entry.id && selected.includes(e.row))).map(entry => entry.id).sort();
  check(JSON.stringify(applicableIds) === JSON.stringify(receipt.selectedInfrastructure.map(e => e.id).sort()), 'selected signed infrastructure omission or extra ID');
  const signedRows = new Set(), costs = [];
  const nullFields = ['metrics', 'resolved', 'totalTokens', 'inputTokens', 'outputTokens', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'knownUsageLowerBound', 'modelTurnMs', 'dshDurationMs', 'gradeDurationMs', 'nativeCalls', 'toolCalls', 'toolErrors', 'nativeAdopted', 'providerCallSucceeded', 'generationCutoff', 'receiptStatus', 'patchPath', 'indexDurationMs', 'indexDiskBytes', 'sourcePreparationMs', 'preparationAndSandboxMs'];
  for (const signed of receipt.selectedInfrastructure) {
    const matches = joined.filter(e => e.id === signed.id);
    check(matches.length === 1 && selected.includes(matches[0].row), `signed ID not one selected scheduled cell: ${signed.id}`);
    const row = matches[0].row, entry = ledger.knownInfraCells.find(e => e.id === signed.id);
    check(entry && digest(signed.metadataSha256) && entry.metadataSha256 === signed.metadataSha256, 'canonical metadata hash binding differs');
    check(entry.noModelRequest === true && entry.recoveryClosed === true && entry.reason === 'native-init-failed-before-model' && entry.tokens === null && entry.resolved === null, 'ledger is not a closed premodel infrastructure outcome');
    check(row.status === 'infrastructure-failed' && row.gradeStatus === 'pending', 'original infrastructure/pending status required');
    check(row.arm !== 'ordinary' && row.usageAvailability === 'unavailable', 'premodel native/unavailable usage contract required');
    for (const key of nullFields) check(row[key] === null, `${signed.id} invented/non-null model or quality field: ${key}`);
    check(Array.isArray(entry.failureEvidence) && entry.failureEvidence.length > 0 && entry.failureEvidence.every(e => digest(e.sha256)), 'ledger failure evidence hashes missing');
    check(Array.isArray(entry.costRefs) && entry.costRefs.length > 0, 'failed preparation costs missing');
    check(new Set(entry.costRefs.map(c => c.metadataSha256)).size === entry.costRefs.length, 'duplicate failed preparation cost metadata');
    check(typeof entry.canonicalMetadataPath === 'string' && path.win32.isAbsolute(entry.canonicalMetadataPath), 'canonical metadata path required');
    for (const cost of entry.costRefs) check(digest(cost.metadataSha256) && typeof cost.metadataPath === 'string' && path.win32.isAbsolute(cost.metadataPath) && Number.isFinite(cost.slotWallMs) && cost.slotWallMs >= 0, 'invalid failed preparation cost reference');
    const canonical = entry.costRefs.filter(c => c.metadataSha256 === entry.metadataSha256 && metadataPathKey(c.metadataPath) === metadataPathKey(entry.canonicalMetadataPath));
    check(canonical.length === 1 && canonical[0].slotWallMs === row.slotWallMs, 'canonical failed preparation cost must match original summary slot wall');
    const archived = entry.costRefs.filter(c => c !== canonical[0]);
    costs.push({ id: signed.id, metadataSha256: signed.metadataSha256, reason: entry.reason,
      canonicalMetadataPath: entry.canonicalMetadataPath, canonicalSlotWallMs: canonical[0].slotWallMs,
      failedPreparationCount: entry.costRefs.length, failedPreparationWallMs: entry.costRefs.reduce((n, c) => n + c.slotWallMs, 0),
      archivedPreparationWallMs: archived.reduce((n, c) => n + c.slotWallMs, 0),
      historyOverlap: 'Non-additive history: failedPreparationWallMs includes canonicalSlotWallMs already present in the original summary slotWallMs. archivedPreparationWallMs is the separate archived portion; no clocks are added automatically.',
      costRefs: entry.costRefs.map(({ phase, metadataPath, metadataSha256, slotWallMs }) => ({ phase, metadataPath, metadataSha256, slotWallMs })) });
    signedRows.add(row);
  }
  return { signedRows, record: { closureSha256: expectedClosureSha256, approvedLedgerSha256: expectedLedgerSha256,
    receipt, signedInfrastructure: costs,
    authority: 'ROOT-approved closed audit pinned by independently supplied raw receipt and ledger SHA-256. This reporter does not independently re-audit metadata, signatures, source evidence, or model provenance.' } };
}
