import { ARMS, RESOURCES, COHORTS, SPLITS, SUITE, keys, check, equal, token, enumValue, nullableNumber, bool, isDigest, isNumber, identity, signedId, pick, projectExecution, projectPanel, projectMacro, GROUP_FIELDS } from './common.mjs';

const ROW = ['modelId', 'campaignId', 'slotId', 'taskId', 'instanceId', 'cohort', 'language', 'split', 'arm', 'status', 'outcome', 'receiptStatus', 'providerCallSucceeded', 'generationCutoff', 'usageAvailability', ...RESOURCES, 'knownUsageLowerBound', 'nativeAdopted', 'gradeStatus', 'resolved', 'metrics', 'error'];
const TOKENS = ['totalTokens', 'inputTokens', 'outputTokens', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const SLOT = ['modelId', 'cohort', 'split', 'taskId', 'arm', 'applicable', 'infrastructureOutcome', 'coveredByReceipt', 'failureAllocationSizeBytes', 'measurementStatus', 'stability', 'allocationSizeBytes', 'files'];
const unique = (values, label) => check(new Set(values).size === values.length, `Duplicate ${label}`);
function files(value, sizes) {
  check(Array.isArray(value), 'File inventory array required');
  for (const file of value) {
    keys(file, ['identity', 'allocationSizeBytes'], 'file');
    check(/^file-[0-9]{6}$/.test(file.identity), 'Opaque file identity required');
    check(Number.isSafeInteger(file.allocationSizeBytes) && file.allocationSizeBytes >= 0, 'Exact file allocation required');
    check(!sizes.has(file.identity) || sizes.get(file.identity) === file.allocationSizeBytes, 'Conflicting allocation for shared file identity');
    sizes.set(file.identity, file.allocationSizeBytes);
  }
}
const subtotal = value => [...new Map(value.map(file => [file.identity, file.allocationSizeBytes])).values()].reduce((a, b) => a + b, 0);

// Validate this external JSON boundary once; recomputation below trusts the resulting objects.
export function validateData(data) {
  keys(data, ['schemaVersion', 'suiteId', 'models', 'tasks', 'rows', 'infrastructure', 'allocation'], 'data');
  check(data.schemaVersion === 1 && data.suiteId === SUITE, 'Unsupported public data identity');
  check(Array.isArray(data.models) && data.models.length === 4, 'Four models required');
  for (const model of data.models) {
    keys(model, ['modelId', 'family', 'model'], 'model'); token(model.modelId, 'model ID'); token(model.family, 'model family');
    keys(model.model, ['provider', 'id', 'reasoningEffort'], 'model configuration');
    for (const [key, value] of Object.entries(model.model)) {
      if (key === 'id') check(typeof value === 'string' && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value), 'Public provider model identifier required');
      else token(value, `model ${key}`);
    }
  }
  unique(data.models.map(m => m.modelId), 'model ID'); unique(data.models.map(m => JSON.stringify(m.model)), 'model configuration');
  check(Array.isArray(data.tasks) && data.tasks.length === 24, '24 tasks required');
  for (const task of data.tasks) {
    keys(task, ['dataset', 'taskId', 'instanceId', 'cohort', 'language', 'split', 'repo', 'base_commit'], 'task');
    for (const key of ['dataset', 'taskId', 'instanceId', 'language']) token(task[key], `task ${key}`);
    check(COHORTS.includes(task.cohort) && SPLITS.includes(task.split), 'Invalid task cohort/split');
    check(task.dataset === (task.cohort === 'context' ? 'contextbench' : 'swebench_multilingual'), 'Dataset/cohort differs');
    check(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(task.repo) && /^[a-f0-9]{40}$/.test(task.base_commit), 'Public repo/base commit required');
  }
  unique(data.tasks.map(t => `${t.cohort}/${t.instanceId}`), 'source task'); unique(data.tasks.map(t => `${t.cohort}/${t.taskId}`), 'cohort/task ID');
  for (const cohort of COHORTS) for (const split of SPLITS) check(data.tasks.filter(t => t.cohort === cohort && t.split === split).length === (split === 'pilot' ? 8 : 4), 'Fixed source-task split differs');
  check(data.tasks.filter(t => t.cohort === 'context' && t.instanceId === 'cli__cli-5698').length === 1, 'CLI sensitivity task required');
  check(Array.isArray(data.rows) && data.rows.length === 288, '288 rows required');
  const models = new Map(data.models.map(m => [m.modelId, m])), tasks = new Map(data.tasks.map(t => [`${t.cohort}/${t.taskId}`, t]));
  for (const row of data.rows) {
    keys(row, ROW, 'row');
    for (const key of ['modelId', 'campaignId', 'slotId', 'taskId', 'instanceId', 'language', 'status', 'gradeStatus', 'usageAvailability']) token(row[key], `row ${key}`);
    check(models.has(row.modelId) && ARMS.includes(row.arm), 'Undeclared model/arm');
    const task = tasks.get(`${row.cohort}/${row.taskId}`);
    check(task && ['cohort', 'instanceId', 'language', 'split'].every(key => task[key] === row[key]), 'Row/task identity differs');
    for (const key of ['outcome', 'receiptStatus']) enumValue(row[key], key);
    for (const key of ['providerCallSucceeded', 'nativeAdopted', 'resolved']) bool(row[key], key);
    enumValue(row.generationCutoff, 'generation cutoff');
    for (const key of RESOURCES) nullableNumber(row[key], key);
    check(row.error === null || /^error-[0-9]{3}$/.test(row.error), 'Opaque error category required');
    if (row.knownUsageLowerBound !== null) { keys(row.knownUsageLowerBound, TOKENS, 'lower bound'); for (const key of TOKENS) nullableNumber(row.knownUsageLowerBound[key], `lower bound ${key}`); }
    if (row.metrics !== null) {
      keys(row.metrics, ['localization'], 'metrics'); keys(row.metrics.localization, ['file', 'symbol', 'span', 'line'], 'localization');
      for (const level of ['file', 'symbol', 'span', 'line']) {
        keys(row.metrics.localization[level], ['coverage', 'precision'], 'quality level');
        for (const value of Object.values(row.metrics.localization[level])) check(value === null || isNumber(value) && value >= 0 && value <= 1, 'Quality fraction required');
      }
    }
  }
  unique(data.rows.map(identity), 'model/task/arm cell'); unique(data.rows.map(signedId), 'campaign/slot cell');
  const campaignIds = [];
  for (const model of data.models) for (const cohort of COHORTS) {
    const rows = data.rows.filter(r => r.modelId === model.modelId && r.cohort === cohort);
    check(rows.length === 36 && new Set(rows.map(r => r.campaignId)).size === 1, '36-cell single campaign required');
    campaignIds.push(rows[0].campaignId);
    for (const task of data.tasks.filter(t => t.cohort === cohort)) for (const arm of ARMS) check(rows.some(r => r.taskId === task.taskId && r.arm === arm), 'Missing scheduled cell');
  }
  unique(campaignIds, 'campaign ID');
  check(Array.isArray(data.infrastructure), 'Infrastructure array required'); unique(data.infrastructure.map(e => e.id), 'signed infrastructure ID');
  const infra = new Map(data.infrastructure.map(e => [e.id, e]));
  for (const entry of data.infrastructure) {
    keys(entry, ['id', 'metadataSha256', 'reason', 'failedPreparationCount', 'failedPreparationWallMs', 'canonicalSlotWallMs', 'archivedPreparationWallMs', 'historyOverlap', 'costRefs'], 'infrastructure');
    check(typeof entry.id === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.id) && isDigest(entry.metadataSha256), 'Public infrastructure identity required');
    check(entry.reason === 'native-init-failed-before-model' && entry.historyOverlap === 'includes-canonical-slot-wall', 'Supported signed infrastructure semantics required');
    check(Array.isArray(entry.costRefs) && entry.costRefs.length > 0 && entry.failedPreparationCount === entry.costRefs.length, 'Failed preparation count differs');
    unique(entry.costRefs.map(c => c.metadataSha256), 'failure cost reference');
    for (const cost of entry.costRefs) {
      keys(cost, ['phase', 'metadataSha256', 'slotWallMs', 'canonical'], 'cost reference'); token(cost.phase, 'cost phase');
      check(isDigest(cost.metadataSha256) && typeof cost.canonical === 'boolean' && isNumber(cost.slotWallMs) && cost.slotWallMs >= 0, 'Invalid public cost reference');
    }
    const canonical = entry.costRefs.filter(c => c.canonical);
    check(canonical.length === 1 && canonical[0].metadataSha256 === entry.metadataSha256, 'One canonical cost required');
    equal(entry.canonicalSlotWallMs, canonical[0].slotWallMs, 'Canonical cost');
    equal(entry.failedPreparationWallMs, entry.costRefs.reduce((n, c) => n + c.slotWallMs, 0), 'Failed preparation cost');
    equal(entry.archivedPreparationWallMs, entry.costRefs.filter(c => !c.canonical).reduce((n, c) => n + c.slotWallMs, 0), 'Archived cost');
    const row = data.rows.find(r => signedId(r) === entry.id);
    check(row && row.status === 'infrastructure-failed' && row.gradeStatus === 'pending' && row.arm !== 'ordinary' && row.usageAvailability === 'unavailable', 'Signed premodel row differs');
    equal(row.slotWallMs, entry.canonicalSlotWallMs, 'Canonical wall overlap');
    for (const key of [...RESOURCES.filter(k => k !== 'slotWallMs'), 'metrics', 'resolved', 'knownUsageLowerBound', 'nativeAdopted', 'providerCallSucceeded', 'generationCutoff', 'receiptStatus']) check(row[key] === null, `Invented premodel ${key}`);
  }
  check(data.rows.every(row => infra.has(signedId(row)) || ['attempt-completed', 'task-failed'].includes(row.status) && row.gradeStatus !== 'pending'), 'Unclosed row');
  keys(data.allocation, ['status', 'measuredAt', 'slots', 'failureInventories', 'hasFailureBuckets'], 'allocation');
  const allocation = data.allocation;
  check(typeof allocation.hasFailureBuckets === 'boolean' && Array.isArray(allocation.slots) && Array.isArray(allocation.failureInventories), 'Allocation shape differs');
  if (allocation.status === 'not-supplied') {
    check(allocation.measuredAt === null && !allocation.hasFailureBuckets && allocation.slots.length === 0 && allocation.failureInventories.length === 0, 'Unsupplied allocation must remain unknown');
    return data;
  }
  check(allocation.status === 'separate-collector-receipt-supplied' && allocation.slots.length === 288, 'All planned allocation group slots required');
  keys(allocation.measuredAt, ['startedAt', 'completedAt'], 'measurement interval');
  for (const value of Object.values(allocation.measuredAt)) check(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'ISO measurement time required');
  const sizes = new Map();
  for (const slot of allocation.slots) {
    keys(slot, SLOT, 'allocation slot');
    const row = data.rows.find(r => identity(r) === identity(slot));
    check(row && slot.applicable === (row.arm !== 'ordinary') && slot.infrastructureOutcome === infra.has(signedId(row)) && typeof slot.coveredByReceipt === 'boolean', 'Allocation classification differs');
    enumValue(slot.measurementStatus, 'measurement status'); enumValue(slot.stability, 'stability');
    nullableNumber(slot.allocationSizeBytes, 'allocation bytes'); nullableNumber(slot.failureAllocationSizeBytes, 'failed allocation bytes'); files(slot.files, sizes);
    if (!slot.coveredByReceipt) check(slot.measurementStatus === 'not-covered-by-receipt' && slot.files.length === 0 && slot.allocationSizeBytes === null && slot.failureAllocationSizeBytes === null, 'Uncovered receipt slot must remain missing');
    if (slot.measurementStatus === 'measured') check(slot.applicable && !slot.infrastructureOutcome && slot.files.length > 0 && subtotal(slot.files) === slot.allocationSizeBytes, 'Measured allocation evidence/subtotal differs');
    else check(slot.allocationSizeBytes === null, 'Unmeasured successful allocation must remain null');
    if (slot.failureAllocationSizeBytes !== null) check(slot.infrastructureOutcome && slot.measurementStatus === 'failure-inventory-measured' && slot.files.length > 0 && subtotal(slot.files) === slot.failureAllocationSizeBytes, 'Failed allocation evidence differs');
  }
  unique(allocation.slots.map(identity), 'allocation slot');
  unique(allocation.failureInventories.map(e => JSON.stringify([e.id, e.formal, e.phase])), 'failed inventory');
  check(!allocation.failureInventories.length || allocation.hasFailureBuckets, 'Failed inventories require failure buckets');
  for (const inventory of allocation.failureInventories) {
    keys(inventory, ['id', 'formal', 'phase', 'metadataSha256', 'status', 'allocationSizeBytes', 'files'], 'failed inventory');
    const entry = infra.get(inventory.id), cost = entry?.costRefs.find(c => c.phase === inventory.phase && c.metadataSha256 === inventory.metadataSha256 && c.canonical === inventory.formal);
    check(cost && typeof inventory.formal === 'boolean', 'Failed inventory/cost binding differs');
    enumValue(inventory.status, 'failed inventory status'); nullableNumber(inventory.allocationSizeBytes, 'failed inventory bytes'); files(inventory.files, sizes);
    if (inventory.status === 'failure-inventory-measured') check(inventory.files.length > 0 && subtotal(inventory.files) === inventory.allocationSizeBytes, 'Failed inventory subtotal differs');
    else check(inventory.allocationSizeBytes === null, 'Unmeasured failure allocation must remain null');
    if (inventory.formal) {
      const row = data.rows.find(r => signedId(r) === inventory.id), slot = allocation.slots.find(s => identity(s) === identity(row));
      equal(inventory.status, slot.measurementStatus, 'Canonical failed allocation status'); equal(inventory.allocationSizeBytes, slot.failureAllocationSizeBytes, 'Canonical failed bytes'); equal(inventory.files, slot.files, 'Canonical failed files');
    }
  }
  if (allocation.hasFailureBuckets) for (const entry of data.infrastructure) check(allocation.failureInventories.filter(e => e.id === entry.id).length === entry.failedPreparationCount, 'Missing failed preparation inventory');
  return data;
}

function bucket(inventories) {
  const measured = inventories.filter(e => ['measured', 'failure-inventory-measured'].includes(e.measurementStatus ?? e.status));
  const identities = new Map(measured.flatMap(e => e.files.map(file => [file.identity, file.allocationSizeBytes])));
  const known = measured.length ? [...identities.values()].reduce((a, b) => a + b, 0) : null;
  return { inventories: inventories.length, measuredInventories: measured.length, gaps: inventories.length - measured.length,
    uniqueFileIds: identities.size, knownAllocationBytes: known, fullAllocationBytes: inventories.length && measured.length === inventories.length ? known : null };
}
function allocationStats(data) {
  const source = data.allocation;
  if (source.status === 'not-supplied') return { status: source.status, groups: [], buckets: null };
  const groups = [];
  for (const modelId of [...data.models.map(m => m.modelId)].sort()) for (const cohort of COHORTS) for (const split of SPLITS) for (const arm of ARMS) {
    const cells = source.slots.filter(s => s.modelId === modelId && s.cohort === cohort && s.split === split && s.arm === arm);
    const native = cells.filter(s => s.applicable), known = native.filter(s => isNumber(s.allocationSizeBytes));
    const ids = new Map(known.flatMap(s => s.files.map(f => [f.identity, f.allocationSizeBytes])));
    const knownTotal = known.length ? [...ids.values()].reduce((a, b) => a + b, 0) : null;
    const signed = native.filter(s => s.infrastructureOutcome).length;
    groups.push({ modelId, cohort, split, arm, applicable: arm !== 'ordinary', plannedNativeCells: native.length,
      signedInfrastructureNativeCells: signed, expectedSuccessfulNativeCells: native.length - signed, knownNativeCells: known.length,
      missingNativeCells: native.length - known.length, stableMeasuredCells: known.filter(s => s.stability === 'stable-two-samples').length,
      uniqueFileIds: ids.size, allocationSizeBytesUniqueFileIdsKnownTotal: knownTotal, allocationSizeBytesUniqueFileIds: native.length && known.length === native.length ? knownTotal : null });
  }
  // Fixed group denominators include all planned cells; receipt buckets retain their actual scope.
  const successful = source.slots.filter(s => s.coveredByReceipt && s.applicable && !s.infrastructureOutcome);
  return { status: source.status, groups: groups.map(g => pick(g, GROUP_FIELDS)), buckets: source.hasFailureBuckets ? {
    successfulFormal: bucket(successful), infrastructureFailureRetained: bucket(source.failureInventories), allRetained: bucket([...successful, ...source.failureInventories]) } : null };
}
export function recompute(data, core) {
  const signedRows = new Set(data.rows.filter(row => data.infrastructure.some(e => e.id === signedId(row))));
  const models = data.models.map(model => {
    const rows = data.rows.filter(row => row.modelId === model.modelId), panels = [];
    for (const cohort of COHORTS) for (const split of SPLITS) {
      const selected = rows.filter(row => row.cohort === cohort && row.split === split);
      panels.push({ cohort, split, primary: core.panel(selected, cohort, signedRows),
        excludingCli5698: cohort === 'context' ? core.panel(selected.filter(row => row.instanceId !== 'cli__cli-5698'), cohort, signedRows) : null,
        languages: Object.fromEntries([...new Set(selected.map(row => row.language))].sort().map(language => [language, core.panel(selected.filter(row => row.language === language), cohort, signedRows)])) });
    }
    return { ...model, panels };
  });
  const equalModelMacro = core.equalModelMacro(models);
  return { denominators: { suitePlannedCells: 288, suitePlannedNativeCells: 192, reportedCells: data.rows.length, models: 4, arms: 3, sourceTasksPerCohort: 12,
    sourceTasksBySplit: { pilot: 8, confirmation_holdout: 4 }, fullCellsPerCohortSplit: { pilot: 96, confirmation_holdout: 48 } },
    overallExecution: projectExecution(core.execution(data.rows, signedRows)), infrastructure: data.infrastructure,
    models: models.map(model => ({ ...pick(model, ['modelId', 'family', 'model']), panels: model.panels.map(p => ({ cohort: p.cohort, split: p.split,
      primary: projectPanel(p.primary), excludingCli5698: p.excludingCli5698 === null ? null : projectPanel(p.excludingCli5698),
      languages: Object.fromEntries(Object.entries(p.languages).map(([name, value]) => [name, projectPanel(value)])) })) })),
    equalModelMacro: projectMacro(equalModelMacro), allocation: allocationStats(data) };
}
export function verifyData(data, expected, core) { validateData(data); equal(recompute(data, core), expected, 'Accepted-report numeric projection differs'); }
