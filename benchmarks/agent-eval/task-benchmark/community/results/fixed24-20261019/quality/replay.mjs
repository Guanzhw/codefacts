// Prepares existing official adapters and compares captured results. Never scores.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { bytes, sha, check, equal, report, verifyPackage } from './core.mjs';
const load = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function materializeAssets({ manifestPath, manifestSha256, output }) {
  verifyPackage(manifestPath, manifestSha256);
  const root = path.dirname(manifestPath), data = load(path.join(root, 'cells.json'));
  check(data.assetBridge, 'Public acquisition bridge absent');
  const assets = load(path.join(root, data.assetBridge.path));
  output = path.resolve(output); fs.mkdirSync(output); fs.mkdirSync(path.join(output, 'helpers'));
  const copy = (ref, filename) => fs.copyFileSync(path.join(root, ref.path), filename, fs.constants.COPYFILE_EXCL);
  for (const helper of assets.helpers) copy(helper, path.join(output, 'helpers', helper.role));
  copy(assets.selection, path.join(output, 'helpers/selection-fixed-24.json'));
  fs.copyFileSync(path.join(root, 'prepare-inputs.py'), path.join(output, 'prepare-inputs.py'), fs.constants.COPYFILE_EXCL);
  const publicTasks = load(path.join(root, assets.publicTasks.path));
  fs.writeFileSync(path.join(output, 'public-tasks.jsonl'), publicTasks.map(t => JSON.stringify(t)).join('\n') + '\n', { flag: 'wx' });
  for (const manifest of assets.manifests) {
    const dir = path.join(output, 'sources/contextbench', manifest.instanceId); fs.mkdirSync(dir, { recursive: true });
    copy(manifest.public, path.join(dir, 'manifest.json'));
  }
  const tasks = [...new Map(data.cells.map(c => [`${c.cohort}/${c.instanceId}`, { instanceId: c.instanceId, cohort: c.cohort, repo: c.task.repo,
    baseCommit: c.task.base_commit, baseline: c.baseline, datasetInput: c.datasetInput, scoringManifest: c.scoringManifest, imageAcquisition: c.imageAcquisition }])).values()];
  const runtimeRecipes = Object.fromEntries(Object.entries(assets.runtimeRecipes).map(([cohort, ref]) => [cohort, load(path.join(root, ref.path))]));
  fs.writeFileSync(path.join(output, 'bridge-plan.json'), bytes({ schemaVersion: 1, datasets: assets.datasets, runtimeRecipes, tasks }), { flag: 'wx' });
  return { status: 'materialized-not-executed', layout: output, plan: path.join(output, 'bridge-plan.json') };
}
function pythonCheck(mapping, layout, command, instanceId) {
  const args = ['-B', path.join(layout, 'prepare-inputs.py'), command, '--plan', path.join(layout, 'bridge-plan.json'), '--mapping', mapping.path];
  if (instanceId) args.push('--instance-id', instanceId);
  const result = spawnSync(mapping.python, args, { encoding: 'utf8', windowsHide: true });
  check(!result.error && result.status === 0, `Official input preparation rejected: ${command}`);
}
function selected(manifestPath, hash, cellId) {
  verifyPackage(manifestPath, hash);
  const root = path.dirname(manifestPath), data = load(path.join(root, 'cells.json'));
  const cell = data.cells.find(c => c.id === cellId); check(cell, 'Unknown cell');
  return { root, cell };
}
export function compareCaptured({ manifestPath, manifestSha256, cellId, observedGradeStatus, resultPath = null, environmentReceiptPath = null }) {
  const { root, cell } = selected(manifestPath, manifestSha256, cellId);
  equal(observedGradeStatus, cell.gradeStatus, 'Captured/replayed grade status differs');
  const environment = { historicalEnvironmentEquality: 'unverified', provenanceGaps: cell.provenanceGaps, currentEnvironmentVerification: 'receipt-not-provided' };
  if (environmentReceiptPath) {
    check(cell.cohort === 'swe', 'Image receipt applies to SWE');
    const r = load(environmentReceiptPath), a = cell.imageAcquisition;
    check(r.status === 'verified-current-local-image' && r.officialTag === a.officialTag && r.platformManifestDigest === a.platformManifestDigest && r.configDigest === a.configDigest &&
      r.localImageId === a.configDigest && r.tagImageId === a.configDigest && r.digestImageId === a.configDigest && r.platform === 'linux/amd64', 'Current replay environment receipt differs');
    check(['docker-sdk-read-only-inspect', 'injected-client-inspection-not-Docker-proof'].includes(r.evidence), 'Image receipt evidence required');
    environment.currentEnvironmentVerification = r.evidence === 'docker-sdk-read-only-inspect' ? 'verified-current-local-image' : 'synthetic-client-inspection-only';
    environment.environmentReceiptSha256 = sha(fs.readFileSync(environmentReceiptPath));
  }
  if (!cell.expected) {
    check(resultPath === null, 'Captured quality unavailable; no metric comparison possible');
    return { status: 'matched-captured-status-only', quality: null, gradeStatus: cell.gradeStatus, ...environment };
  }
  check(resultPath !== null, 'Replayed result required');
  equal(report(cell.cohort, load(resultPath), cell.instanceId), load(path.join(root, cell.expected.path)), 'Captured/replayed official result differs');
  return { status: 'matched-captured-official-result', gradeStatus: cell.gradeStatus, ...environment };
}
export function prepare({ manifestPath, manifestSha256, cellId, mappingPath, output }) {
  const { root, cell } = selected(manifestPath, manifestSha256, cellId), mapping = load(mappingPath);
  check(cell.gaps.length === 0, 'Cell quality replay unavailable; inspect explicit gaps');
  const required = ['officialRoot', 'datasetPath', 'python', 'assetLayout'];
  if (cell.cohort === 'context') required.push('repoRoot', 'repoCache');
  for (const key of required) check(typeof mapping[key] === 'string' && path.isAbsolute(mapping[key]), 'Operator absolute path mapping required');
  // External downloads/extraction are operator work. Verify every prerequisite blob
  // by content, with no network, Docker, model, or upstream invocation here.
  for (const prerequisite of cell.acquisitions) {
    const filename = mapping.assets?.[prerequisite.sha256];
    check(typeof filename === 'string' && sha(fs.readFileSync(filename)) === prerequisite.sha256, 'Acquired prerequisite checksum differs');
  }
  {
    const plan = load(path.join(mapping.assetLayout, 'bridge-plan.json'));
    const task = plan.tasks.find(t => t.cohort === cell.cohort && t.instanceId === cell.instanceId);
    equal(task, { instanceId: cell.instanceId, cohort: cell.cohort, repo: cell.task.repo, baseCommit: cell.task.base_commit, baseline: cell.baseline,
      datasetInput: cell.datasetInput, scoringManifest: cell.scoringManifest, imageAcquisition: cell.imageAcquisition }, 'Prepared layout/captured task lineage differs');
    // Bind the materialized static helper/manifest bytes back to this public package.
    const assets = load(path.join(root, 'assets.json'));
    equal(plan.datasets, assets.datasets, 'Prepared canonical dataset lineage differs');
    equal(plan.runtimeRecipes, Object.fromEntries(Object.entries(assets.runtimeRecipes).map(([c, ref]) => [c, load(path.join(root, ref.path))])), 'Prepared runtime recipes differ');
    for (const h of assets.helpers) check(sha(fs.readFileSync(path.join(mapping.assetLayout, 'helpers', h.role))) === h.sha256, 'Prepared helper checksum differs');
    check(sha(fs.readFileSync(path.join(mapping.assetLayout, 'helpers/selection-fixed-24.json'))) === assets.selection.sha256, 'Prepared selection checksum differs');
    check(sha(fs.readFileSync(path.join(mapping.assetLayout, 'prepare-inputs.py'))) === sha(fs.readFileSync(path.join(root, 'prepare-inputs.py'))), 'Preparation wrapper checksum differs');
    if (cell.cohort === 'context') {
      mapping.sourceManifestPath = path.join(mapping.assetLayout, 'sources/contextbench', cell.instanceId, 'manifest.json');
      check(sha(fs.readFileSync(mapping.sourceManifestPath)) === cell.scoringManifest.public.sha256, 'Public scoring manifest checksum differs');
    }
    const mapped = { ...mapping, cohort: cell.cohort, path: mappingPath };
    // Python checks require cohort in the private operator mapping, not a public path.
    check(mapping.cohort === cell.cohort, 'Operator mapping cohort differs');
    pythonCheck(mapped, mapping.assetLayout, 'verify-dataset', cell.instanceId);
    pythonCheck(mapped, mapping.assetLayout, 'verify-runtime');
    if (cell.cohort === 'context') pythonCheck(mapped, mapping.assetLayout, 'verify-base', cell.instanceId);
  }
  const predictions = load(path.join(root, cell.prediction.path));
  if (cell.cohort === 'context') predictions[0].repo_url = mapping.repoRoot;
  output = path.resolve(output); fs.mkdirSync(output);
  const predictionsPath = path.join(output, 'predictions.json'); fs.writeFileSync(predictionsPath, bytes(predictions), { flag: 'wx' });
  const adapter = cell.sources.find(s => s.role === 'official.py');
  fs.copyFileSync(path.join(root, adapter.path), path.join(output, 'official.py'), fs.constants.COPYFILE_EXCL);
  const normalizer = cell.sources.find(s => s.role === 'grade.mjs');
  fs.copyFileSync(path.join(root, normalizer.path), path.join(output, 'grade.mjs'), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(path.join(root, 'prepare-inputs.py'), path.join(output, 'prepare-inputs.py'), fs.constants.COPYFILE_EXCL);
  if (cell.cohort === 'swe') fs.writeFileSync(path.join(output, 'replay-image.json'), bytes(cell.imageAcquisition), { flag: 'wx' });
  const { timeoutMs, ...adapterOptions } = cell.gradingOptions;
  const config = { officialRoot: mapping.officialRoot, datasetPath: mapping.datasetPath, predictionsPath,
    outputDir: path.join(output, 'official-output'), runId: `quality-${sha(bytes([cellId, output])).slice(0, 24)}`, ...adapterOptions };
  if (cell.cohort === 'context') { config.repoCache = mapping.repoCache; config.sourceManifestPath = mapping.sourceManifestPath; }
  fs.writeFileSync(path.join(output, 'config.json'), bytes(config), { flag: 'wx' });
  fs.writeFileSync(path.join(output, 'run-options.json'), bytes({ kind: cell.cohort, python: mapping.python, instanceId: cell.instanceId, timeoutMs }), { flag: 'wx' });
  fs.writeFileSync(path.join(output, 'run.mjs'), `import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runOfficialGrade } from './grade.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const r = JSON.parse(fs.readFileSync(path.join(root, 'run-options.json')));
const configPath = path.join(root, 'config.json'), config = JSON.parse(fs.readFileSync(configPath));
if(r.kind==='swe') {
  const inspected=spawnSync(r.python,['-B',path.join(root,'prepare-inputs.py'),'verify-image','--image-spec',path.join(root,'replay-image.json'),'--receipt',path.join(root,'replay-environment.json')],{encoding:'utf8',windowsHide:true});
  if(inspected.error||inspected.status!==0) throw new Error('Current fixed-image inspection rejected; official grader was not started');
}
const grade = await runOfficialGrade({kind:r.kind,command:r.python,args:['-B',path.join(root,'official.py'),'--kind',r.kind,'--config',configPath],outputDir:config.outputDir,resultPath:path.join(config.outputDir,'result.json'),instanceId:r.instanceId,timeoutMs:r.timeoutMs});
console.log(JSON.stringify({status:grade.status,resolved:grade.resolved,historicalEnvironmentEquality:'unverified',currentEnvironmentReceipt:r.kind==='swe'?'replay-environment.json':null}));
`, { flag: 'wx' });
  return { status: 'prepared-not-executed', kind: cell.cohort, adapter: path.join(output, 'official.py'), config: path.join(output, 'config.json'),
    provenanceGaps: cell.provenanceGaps, historicalEnvironmentEquality: 'unverified',
    prerequisites: 'Operator binds extracted roots; SWE runner must inspect current tag/platform/config before grading. Historical equality remains unverified.' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, manifestPath, manifestSha256, cellId, arg, output, environmentReceiptPath] = process.argv.slice(2);
    check(path.isAbsolute(manifestPath), 'Absolute manifest path required');
    if (command === 'assets') console.log(JSON.stringify(materializeAssets({ manifestPath, manifestSha256, output: cellId }), null, 2));
    else if (command === 'prepare') console.log(JSON.stringify(prepare({ manifestPath, manifestSha256, cellId, mappingPath: arg, output }), null, 2));
    else if (command === 'compare') console.log(JSON.stringify(compareCaptured({ manifestPath, manifestSha256, cellId, observedGradeStatus: arg, resultPath: output ?? null, environmentReceiptPath: environmentReceiptPath ?? null }), null, 2));
    else throw new Error('Use assets MANIFEST SHA NEW-LAYOUT; prepare MANIFEST SHA CELL MAPPING NEW-OUTPUT; compare MANIFEST SHA CELL STATUS [RESULT]');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
