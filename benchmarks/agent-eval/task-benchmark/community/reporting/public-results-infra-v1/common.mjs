import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

export const SUITE = 'community-four-family-fixed24-20261017-v1';
export const PRODUCER_SHA256 = '274b786d8cb7f1cb540ff7327daadd1e2dd7f5de11086ff79ad6d3e41b7fd1c7';
export const FRAMEWORK = 'ec1c7f7d788db8244388e200f5849de3b1564b21';
export const ARMS = ['ordinary', 'codefacts022', 'codegraph'];
export const RESOURCES = ['totalTokens', 'inputTokens', 'outputTokens', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'modelTurnMs', 'dshDurationMs', 'slotWallMs', 'preparationAndSandboxMs', 'sourcePreparationMs', 'indexDurationMs', 'gradeDurationMs', 'indexDiskBytes', 'nativeCalls', 'toolCalls', 'toolErrors'];
export const QUALITY = ['file', 'symbol', 'span', 'line'].flatMap(level => ['coverage', 'precision'].map(metric => `${level}.${metric}`));
export const COHORTS = ['context', 'swe'];
export const SPLITS = ['pilot', 'confirmation_holdout'];
export const FILES = ['data.json', 'expected.json', 'producer-core.mjs', 'common.mjs', 'statistics.mjs', 'verify.mjs', 'METHODS.md'];
export const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const check = (condition, message) => { if (!condition) throw new Error(message); };
export const equal = (actual, expected, label) => { try { assert.deepStrictEqual(actual, expected); } catch (error) { throw new Error(`${label}: ${error.message}`); } };
export const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
export const jsonBytes = value => JSON.stringify(value, null, 2) + '\n';
export const identity = row => JSON.stringify([row.modelId, row.cohort, row.split, row.taskId, row.arm]);
export const signedId = row => `${row.campaignId}/${row.slotId}`;
export const isNumber = value => typeof value === 'number' && Number.isFinite(value);
export const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function keys(value, names, label) {
  check(value && typeof value === 'object' && !Array.isArray(value), `${label}: object required`);
  equal(Object.keys(value).sort(), [...names].sort(), `${label}: unexpected/missing field`);
}
export function token(value, label) { check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value), `${label}: public token required`); }
export function enumValue(value, label) { check(value === null || typeof value === 'string' || typeof value === 'boolean', `${label}: public scalar enum required`); if (value !== null) token(String(value), label); }
export function nullableNumber(value, label) { check(value === null || isNumber(value) && value >= 0, `${label}: nonnegative finite number or null required`); }
export function bool(value, label) { check(value === null || typeof value === 'boolean', `${label}: boolean or null required`); }
export function pinned(file, sha256, label) {
  check(isDigest(sha256), `${label}: explicit raw SHA-256 required`);
  const bytes = fs.readFileSync(file);
  check(digest(bytes) === sha256, `${label}: SHA-256 mismatch`);
  return bytes;
}
export function options(argv, allowed) {
  check(argv.length % 2 === 0, 'Every option requires one value');
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].slice(2);
    check(argv[i].startsWith('--') && allowed.includes(name) && !(name in result), 'Unknown/duplicate option');
    result[name] = argv[i + 1];
  }
  for (const name of allowed) check(typeof result[name] === 'string' && result[name].length > 0, `Missing --${name}`);
  return result;
}
export function contained(root, name) {
  check(FILES.includes(name), `Unknown package file: ${name}`);
  const filename = path.join(root, name);
  check(fs.lstatSync(filename).isFile() && !fs.lstatSync(filename).isSymbolicLink(), `Regular package file required: ${name}`);
  return filename;
}

// Public expected values are projected from the accepted report, never recomputed here.
const AVAIL = ['total', 'knownTotal', 'known', 'missing', 'knownMean'];
const EXEC_NUM = ['planned', 'terminal', 'actualModelTerminal', 'signedInfrastructure', 'accountedClosed', 'unaccounted', 'attemptCompleted', 'taskFailed', 'infrastructureFailed', 'nonterminal'];
const COUNTS = ['statuses', 'outcomes', 'receiptStatuses', 'providerCallSucceeded', 'generationCutoff', 'gradeStatuses', 'usageAvailability'];
export const projectAvailability = value => pick(value, AVAIL);
export function projectExecution(value, errorKey = key => key) {
  return { ...pick(value, EXEC_NUM), ...Object.fromEntries(COUNTS.map(key => [key, { ...value[key] }])),
    errors: Object.fromEntries(Object.entries(value.errors).map(([key, count]) => [errorKey(key), count])) };
}
function projectArm(value, errorKey) {
  return { ...projectExecution(value, errorKey), resources: Object.fromEntries(RESOURCES.map(key => [key, projectAvailability(value.resources[key])])),
    quality: value.quality === null ? null : Object.fromEntries(QUALITY.map(key => [key, projectAvailability(value.quality[key])])),
    officialScored: value.officialScored, validContextMetrics: value.validContextMetrics === null ? null : pick(value.validContextMetrics, ['valid', 'all']),
    validLocalizationQuality: value.validLocalizationQuality === null ? null : pick(value.validLocalizationQuality, ['valid', 'all']),
    missingQualityByReason: { ...value.missingQualityByReason }, resolved: value.resolved === null ? null : pick(value.resolved, ['planned', 'knownTrue', 'knownFalse', 'unknown', 'rate', 'lowerBound', 'upperBound']),
    lowerBoundOnlyForNonExact: projectAvailability(value.lowerBoundOnlyForNonExact), nativeAdoption: pick(value.nativeAdoption, ['known', 'adopted']),
    toolErrorRate: pick(value.toolErrorRate, ['knownAttempts', 'plannedAttempts', 'errors', 'calls', 'rate']) };
}
function projectPair(value) {
  return { arm: value.arm, plannedTaskPairs: value.plannedTaskPairs,
    pairs: value.pairs.map(pair => ({ ...pick(pair, ['taskId', 'instanceId', 'ordinaryGrade', 'treatmentGrade', 'ordinaryStatus', 'treatmentStatus', 'ordinaryResolved', 'treatmentResolved']),
      resources: pick(pair.resources, RESOURCES), quality: pair.quality === null ? null : pick(pair.quality, QUALITY) })),
    correctness: value.correctness === null ? null : pick(value.correctness, [...AVAIL, 'plannedTaskPairs', 'gradedPairs', 'missingPairs', 'meanDifference', 'gained', 'lost', 'bothCorrect', 'bothIncorrect', 'lowerBound', 'upperBound']),
    resources: Object.fromEntries(RESOURCES.map(key => { const r = value.resources[key]; return [key, { ...projectAvailability(r), ordinary: projectAvailability(r.ordinary), treatment: projectAvailability(r.treatment), ratio: r.ratio, relativeChange: r.relativeChange }]; })),
    quality: value.quality === null ? null : Object.fromEntries(QUALITY.map(key => [key, projectAvailability(value.quality[key])])) };
}
export function projectPanel(value, errorKey = key => key) {
  return { ...pick(value, ['taskIds', 'sourceTaskCount', 'plannedCells']), arms: Object.fromEntries(ARMS.map(arm => [arm, projectArm(value.arms[arm], errorKey)])), paired: value.paired.map(projectPair) };
}
const macroValue = value => pick(value, ['mean', 'knownMean', 'plannedModels', 'knownModels', 'missingModels', 'missingModelIds']);
export function projectMacro(values) {
  return values.map(value => ({ cohort: value.cohort, split: value.split, paired: value.paired.map(pair => ({ arm: pair.arm,
    quality: value.cohort === 'context' ? Object.fromEntries(QUALITY.map(key => [key, macroValue(pair.quality[key])])) : macroValue(pair.quality),
    resourceRatios: Object.fromEntries(RESOURCES.map(key => [key, macroValue(pair.resourceRatios[key])])) })) }));
}
export const GROUP_FIELDS = ['modelId', 'cohort', 'split', 'arm', 'applicable', 'plannedNativeCells', 'signedInfrastructureNativeCells', 'expectedSuccessfulNativeCells', 'knownNativeCells', 'missingNativeCells', 'stableMeasuredCells', 'uniqueFileIds', 'allocationSizeBytesUniqueFileIdsKnownTotal', 'allocationSizeBytesUniqueFileIds'];
export const BUCKET_FIELDS = ['inventories', 'measuredInventories', 'gaps', 'uniqueFileIds', 'knownAllocationBytes', 'fullAllocationBytes'];
export function projectInfrastructure(report) {
  return (report.rootClosure?.signedInfrastructure ?? []).map(entry => ({
    ...pick(entry, ['id', 'metadataSha256', 'reason', 'failedPreparationCount', 'failedPreparationWallMs', 'canonicalSlotWallMs', 'archivedPreparationWallMs']),
    historyOverlap: 'includes-canonical-slot-wall', costRefs: entry.costRefs.map(cost => ({ ...pick(cost, ['phase', 'metadataSha256', 'slotWallMs']), canonical: cost.metadataSha256 === entry.metadataSha256 })) }));
}
export function projectExpected(report, errorKey = key => key) {
  return { denominators: pick(report.denominators, ['suitePlannedCells', 'suitePlannedNativeCells', 'reportedCells', 'models', 'arms', 'sourceTasksPerCohort', 'sourceTasksBySplit', 'fullCellsPerCohortSplit']),
    overallExecution: projectExecution(report.overallExecution, errorKey), infrastructure: projectInfrastructure(report),
    models: report.models.map(model => ({ modelId: model.modelId, family: model.family, model: pick(model.model, ['provider', 'id', 'reasoningEffort']), panels: model.panels.map(panel => ({ cohort: panel.cohort, split: panel.split,
      primary: projectPanel(panel.primary, errorKey), excludingCli5698: panel.excludingCli5698 === null ? null : projectPanel(panel.excludingCli5698, errorKey),
      languages: Object.fromEntries(Object.entries(panel.languages).map(([key, value]) => [key, projectPanel(value, errorKey)])) })) })),
    equalModelMacro: projectMacro(report.equalModelMacro),
    allocation: report.allocation.status === 'not-supplied' ? { status: 'not-supplied', groups: [], buckets: null } : {
      status: report.allocation.status, groups: report.allocation.groups.map(group => pick(group, GROUP_FIELDS)),
      buckets: report.allocation.failureAllocation === null ? null : Object.fromEntries(['successfulFormal', 'infrastructureFailureRetained', 'allRetained'].map(name => [name, pick(report.allocation.failureAllocation.buckets[name], BUCKET_FIELDS)])) } };
}
