// Staged source. Run actual inputs only after ROOT accepts closed full288 pins.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { projectInputs, deriveCore } from '../public-results-infra-v1/export.mjs';
import { verifyData } from '../public-results-infra-v1/statistics.mjs';
import { PRODUCER_SHA256 } from '../public-results-infra-v1/common.mjs';
import { sha, bytes, objectHash, check, equal, digest, pick, token, prediction, diagnostics, report, acquisition, image, verifyPackage } from './core.mjs';
import { packageAssets, datasetInput } from './assets.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const json = raw => JSON.parse(raw.toString('utf8'));
const id = row => `${row.campaignId}/${row.slotId}`;

export async function exportPackage({ approvalPath, approvalSha256, output }) {
  const readInputs = new Map();
  const read = (ref, label) => {
    check(ref && typeof ref.path === 'string' && digest(ref.sha256), `${label}: explicit raw pin required`);
    const raw = fs.readFileSync(ref.path); check(sha(raw) === ref.sha256, `${label}: SHA-256 mismatch`);
    readInputs.set(ref.path, ref.sha256); return raw;
  };
  const approval = json(read({ path: approvalPath, sha256: approvalSha256 }, 'ROOT approval'));
  check(approval.schemaVersion === 1 && approval.kind === 'closed-full288-quality-replay-approval' && approval.status === 'root-approved' && approval.approvedBy === 'root', 'Explicit ROOT full288 approval required');
  check(digest(approval.acceptedNumericManifestSha256), 'Accepted numeric bundle manifest pin required');
  const source = Object.fromEntries(['summary', 'report', 'selection', 'producer'].map(k => [k, read(approval.inputs[k], k)]));
  check(approval.inputs.producer.sha256 === PRODUCER_SHA256, 'Unsupported accepted aggregate producer');
  const accepted = json(source.report);
  check(accepted.input.sha256 === approval.inputs.summary.sha256, 'Report/summary pin differs');
  const core = await import(`data:text/javascript;base64,${Buffer.from(deriveCore(source.producer.toString('utf8'))).toString('base64')}`);
  const selection = json(source.selection);
  const { data, expected } = projectInputs(accepted, json(source.summary), selection);
  verifyData(data, expected, core); // Reuse accepted full288 membership and closure.
  check(Array.isArray(approval.cells) && approval.cells.length === 288 && new Set(approval.cells.map(c => c.id)).size === 288, 'Exactly 288 explicit cell bindings required');
  equal(approval.cells.map(c => c.id).sort(), data.rows.map(id).sort(), 'Cell binding membership differs');
  check(Array.isArray(approval.campaigns) && approval.campaigns.length === 8 && new Set(approval.campaigns.map(c => c.campaignId)).size === 8, 'Eight frozen campaign bindings required');
  // Existing audited metadata inventories may be split by cohort/phase. No tree IO.
  const audited = new Map();
  check(Array.isArray(approval.metadataAudits) && approval.metadataAudits.length > 0, 'Closed metadata audit pins required');
  for (const ref of approval.metadataAudits) {
    const audit = json(read(ref, 'closed metadata audit'));
    check(audit.status === 'metadata-audit-passed-awaiting-root-review' && audit.errors?.length === 0, 'Passing closed metadata audit required');
    for (const c of audit.cells) {
      const hash = audit.inputHashes[c.metaPath]; check(digest(hash), 'Audited metadata hash missing');
      if (audited.has(c.id)) equal(audited.get(c.id), { path: c.metaPath, sha256: hash }, 'Conflicting metadata audits');
      audited.set(c.id, { path: c.metaPath, sha256: hash });
    }
  }
  const contents = new Map();
  const put = (raw, ext = 'json') => {
    const hash = sha(raw), name = `artifacts/${hash}.${ext}`; contents.set(name, raw);
    return { path: name, sha256: hash };
  };
  const campaigns = new Map();
  for (const binding of approval.campaigns) {
    token(binding.campaignId);
    const frozen = json(read(binding.freeze, 'campaign freeze'));
    check(frozen.campaignId === binding.campaignId && Array.isArray(frozen.pins) && frozen.schedule.length === 36, 'Frozen campaign identity/schedule differs');
    check(frozen.manifestHash === objectHash(frozen.manifest), 'Frozen manifest hash differs');
    const sources = [];
    check(Array.isArray(binding.sources), 'Explicit frozen adapter source bindings required');
    for (const ref of binding.sources) {
      check(['official.py', 'grade.mjs', 'grade-campaign.mjs', 'trace.mjs', 'rpc.mjs'].includes(ref.role), 'Known grading source role required');
      check(frozen.pins.some(p => p.path === ref.path && p.sha256 === ref.sha256), 'Historical grading source absent from freeze');
      const artifact = put(read(ref, 'frozen adapter source'), ref.role.endsWith('.py') ? 'py' : 'mjs');
      sources.push({ ...artifact, role: ref.role });
    }
    check(new Set(sources.map(s => s.role)).size === sources.length, 'Duplicate grading source role');
    const upstream = (binding.upstream ?? []).map(acquisition);
    campaigns.set(binding.campaignId, { frozen, rawSha256: binding.freeze.sha256, sources, upstream });
  }
  check(selection.datasets?.length === 2 && selection.datasets.every(d => d.path.endsWith('.parquet')), 'Fixed24 canonical Parquet selection required');
  const assetBridge = packageAssets(json(read(approval.publicAssets, 'public asset lineage')), { read, put,
    frozenPins: new Set([...campaigns.values()].flatMap(c => c.frozen.pins.map(p => p.sha256))), selectionSha256: approval.inputs.selection.sha256 });
  check(approval.tasks.length === 24 && new Set(approval.tasks.map(t => `${t.cohort}/${t.taskId}`)).size === 24, '24 explicit replay task prerequisites required');
  const tasks = new Map(approval.tasks.map(t => [`${t.cohort}/${t.taskId}`, t]));
  const cells = data.rows.map(row => {
    const binding = approval.cells.find(c => c.id === id(row)), campaign = campaigns.get(row.campaignId);
    check(campaign, 'Missing frozen campaign');
    check(campaign.sources.find(s => s.role === 'official.py')?.sha256 === assetBridge.helpers.find(h => h.role === 'official.py').sha256, 'Historical adapter/preparation layout differs');
    const task = data.tasks.find(t => t.cohort === row.cohort && t.taskId === row.taskId), requirements = tasks.get(`${row.cohort}/${row.taskId}`);
    check(requirements, 'Missing task prerequisite binding');
    const acquisitions = (requirements.acquisitions ?? []).map(acquisition);
    const input = datasetInput(requirements.datasetInput, row.cohort, assetBridge.datasets[row.cohort].canonical, assetBridge.datasets.swe.derivedSha256);
    check(acquisitions.some(a => a.kind === 'dataset' && a.sha256 === input.canonicalSha256), 'Explicit canonical/grader-input lineage required');
    const scoringManifest = row.cohort === 'context' ? assetBridge?.manifests.find(m => m.instanceId === row.instanceId) ?? null : null;
    const runtime = assetBridge?.runtimeRecipes[row.cohort] ?? null;
    const acquiredImage = row.cohort === 'swe' ? assetBridge?.images.find(i => i.instanceId === row.instanceId) ?? null : null;
    const gaps = [], provenanceGaps = ['historical-runtime-root-identity-unverified'], hashes = {};
    const infra = data.infrastructure.find(c => c.id === id(row));
    if (infra) check(binding.meta?.sha256 === infra.metadataSha256, 'Signed infrastructure metadata hash differs');
    else equal(binding.meta, audited.get(id(row)), 'Cell metadata not bound by accepted closed audit');
    const meta = json(read(binding.meta, 'cell metadata'));
    check(meta.freezeHash === objectHash(campaign.frozen), 'Cell/freeze hash differs');
    const scheduled = campaign.frozen.schedule.find(s => s.id === row.slotId);
    equal(meta.slot, scheduled, 'Cell frozen schedule differs');
    check(meta.slot.taskId === row.taskId && meta.slot.arm === row.arm && meta.status === row.status && meta.grade?.status === row.gradeStatus &&
      ['cohort', 'taskId', 'split', 'language'].every(k => meta[k] === row[k]), 'Cell metadata identity/status differs');
    equal(meta.grade.resolved, row.resolved, 'Metadata/summary resolved differs');
    const grade = meta.grade;
    if (grade.provenance) check(grade.provenance.freezeHash === objectHash(campaign.frozen), 'Grade/freeze provenance differs');
    let predRef = null, diagRef = null, expectedRef = null, rawReportRef = null, declarationStatus = null;
    let rawPrediction = null, rawDiagnostics = null;
    if (binding.prediction) {
      const predBytes = read(binding.prediction, 'prediction'); hashes.prediction = sha(predBytes);
      const predictions = json(predBytes); check(Array.isArray(predictions) && predictions.length === 1, 'Single prediction required');
      rawPrediction = predictions[0];
      if (row.cohort === 'context') {
        check(binding.diagnostics, 'Context prediction diagnostics pin required');
        const diagBytes = read(binding.diagnostics, 'diagnostics'); hashes.diagnostics = sha(diagBytes); rawDiagnostics = json(diagBytes);
        const projected = diagnostics(rawDiagnostics); declarationStatus = projected.declarationStatus; diagRef = put(bytes(projected));
      }
      if (binding.prediction.binding === 'grade-input' || binding.prediction.binding === undefined) {
        check(grade.provenance?.inputHash === objectHash({ prediction: rawPrediction, diagnostics: rawDiagnostics, modelAttemptStatus: meta.status }), 'Prediction/diagnostics grading inputHash differs');
      } else check(binding.prediction.binding === 'root-accepted-artifact', 'Explicit accepted prediction binding required');
      predRef = put(bytes([prediction(row.cohort, rawPrediction, row.instanceId)]));
    } else {
      gaps.push('prediction-unavailable');
      if (binding.withheld?.predictionSha256) {
        check(digest(binding.withheld.predictionSha256) && binding.withheld.reason === 'root-withheld-sensitive-scoring-content', 'Withheld prediction checksum/reason required');
        hashes.prediction = binding.withheld.predictionSha256; gaps.push('root-withheld-sensitive-scoring-content');
      }
    }
    if (row.cohort === 'context' && declarationStatus !== 'valid') gaps.push(declarationStatus ?? 'declaration-status-unavailable');
    if (binding.report) {
      const raw = read(binding.report, 'official report'); hashes.report = sha(raw);
      if (grade.receipt?.resultSha256) check(hashes.report === grade.receipt.resultSha256, 'Official report receipt pin differs');
      else check(binding.report.binding === 'root-accepted-artifact', 'Official report needs receipt or explicit ROOT artifact binding');
      let parsed;
      try { parsed = json(raw); } catch { gaps.push('invalid-report-json'); }
      if (parsed) {
        let projection;
        try { projection = report(row.cohort, parsed, row.instanceId); } catch { gaps.push('invalid-official-report'); }
        if (projection) {
          expectedRef = put(bytes(projection));
          if (row.cohort === 'swe' && isDeepStrictEqual(parsed, projection)) rawReportRef = put(raw);
          else if (row.cohort === 'swe') gaps.push('raw-report-public-projection-required');
          if (row.cohort === 'swe' && row.gradeStatus === 'completed') equal(row.resolved, projection[row.instanceId].infra_failure === true ? null : projection[row.instanceId].resolved, 'Summary/report resolved differs');
          if (row.cohort === 'context' && row.gradeStatus === 'completed') {
            for (const level of ['file', 'symbol', 'span', 'line']) for (const metric of ['coverage', 'precision'])
              equal(row.metrics?.localization?.[level]?.[metric], projection.officialResult.final[level][metric], 'Summary/report localization differs');
          }
        }
      }
    } else {
      if (grade.receipt?.resultSha256) {
        check(binding.withheld?.reportSha256 === grade.receipt.resultSha256 && binding.withheld.reason === 'root-withheld-sensitive-scoring-content', 'Pinned historical report omitted');
        hashes.report = binding.withheld.reportSha256; gaps.push('root-withheld-sensitive-scoring-content');
      }
      gaps.push('official-report-unavailable');
    }
    if (row.gradeStatus !== 'completed') gaps.push(`captured-grade-${token(row.gradeStatus)}`);
    const roles = campaign.sources.map(s => s.role);
    if (!roles.includes('official.py')) gaps.push('frozen-official-adapter-unavailable');
    if (!roles.includes('grade.mjs')) gaps.push('frozen-grade-normalizer-unavailable');
    if (!campaign.upstream.some(a => a.kind === 'upstream-tree')) gaps.push('upstream-tree-acquisition-unavailable');
    if (!runtime) gaps.push('grading-runtime-recipe-unavailable');
    if (row.cohort === 'context' && (!acquisitions.some(a => a.kind === 'source') || !scoringManifest)) gaps.push('context-source-acquisition-unavailable');
    if (row.cohort === 'swe' && !acquiredImage) gaps.push('official-image-acquisition-unavailable');
    const provenance = { freezeSha256: campaign.rawSha256, freezeObjectHash: objectHash(campaign.frozen), metadataSha256: binding.meta.sha256,
      inputHash: grade.provenance?.inputHash ?? null, configHash: grade.provenance?.configHash ?? null, originalArtifactHashes: hashes };
    for (const hash of [provenance.inputHash, provenance.configHash]) check(hash === null || digest(hash), 'Grade provenance hash invalid');
    const baseline = pick(requirements.baseline ?? {}, ['policy', 'upstreamBaseCommit', 'gradingCommit', 'sourceManifestSha256', 'archiveSha256']);
    const policies = row.cohort === 'swe' ? ['official-prebuilt-image', 'unavailable'] : ['original-upstream-commit', 'archive-identical-synthetic-baseline', 'unavailable'];
    check(policies.includes(baseline.policy), 'Baseline policy not supported for cohort');
    if (baseline.policy === 'official-prebuilt-image') {
      check(baseline.upstreamBaseCommit === task.base_commit && baseline.gradingCommit === null &&
        !('sourceManifestSha256' in baseline) && !('archiveSha256' in baseline), 'SWE image baseline requires canonical base metadata and null gradingCommit');
    } else if (baseline.policy !== 'unavailable') {
      check(baseline.upstreamBaseCommit === task.base_commit && /^[a-f0-9]{40}$/.test(baseline.gradingCommit), 'Baseline source identity differs');
      check((baseline.policy === 'original-upstream-commit') === (baseline.gradingCommit === baseline.upstreamBaseCommit), 'Baseline policy/commit consistency differs');
      if (row.cohort === 'context' && rawPrediction) check(rawPrediction.commit === baseline.gradingCommit, 'Prediction grading commit differs');
      if (baseline.policy === 'archive-identical-synthetic-baseline') {
        check(digest(baseline.sourceManifestSha256) && digest(baseline.archiveSha256), 'Synthetic baseline manifest/archive pins required');
        check(acquisitions.some(a => a.kind === 'source' && a.sha256 === baseline.archiveSha256) && scoringManifest.originalSha256 === baseline.sourceManifestSha256 && scoringManifest.archiveSha256 === baseline.archiveSha256, 'Baseline/acquisition source pins differ');
      }
    } else gaps.push('grading-baseline-unavailable');
    if (scoringManifest) {
      check(scoringManifest.gradingCommit === baseline.gradingCommit && scoringManifest.upstreamBaseCommit === baseline.upstreamBaseCommit, 'Manifest/captured baseline commit differs');
      baseline.publicSourceManifestSha256 = scoringManifest.public.sha256;
    }
    let imageExecution = null;
    if (row.cohort === 'swe') {
      if (binding.imageExecution) {
        const ref = binding.imageExecution, execution = json(read(ref, 'historical per-cell image binding'));
        check(execution.id === id(row), 'Historical image/cell binding differs');
        imageExecution = { ...image(execution), provenanceSha256: ref.sha256 };
        check(acquiredImage && imageExecution.officialTag === acquiredImage.officialTag && imageExecution.registryManifestDigest === acquiredImage.platformManifestDigest && imageExecution.localImageId === acquiredImage.configDigest, 'Historical/acquired image identities differ');
      } else provenanceGaps.push('historical-cell-image-binding-unavailable');
    }
    const gradingOptions = pick(requirements.gradingOptions ?? {}, ['timeoutMs', 'timeoutSeconds', 'maxWorkers', 'openFileLimit', 'split', 'emptyPatchControl']);
    for (const key of ['timeoutMs', 'timeoutSeconds', 'maxWorkers', 'openFileLimit']) if (key in gradingOptions) check(Number.isSafeInteger(gradingOptions[key]) && gradingOptions[key] > 0, 'Positive grader setting required');
    if (!gradingOptions.timeoutMs) gaps.push('grader-timeout-unavailable');
    if ('split' in gradingOptions) token(gradingOptions.split);
    if ('emptyPatchControl' in gradingOptions) check(typeof gradingOptions.emptyPatchControl === 'boolean', 'Boolean empty-patch control required');
    return { ...pick(row, ['modelId', 'campaignId', 'slotId', 'taskId', 'instanceId', 'cohort', 'split', 'language', 'arm', 'status', 'gradeStatus', 'resolved']),
      id: id(row), task: pick(task, ['dataset', 'repo', 'base_commit']), declarationStatus, prediction: predRef, diagnostics: diagRef,
      expected: expectedRef, rawReport: rawReportRef, sources: campaign.sources, acquisitions: [...campaign.upstream, ...acquisitions],
      baseline, gradingOptions, provenance, gaps, provenanceGaps, historicalEnvironmentEquality: 'unverified', replayAvailability: gaps.length ? 'unavailable' : 'prerequisites-required',
      datasetInput: input, scoringManifest, runtimeRecipe: runtime, imageAcquisition: acquiredImage, imageExecution };
  });
  const publicData = { schemaVersion: 1, suiteId: data.suiteId, acceptedNumericManifestSha256: approval.acceptedNumericManifestSha256, cells,
    assetBridge: { path: 'assets.json', sha256: sha(bytes(assetBridge)) } };
  contents.set('assets.json', bytes(assetBridge));
  contents.set('cells.json', bytes(publicData));
  for (const name of ['core.mjs', 'verify.mjs', 'replay.mjs', 'recipe.md', 'assets.mjs', 'prepare-inputs.py']) contents.set(name, fs.readFileSync(path.join(HERE, name)));
  // Recheck every explicitly read byte before writing any deliverable.
  for (const [file, hash] of readInputs) check(sha(fs.readFileSync(file)) === hash, 'Approved input changed during export');
  const manifest = { schemaVersion: 1, kind: 'captured-quality-replay', suiteId: data.suiteId, rootApprovalSha256: approvalSha256,
    acceptedNumericManifestSha256: approval.acceptedNumericManifestSha256,
    inputs: Object.fromEntries(Object.entries(approval.inputs).map(([k, v]) => [k, v.sha256])),
    claim: 'captured-quality-artifacts-with-external-prerequisites-no-regrade-performed',
    files: Object.fromEntries([...contents].map(([name, raw]) => [name, sha(raw)])) };
  output = path.resolve(output); fs.mkdirSync(output); fs.mkdirSync(path.join(output, 'artifacts'));
  for (const [name, raw] of contents) fs.writeFileSync(path.join(output, name), raw, { flag: 'wx' });
  const manifestBytes = bytes(manifest); fs.writeFileSync(path.join(output, 'manifest.json'), manifestBytes, { flag: 'wx' });
  return { output, ...verifyPackage(path.join(output, 'manifest.json'), sha(manifestBytes)) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { check(process.argv.length === 5, 'Usage: node export.mjs ROOT-APPROVAL.json SHA256 NEW-OUTPUT');
    console.log(JSON.stringify(await exportPackage({ approvalPath: process.argv[2], approvalSha256: process.argv[3], output: process.argv[4] }), null, 2));
  } catch { console.error('Quality export rejected; inspect pinned inputs with the ROOT operator.'); process.exitCode = 1; }
}
