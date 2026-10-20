// Adapts context-pilot-96-v1/summarize.mjs and community/{summary,suite-summary}.mjs.
// Offline reporting only: receives a frozen summarizeSuite result, never loads campaigns.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateClosure, metadataPathKey } from './infra-closure.mjs';

export const ARMS = ['ordinary', 'codefacts022', 'codegraph'];
export const RESOURCES = ['totalTokens', 'inputTokens', 'outputTokens', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'modelTurnMs', 'dshDurationMs', 'slotWallMs', 'preparationAndSandboxMs', 'sourcePreparationMs', 'indexDurationMs', 'gradeDurationMs', 'indexDiskBytes', 'nativeCalls', 'toolCalls', 'toolErrors'];
export const QUALITY = ['file', 'symbol', 'span', 'line'].flatMap(level => ['coverage', 'precision'].map(metric => `${level}.${metric}`));
const terminal = new Set(['attempt-completed', 'task-failed']);
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const sum = values => values.reduce((a, b) => a + b, 0);
const sorted = values => [...new Set(values)].sort();
const configKey = model => JSON.stringify([model?.provider, model?.id, model?.reasoningEffort]);
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function availability(values) {
  const known = values.filter(numeric);
  return { total: known.length === values.length ? sum(known) : null, knownTotal: known.length ? sum(known) : null,
    known: known.length, missing: values.length - known.length, knownMean: known.length ? sum(known) / known.length : null };
}
const count = (rows, key) => Object.fromEntries(sorted(rows.map(row => row[key] == null ? 'null' : String(row[key]))).map(value => [value, rows.filter(row => (row[key] == null ? 'null' : String(row[key])) === value).length]));
const valid = row => row.gradeStatus === 'completed' && row.metrics !== null;
const quality = (row, key) => { const [level, metric] = key.split('.'); return valid(row) ? row.metrics?.localization?.[level]?.[metric] ?? null : null; };
const resolved = row => row.cohort === 'swe' && row.gradeStatus === 'completed' && typeof row.resolved === 'boolean' ? Number(row.resolved) : null;
const difference = (a, b) => numeric(a) && numeric(b) ? b - a : null;

function execution(rows, signedRows = new Set()) {
  return { planned: rows.length, terminal: rows.filter(row => terminal.has(row.status)).length,
    actualModelTerminal: rows.filter(row => terminal.has(row.status)).length,
    signedInfrastructure: rows.filter(row => signedRows.has(row)).length,
    accountedClosed: rows.filter(row => terminal.has(row.status) || signedRows.has(row)).length,
    unaccounted: rows.filter(row => !terminal.has(row.status) && !signedRows.has(row)).length,
    attemptCompleted: rows.filter(row => row.status === 'attempt-completed').length,
    taskFailed: rows.filter(row => row.status === 'task-failed').length,
    infrastructureFailed: rows.filter(row => row.status === 'infrastructure-failed').length,
    nonterminal: rows.filter(row => !terminal.has(row.status)).length,
    statuses: count(rows, 'status'), outcomes: count(rows, 'outcome'), receiptStatuses: count(rows, 'receiptStatus'),
    providerCallSucceeded: count(rows, 'providerCallSucceeded'), generationCutoff: count(rows, 'generationCutoff'),
    gradeStatuses: count(rows, 'gradeStatus'), usageAvailability: count(rows, 'usageAvailability'), errors: count(rows, 'error') };
}
function resolvedCounts(rows) {
  const values = rows.map(resolved), knownTrue = values.filter(value => value === 1).length, knownFalse = values.filter(value => value === 0).length;
  const unknown = rows.length - knownTrue - knownFalse;
  return { planned: rows.length, knownTrue, knownFalse, unknown, rate: unknown || !rows.length ? null : knownTrue / rows.length,
    lowerBound: rows.length ? knownTrue / rows.length : null, upperBound: rows.length ? (knownTrue + unknown) / rows.length : null };
}
export function aggregate(rows, cohort, signedRows = new Set()) {
  const callPairs = rows.filter(row => numeric(row.toolCalls) && numeric(row.toolErrors));
  const calls = sum(callPairs.map(row => row.toolCalls)), errors = sum(callPairs.map(row => row.toolErrors));
  return { ...execution(rows, signedRows), resources: Object.fromEntries(RESOURCES.map(key => [key, availability(rows.map(row => row[key]))])),
    quality: cohort === 'context' ? Object.fromEntries(QUALITY.map(key => [key, availability(rows.map(row => quality(row, key)))])) : null,
    officialScored: rows.filter(row => row.gradeStatus === 'completed').length,
    validContextMetrics: cohort === 'context' ? { valid: rows.filter(valid).length, all: rows.length } : null,
    validLocalizationQuality: cohort === 'context' ? { valid: rows.filter(row => QUALITY.every(key => numeric(quality(row, key)))).length, all: rows.length } : null,
    missingQualityByReason: count(rows.filter(row => cohort === 'context' ? !valid(row) : resolved(row) === null).map(row => signedRows.has(row) ? { gradeStatus: 'signed-infrastructure-before-model' } : row), 'gradeStatus'),
    resolved: cohort === 'swe' ? resolvedCounts(rows) : null,
    lowerBoundOnlyForNonExact: availability(rows.filter(row => !numeric(row.totalTokens)).map(row => row.knownUsageLowerBound?.totalTokens ?? null)),
    nativeAdoption: { known: rows.filter(row => typeof row.nativeAdopted === 'boolean').length, adopted: rows.filter(row => row.nativeAdopted === true).length,
      interpretation: 'Recognized native attempts including errored calls; adoption does not establish successful native service.' },
    toolErrorRate: { knownAttempts: callPairs.length, plannedAttempts: rows.length, errors: callPairs.length ? errors : null,
      calls: callPairs.length ? calls : null, rate: calls ? errors / calls : null, denominator: 'All tool calls in attempts with known toolCalls and toolErrors; native-only errors are unavailable in this schema.' } };
}
function paired(rows, taskIds, arm, cohort) {
  const pairs = taskIds.map(taskId => {
    const ordinary = rows.find(row => row.taskId === taskId && row.arm === 'ordinary');
    const treatment = rows.find(row => row.taskId === taskId && row.arm === arm);
    return { taskId, instanceId: ordinary.instanceId, ordinaryGrade: ordinary.gradeStatus, treatmentGrade: treatment.gradeStatus,
      ordinaryStatus: ordinary.status, treatmentStatus: treatment.status,
      ordinaryResolved: cohort === 'swe' ? resolved(ordinary) : null, treatmentResolved: cohort === 'swe' ? resolved(treatment) : null,
      resources: Object.fromEntries(RESOURCES.map(key => [key, difference(ordinary[key], treatment[key])])),
      quality: cohort === 'context' ? Object.fromEntries(QUALITY.map(key => [key, difference(quality(ordinary, key), quality(treatment, key))])) : null };
  });
  const correctness = cohort === 'swe' ? (() => {
    const complete = pairs.filter(pair => pair.ordinaryResolved !== null && pair.treatmentResolved !== null);
    const deltas = availability(pairs.map(pair => difference(pair.ordinaryResolved, pair.treatmentResolved)));
    return { ...deltas, plannedTaskPairs: taskIds.length, gradedPairs: complete.length, missingPairs: taskIds.length - complete.length,
      meanDifference: deltas.total === null || !taskIds.length ? null : deltas.total / taskIds.length,
      gained: complete.filter(pair => pair.ordinaryResolved === 0 && pair.treatmentResolved === 1).length,
      lost: complete.filter(pair => pair.ordinaryResolved === 1 && pair.treatmentResolved === 0).length,
      bothCorrect: complete.filter(pair => pair.ordinaryResolved === 1 && pair.treatmentResolved === 1).length,
      bothIncorrect: complete.filter(pair => pair.ordinaryResolved === 0 && pair.treatmentResolved === 0).length,
      lowerBound: taskIds.length ? sum(pairs.map(pair => (pair.treatmentResolved ?? 0) - (pair.ordinaryResolved ?? 1))) / taskIds.length : null,
      upperBound: taskIds.length ? sum(pairs.map(pair => (pair.treatmentResolved ?? 1) - (pair.ordinaryResolved ?? 0))) / taskIds.length : null };
  })() : null;
  return { arm, direction: `${arm} minus ordinary`, plannedTaskPairs: taskIds.length, pairs, correctness,
    resources: Object.fromEntries(RESOURCES.map(key => {
      const ordinary = availability(rows.filter(row => row.arm === 'ordinary').map(row => row[key]));
      const treatment = availability(rows.filter(row => row.arm === arm).map(row => row[key]));
      const ratio = ordinary.total !== null && ordinary.total !== 0 && treatment.total !== null ? treatment.total / ordinary.total : null;
      return [key, { ...availability(pairs.map(pair => pair.resources[key])), ordinary, treatment, ratio, relativeChange: ratio === null ? null : ratio - 1 }];
    })), quality: cohort === 'context' ? Object.fromEntries(QUALITY.map(key => [key, availability(pairs.map(pair => pair.quality[key]))])) : null };
}
export function panel(rows, cohort, signedRows = new Set()) {
  const taskIds = sorted(rows.map(row => row.taskId));
  return { taskIds, sourceTaskCount: taskIds.length, plannedCells: rows.length,
    arms: Object.fromEntries(ARMS.map(arm => [arm, aggregate(rows.filter(row => row.arm === arm), cohort, signedRows)])),
    paired: ARMS.slice(1).map(arm => paired(rows, taskIds, arm, cohort)) };
}
function check(condition, message) { if (!condition) throw new Error(message); }
function validateAndClassifySummary(summary, mode, closure = null, inputSha256 = null) {
  check(['full288', 'pilot96'].includes(mode), 'mode must explicitly be full288 or pilot96');
  check(summary.schemaVersion === 1 && summary.plannedAttempts === 288 && summary.plannedModels === 4 && summary.plannedCampaigns === 8, 'Expected frozen suite schema: 4 models, 8 campaigns, 288 planned attempts');
  check(summary.suiteId === 'community-four-family-fixed24-20261017-v1', 'Expected this frozen evaluation suite identity');
  check(summary.models?.length === 4 && new Set(summary.models.map(model => model.id)).size === 4, 'Expected four distinct model identities');
  const signatures = new Map(), configurations = new Set();
  for (const model of summary.models) {
    const configuration = configKey(model.model);
    check(!configurations.has(configuration), 'Duplicate model configuration'); configurations.add(configuration);
    check(model.campaigns?.length === 2, `Expected two campaigns: ${model.id}`);
    const cohorts = new Set();
    for (const campaign of model.campaigns) {
      check(campaign.plannedAttempts === 36 && campaign.attempts?.length === 36, `Expected all 36 planned campaign cells: ${campaign.campaignId}`);
      check(configKey(campaign.model) === configuration, `Campaign model differs: ${campaign.campaignId}`);
      const cohort = campaign.attempts[0].cohort;
      check(['context', 'swe'].includes(cohort) && !cohorts.has(cohort), `Duplicate/invalid campaign cohort: ${campaign.campaignId}`); cohorts.add(cohort);
      check(campaign.attempts.every(row => row.cohort === cohort), 'Mixed campaign cohort');
      const taskIds = sorted(campaign.attempts.map(row => row.taskId));
      check(taskIds.length === 12, `Expected 12 source tasks: ${campaign.campaignId}`);
      for (const id of taskIds) {
        const cells = campaign.attempts.filter(row => row.taskId === id), first = cells[0];
        check(cells.length === 3 && ARMS.every(arm => cells.filter(row => row.arm === arm).length === 1), `Missing or duplicate task/arm: ${id}`);
        check(cells.every(row => ['instanceId', 'cohort', 'split', 'language'].every(key => row[key] === first[key])), `Inconsistent task identity: ${id}`);
        check(['pilot', 'confirmation_holdout'].includes(first.split), `Invalid split: ${id}`);
        check(typeof first.instanceId === 'string' && typeof first.language === 'string', `Missing task identity: ${id}`);
      }
      for (const [split, expected] of [['pilot', 24], ['confirmation_holdout', 12]]) check(campaign.attempts.filter(row => row.split === split).length === expected, `Invalid ${split} denominator`);
      const signature = JSON.stringify(campaign.attempts.filter(row => row.arm === 'ordinary').map(({ taskId, instanceId, cohort, split, language }) => ({ taskId, instanceId, cohort, split, language })).sort((a, b) => a.taskId.localeCompare(b.taskId)));
      if (signatures.has(cohort)) check(signatures.get(cohort) === signature, `Fixed tasks differ across models: ${cohort}`); else signatures.set(cohort, signature);
    }
  }
  const rows = summary.models.flatMap(model => model.campaigns.flatMap(campaign => campaign.attempts));
  const selected = rows.filter(row => mode === 'full288' || row.cohort === 'context' && row.split === 'pilot');
  check(selected.length === (mode === 'full288' ? 288 : 96), 'Selected denominator mismatch');
  const classified = validateClosure(summary, mode, inputSha256, selected, closure);
  const { signedRows } = classified;
  check(selected.every(row => terminal.has(row.status) || signedRows.has(row)), `${mode} requires every selected cell terminal; unstarted/active cells remain unfinished`);
  check(selected.every(row => typeof row.gradeStatus === 'string' && row.gradeStatus.trim().length > 0), `${mode} requires an explicit gradeStatus from the audited summary`);
  check(selected.every(row => row.gradeStatus !== 'pending' || signedRows.has(row)), `${mode} contains pending official grading`);
  const cli = rows.filter(row => row.cohort === 'context' && row.instanceId === 'cli__cli-5698');
  check(cli.length === 12 && new Set(cli.map(row => row.taskId)).size === 1 && new Set(cli.map(row => row.split)).size === 1, 'CLI sensitivity requires same source task in every model and arm');
  return { rows: selected, ...classified };
}
export function validateSummary(summary, mode, closure = null, inputSha256 = null) {
  return validateAndClassifySummary(summary, mode, closure, inputSha256).rows;
}
function macro(values) {
  const result = availability(values.map(value => value.value));
  return { mean: result.missing || !values.length ? null : result.knownMean, knownMean: result.knownMean,
    plannedModels: values.length, knownModels: result.known, missingModels: result.missing,
    missingModelIds: values.filter(value => !numeric(value.value)).map(value => value.modelId) };
}
const keyIdentity = row => JSON.stringify([row.modelId, row.cohort, row.split, row.taskId, row.arm]);
function allocationSummary(receipt, rows, suiteId, rootClosure) {
  if (receipt === null) return { status: 'not-supplied', physicalAllocationBytes: null };
  const raw = receipt.receipt;
  check([1, 2].includes(raw.schemaVersion) && raw.suiteId === suiteId && raw.mode === 'final' && Array.isArray(raw.slots), 'Expected actual final physical-index collector schema and matching suite');
  const signedIds = new Set(rootClosure?.signedInfrastructure.map(e => e.id) ?? []);
  const joinedId = row => `${row.parentCampaignId}/${row.slotId}`;
  if (raw.schemaVersion === 2) {
    check(rootClosure ? raw.rootApprovedLedger?.sha256?.toLowerCase() === rootClosure.approvedLedgerSha256 : raw.rootApprovedLedger === null,
      'Physical v2 requires matching ROOT-approved ledger binding, or explicit null when no infrastructure is signed');
    check(raw.plannedSlots === 288 && raw.nativeSlots === 192 && raw.expectedSuccessfulNativeSlots === 192 - signedIds.size, 'Physical v2 planned/successful native denominator mismatch');
    check(Array.isArray(raw.failureInventories), 'Physical v2 failure inventories required');
    for (const source of raw.slots) {
      const target = rows.find(row => row.parentCampaignId === source.campaignId && row.slotId === source.slotId);
      check(target && keyIdentity(target) === keyIdentity(source), 'Physical v2 structural campaign/slot identity differs');
      const infra = signedIds.has(joinedId(target));
      check(source.infrastructureOutcome === infra, 'Physical v2 infrastructure classification differs from signed ledger');
      check(source.outcomeBucket === (infra ? 'infrastructure-failure-index' : source.arm === 'ordinary' ? 'ordinary' : 'successful-formal-index'), 'Physical v2 outcome bucket differs');
      if (infra) check(source.measurementStatus !== 'measured', 'Failed infrastructure cannot be a successful measured index');
    }
    check(new Set(raw.failureInventories.map(e => JSON.stringify([e.id, e.formal, e.phase]))).size === raw.failureInventories.length, 'Duplicate retained failure inventory');
    for (const entry of raw.failureInventories) {
      check(signedIds.has(entry.id) && typeof entry.formal === 'boolean', 'Unsigned failure inventory or missing formal classification');
      if (!entry.formal) check(typeof entry.metadataPath === 'string' && typeof entry.metadataSha256 === 'string' && rootClosure.signedInfrastructure.find(e => e.id === entry.id).costRefs.some(c => c.phase === entry.phase && metadataPathKey(c.metadataPath) === metadataPathKey(entry.metadataPath) && c.metadataSha256.toLowerCase() === entry.metadataSha256.toLowerCase()), 'Historical failure inventory not linked to approved preparation phase/path/hash');
    }
    const formal = raw.failureInventories.filter(e => e.formal);
    check(new Set(formal.map(e => e.id)).size === formal.length, 'Duplicate canonical failure inventory');
    for (const source of raw.slots.filter(s => s.infrastructureOutcome)) {
      const inventory = formal.find(e => e.id === `${source.campaignId}/${source.slotId}`);
      check(inventory && inventory.status === source.measurementStatus && inventory.allocationSizeBytes === source.allocationSizeBytes && JSON.stringify(inventory.files) === JSON.stringify(source.files), 'Canonical failed inventory differs from slot evidence');
      check(raw.failureInventories.filter(e => e.id === inventory.id).length === rootClosure.signedInfrastructure.find(e => e.id === inventory.id).failedPreparationCount, 'Retained failure inventory count differs from approved preparation history');
    }
  }
  check(typeof raw.startedAt === 'string' && typeof raw.completedAt === 'string', 'Collector measurement times required');
  const key = keyIdentity;
  check(new Set(raw.slots.map(key)).size === raw.slots.length, 'Duplicate physical collector slot');
  // Collector measured rows have a nonempty twice-sampled inventory. Validate
  // this external JSON evidence once before trusting it in report groups.
  const collectorSizes = new Map();
  const failedInventories = raw.schemaVersion === 2 ? raw.failureInventories.filter(entry => entry.status === 'failure-inventory-measured') : [];
  for (const slot of [...raw.slots.filter(slot => slot.measurementStatus === 'measured'), ...failedInventories]) {
    check((slot.applicable === true || failedInventories.includes(slot)) && Array.isArray(slot.files) && slot.files.length > 0,
      `Measured collector slot requires file evidence: ${slot.slotId}`);
    check(Number.isSafeInteger(slot.allocationSizeBytes) && slot.allocationSizeBytes >= 0,
      `Measured collector slot requires exact allocation bytes: ${slot.slotId}`);
    const identities = new Map();
    for (const file of slot.files) {
      check(typeof file.identity === 'string' && file.identity.length > 0 && Number.isSafeInteger(file.allocationSizeBytes) && file.allocationSizeBytes >= 0,
        `Collector file requires identity and exact allocation bytes: ${slot.slotId}`);
      if (collectorSizes.has(file.identity)) check(collectorSizes.get(file.identity) === file.allocationSizeBytes, 'Conflicting allocation for same collector file identity');
      collectorSizes.set(file.identity, file.allocationSizeBytes);
      identities.set(file.identity, file.allocationSizeBytes);
    }
    check(sum([...identities.values()]) === slot.allocationSizeBytes,
      `Measured collector file allocation does not match advertised slot allocation: ${slot.slotId}`);
  }
  const groups = [];
  for (const modelId of sorted(rows.map(row => row.modelId))) for (const cohort of ['context', 'swe']) for (const split of ['pilot', 'confirmation_holdout']) for (const arm of ARMS) {
    const planned = rows.filter(row => row.modelId === modelId && row.cohort === cohort && row.split === split && row.arm === arm);
    if (!planned.length) continue;
    const cells = planned.map(row => {
      const source = raw.slots.find(slot => key(slot) === key(row));
      const infrastructureOutcome = signedIds.has(joinedId(row));
      check(!infrastructureOutcome || source?.measurementStatus !== 'measured', 'Failed infrastructure cannot be a successful measured index');
      return { modelId, cohort, split, taskId: row.taskId, arm, applicable: arm !== 'ordinary', infrastructureOutcome,
        failureAllocationSizeBytes: infrastructureOutcome && source?.measurementStatus === 'failure-inventory-measured' ? source.allocationSizeBytes : null,
        measurementStatus: source?.measurementStatus ?? 'not-covered-by-receipt', stability: source?.stability ?? null,
        allocationSizeBytes: source?.applicable === true && source.measurementStatus === 'measured' ? source.allocationSizeBytes : null,
        files: source?.files ?? [] };
    });
    const native = cells.filter(cell => cell.applicable), known = native.filter(cell => numeric(cell.allocationSizeBytes));
    const files = new Map();
    for (const cell of known) for (const file of cell.files) {
      files.set(file.identity, file.allocationSizeBytes);
    }
    const knownTotal = known.length ? sum([...files.values()]) : null;
    const infrastructureNativeCells = native.filter(c => c.infrastructureOutcome).length;
    groups.push({ modelId, cohort, split, arm, applicable: arm !== 'ordinary', plannedNativeCells: native.length,
      signedInfrastructureNativeCells: infrastructureNativeCells, expectedSuccessfulNativeCells: native.length - infrastructureNativeCells,
      knownNativeCells: known.length, missingNativeCells: native.length - known.length,
      stableMeasuredCells: known.filter(cell => cell.stability === 'stable-two-samples').length,
      uniqueFileIds: files.size, allocationSizeBytesUniqueFileIdsKnownTotal: knownTotal,
      allocationSizeBytesUniqueFileIds: native.length && known.length === native.length ? knownTotal : null, cells });
  }
  let failureAllocation = null;
  if (raw.schemaVersion === 2) {
    const bucket = inventories => {
      const measured = inventories.filter(e => ['measured', 'failure-inventory-measured'].includes(e.measurementStatus ?? e.status));
      const files = new Map(measured.flatMap(e => e.files.map(file => [file.identity, file.allocationSizeBytes])));
      const known = measured.length ? sum([...files.values()]) : null;
      return { inventories: inventories.length, measuredInventories: measured.length, gaps: inventories.length - measured.length,
        uniqueFileIds: files.size, knownAllocationBytes: known, fullAllocationBytes: inventories.length && measured.length === inventories.length ? known : null };
    };
    const successful = raw.slots.filter(s => s.applicable && !s.infrastructureOutcome);
    const recomputed = { successfulFormal: bucket(successful), infrastructureFailureRetained: bucket(raw.failureInventories), allRetained: bucket([...successful, ...raw.failureInventories]) };
    for (const [name, value] of Object.entries(recomputed)) for (const [field, expected] of Object.entries(value)) check(raw.allocationBuckets?.[name]?.[field] === expected, `Physical v2 ${name}.${field} subtotal mismatch`);
    check(raw.totals?.applicableSlots === successful.length && raw.totals.measuredSlots === recomputed.successfulFormal.measuredInventories && raw.totals.uniqueFileIds === recomputed.successfulFormal.uniqueFileIds && raw.totals.allocationSizeBytesUniqueFileIdsKnownTotal === recomputed.successfulFormal.knownAllocationBytes, 'Physical v2 legacy successful totals include inconsistent/failure bytes');
    failureAllocation = { buckets: recomputed, inventories: raw.failureInventories,
      meaning: 'Partial canonical and retained archived failure allocations deduplicated separately from successful formal index samples; no physical bytes become cold-index successes.' };
  }
  return { status: 'separate-collector-receipt-supplied', sourcePath: receipt.sourcePath, sha256: receipt.sha256, failureAllocation,
    measuredAt: { startedAt: raw.startedAt, completedAt: raw.completedAt }, collectorScope: raw.filters,
    meaning: 'Post-query measurement snapshot; Windows FileStandardInfo AllocationSize deduplicated by collector file identity. Distinct from setup indexDiskBytes. Partial receipt coverage remains missing for other planned native cells.',
    groups, receipt: raw };
}
export function buildReport(summary, { mode, inputSha256, allocationReceipt = null, closure = null } = {}) {
  const { rows: all, signedRows, record: rootClosure } = validateAndClassifySummary(summary, mode, closure, inputSha256);
  const models = summary.models.map(model => {
    const rows = model.campaigns.flatMap(campaign => campaign.attempts).filter(row => mode === 'full288' || row.cohort === 'context' && row.split === 'pilot');
    const panels = [];
    for (const cohort of ['context', 'swe']) for (const split of ['pilot', 'confirmation_holdout']) {
      const selected = rows.filter(row => row.cohort === cohort && row.split === split);
      if (!selected.length) continue;
      panels.push({ cohort, split, primary: panel(selected, cohort, signedRows),
        excludingCli5698: cohort === 'context' ? panel(selected.filter(row => row.instanceId !== 'cli__cli-5698'), cohort, signedRows) : null,
        languages: Object.fromEntries(sorted(selected.map(row => row.language)).map(language => [language, panel(selected.filter(row => row.language === language), cohort, signedRows)])) });
    }
    return { modelId: model.id, family: model.family, model: model.model, panels, rows };
  });
  const equalModelMacro = models[0].panels.map(first => ({ cohort: first.cohort, split: first.split,
    paired: ARMS.slice(1).map(arm => {
      const pairs = models.map(model => ({ modelId: model.modelId, pair: model.panels.find(p => p.cohort === first.cohort && p.split === first.split).primary.paired.find(pair => pair.arm === arm) }));
      return { arm, quality: first.cohort === 'context' ? Object.fromEntries(QUALITY.map(key => [key, macro(pairs.map(({ modelId, pair }) => ({ modelId, value: pair.quality[key].total === null ? null : pair.quality[key].knownMean })))])) : macro(pairs.map(({ modelId, pair }) => ({ modelId, value: pair.correctness.meanDifference }))),
        // Only dimensionless within-model ratios are averaged, as in suite-summary.mjs.
        resourceRatios: Object.fromEntries(RESOURCES.map(key => [key, macro(pairs.map(({ modelId, pair }) => ({ modelId, value: pair.resources[key].ratio })))])) };
    }) }));
  return { schemaVersion: 1, generatorVersion: '2.0.0-infra', suiteId: summary.suiteId, mode, rootClosure,
    scope: mode === 'pilot96' ? 'CLOSED CONTEXT PILOT VALIDATION ONLY: 96 cells. Not a full-suite result.' : 'FINAL ROOT-AUDITED SUITE INPUT: all 288 planned cells retained. Reporter checks are structural.',
    input: { sha256: inputSha256 ?? null, schema: 'community/suite-summary.mjs summarizeSuite schemaVersion 1' },
    denominators: { suitePlannedCells: 288, suitePlannedNativeCells: 192, reportedCells: all.length, models: 4, arms: 3, sourceTasksPerCohort: 12,
      sourceTasksBySplit: { pilot: 8, confirmation_holdout: 4 }, fullCellsPerCohortSplit: { pilot: 96, confirmation_holdout: 48 } },
    methods: {
      inputAuthority: 'The immutable summary must come from root-audited closed-phase and frozen-input verification. Reporter structural/status checks do not independently prove frozen model identity, accepted grade policy, official report provenance, or full suite closure.',
      quality: 'Context: completed official adapted reference localization agreement. SWE: completed official resolved true/false/null. They are separate outcomes.',
      missing: 'All planned cells retained. Null is unknown. Known-report means are descriptive of measured reports; no zero imputation. Lower-bound usage is separate from exact usage.',
      paired: 'Same source task and model, treatment minus ordinary; fixed pairs retain missing measurements and failed attempts. No filtering on native adoption or correctness.',
      timing: 'Aggregate every duration independently. preparationAndSandboxMs contains source preparation, native cold indexing and SWE sandbox start. dshDurationMs contains modelTurnMs. slotWallMs contains preparation, cleanup, provenance and injected official grading; it excludes some separately timed phase audits. Never add these overlapping durations.',
      disk: 'indexDiskBytes is setup logical file length. Fresh private index per assigned cell; no OS cache flush. Physical allocation requires a separate actual collector receipt, with measurement time and possible post-query growth disclosed.',
      confirmation: 'pilot and confirmation_holdout remain separate; fixed Context confirmation tasks were historically observed, so confirmation is replication, not an unseen holdout.',
      tokenizers: 'Token/time comparisons remain within model. Equal-model macros use within-model ratios or quality effects; no pooled cross-tokenizer efficiency score.',
      native: 'nativeCalls/nativeAdopted count recognized attempts including errors. Successful native service cannot be derived from adoption or aggregate toolErrors.',
      sharedHost: 'Serial model execution on shared host; read-only metadata audits overlapped earlier runs. Elapsed observations do not establish hardware isolation.',
      sweValidation: mode === 'pilot96' ? 'Anticipated SWE shape verified against summarizeAttempt and suite-summary SWE unknown-grading tests. Actual finalized SWE suite integration remains pending until a closed full288 input is supplied.' : 'All 288 cells, including SWE, passed closed-summary ingestion. Completed official grading supplies SWE resolved values; missing/failed grades remain unknown. Consult verification receipt for source hashes and independently checked integration coverage.' },
    overallExecution: execution(all, signedRows), models, equalModelMacro,
    allocation: allocationSummary(allocationReceipt, models.flatMap(model => model.rows.map(row => ({ ...row, modelId: model.modelId,
      parentCampaignId: summary.models.find(m => m.id === model.modelId).campaigns.find(c => c.attempts.includes(row)).campaignId }))), summary.suiteId, rootClosure) };
}

const fmt = value => value === null ? 'null' : Number.isInteger(value) ? String(value) : value.toFixed(4);
const cell = value => `${fmt(value.knownTotal)} / ${value.known} / ${value.known + value.missing}`;
export function markdown(report) {
  const lines = ['# Fixed-suite quantitative report', '', report.scope, '', `Input SHA-256: ${report.input.sha256}`, '',
    `${report.denominators.reportedCells} reported model-task-arm cells; ${report.denominators.suitePlannedCells} planned in the full suite.`, '',
    `Actual model-terminal: ${report.overallExecution.actualModelTerminal}; ROOT-signed premodel infrastructure: ${report.overallExecution.signedInfrastructure}; accounted closed: ${report.overallExecution.accountedClosed}; unaccounted: ${report.overallExecution.unaccounted}. Original model nonterminal: ${report.overallExecution.nonterminal}; planned native cells: ${report.denominators.suitePlannedNativeCells}.`, '',
    ...Object.values(report.methods).map(value => value + '\n'),
    '## Execution and quality by model, cohort, split and arm', '',
    'Context quality cells: score sum / known reports / planned cells. SWE: true / false / unknown, and full-denominator lower–upper bound.', '',
    '| Model | Cohort | Split | Arm | Completed / planned | Task / infrastructure failed | Grade statuses | Quality |',
    '|---|---|---|---|---:|---|---|---|'];
  for (const model of report.models) for (const p of model.panels) for (const arm of ARMS) {
    const a = p.primary.arms[arm];
    const q = a.quality ? QUALITY.map(key => `${key}: ${cell(a.quality[key])}`).join('; ') : `${a.resolved.knownTrue} / ${a.resolved.knownFalse} / ${a.resolved.unknown}; rate ${fmt(a.resolved.rate)}, bounds ${fmt(a.resolved.lowerBound)}–${fmt(a.resolved.upperBound)}`;
    lines.push(`| ${model.modelId} | ${p.cohort} | ${p.split} | ${arm} | ${a.attemptCompleted}/${a.planned} | ${a.taskFailed} / ${a.infrastructureFailed} | ${JSON.stringify(a.gradeStatuses)} | ${q} |`);
  }
  lines.push('', '## Per-language quality', '', '| Model | Cohort | Split | Language | Arm | Planned | Quality |', '|---|---|---|---|---|---:|---|');
  for (const m of report.models) for (const p of m.panels) for (const [language, lang] of Object.entries(p.languages)) for (const arm of ARMS) {
    const a = lang.arms[arm]; lines.push(`| ${m.modelId} | ${p.cohort} | ${p.split} | ${language} | ${arm} | ${a.planned} | ${a.quality ? QUALITY.map(key => `${key}: ${cell(a.quality[key])}`).join('; ') : JSON.stringify(a.resolved)} |`);
  }
  lines.push('', '## Exact resources and cache availability within each model', '', 'Every cell is known sum / known measurements / planned cells. Durations are milliseconds and overlap. Index size is setup logical bytes. Lower-bound-only usage remains in JSON.', '', '| Model | Cohort | Split | Arm | Resource | Sum / known / planned |', '|---|---|---|---|---|---:|');
  for (const m of report.models) for (const p of m.panels) for (const arm of ARMS) for (const key of RESOURCES) lines.push(`| ${m.modelId} | ${p.cohort} | ${p.split} | ${arm} | ${key} | ${cell(p.primary.arms[arm].resources[key])} |`);
  lines.push('', '## Matched-task deltas', '', 'Known mean treatment minus ordinary; known / fixed planned pairs. All per-task nulls and full-workload within-model ratios are retained in JSON.', '', '| Model | Cohort | Split | Treatment | Measure | Known mean delta | Known / planned pairs |', '|---|---|---|---|---|---:|---:|');
  for (const m of report.models) for (const p of m.panels) for (const pair of p.primary.paired) {
    for (const [key, value] of Object.entries({ ...pair.resources, ...(pair.quality ?? {}), ...(pair.correctness ? { resolved: pair.correctness } : {}) })) lines.push(`| ${m.modelId} | ${p.cohort} | ${p.split} | ${pair.arm} | ${key} | ${fmt(value.knownMean)} | ${value.known}/${pair.plannedTaskPairs} |`);
  }
  lines.push('', '## CLI-5698 sensitivity', '', 'Exclude cli__cli-5698 uniformly from every model and arm in the Context split containing it; keep primary results intact. Unaffected splits retain their original denominator.', '', '| Model | Split | Arm | Planned | Quality |', '|---|---|---|---:|---|');
  for (const m of report.models) for (const p of m.panels.filter(p => p.excludingCli5698)) for (const arm of ARMS) {
    const a = p.excludingCli5698.arms[arm]; lines.push(`| ${m.modelId} | ${p.split} | ${arm} | ${a.planned} | ${QUALITY.map(key => `${key}: ${cell(a.quality[key])}`).join('; ')} |`);
  }
  lines.push('', 'Sensitivity paired deltas (same fixed retained source tasks):', '', '| Model | Split | Treatment | Measure | Known mean delta | Known / planned |', '|---|---|---|---|---:|---:|');
  for (const m of report.models) for (const p of m.panels.filter(p => p.excludingCli5698)) for (const pair of p.excludingCli5698.paired) for (const key of QUALITY) lines.push(`| ${m.modelId} | ${p.split} | ${pair.arm} | ${key} | ${fmt(pair.quality[key].knownMean)} | ${pair.quality[key].known}/${pair.plannedTaskPairs} |`);
  lines.push('', '## Native attempts and measurement gaps', '', '| Model | Cohort | Split | Arm | Known adoption / adopted | Native calls | All-tool error rate | Missing quality reasons |', '|---|---|---|---|---|---|---|---|');
  for (const m of report.models) for (const p of m.panels) for (const arm of ARMS) {
    const a = p.primary.arms[arm]; lines.push(`| ${m.modelId} | ${p.cohort} | ${p.split} | ${arm} | ${a.nativeAdoption.known} / ${a.nativeAdoption.adopted} | ${cell(a.resources.nativeCalls)} | ${JSON.stringify(a.toolErrorRate)} | ${JSON.stringify(a.missingQualityByReason)} |`);
  }
  lines.push('', '## Separate physical allocation snapshot', '', `Physical allocation: ${report.allocation.status}.`);
  if (report.rootClosure) lines.push('', 'ROOT closure preserves original infrastructure-failed / pending metadata and null model/quality values. It accounts for the scheduled cell without inventing a model attempt. Failed preparation history is non-additive: its total includes the canonical slot wall already present in the original summary; the separately labeled archived portion is not automatically added to any clock. These are not model durations:', '', JSON.stringify(report.rootClosure.signedInfrastructure));
  if (report.allocation.groups) {
    lines.push('', report.allocation.meaning, '', `Measurement interval: ${report.allocation.measuredAt.startedAt} to ${report.allocation.measuredAt.completedAt}.`, '', '| Model | Cohort | Split | Arm | Known / planned native cells | Stable measured | Unique-file allocation bytes (complete / known subtotal) |', '|---|---|---|---|---:|---:|---|');
    for (const g of report.allocation.groups.filter(g => g.applicable)) lines.push(`| ${g.modelId} | ${g.cohort} | ${g.split} | ${g.arm} | ${g.knownNativeCells}/${g.plannedNativeCells} | ${g.stableMeasuredCells} | ${fmt(g.allocationSizeBytesUniqueFileIds)} / ${fmt(g.allocationSizeBytesUniqueFileIdsKnownTotal)} |`);
  }
  if (report.allocation.failureAllocation) lines.push('', 'Retained failure allocations (separate from successful native samples):', '', JSON.stringify(report.allocation.failureAllocation.buckets));
  lines.push('', 'The JSON preserves every selected original attempt row, all status/error counts, usage lower bounds, per-language resources and paired nulls, and equal-model macros. One observation per model/task/arm supports descriptive comparisons, without a general productivity ranking.', '');
  return lines.join('\n');
}
export function writeReport({ inputPath, expectedSha256, mode, outputName, allocationPath, closurePath, expectedClosureSha256, ledgerPath, expectedLedgerSha256 }) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  check(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(outputName), 'output-name must be a simple unique directory name');
  check(/^[a-f0-9]{64}$/.test(expectedSha256), 'An explicit --sha256 of the immutable input is required');
  const bytes = fs.readFileSync(inputPath), digest = sha256(bytes);
  check(digest === expectedSha256, 'Input SHA-256 mismatch');
  let allocationReceipt = null, allocationBytes;
  if (allocationPath) {
    allocationBytes = fs.readFileSync(allocationPath);
    allocationReceipt = { sourcePath: path.resolve(allocationPath), sha256: sha256(allocationBytes), receipt: JSON.parse(allocationBytes),
      interpretation: 'Actual separate collector receipt attached verbatim. Its field semantics and measurement scope must be reviewed against collector documentation; no logical-byte conversion or inferred physical total.' };
  }
  let closure = null;
  if ([closurePath, expectedClosureSha256, ledgerPath, expectedLedgerSha256].some(value => value !== undefined)) {
    check(closurePath && expectedClosureSha256 && ledgerPath && expectedLedgerSha256, 'All ROOT closure and approved ledger path/hash options are required together');
    closure = { closureBytes: fs.readFileSync(closurePath), expectedClosureSha256,
      ledgerBytes: fs.readFileSync(ledgerPath), expectedLedgerSha256 };
  }
  const report = buildReport(JSON.parse(bytes), { mode, inputSha256: digest, allocationReceipt, closure });
  check(sha256(fs.readFileSync(inputPath)) === digest, 'Input changed during reporting');
  if (allocationPath) check(sha256(fs.readFileSync(allocationPath)) === sha256(allocationBytes), 'Allocation receipt changed during reporting');
  if (closure) {
    check(sha256(fs.readFileSync(closurePath)) === expectedClosureSha256, 'ROOT closure changed during reporting');
    check(sha256(fs.readFileSync(ledgerPath)) === expectedLedgerSha256, 'Approved ledger changed during reporting');
  }
  const output = path.join(root, 'runs', outputName);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(output); // Exclusive creation: never overwrite an existing report.
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(path.join(output, 'REPORT.md'), markdown(report), { flag: 'wx' });
  fs.writeFileSync(path.join(output, 'provenance.json'), JSON.stringify({ inputPath: path.resolve(inputPath), sha256: digest,
    generatorSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))), closureValidatorSha256: sha256(fs.readFileSync(new URL('./infra-closure.mjs', import.meta.url))),
    closure: closure ? { sourcePath: path.resolve(closurePath), sha256: expectedClosureSha256, ledgerPath: path.resolve(ledgerPath), ledgerSha256: expectedLedgerSha256, stableOnRecheck: true } : null, inputStableOnRecheck: true,
    outputDeterministic: 'report.json and REPORT.md exclude wall-clock generation times and output directory names' }, null, 2) + '\n', { flag: 'wx' });
  return { output, mode, reportedCells: report.denominators.reportedCells, inputSha256: digest };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = process.argv.slice(2);
    check(values.length % 2 === 0, 'Each CLI option requires a value');
    const pairs = [];
    for (let index = 0; index < values.length; index += 2) {
      check(values[index].startsWith('--'), 'CLI options must start with --');
      check(!pairs.some(([key]) => key === values[index].slice(2)), 'Duplicate CLI option');
      pairs.push([values[index].slice(2), values[index + 1]]);
    }
    const args = Object.fromEntries(pairs);
    check(Object.keys(args).every(key => ['input', 'sha256', 'mode', 'output-name', 'allocation-receipt', 'closure-receipt', 'closure-sha256', 'approved-ledger', 'ledger-sha256'].includes(key)), 'Unknown CLI option');
    console.log(JSON.stringify(writeReport({ inputPath: args.input, expectedSha256: args.sha256, mode: args.mode,
      outputName: args['output-name'], allocationPath: args['allocation-receipt'], closurePath: args['closure-receipt'], expectedClosureSha256: args['closure-sha256'], ledgerPath: args['approved-ledger'], expectedLedgerSha256: args['ledger-sha256'] }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
