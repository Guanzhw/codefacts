// Tiny synthetic unit boundary only; no full288 fixture or real campaign IO.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { allocated, distribution, derive, render } from './appendix.mjs';
import { exportAppendix } from './export.mjs';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let checks = 0;
const eq = (actual, expected) => { assert.deepStrictEqual(actual, expected); checks++; };
const fails = (call, pattern) => { assert.throws(call, pattern); checks++; };
eq(distribution([null, 0, 10, 20]), { known: 3, missing: 1, median: 10, p95: 20, mean: 10 });
eq(distribution([0, 20]), { known: 2, missing: 0, median: 10, p95: 20, mean: 10 });
eq(distribution([null]), { known: 0, missing: 1, median: null, p95: null, mean: null });
const file = (identity, allocationSizeBytes) => ({ identity, allocationSizeBytes });
const shared = file('file-000001', 4096), zero = file('file-000002', 0), another = file('file-000003', 8192), failed = file('file-000004', 16384);
eq(allocated([{ measurementStatus: 'measured', files: [shared, shared] }, { status: 'missing', files: [] }]),
  { inventories: 2, known: 1, missing: 1, uniqueFileIds: 1, knownBytes: 4096, completeBytes: null });
eq(allocated([{ measurementStatus: 'measured', files: [zero] }]).knownBytes, 0);
const specs = [
  ['a', 't1', 'codefacts022', 'serial-original', 1, 0, 0, [shared, shared]],
  ['a', 't2', 'codefacts022', 'serial-original', 1, null, null, null],
  ['a', 't3', 'codefacts022', 'serial-original', 1, 20, 20, [zero]],
  ['a', 't1', 'codegraph', 'serial-original', 1, 10, 10, [shared]],
  ['b', 't1', 'codefacts022', 'serial-original', 1, 40, 40, [another]],
  ['a', 't4', 'codefacts022', 'parallel-new', 2, 80, 80, [another]],
  ['a', 't5', 'codefacts022', 'parallel-new', 1, 160, 160, [another]],
  ['a', 't1', 'ordinary', 'serial-original', 1, 0, 0, null],
  ['a', 't6', 'codegraph', 'serial-original', 1, null, null, null],
];
const rows = specs.map(([modelId, taskId, arm, conditionId, admittedConcurrency, cold, logical], i) => ({ modelId, taskId, instanceId: taskId, arm, campaignId: `${modelId}-context`, slotId: `slot-${i}`, cohort: 'context', split: 'pilot', indexDiskBytes: logical }));
const id = row => `${row.campaignId}/${row.slotId}`;
const failedId = id(rows.at(-1));
const costs = [2, 3, 5].map((slotWallMs, i) => ({ phase: `phase-${i}`, metadataSha256: String(i).repeat(64), canonical: i === 2, slotWallMs }));
const inventories = costs.map(cost => ({ id: failedId, formal: cost.canonical, phase: cost.phase, metadataSha256: cost.metadataSha256,
  status: 'failure-inventory-measured', allocationSizeBytes: 20480, files: [shared, failed] }));
const adapted = { schemaVersion: 1, kind: 'timing-regime-adapted-public-results', nonTimingData: { suiteId: 'synthetic-only', rows,
  infrastructure: [{ id: failedId, failedPreparationCount: 3, failedPreparationWallMs: 10, canonicalSlotWallMs: 5, archivedPreparationWallMs: 5, costRefs: costs }],
  allocation: { status: 'separate-collector-receipt-supplied', measuredAt: { startedAt: '2026-01-01', completedAt: '2026-01-02' }, failureInventories: inventories,
    slots: specs.map((spec, i) => ({ ...rows[i], applicable: spec[2] !== 'ordinary', infrastructureOutcome: i === specs.length - 1,
      measurementStatus: spec[7] ? 'measured' : 'missing', allocationSizeBytes: spec[7] ? [...new Map(spec[7].map(f => [f.identity, f.allocationSizeBytes])).values()].reduce((a, b) => a + b, 0) : null, files: spec[7] ?? [] })) } },
  timing: { rows: specs.map((spec, i) => ({ cellId: id(rows[i]), conditionId: spec[3], admittedConcurrency: spec[4], clocks: { indexDurationMs: spec[5] } })) } };
const before = JSON.stringify(adapted), report = derive(adapted);
eq(JSON.stringify(adapted), before);
eq(report.distinctSourceTasks, 6);
eq(report.panels.length, 6);
const cf = report.panels.find(p => p.modelId === 'a' && p.arm === 'codefacts022' && p.conditionId === 'serial-original');
eq(cf.coldIndexMs, { known: 2, missing: 1, median: 10, p95: 20, mean: 10 });
eq(cf.setupLogicalBytes, cf.coldIndexMs);
eq(cf.distinctSourceTasks, 3);
eq(cf.actualAllocatedBytes, { inventories: 3, known: 2, missing: 1, uniqueFileIds: 2, knownBytes: 4096, completeBytes: null });
eq(report.panels.filter(p => p.conditionId === 'parallel-new').map(p => p.admittedConcurrency).sort(), [1, 2]);
const cg = report.panels.find(p => p.arm === 'codegraph');
eq([cg.plannedCells, cg.expectedSuccessfulIndexCells, cg.signedPremodelCells, cg.coldIndexMs.known, cg.coldIndexMs.missing], [2, 1, 1, 1, 0]);
const ordinary = report.panels.find(p => p.arm === 'ordinary');
eq([ordinary.nativeIndexApplicable, ordinary.coldIndexMs, ordinary.setupLogicalBytes, ordinary.actualAllocatedBytes], [false, null, null, null]);
eq(report.retainedBuckets.successfulFormal.knownBytes, 12288);
eq(report.retainedBuckets.infrastructureFailureRetained.knownBytes, 20480);
eq(report.retainedBuckets.allRetained.knownBytes, 28672);
eq(report.retainedBuckets.allRetained.completeBytes, null);
eq(report.failures[0].costRefs.map(cost => cost.slotWallMs), [2, 3, 5]);
eq(report.failures[0].failedPreparationWallMs, 10);
eq(report.failures[0].retainedAllocation.knownBytes, 20480);
const missing = structuredClone(adapted);
missing.nonTimingData.allocation = { status: 'not-supplied', measuredAt: null, slots: [], failureInventories: [] };
const noReceipt = derive(missing);
eq([noReceipt.retainedBuckets.successfulFormal.known, noReceipt.retainedBuckets.successfulFormal.missing, noReceipt.retainedBuckets.successfulFormal.knownBytes], [0, 7, null]);
eq([noReceipt.retainedBuckets.infrastructureFailureRetained.known, noReceipt.retainedBuckets.infrastructureFailureRetained.missing, noReceipt.retainedBuckets.infrastructureFailureRetained.knownBytes], [0, 3, null]);
eq(render(report).includes('未清 OS cache'), true);
eq(render(report).includes('phase-2'), true);
const scratch = fs.mkdtempSync(path.join(ROOT, '.synthetic-'));
try {
  const publicDir = path.join(scratch, 'synthetic-public'), output = path.join(scratch, 'synthetic-appendix');
  fs.mkdirSync(publicDir);
  const input = path.join(publicDir, 'adapted.json'), bytes = Buffer.from(before);
  fs.writeFileSync(input, bytes);
  fails(() => exportAppendix({ input, sha256: '0'.repeat(64), output }), /SHA-256 mismatch/);
  const result = exportAppendix({ input, sha256: hash(bytes), output });
  eq(fs.readdirSync(output).sort(), ['APPENDIX.zh-CN.md', 'appendix.json']);
  eq(fs.readFileSync(input), bytes);
  eq(fs.readdirSync(publicDir), ['adapted.json']);
  eq(result.sourceSha256, hash(bytes));
  eq(JSON.parse(fs.readFileSync(path.join(output, 'appendix.json'))).panels, report.panels);
  eq(fs.readFileSync(path.join(output, 'APPENDIX.zh-CN.md'), 'utf8'), render(report));
  fails(() => exportAppendix({ input, sha256: hash(bytes), output }), /EEXIST/);
  fails(() => exportAppendix({ input, sha256: hash(bytes), output: publicDir }), /sibling directory/);
} finally {
  const resolved = path.resolve(scratch);
  assert.equal(path.dirname(resolved), path.resolve(ROOT));
  assert.ok(path.basename(resolved).startsWith('.synthetic-'));
  fs.rmSync(resolved, { recursive: true });
}
console.log(JSON.stringify({ status: 'passed', kind: 'tiny-synthetic-only', checks, sourceSha256: Object.fromEntries(['appendix.mjs', 'export.mjs', 'synthetic-tests.mjs', 'README.md'].map(name => [name, hash(fs.readFileSync(path.join(ROOT, name)))])), actualFull288Integration: 'pending' }, null, 2));
