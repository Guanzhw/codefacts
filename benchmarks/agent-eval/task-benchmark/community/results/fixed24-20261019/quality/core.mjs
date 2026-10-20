import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

export const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const bytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export const objectHash = value => sha(JSON.stringify(value)); // community/rpc.mjs hash(object)
export const check = (ok, label) => { if (!ok) throw new Error(label); };
export const equal = (a, b, label) => { try { assert.deepStrictEqual(a, b); } catch { throw new Error(label); } };
export const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const pick = (value, names) => Object.fromEntries(names.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
export function token(value) { check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value), 'Public token required'); return value; }
export function relative(value) {
  check(typeof value === 'string' && value.length > 0 && !/[\\:\x00-\x1f]/.test(value) && !value.startsWith('/') &&
    value.split('/').every(p => p && !['.', '..', '.git'].includes(p)), 'Unsafe source-relative path');
  return value;
}
function region(value) {
  check(Array.isArray(value.files) && value.spans && typeof value.spans === 'object' && !Array.isArray(value.spans), 'Exploration region shape');
  value.files.forEach(relative);
  for (const [file, ranges] of Object.entries(value.spans)) {
    relative(file); check(Array.isArray(ranges), 'Span array required');
    for (const span of ranges) check(Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && span.start >= 1 && span.end >= span.start &&
      Object.keys(span).sort().join(',') === 'end,start', 'Inclusive source span required');
  }
  return { files: value.files, spans: value.spans };
}
export function prediction(cohort, raw, instanceId) {
  check(raw.instance_id === instanceId, 'Prediction instance differs');
  if (cohort === 'swe') {
    token(raw.model_name_or_path); check(typeof raw.model_patch === 'string', 'Patch string required');
    let inFileHeader = true;
    for (const line of raw.model_patch.split('\n')) {
      const diff = /^diff --git (\S+) (\S+)\r?$/.exec(line);
      if (diff) { relative(diff[1]); relative(diff[2]); inFileHeader = true; }
      if (line.startsWith('@@')) inFileHeader = false;
      const head = inFileHeader ? /^(?:---|\+\+\+) ([^\t\r]+)(?:\t.*)?\r?$/.exec(line) : null;
      if (head && head[1] !== '/dev/null') relative(head[1]);
    }
    return { instance_id: instanceId, model_name_or_path: raw.model_name_or_path, model_patch: raw.model_patch };
  }
  check(raw.model_patch === '' && /^[a-f0-9]{40}$/.test(raw.commit), 'Read-only Context prediction required');
  const t = raw.traj_data;
  check(t && Array.isArray(t.pred_steps), 'Context pred_steps required');
  const final = region({ files: t.pred_files, spans: t.pred_spans });
  return { instance_id: instanceId, repo_url: '__OPERATOR_REPO_ROOT__', commit: raw.commit, model_patch: '',
    traj_data: { pred_steps: t.pred_steps.map(region), pred_files: final.files, pred_spans: final.spans } };
}
const DECLARATIONS = ['valid', 'missing-final-declaration', 'invalid-final-json', 'invalid-final-schema', 'invalid-final-region'];
const REASONS = ['unresolved-source-file', 'source-line-mismatch-or-truncated', 'ambiguous-source-excerpt', 'unmatched-source-excerpt', 'unterminated-native-source-fence', 'missing-bridge-response', 'locator-only-no-visible-source', 'unrecognized-native-source-format', 'unsupported-tool-for-readonly-context'];
export function diagnostics(raw) {
  check(DECLARATIONS.includes(raw.declarationStatus), 'Unknown declaration status');
  const result = { declarationStatus: raw.declarationStatus };
  for (const k of ['requests', 'responses', 'failedResponses', 'locatorOnlyResponses']) {
    check(Number.isSafeInteger(raw[k]) && raw[k] >= 0, 'Declaration count required'); result[k] = raw[k];
  }
  result.unmappedByReason = {};
  for (const [key, value] of Object.entries(raw.unmappedByReason ?? {})) {
    check(REASONS.includes(key), 'Unknown declaration diagnostic reason');
    check(Number.isSafeInteger(value.count) && value.count >= 0 && Number.isSafeInteger(value.bytes) && value.bytes >= 0, 'Diagnostic counts required');
    result.unmappedByReason[key] = pick(value, ['count', 'bytes']);
  }
  return result;
}
function numericTree(raw) {
  if (raw === null || typeof raw === 'number' && Number.isFinite(raw)) return raw;
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'Official numeric metric tree required');
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [token(k), numericTree(v)]));
}
export function report(cohort, raw, instanceId) {
  if (cohort === 'context') {
    check(raw.kind === 'context' && raw.instance_id === instanceId && raw.officialResult?.instance_id === instanceId && !raw.officialResult.error, 'Context official identity');
    const official = raw.officialResult, trajectory = official.trajectory;
    check(Number.isSafeInteger(official.num_steps) && official.num_steps >= 0 && Array.isArray(trajectory?.steps) && official.num_steps === trajectory.steps.length, 'Context official step count required');
    const steps = trajectory.steps.map((value, index) => {
      check(value?.step === index + 1, 'Context official ordered step required');
      const coverage = Object.fromEntries(['file', 'symbol', 'span', 'line'].map(level => {
        const metric = value.coverage?.[level];
        check(typeof metric === 'number' && Number.isFinite(metric), 'Context official step coverage required');
        return [level, metric];
      }));
      return { step: value.step, coverage };
    });
    const result = { kind: 'context', instance_id: instanceId, officialResult: { instance_id: instanceId,
      num_steps: official.num_steps, final: numericTree(official.final), trajectory: { steps,
        auc_coverage: numericTree(trajectory.auc_coverage), redundancy: numericTree(trajectory.redundancy) } } };
    for (const level of ['file', 'symbol', 'span', 'line']) for (const metric of ['coverage', 'precision'])
      check(typeof result.officialResult.final[level]?.[metric] === 'number', 'Eight localization metrics required');
    check(result.officialResult.trajectory.auc_coverage && result.officialResult.trajectory.redundancy, 'Full trajectory metrics required');
    return result;
  }
  const r = raw[instanceId]; check(r && typeof r.resolved === 'boolean', 'SWE official resolved required');
  check(typeof r.patch_is_None === 'boolean', 'SWE patch_is_None boolean required');
  const result = pick(r, ['resolved', 'instance_id', 'infra_failure', 'patch_successfully_applied', 'patch_exists', 'patch_is_None']);
  if (result.instance_id !== undefined) check(result.instance_id === instanceId, 'SWE report instance differs');
  for (const key of ['infra_failure', 'patch_successfully_applied', 'patch_exists']) if (key in result) check(typeof result[key] === 'boolean', 'SWE boolean field required');
  if (r.tests_status !== undefined) {
    result.tests_status = {};
    for (const category of ['FAIL_TO_PASS', 'PASS_TO_PASS', 'FAIL_TO_FAIL', 'PASS_TO_FAIL']) if (r.tests_status[category] !== undefined) {
      const value = r.tests_status[category];
      check(['success', 'failure'].every(k => Array.isArray(value[k]) && value[k].every(x => typeof x === 'string')), 'Official test-name lists required');
      result.tests_status[category] = pick(value, ['success', 'failure']);
    }
  }
  return { [instanceId]: result };
}
export function acquisition(raw) {
  const result = pick(raw, ['kind', 'repository', 'revision', 'path', 'sha256']);
  check(['dataset', 'source', 'upstream-tree'].includes(result.kind), 'Known canonical acquisition kind required');
  const url = new URL(result.repository);
  check(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'Canonical credential-free HTTPS repository required');
  check(/^[a-f0-9]{40,64}$/.test(result.revision), 'Immutable acquisition revision required');
  relative(result.path); check(digest(result.sha256), 'Acquisition raw checksum required');
  return result;
}
export function image(raw) {
  if (raw === null) return null;
  const result = pick(raw, ['officialTag', 'registryManifestDigest', 'localImageId', 'modelImageId']);
  check(typeof result.officialTag === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_./:@-]+$/.test(result.officialTag), 'Official image tag required');
  for (const k of ['registryManifestDigest', 'localImageId', 'modelImageId']) check(result[k] === null || /^sha256:[a-f0-9]{64}$/.test(result[k]), 'Image identity or explicit null required');
  return { ...result, availability: 'external-prerequisite-unverified' };
}
export function verifyPackage(manifestPath, expectedHash) {
  const manifestBytes = fs.readFileSync(manifestPath);
  check(digest(expectedHash) && sha(manifestBytes) === expectedHash, 'Package manifest pin mismatch');
  const manifest = JSON.parse(manifestBytes), root = path.dirname(manifestPath);
  check(manifest.schemaVersion === 1 && manifest.kind === 'captured-quality-replay', 'Quality manifest required');
  for (const [name, expected] of Object.entries(manifest.files)) {
    relative(name); check(/^(?:[a-z][a-z.-]+|artifacts\/[a-f0-9]{64}\.(?:json|py|mjs|patch))$/.test(name), 'Unexpected package member');
    const filename = path.join(root, name), stat = fs.lstatSync(filename);
    check(stat.isFile() && !stat.isSymbolicLink() && digest(expected) && sha(fs.readFileSync(filename)) === expected, 'Package artifact pin mismatch');
  }
  for (const name of ['cells.json', 'core.mjs', 'verify.mjs', 'replay.mjs', 'RECIPE.md'.toLowerCase()]) check(name in manifest.files, 'Required package member missing');
  const artifactDir = path.join(root, 'artifacts'), artifactStat = fs.lstatSync(artifactDir);
  check(artifactStat.isDirectory() && !artifactStat.isSymbolicLink(), 'Regular artifact directory required');
  const actual = fs.readdirSync(root).filter(n => n !== 'artifacts' && n !== 'manifest.json').concat(fs.readdirSync(artifactDir).map(n => `artifacts/${n}`)).sort();
  equal(actual, Object.keys(manifest.files).sort(), 'Unexpected or missing package file');
  const data = JSON.parse(fs.readFileSync(path.join(root, 'cells.json')));
  check(data.cells.length === 288 && new Set(data.cells.map(c => c.id)).size === 288, 'Complete unique 288 cells required');
  const verifyRef = ref => { if (ref !== null) check(manifest.files[ref.path] === ref.sha256, 'Unbound cell artifact'); };
  check(data.assetBridge, 'Fixed24 public acquisition bridge required');
  {
    verifyRef(data.assetBridge);
    const assets = JSON.parse(fs.readFileSync(path.join(root, data.assetBridge.path)));
    [assets.selection, assets.publicTasks, assets.attribution, ...assets.helpers, ...Object.values(assets.runtimeRecipes), ...assets.manifests.map(m => m.public)].forEach(verifyRef);
    for (const name of ['assets.mjs', 'prepare-inputs.py']) check(name in manifest.files, 'Required acquisition helper missing');
  }
  for (const cell of data.cells) {
    for (const name of ['prediction', 'diagnostics', 'expected', 'rawReport']) verifyRef(cell[name]);
    cell.sources.forEach(verifyRef);
    check(Array.isArray(cell.provenanceGaps) && cell.historicalEnvironmentEquality === 'unverified', 'Explicit provenance limitations required');
    if (cell.scoringManifest) verifyRef(cell.scoringManifest.public);
    if (cell.runtimeRecipe) verifyRef(cell.runtimeRecipe);
    if (cell.prediction) prediction(cell.cohort, JSON.parse(fs.readFileSync(path.join(root, cell.prediction.path)))[0], cell.instanceId);
    if (cell.expected) report(cell.cohort, JSON.parse(fs.readFileSync(path.join(root, cell.expected.path))), cell.instanceId);
    check(cell.replayAvailability === (cell.gaps.length ? 'unavailable' : 'prerequisites-required'), 'Replay gap semantics differ');
  }
  return { status: 'passed', cells: data.cells.length, packageSha256: expectedHash, prerequisitesRequired: data.cells.filter(c => !c.gaps.length).length,
    unavailable: data.cells.filter(c => c.gaps.length).length, provenanceLimited: data.cells.filter(c => c.provenanceGaps.length).length };
}
