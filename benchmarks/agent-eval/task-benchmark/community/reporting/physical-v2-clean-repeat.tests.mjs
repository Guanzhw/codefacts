// Synthetic-only reporting contract checks. Prepared for independent review;
// execute only after ROOT authorizes behavior tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as producer from './final-aggregate-generator-infra-v2/aggregate.mjs';
import { fixture } from './public-results-infra-v1/synthetic-fixture.mjs';
import { digest, jsonBytes, PRODUCER_SHA256 } from './public-results-infra-v1/common.mjs';
import { deriveCore, exportPackage } from './public-results-infra-v1/export.mjs';
import { verifyPackage } from './public-results-infra-v1/verify.mjs';

assert.equal(process.argv.length, 4, 'Use --work-dir with a fresh synthetic output directory');
assert.equal(process.argv[2], '--work-dir');
const work = path.resolve(process.argv[3]);
fs.mkdirSync(work); // Exclusive: fixture evidence is retained and never overwritten.
const tests = [];
const pass = name => tests.push({ name, status: 'passed' });
const clone = value => structuredClone(value);
let signedInput;
const signed = fixture({ buildReport(summary, options) {
  signedInput = { summary: clone(summary), options: clone(options) };
  return producer.buildReport(summary, options);
} });
assert.equal(signed.report.overallExecution.signedInfrastructure, 1);
assert.equal(signed.report.overallExecution.actualModelTerminal, 287);
pass('historical signed v2 accepts its exact ROOT closure and ledger');

function reject(name, input, pattern) {
  assert.throws(() => producer.buildReport(input.summary, input.options), pattern);
  pass(name);
}
const noSignedClosure = clone(signedInput);
noSignedClosure.options.closure = null;
reject('signed infrastructure still requires a ROOT closure', noSignedClosure, /requires every selected cell terminal/);
const signedWrongLedger = clone(signedInput);
signedWrongLedger.options.allocationReceipt.receipt.rootApprovedLedger.sha256 = '0'.repeat(64);
reject('signed v2 rejects the wrong receipt ledger binding', signedWrongLedger, /matching ROOT-approved ledger binding/);
const signedWrongRawLedger = clone(signedInput);
signedWrongRawLedger.options.closure.ledgerBytes = Buffer.from('{}');
reject('signed v2 rejects the wrong pinned raw ledger', signedWrongRawLedger, /approved ledger raw SHA-256 mismatch/);

function buckets(raw) {
  const bucket = entries => {
    const measured = entries.filter(e => ['measured', 'failure-inventory-measured'].includes(e.measurementStatus ?? e.status));
    const sizes = new Map(measured.flatMap(e => e.files.map(f => [f.identity, f.allocationSizeBytes])));
    const known = measured.length ? [...sizes.values()].reduce((sum, size) => sum + size, 0) : null;
    return { inventories: entries.length, measuredInventories: measured.length, gaps: entries.length - measured.length,
      uniqueFileIds: sizes.size, knownAllocationBytes: known, fullAllocationBytes: entries.length && measured.length === entries.length ? known : null };
  };
  const successful = raw.slots.filter(s => s.applicable && !s.infrastructureOutcome);
  raw.allocationBuckets = { successfulFormal: bucket(successful), infrastructureFailureRetained: bucket(raw.failureInventories), allRetained: bucket([...successful, ...raw.failureInventories]) };
  const b = raw.allocationBuckets.successfulFormal;
  raw.totals = { applicableSlots: successful.length, measuredSlots: b.measuredInventories, uniqueFileIds: b.uniqueFileIds, allocationSizeBytesUniqueFileIdsKnownTotal: b.knownAllocationBytes };
}

const clean = clone(signedInput);
const campaign = clean.summary.models[0].campaigns[0];
const formerInfra = campaign.attempts.find(r => r.status === 'infrastructure-failed');
const taskIdentity = Object.fromEntries(['slotId', 'taskId', 'instanceId', 'cohort', 'split', 'language', 'arm'].map(key => [key, formerInfra[key]]));
Object.assign(formerInfra, clone(campaign.attempts.find(r => r.status === 'attempt-completed' && r.gradeStatus === 'completed' && r.arm === formerInfra.arm)), taskIdentity);
const raw = clean.options.allocationReceipt.receipt;
const formerInfraSlot = raw.slots.find(s => s.infrastructureOutcome);
Object.assign(formerInfraSlot, { infrastructureOutcome: false, outcomeBucket: 'successful-formal-index', measurementStatus: 'measured',
  stability: 'stable-two-samples', allocationSizeBytes: 4096, files: [{ identity: 'clean-restored-native', allocationSizeBytes: 4096, path: '/PRIVATE_FIXTURE/clean/index.sqlite' }] });
raw.rootApprovedLedger = null;
raw.expectedSuccessfulNativeSlots = 192;
raw.failureInventories = [];
buckets(raw);
clean.options.closure = null;
clean.options.inputSha256 = digest(jsonBytes(clean.summary));
clean.options.allocationReceipt.sha256 = digest(jsonBytes(raw));
const cleanReport = producer.buildReport(clean.summary, clean.options);
assert.equal(cleanReport.rootClosure, null);
assert.equal(cleanReport.overallExecution.actualModelTerminal, 288);
assert.equal(cleanReport.overallExecution.signedInfrastructure, 0);
assert.equal(cleanReport.allocation.receipt.schemaVersion, 2);
assert.equal(cleanReport.allocation.receipt.rootApprovedLedger, null);
assert.equal(cleanReport.allocation.receipt.expectedSuccessfulNativeSlots, 192);
assert.equal(cleanReport.allocation.failureAllocation.buckets.infrastructureFailureRetained.inventories, 0);
pass('clean v2 with explicit null ledger accepts all 288 model-terminal cells and 192 expected native cells');

for (const [name, mutate, pattern] of [
  ['clean v2 rejects a non-null ledger', i => { i.options.allocationReceipt.receipt.rootApprovedLedger = { sha256: '0'.repeat(64) }; }, /matching ROOT-approved ledger binding/],
  ['clean v2 requires an explicit null ledger', i => { delete i.options.allocationReceipt.receipt.rootApprovedLedger; }, /matching ROOT-approved ledger binding/],
  ['clean v2 rejects unsigned infrastructure', i => { i.options.allocationReceipt.receipt.slots[0].infrastructureOutcome = true; }, /infrastructure classification differs/],
  ['clean v2 rejects any unsigned failure inventory', i => { i.options.allocationReceipt.receipt.failureInventories.push(clone(signedInput.options.allocationReceipt.receipt.failureInventories[0])); }, /Unsigned failure inventory/],
  ['clean v2 rejects an incorrect expected native count', i => { i.options.allocationReceipt.receipt.expectedSuccessfulNativeSlots = 191; }, /denominator mismatch/],
  ['clean v2 rejects a structural slot identity mismatch', i => { i.options.allocationReceipt.receipt.slots[0].slotId = 'unknown-slot'; }, /structural campaign\/slot identity differs/],
  ['clean v2 rejects an incorrect allocation bucket', i => { i.options.allocationReceipt.receipt.allocationBuckets.successfulFormal.knownAllocationBytes++; }, /subtotal mismatch/],
  ['clean v2 rejects conflicting file identities', i => {
    const measured = i.options.allocationReceipt.receipt.slots.filter(s => s.measurementStatus === 'measured');
    measured[1].files = [{ ...measured[1].files[0], identity: measured[0].files[0].identity, allocationSizeBytes: measured[0].files[0].allocationSizeBytes + 4096 }];
    measured[1].allocationSizeBytes = measured[1].files[0].allocationSizeBytes;
  }, /Conflicting allocation for same collector file identity/],
]) {
  const input = clone(clean); mutate(input); reject(name, input, pattern);
}

const contextPilot = cleanReport.models[0].panels.find(p => p.cohort === 'context' && p.split === 'pilot');
assert.equal(contextPilot.primary.arms.ordinary.resources.totalTokens.total, null);
assert.equal(contextPilot.primary.arms.ordinary.resources.totalTokens.missing, 1);
const swePilot = cleanReport.models[0].panels.find(p => p.cohort === 'swe' && p.split === 'pilot');
assert.equal(swePilot.primary.arms.codegraph.resolved.rate, null);
assert.equal(swePilot.primary.arms.codegraph.resolved.unknown, 1);
assert.equal(swePilot.primary.paired.find(p => p.arm === 'codegraph').correctness.meanDifference, null);
assert.equal(cleanReport.allocation.failureAllocation.buckets.successfulFormal.fullAllocationBytes, null);
pass('primary exact-total, SWE rate, paired-delta, and incomplete physical-allocation null policies persist');

const producerPath = fileURLToPath(new URL('./final-aggregate-generator-infra-v2/aggregate.mjs', import.meta.url));
const producerBytes = fs.readFileSync(producerPath);
assert.equal(digest(producerBytes), PRODUCER_SHA256);
deriveCore(producerBytes.toString('utf8'));
pass('candidate producer raw hash is accepted by the actual core derivation');

async function roundTrip(name, report, summary, selection) {
  const paths = {};
  for (const [key, value] of Object.entries({ report, summary, selection })) {
    const file = path.join(work, `${name}-${key}.json`), bytes = jsonBytes(value);
    fs.writeFileSync(file, bytes, { flag: 'wx' }); paths[key] = file; paths[`${key}-sha256`] = digest(bytes);
  }
  const output = path.join(work, `${name}-package`);
  const exported = await exportPackage({ ...paths, producer: producerPath, 'producer-sha256': PRODUCER_SHA256, output });
  const verified = await verifyPackage(path.join(output, 'manifest.json'), exported.manifestSha256);
  assert.equal(verified.status, 'passed');
  assert.equal(verified.signedInfrastructure, name === 'clean' ? 0 : 1);
  assert.equal(verified.expectedSuccessfulNativeCells, name === 'clean' ? 192 : 191);
  pass(`${name} v2 actual exportPackage/verifyPackage round trip`);
}
await roundTrip('clean', cleanReport, clean.summary, signed.selection);
await roundTrip('signed', signed.report, signedInput.summary, signed.selection);
const receipt = { status: 'passed', syntheticOnly: true, producerSha256: PRODUCER_SHA256, tests };
fs.writeFileSync(path.join(work, 'fixture-test-receipt.json'), jsonBytes(receipt), { flag: 'wx' });
console.log(JSON.stringify(receipt, null, 2));
