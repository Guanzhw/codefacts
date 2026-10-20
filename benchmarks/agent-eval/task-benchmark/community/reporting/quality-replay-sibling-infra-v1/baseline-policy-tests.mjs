// Targeted correction check. Reuses only the current sibling's synthetic inputs;
// does not rerun the general fixture suite or any official grader.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { exportPackage } from './export.mjs';
import { bytes, sha, objectHash, verifyPackage } from './core.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = process.argv[2] ?? process.env.QUALITY_BRIDGE_BASELINE_FIXTURE;
assert.ok(fixture && path.isAbsolute(fixture), 'Pass absolute fixture root from the migrated synthetic-tests.mjs result');
const manifestPath = path.join(fixture, 'package', 'manifest.json');
const originalManifestSha256 = JSON.parse(fs.readFileSync(path.join(fixture, 'VALIDATION.json'))).manifestSha256;
verifyPackage(manifestPath, originalManifestSha256);
const load = filename => JSON.parse(fs.readFileSync(filename));
const manifest = load(manifestPath), approvalPath = path.join(fixture, 'PRIVATE_FIXTURE', 'root-approval.json');
assert.equal(sha(fs.readFileSync(approvalPath)), manifest.rootApprovalSha256);
const original = load(approvalPath), root = fs.mkdtempSync(path.join(HERE, 'baseline-policy-run-'));
assert.ok(original.tasks.filter(t => t.cohort === 'swe').every(t => t.baseline.policy === 'official-prebuilt-image' && t.baseline.gradingCommit === null), 'Regenerate fixture with the current sibling synthetic-tests.mjs');
function write(name, value) {
  const raw = bytes(value), filename = path.join(root, name);
  fs.writeFileSync(filename, raw, { flag: 'wx' }); return { path: filename, sha256: sha(raw) };
}
function rebound(label, policy, gradingCommit, sourcePins) {
  const approval = structuredClone(original), task = approval.tasks.find(t => t.cohort === 'context');
  task.baseline = { policy, upstreamBaseCommit: '1'.repeat(40), gradingCommit };
  if (sourcePins) {
    task.baseline.archiveSha256 = task.acquisitions.find(a => a.kind === 'source').sha256;
  }
  const assetInput = load(approval.publicAssets.path);
  const instanceId = load(approval.cells.find(c => { const m = load(c.meta.path); return m.cohort === 'context' && m.taskId === task.taskId; }).prediction.path)[0].instance_id;
  const manifest = assetInput.contextManifests.find(m => load(m.original.path).instanceId === instanceId);
  manifest.gradingCommit = gradingCommit;
  if (sourcePins) task.baseline.sourceManifestSha256 = manifest.original.sha256;
  approval.publicAssets = write(`${label}-public-assets.json`, assetInput);
  const audit = load(approval.metadataAudits[0].path);
  let reboundCells = 0;
  for (const binding of approval.cells) {
    const meta = load(binding.meta.path);
    if (meta.cohort !== task.cohort || meta.taskId !== task.taskId) continue;
    const prediction = load(binding.prediction.path), diagnostics = load(binding.diagnostics.path);
    prediction[0].commit = gradingCommit;
    binding.prediction = write(`${label}-${++reboundCells}-prediction.json`, prediction);
    meta.grade.provenance.inputHash = objectHash({ prediction: prediction[0], diagnostics, modelAttemptStatus: meta.status });
    const oldPath = binding.meta.path;
    binding.meta = write(`${label}-${reboundCells}-meta.json`, meta);
    audit.cells.find(c => c.id === binding.id).metaPath = binding.meta.path;
    delete audit.inputHashes[oldPath]; audit.inputHashes[binding.meta.path] = binding.meta.sha256;
    assert.equal(sha(fs.readFileSync(binding.prediction.path)), binding.prediction.sha256);
    assert.equal(sha(fs.readFileSync(binding.meta.path)), audit.inputHashes[binding.meta.path]);
    assert.equal(load(binding.meta.path).grade.provenance.inputHash,
      objectHash({ prediction: load(binding.prediction.path)[0], diagnostics, modelAttemptStatus: meta.status }));
  }
  assert.equal(reboundCells, 12);
  approval.metadataAudits = [write(`${label}-audit.json`, audit)];
  const ref = write(`${label}-approval.json`, approval);
  return { approvalPath: ref.path, approvalSha256: ref.sha256, output: path.join(root, `${label}-package`), reboundCells, taskId: task.taskId };
}
const different = '2'.repeat(40), upstream = '1'.repeat(40), evidence = [];
const badOriginal = rebound('different-original', 'original-upstream-commit', different, false);
await assert.rejects(exportPackage(badOriginal), /^Error: Baseline policy\/commit consistency differs$/);
assert.equal(fs.existsSync(badOriginal.output), false);
evidence.push({ case: 'different-original-commit', reboundCells: 12, rejectedAt: 'Baseline policy/commit consistency differs', outputCreated: false });
for (const [label, policy, commit, sourcePins] of [
  ['equal-original', 'original-upstream-commit', upstream, false],
  ['different-synthetic', 'archive-identical-synthetic-baseline', different, true]
]) {
  const options = rebound(label, policy, commit, sourcePins), result = await exportPackage(options);
  const cells = load(path.join(result.output, 'cells.json')).cells.filter(c => c.cohort === 'context' && c.taskId === options.taskId);
  assert.equal(cells.length, 12); assert.ok(cells.every(c => c.gaps.length === 0));
  assert.ok(cells.every(c => c.baseline.policy === policy && c.baseline.gradingCommit === commit));
  if (sourcePins) assert.ok(cells.every(c => c.baseline.sourceManifestSha256 && c.baseline.archiveSha256));
  evidence.push({ case: label, reboundCells: 12, zeroGapCells: 12, status: 'passed', manifestSha256: result.packageSha256 });
}
const badSynthetic = rebound('equal-synthetic', 'archive-identical-synthetic-baseline', upstream, true);
await assert.rejects(exportPackage(badSynthetic), /^Error: Baseline policy\/commit consistency differs$/);
evidence.push({ case: 'equal-synthetic-commit', reboundCells: 12, rejectedAt: 'Baseline policy/commit consistency differs' });
const missingPins = rebound('missing-synthetic-pins', 'archive-identical-synthetic-baseline', different, false);
await assert.rejects(exportPackage(missingPins), /^Error: Synthetic baseline manifest\/archive pins required$/);
evidence.push({ case: 'different-synthetic-missing-source-pins', reboundCells: 12, rejectedAt: 'Synthetic baseline manifest/archive pins required' });
const contextImage = rebound('context-image-policy', 'official-prebuilt-image', different, true);
await assert.rejects(exportPackage(contextImage), /^Error: Baseline policy not supported for cohort$/);
assert.equal(fs.existsSync(contextImage.output), false);
evidence.push({ case: 'context-cannot-use-image-policy', reboundCells: 12, rejectedAt: 'Baseline policy not supported for cohort' });
function sweOptions(label, mutate) {
  const approval = structuredClone(original), task = approval.tasks.find(t => t.cohort === 'swe');
  task.baseline = { policy: 'official-prebuilt-image', upstreamBaseCommit: task.baseline.upstreamBaseCommit, gradingCommit: null };
  mutate(task.baseline);
  const ref = write(`${label}-approval.json`, approval);
  return { approvalPath: ref.path, approvalSha256: ref.sha256, output: path.join(root, `${label}-package`), taskId: task.taskId };
}
const imageOptions = sweOptions('swe-prebuilt-image', () => {}), imageResult = await exportPackage(imageOptions);
const imageCells = load(path.join(imageResult.output, 'cells.json')).cells.filter(c => c.cohort === 'swe' && c.taskId === imageOptions.taskId);
assert.equal(imageCells.length, 12); assert.ok(imageCells.some(c => c.gaps.length === 0));
assert.ok(imageCells.every(c => c.baseline.policy === 'official-prebuilt-image' && c.baseline.gradingCommit === null && c.imageAcquisition));
assert.ok(imageCells.every(c => c.imageExecution === null && c.provenanceGaps.includes('historical-cell-image-binding-unavailable') && c.historicalEnvironmentEquality === 'unverified'));
evidence.push({ case: 'swe-image-baseline-no-historical-head-claim', cells: 12, manifestSha256: imageResult.packageSha256 });
for (const [label, mutate, pattern] of [
  ['swe-fake-grading-commit', b => { b.gradingCommit = b.upstreamBaseCommit; }, /SWE image baseline requires canonical base metadata and null gradingCommit/],
  ['swe-missing-null', b => { delete b.gradingCommit; }, /SWE image baseline requires canonical base metadata and null gradingCommit/],
  ['swe-wrong-base', b => { b.upstreamBaseCommit = 'f'.repeat(40); }, /SWE image baseline requires canonical base metadata and null gradingCommit/],
  ['swe-context-source-claim', b => { b.sourceManifestSha256 = '3'.repeat(64); }, /SWE image baseline requires canonical base metadata and null gradingCommit/],
  ['swe-context-policy', b => { b.policy = 'original-upstream-commit'; b.gradingCommit = b.upstreamBaseCommit; }, /Baseline policy not supported for cohort/],
  ['swe-synthetic-policy', b => { b.policy = 'archive-identical-synthetic-baseline'; b.gradingCommit = different; }, /Baseline policy not supported for cohort/]
]) {
  const options = sweOptions(label, mutate);
  await assert.rejects(exportPackage(options), pattern); assert.equal(fs.existsSync(options.output), false);
  evidence.push({ case: label, rejectedAt: pattern.source, outputCreated: false });
}
verifyPackage(manifestPath, originalManifestSha256); // Historical evidence untouched.
const result = { status: 'passed', scope: 'targeted-synthetic-baseline-policy-only-no-corpus-no-official-grading', root,
  originalManifestSha256, exporterSha256: sha(fs.readFileSync(path.join(HERE, 'export.mjs'))), evidence };
fs.writeFileSync(path.join(root, 'VALIDATION.json'), bytes(result), { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
