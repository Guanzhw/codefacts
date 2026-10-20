// The fixed benchmark's acquisition -> grader-input lineage, not an asset loader.
import path from 'node:path';
import { sha, bytes, objectHash, check, digest, pick, relative, token, acquisition } from './core.mjs';
export const MANIFEST_FIELDS = ['schemaVersion', 'dataset', 'instanceId', 'repo', 'baseCommit', 'archiveSha256', 'entries', 'digest'];
export const HELPER_ROLES = ['official.py', 'export-fixed-selection.py', 'prepare-context-bases.py'];
export const GOLD_REPRESENTATION = 'contextbench.Gold._data-canonical-json-v1';
export const SWE_REPRESENTATION = 'selected-SWE-JSONL-record-canonical-json-v1';
export function scoringManifest(raw) {
  check(Object.keys(raw).every(k => [...MANIFEST_FIELDS, 'sourceRepresentation'].includes(k)), 'Unexpected scoring manifest field');
  const result = pick(raw, MANIFEST_FIELDS);
  check(result.schemaVersion === 1 && result.dataset === 'contextbench' && digest(result.archiveSha256) && digest(result.digest), 'Context scoring manifest identity');
  token(result.instanceId); check(/^[a-f0-9]{40}$/.test(result.baseCommit), 'Manifest base commit required');
  check(Array.isArray(result.entries) && result.digest === objectHash(result.entries), 'Manifest entries digest differs');
  const paths = new Set();
  for (const e of result.entries) {
    relative(e.path); check(!paths.has(e.path), 'Duplicate source manifest path'); paths.add(e.path);
    check(Object.keys(e).every(k => ['path', 'bytes', 'sha256', 'mode', 'target'].includes(k)), 'Unexpected source entry field');
    check(Number.isSafeInteger(e.bytes) && e.bytes >= 0 && digest(e.sha256) && ['100644', '100755', '120000'].includes(e.mode), 'Source entry bytes/hash/mode');
    check((e.mode === '120000') === ('target' in e), 'Symlink mode/target differs');
    if ('target' in e) {
      check(typeof e.target === 'string' && !/^[\\/]|[\\:\x00]/.test(e.target), 'Unsafe symlink target');
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(e.path), e.target));
      check(resolved !== '..' && !resolved.startsWith('../') && sha(Buffer.from(e.target)) === e.sha256 && Buffer.byteLength(e.target) === e.bytes, 'Symlink target identity differs');
    }
  }
  return result;
}
export function datasetInput(raw, cohort, canonical, derivedSweSha256) {
  const r = pick(raw, ['canonicalSha256', 'canonicalFormat', 'graderSha256', 'graderFormat', 'recordRepresentation', 'recordSha256']);
  check(r.canonicalFormat === 'parquet' && r.canonicalSha256 === canonical.sha256 && digest(r.graderSha256) && digest(r.recordSha256), 'Canonical dataset/record pin differs');
  if (cohort === 'context') check(r.graderFormat === 'parquet' && r.graderSha256 === r.canonicalSha256 && r.recordRepresentation === GOLD_REPRESENTATION, 'Context official Parquet/Gold representation required');
  else check(r.graderFormat === 'jsonl' && r.graderSha256 === derivedSweSha256 && r.graderSha256 !== r.canonicalSha256 && r.recordRepresentation === SWE_REPRESENTATION, 'SWE canonical/derived/record lineage differs');
  return r;
}
export function runtimeRecipe(raw) {
  const r = pick(raw, ['cohort', 'pythonVersion', 'requirements', 'requirementsSha256', 'environmentPinsSha256', 'upstream', 'identity', 'packageArtifactHashes', 'historicalRootIdentity']);
  check(['context', 'swe'].includes(r.cohort) && /^3\.\d+\.\d+$/.test(r.pythonVersion), 'Runtime Python version required');
  check(typeof r.requirements === 'string' && sha(Buffer.from(r.requirements)) === r.requirementsSha256 && digest(r.environmentPinsSha256), 'Runtime requirements source pin differs');
  check(r.requirements.trim().split(/\r?\n/).every(l => /^[a-zA-Z0-9_.-]+==[a-zA-Z0-9_.+-]+$/.test(l)), 'Version-pinned requirements required');
  const url = new URL(r.upstream.repository); check(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && /^[a-f0-9]{40}$/.test(r.upstream.revision), 'Runtime upstream revision required');
  r.upstream = pick(r.upstream, ['repository', 'revision']);
  check(r.identity === 'version-pinned-reconstruction' && r.packageArtifactHashes === 'not-recorded' && r.historicalRootIdentity === 'unverified', 'Explicit runtime reconstruction provenance required');
  return r;
}
export function imageAcquisition(raw) {
  const r = pick(raw, ['instanceId', 'officialTag', 'indexDigest', 'platformManifestDigest', 'configDigest', 'platform', 'provenanceSha256']);
  token(r.instanceId); check(typeof r.officialTag === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_./:@-]+$/.test(r.officialTag), 'Official acquisition tag required');
  for (const k of ['indexDigest', 'platformManifestDigest', 'configDigest']) check(/^sha256:[a-f0-9]{64}$/.test(r[k]), 'Immutable image acquisition identity required');
  check(digest(r.provenanceSha256) && r.platform === 'linux/amd64', 'Image acquisition platform/provenance required');
  return { ...r, availability: 'metadata-only-layers-unverified', historicalCellBinding: 'not-established-by-acquisition' };
}
export function packageAssets(input, { read, put, frozenPins, selectionSha256 }) {
  check(input.schemaVersion === 1 && input.kind === 'fixed24-public-acquisition-bridge', 'Fixed acquisition bridge required');
  const selectionBytes = read(input.selection, 'bridge selection'), selection = JSON.parse(selectionBytes);
  check(input.selection.sha256 === selectionSha256, 'Bridge/frozen selection differs');
  const selectionRef = put(selectionBytes);
  const helpers = input.helpers.map(ref => {
    check(HELPER_ROLES.includes(ref.role) && frozenPins.has(ref.sha256), 'Helper role/historical freeze pin differs');
    return { ...put(read(ref, 'historical preparation helper'), 'py'), role: ref.role, originalSha256: ref.sha256 };
  });
  check(helpers.length === 3 && new Set(helpers.map(h => h.role)).size === 3, 'Three exact preparation helpers required');
  const runtimeRecipes = Object.fromEntries(['context', 'swe'].map(cohort => {
    const recipe = runtimeRecipe(JSON.parse(read(input.runtimeRecipes[cohort], 'runtime recipe')));
    check(recipe.cohort === cohort, 'Runtime recipe cohort differs');
    return [cohort, put(bytes(recipe))];
  }));
  const manifests = input.contextManifests.map(ref => {
    check(frozenPins.has(ref.original.sha256), 'Original scoring manifest absent from freeze');
    const manifest = scoringManifest(JSON.parse(read(ref.original, 'original scoring manifest'))), raw = bytes(manifest);
    check(sha(raw) === ref.publicSha256 && /^[a-f0-9]{40}$/.test(ref.gradingCommit), 'Public scoring manifest/commit pin differs');
    const selected = selection.selections.find(s => s.dataset === 'contextbench' && s.id === manifest.instanceId);
    check(selected?.repo === manifest.repo && selected.base_commit === manifest.baseCommit, 'Manifest/fixed selection differs');
    const archive = acquisition(ref.archive); check(archive.kind === 'source' && archive.sha256 === manifest.archiveSha256 && archive.revision === manifest.baseCommit, 'Canonical archive/manifest differs');
    return { instanceId: manifest.instanceId, originalSha256: ref.original.sha256, public: put(raw), projection: 'remove-sourceRepresentation-v1',
      archiveSha256: manifest.archiveSha256, archive, upstreamBaseCommit: manifest.baseCommit, gradingCommit: ref.gradingCommit };
  });
  check(manifests.length === 12 && new Set(manifests.map(m => m.instanceId)).size === 12, 'Twelve public Context scoring manifests required');
  const datasets = Object.fromEntries(['context', 'swe'].map(cohort => {
    const canonical = acquisition(input.datasets[cohort].canonical);
    const selected = selection.datasets.find(d => d.sha256 === canonical.sha256 && d.revision === canonical.revision && d.path === canonical.path);
    check(selected, 'Canonical dataset not in frozen selection');
    const value = { canonical, format: 'parquet' };
    if (cohort === 'swe') { check(digest(input.datasets.swe.derivedSha256) && input.datasets.swe.derivedSha256 !== canonical.sha256, 'Distinct derived SWE raw pin required'); value.derivedSha256 = input.datasets.swe.derivedSha256; }
    return [cohort, value];
  }));
  const images = JSON.parse(read(input.imageAcquisitions, 'image acquisition metadata')).map(imageAcquisition);
  check(images.length === 12 && new Set(images.map(i => i.instanceId)).size === 12, 'Twelve SWE image acquisition rows required');
  const notices = JSON.parse(read(input.attribution, 'source attribution'));
  const attribution = put(bytes({ notices: notices.notices.map(n => {
    check(['ContextBench-Apache-2.0', 'SWE-bench-MIT'].includes(n.kind) && digest(n.sourceSha256) && typeof n.text === 'string', 'Known attribution source required');
    return pick(n, ['kind', 'sourceSha256', 'text']);
  }), contextDatasetLicense: 'not-asserted-by-source-license', taskRepositoryNotices: 'retain-from-canonical-archives' }));
  const publicTasks = put(bytes(selection.selections.map(s => pick(s, ['dataset', 'id', 'repo', 'base_commit', 'language', 'split']))));
  return { schemaVersion: 1, kind: input.kind, selection: selectionRef, helpers, runtimeRecipes, manifests, datasets, images, attribution, publicTasks };
}
