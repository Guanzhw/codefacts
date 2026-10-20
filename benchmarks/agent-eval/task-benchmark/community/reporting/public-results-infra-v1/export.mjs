import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUITE, FRAMEWORK, PRODUCER_SHA256, FILES, RESOURCES, check, equal, pick, pinned, digest, jsonBytes, options, projectExpected, projectInfrastructure } from './common.mjs';
import { verifyData } from './statistics.mjs';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TOKENS = ['totalTokens', 'inputTokens', 'outputTokens', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

export function deriveCore(source) {
  check(digest(Buffer.from(source)) === PRODUCER_SHA256, 'Only independently reviewed aggregate source hash is supported');
  const slice = (start, end) => {
    const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
    check(from >= 0 && to > from && source.indexOf(start, from + start.length) < 0, 'Producer extraction anchors differ');
    return source.slice(from, to);
  };
  // Verbatim arithmetic, without IO, closure validation, or CLI. sha256 retains its builtin import.
  const arithmetic = slice('export const ARMS =', 'function check(condition, message)');
  const macro = slice('function macro(values)', 'const keyIdentity =');
  const equalModel = slice('  const equalModelMacro = models[0].panels.map', '  return { schemaVersion: 1, generatorVersion:');
  return `// Derived from aggregate.mjs ${PRODUCER_SHA256}; aggregate-core-v1.\nimport crypto from 'node:crypto';\n${arithmetic}${macro}export { execution };\nexport function equalModelMacro(models) {\n${equalModel}  return equalModelMacro;\n}\n`;
}
function rowProjection(row, modelId, campaignId, errorCategory) {
  return { modelId, campaignId, ...pick(row, ['slotId', 'taskId', 'instanceId', 'cohort', 'language', 'split', 'arm', 'status', 'outcome', 'receiptStatus', 'providerCallSucceeded', 'generationCutoff', 'usageAvailability', ...RESOURCES, 'nativeAdopted', 'gradeStatus', 'resolved']),
    knownUsageLowerBound: row.knownUsageLowerBound === null ? null : Object.fromEntries(TOKENS.map(key => [key, row.knownUsageLowerBound[key] ?? null])),
    metrics: row.metrics === null ? null : { localization: Object.fromEntries(['file', 'symbol', 'span', 'line'].map(level => [level, Object.fromEntries(['coverage', 'precision'].map(metric => [metric, row.metrics.localization?.[level]?.[metric] ?? null]))])) },
    error: errorCategory(row.error === null ? 'null' : String(row.error)) === 'null' ? null : errorCategory(String(row.error)) };
}
export function projectInputs(report, summary, selection) {
  check(report.schemaVersion === 1 && report.generatorVersion === '2.0.0-infra' && report.mode === 'full288' && report.suiteId === SUITE, 'Accepted full288 aggregate report required');
  check(report.denominators.reportedCells === 288 && report.denominators.suitePlannedCells === 288 && report.overallExecution.accountedClosed === 288 && report.overallExecution.unaccounted === 0, 'Accepted report is not closed full288');
  check(summary.schemaVersion === 1 && summary.suiteId === SUITE && summary.plannedAttempts === 288 && summary.plannedModels === 4 && summary.plannedCampaigns === 8, 'Matching full suite summary required');
  const errors = [...new Set(report.models.flatMap(m => m.rows.map(row => row.error === null ? 'null' : String(row.error))))].filter(e => e !== 'null').sort();
  check(errors.length <= 999, 'Public error category capacity exceeded');
  const errorMap = new Map([['null', 'null'], ...errors.map((raw, i) => [raw, `error-${String(i + 1).padStart(3, '0')}`])]);
  const errorCategory = raw => { check(errorMap.has(raw), 'Accepted error count has no row source'); return errorMap.get(raw); };
  const models = report.models.map(model => ({ modelId: model.modelId, family: model.family, model: pick(model.model, ['provider', 'id', 'reasoningEffort']) }));
  const rows = report.models.flatMap(model => {
    const source = summary.models.find(m => m.id === model.modelId);
    check(source, 'Accepted model absent from pinned summary'); equal(model.model, source.model, 'Report/summary model');
    const sourceRows = source.campaigns.flatMap(c => c.attempts);
    equal(model.rows, sourceRows, 'Report rows must be original pinned summary rows');
    return model.rows.map(row => {
      const campaign = source.campaigns.find(c => c.attempts.some(r => r.cohort === row.cohort && r.slotId === row.slotId && r.taskId === row.taskId && r.arm === row.arm));
      check(campaign, 'Missing source campaign'); return rowProjection(row, model.modelId, campaign.campaignId, errorCategory);
    });
  });
  const tasks = summary.models[0].campaigns.flatMap(c => c.attempts.filter(r => r.arm === 'ordinary')).map(row => {
    const dataset = row.cohort === 'context' ? 'contextbench' : 'swebench_multilingual';
    const matches = selection.selections.filter(s => s.dataset === dataset && s.id === row.instanceId);
    check(matches.length === 1, 'Pinned selection source task missing/duplicate');
    const s = matches[0]; check(s.language === row.language && s.split === row.split, 'Pinned task split/language differs');
    return { dataset, ...pick(row, ['taskId', 'instanceId', 'cohort', 'language', 'split']), ...pick(s, ['repo', 'base_commit']) };
  });
  check(selection.selections.length === 24, 'Exactly 24 pinned selections required');
  const infrastructure = projectInfrastructure(report);
  // A fresh opaque map spans every slot and every retained archive, preserving hardlink equality.
  const ids = new Map();
  const publicFiles = files => files.map(file => {
    check(typeof file.identity === 'string' && file.identity.length > 0, 'Private collector identity missing');
    if (!ids.has(file.identity)) ids.set(file.identity, `file-${String(ids.size + 1).padStart(6, '0')}`);
    return { identity: ids.get(file.identity), allocationSizeBytes: file.allocationSizeBytes };
  });
  const a = report.allocation;
  const allocation = a.status === 'not-supplied' ? { status: a.status, measuredAt: null, slots: [], failureInventories: [], hasFailureBuckets: false } : {
    status: a.status, measuredAt: pick(a.measuredAt, ['startedAt', 'completedAt']),
    slots: a.groups.flatMap(g => g.cells.map(cell => ({ ...pick(cell, ['modelId', 'cohort', 'split', 'taskId', 'arm', 'applicable', 'infrastructureOutcome', 'failureAllocationSizeBytes', 'measurementStatus', 'stability', 'allocationSizeBytes']),
      coveredByReceipt: a.receipt.slots.some(s => ['modelId', 'cohort', 'split', 'taskId', 'arm'].every(key => s[key] === cell[key])),
      files: publicFiles(['measured', 'failure-inventory-measured'].includes(cell.measurementStatus) ? cell.files : []) }))),
    failureInventories: (a.failureAllocation?.inventories ?? []).map(inventory => {
      const entry = infrastructure.find(e => e.id === inventory.id);
      check(entry, 'Unclassified failed allocation inventory');
      const cost = inventory.formal ? entry.costRefs.find(c => c.canonical) : entry.costRefs.find(c => c.phase === inventory.phase && c.metadataSha256.toLowerCase() === inventory.metadataSha256?.toLowerCase());
      check(cost, 'Failed inventory cost hash/phase not in accepted history');
      return { id: inventory.id, formal: inventory.formal, phase: cost.phase, metadataSha256: cost.metadataSha256,
        status: inventory.status, allocationSizeBytes: inventory.status === 'failure-inventory-measured' ? inventory.allocationSizeBytes : null,
        files: publicFiles(inventory.status === 'failure-inventory-measured' ? inventory.files : []) };
    }), hasFailureBuckets: a.failureAllocation !== null };
  const data = { schemaVersion: 1, suiteId: SUITE, models, tasks, rows, infrastructure, allocation };
  const expected = projectExpected(report, errorCategory);
  return { data, expected };
}
export async function exportPackage(args) {
  const reportBytes = pinned(args.report, args['report-sha256'], 'accepted report');
  const summaryBytes = pinned(args.summary, args['summary-sha256'], 'accepted summary');
  const selectionBytes = pinned(args.selection, args['selection-sha256'], 'fixed selection');
  const producerBytes = pinned(args.producer, args['producer-sha256'], 'accepted producer source');
  check(args['producer-sha256'] === PRODUCER_SHA256, 'Unsupported producer version/hash');
  const report = JSON.parse(reportBytes), summary = JSON.parse(summaryBytes), selection = JSON.parse(selectionBytes);
  check(report.input.sha256 === args['summary-sha256'], 'Accepted report input-summary raw hash differs');
  const coreSource = deriveCore(producerBytes.toString('utf8'));
  const core = await import(`data:text/javascript;base64,${Buffer.from(coreSource).toString('base64')}`);
  const { data, expected } = projectInputs(report, summary, selection);
  verifyData(data, expected, core); // Compare independently accepted aggregate values before any output write.
  const contents = { 'data.json': jsonBytes(data), 'expected.json': jsonBytes(expected), 'producer-core.mjs': coreSource };
  for (const name of ['common.mjs', 'statistics.mjs', 'verify.mjs', 'METHODS.md']) contents[name] = fs.readFileSync(path.join(ROOT, name));
  const manifest = { schemaVersion: 1, kind: 'accepted-results-arithmetic-projection', suiteId: SUITE,
    producer: { version: '2.0.0-infra', frameworkRevision: FRAMEWORK, aggregateSha256: PRODUCER_SHA256, coreDerivation: 'aggregate-core-v1' },
    sources: { acceptedReportSha256: args['report-sha256'], summarySha256: args['summary-sha256'], selectionSha256: args['selection-sha256'],
      closureSha256: report.rootClosure?.closureSha256 ?? null, approvedLedgerSha256: report.rootClosure?.approvedLedgerSha256 ?? null },
    files: Object.fromEntries(FILES.map(name => [name, digest(contents[name])])),
    scope: { plannedCells: 288, plannedNativeCells: 192, contextConfirmation: 'historically-observed-replication', sweConfirmation: 'confirmation', authority: 'existing-accepted-inputs-only', claim: 'public-arithmetic-reproduction' } };
  // Recheck only explicit immutable inputs; no discovery of campaign state or new authority.
  for (const name of ['report', 'summary', 'selection', 'producer']) pinned(args[name], args[`${name}-sha256`], name);
  const output = path.resolve(args.output);
  fs.mkdirSync(output); // Parent must exist. Exclusive output directory; never merge/overwrite.
  for (const name of FILES) fs.writeFileSync(path.join(output, name), contents[name], { flag: 'wx' });
  const bytes = jsonBytes(manifest); fs.writeFileSync(path.join(output, 'manifest.json'), bytes, { flag: 'wx' });
  return { output, manifestSha256: digest(bytes), plannedCells: 288, actualModelTerminal: expected.overallExecution.actualModelTerminal,
    signedInfrastructure: expected.overallExecution.signedInfrastructure, expectedSuccessfulNativeCells: 192 - data.infrastructure.length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = options(process.argv.slice(2), ['report', 'report-sha256', 'summary', 'summary-sha256', 'selection', 'selection-sha256', 'producer', 'producer-sha256', 'output']);
    console.log(JSON.stringify(await exportPackage(args), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
