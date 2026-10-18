// UNEXECUTED synthetic definition. No measured campaign, source, gold, answer, or trace input.
import { ARMS, RESOURCES, SUITE, digest, jsonBytes, pick } from './common.mjs';

export function fixture(producer) {
  const models = ['a', 'b', 'c', 'd'].map(id => ({ id, family: `family-${id}`, model: { provider: 'synthetic', id: `model-${id}`, reasoningEffort: 'high' } }));
  const selections = [], tasks = [];
  for (const cohort of ['context', 'swe']) for (let i = 0; i < 12; i++) {
    const instanceId = cohort === 'context' && i === 0 ? 'cli__cli-5698' : `synthetic__${cohort}-${i}`;
    const language = ['go', 'rust', 'javascript', 'typescript'][Math.floor(i / 3)], split = i % 3 === 2 ? 'confirmation_holdout' : 'pilot';
    const task = { taskId: `${cohort}-${i}`, instanceId, cohort, language, split };
    tasks.push(task); selections.push({ dataset: cohort === 'context' ? 'contextbench' : 'swebench_multilingual', id: instanceId, language, split, repo: 'synthetic/repository', base_commit: '1'.repeat(40) });
  }
  const summary = { schemaVersion: 1, suiteId: SUITE, plannedAttempts: 288, plannedModels: 4, plannedCampaigns: 8,
    models: models.map(model => ({ ...model, campaigns: ['context', 'swe'].map(cohort => ({ campaignId: `${model.id}-${cohort}`, model: model.model, plannedAttempts: 36,
      attempts: tasks.filter(t => t.cohort === cohort).flatMap(task => ARMS.map((arm, index) => ({ ...task, slotId: `${task.taskId}-${arm}`, arm,
        status: 'attempt-completed', outcome: 'completed', receiptStatus: 'attempt-completed', providerCallSucceeded: true, generationCutoff: false,
        usageAvailability: 'exact-provider-turn-usage', ...Object.fromEntries(RESOURCES.map(key => [key, 10 + index])),
        totalTokens: 100 + index, inputTokens: 70, outputTokens: 30 + index, uncachedInputTokens: 60, cacheReadTokens: 10, cacheWriteTokens: 0,
        knownUsageLowerBound: { totalTokens: 100 + index, inputTokens: 70, outputTokens: 30 + index, uncachedInputTokens: 60, cacheReadTokens: 10, cacheWriteTokens: 0 },
        nativeCalls: arm === 'ordinary' ? 0 : 10 + index, nativeAdopted: arm !== 'ordinary', gradeStatus: 'completed', resolved: cohort === 'swe' ? index !== 0 : null,
        metrics: cohort === 'context' ? { localization: Object.fromEntries(['file', 'symbol', 'span', 'line'].map(level => [level, { coverage: 0.5 + index / 10, precision: 0.4 + index / 10 }])) } : null,
        patchPath: cohort === 'swe' ? '/PRIVATE_FIXTURE/patch.diff' : null, error: null }))) })) })) };
  const a = summary.models[0], context = a.campaigns[0], swe = a.campaigns[1];
  const lower = context.attempts.find(r => r.taskId === 'context-0' && r.arm === 'ordinary');
  for (const key of ['totalTokens', 'inputTokens', 'outputTokens', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens']) lower[key] = null;
  lower.usageAvailability = 'known-lower-bound'; lower.knownUsageLowerBound = { totalTokens: 19, inputTokens: 14, outputTokens: 5, uncachedInputTokens: 14, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const zero = context.attempts.find(r => r.taskId === 'context-1' && r.arm === 'codefacts022');
  for (const key of ['totalTokens', 'inputTokens', 'outputTokens', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens']) { zero[key] = 0; zero.knownUsageLowerBound[key] = 0; }
  const invalid = context.attempts.find(r => r.taskId === 'context-3' && r.arm === 'codegraph');
  invalid.gradeStatus = 'invalid-final-json'; invalid.metrics = null; invalid.error = '/PRIVATE_FIXTURE/private-session/invalid declaration';
  const failedOfficial = swe.attempts.find(r => r.taskId === 'swe-0' && r.arm === 'codegraph');
  failedOfficial.gradeStatus = 'failed'; failedOfficial.resolved = null; failedOfficial.gradeDurationMs = null;
  // A model attempt failure and a completed official grade are independent dimensions.
  const modelFailed = swe.attempts.find(r => r.taskId === 'swe-1' && r.arm === 'codefacts022');
  Object.assign(modelFailed, { status: 'task-failed', receiptStatus: 'attempt-failed', providerCallSucceeded: false,
    outcome: 'provider-or-task-failed', generationCutoff: false, usageAvailability: 'known-lower-bound',
    knownUsageLowerBound: { totalTokens: 37, inputTokens: 29, outputTokens: 8, uncachedInputTokens: 29, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  for (const key of ['totalTokens', 'inputTokens', 'outputTokens', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens']) modelFailed[key] = null;
  const infra = context.attempts.find(r => r.taskId === 'context-2' && r.arm === 'codegraph'), infraId = `${context.campaignId}/${infra.slotId}`;
  Object.assign(infra, { status: 'infrastructure-failed', gradeStatus: 'pending', usageAvailability: 'unavailable', slotWallMs: 5,
    error: '/PRIVATE_FIXTURE/native/private-init failed', outcome: null, patchPath: null });
  for (const key of [...RESOURCES.filter(k => k !== 'slotWallMs'), 'metrics', 'resolved', 'knownUsageLowerBound', 'nativeAdopted', 'providerCallSucceeded', 'generationCutoff', 'receiptStatus']) infra[key] = null;
  const costs = [2, 3, 5].map((slotWallMs, i) => ({ phase: `failed-phase-${i}`, metadataPath: `/PRIVATE_FIXTURE/${i === 2 ? 'canonical' : `archive-${i}`}/meta.json`, metadataSha256: String(i + 1).repeat(64), slotWallMs }));
  const ledger = { schemaVersion: 1, suiteId: SUITE, status: 'root-approved', approvedBy: 'root', suiteFreezeSha256: 'f'.repeat(64), supplementSha256: 'e'.repeat(64),
    knownInfraCells: [{ id: infraId, metadataSha256: costs[2].metadataSha256, canonicalMetadataPath: costs[2].metadataPath, reason: 'native-init-failed-before-model', noModelRequest: true, recoveryClosed: true,
      tokens: null, resolved: null, failureEvidence: [{ path: '/PRIVATE_FIXTURE/log', sha256: 'a'.repeat(64) }], costRefs: costs }] };
  const ledgerBytes = jsonBytes(ledger), inputSha256 = digest(jsonBytes(summary)), expectedLedgerSha256 = digest(ledgerBytes);
  const closureReceipt = { schemaVersion: 1, kind: 'closed-summary-root-approval', status: 'root-approved', approvedBy: 'root', suiteId: SUITE, mode: 'full288', inputSummarySha256: inputSha256,
    approvedLedgerSha256: expectedLedgerSha256, suiteFreezeSha256: ledger.suiteFreezeSha256, supplementSha256: ledger.supplementSha256, metadataAuditSha256: 'b'.repeat(64), selectedInfrastructure: [{ id: infraId, metadataSha256: costs[2].metadataSha256 }] };
  const closureBytes = jsonBytes(closureReceipt), closure = { closureBytes, ledgerBytes, expectedClosureSha256: digest(closureBytes), expectedLedgerSha256 };
  const all = summary.models.flatMap(model => model.campaigns.flatMap(c => c.attempts.map(row => ({ ...row, modelId: model.id, campaignId: c.campaignId }))));
  let native = 0;
  const slots = all.map(row => {
    const failed = `${row.campaignId}/${row.slotId}` === infraId, applicable = row.arm !== 'ordinary';
    if (applicable && !failed) native++;
    const missing = applicable && !failed && native === 2, zeroBytes = applicable && !failed && native === 3;
    const files = !applicable || missing || failed ? [] : [{ identity: native === 1 ? 'shared-hardlink' : `disk-${native}`, allocationSizeBytes: zeroBytes ? 0 : 4096, path: '/PRIVATE_FIXTURE/index/database.sqlite' }];
    if (native === 1 && applicable && !failed) files.push({ ...files[0], path: '/PRIVATE_FIXTURE/index/alias.sqlite' });
    return { ...pick(row, ['modelId', 'campaignId', 'slotId', 'taskId', 'cohort', 'split', 'arm']), applicable, infrastructureOutcome: failed,
      outcomeBucket: failed ? 'infrastructure-failure-index' : applicable ? 'successful-formal-index' : 'ordinary',
      measurementStatus: failed ? 'failure-inventory-measured' : !applicable ? 'not-applicable' : missing ? 'missing' : 'measured',
      stability: applicable && !missing ? 'stable-two-samples' : null, allocationSizeBytes: applicable && !missing && !failed ? zeroBytes ? 0 : 4096 : null, files };
  });
  const failedFiles = [{ identity: 'shared-hardlink', allocationSizeBytes: 4096, path: '/PRIVATE_FIXTURE/failure/shared.sqlite' }, { identity: 'failed-retained', allocationSizeBytes: 8192, path: '/PRIVATE_FIXTURE/failure/partial.sqlite' }];
  const inventories = costs.map((cost, i) => ({ id: infraId, formal: i === 2, phase: cost.phase, metadataPath: cost.metadataPath, metadataSha256: cost.metadataSha256,
    status: 'failure-inventory-measured', allocationSizeBytes: 12288, files: failedFiles }));
  Object.assign(slots.find(s => s.infrastructureOutcome), { allocationSizeBytes: 12288, files: failedFiles });
  const bucket = entries => {
    const measured = entries.filter(e => ['measured', 'failure-inventory-measured'].includes(e.measurementStatus ?? e.status));
    const sizes = new Map(measured.flatMap(e => e.files.map(f => [f.identity, f.allocationSizeBytes])));
    const bytes = measured.length ? [...sizes.values()].reduce((a, b) => a + b, 0) : null;
    return { inventories: entries.length, measuredInventories: measured.length, gaps: entries.length - measured.length, uniqueFileIds: sizes.size, knownAllocationBytes: bytes, fullAllocationBytes: entries.length && measured.length === entries.length ? bytes : null };
  };
  const successful = slots.filter(s => s.applicable && !s.infrastructureOutcome), successfulBucket = bucket(successful);
  const raw = { schemaVersion: 2, suiteId: SUITE, mode: 'final', rootApprovedLedger: { sha256: expectedLedgerSha256 }, plannedSlots: 288, nativeSlots: 192, expectedSuccessfulNativeSlots: 191,
    startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z', filters: { cohort: 'all', split: 'all' }, slots, failureInventories: inventories,
    allocationBuckets: { successfulFormal: successfulBucket, infrastructureFailureRetained: bucket(inventories), allRetained: bucket([...successful, ...inventories]) },
    totals: { applicableSlots: successful.length, measuredSlots: successfulBucket.measuredInventories, uniqueFileIds: successfulBucket.uniqueFileIds, allocationSizeBytesUniqueFileIdsKnownTotal: successfulBucket.knownAllocationBytes } };
  const allocationReceipt = { sourcePath: '/PRIVATE_FIXTURE/physical-receipt.json', sha256: digest(jsonBytes(raw)), receipt: raw };
  const report = producer.buildReport(summary, { mode: 'full288', inputSha256, closure, allocationReceipt });
  return { summary, selection: { seed: 'synthetic-only', selections }, report, inputSha256 };
}
