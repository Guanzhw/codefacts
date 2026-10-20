import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { S, SUITE, read, hash, sha, loadContext, validateKnown, auditAccounted, snapshotProduced, checkPrior, requirePilot } from '../accounted-suite-controller-v1/controller.mjs';
import { runtime, withConfig, assertConfigIdentity, CONFIG_MODULE } from '../config.mjs';
const { config: CONFIG, identity: CONFIG_IDENTITY, configPath: CONFIG_PATH, args: ARGS } = runtime();
const { verifySuite, auditProducedCells, acceptedGrade, terminal } = await import(pathToFileURL(ensureSidecar()).href);
import { transform, ORIGINAL, ensureSidecar } from '../accounted-suite-controller-v1/build-sidecar.mjs';
import { selectWave, drainWave } from './scheduler.mjs';
import { startWorker } from './worker-process.mjs';

const SELF = fileURLToPath(import.meta.url), HERE = path.dirname(SELF);
const LEGACY = path.resolve(HERE, '../accounted-suite-controller-v1');
const FRAMEWORK = CONFIG.frameworkDir;
const GUARD = CONFIG.guardModule;
const GIB = 1024n ** 3n;
const equal = (a, b) => hash(a) === hash(b);
const absolute = value => { if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Absolute path required'); return value; };
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const cellMeta = (context, cell) => path.join(context.loaded.get(cell.campaignId).evidenceDir, 'attempts', cell.slotId, 'slot-meta.json');
const selectedFor = (context, cohort, split) => context.frozen.schedule.filter(cell => cell.cohort === cohort && cell.split === split);

export function artifactHashes() {
  const sidecar = path.join(CONFIG.sidecarBuildDir, 'suite-exposed.mjs');
  if (fs.readFileSync(sidecar, 'utf8') !== transform(fs.readFileSync(ORIGINAL, 'utf8')).output) throw new Error('Reviewed mechanical sidecar differs');
  return { configModuleSha256: sha(CONFIG_MODULE), configSha256: sha(CONFIG_PATH), controllerSha256: sha(SELF), schedulerSha256: sha(path.join(HERE, 'scheduler.mjs')), workerProcessSha256: sha(path.join(HERE, 'worker-process.mjs')),
    legacyControllerSha256: sha(path.join(LEGACY, 'controller.mjs')), sidecarSha256: sha(sidecar),
    generatorSha256: sha(path.join(LEGACY, 'build-sidecar.mjs')), transformReceiptSha256: sha(path.join(CONFIG.sidecarBuildDir, 'sidecar-transform.json')),
    originalSuiteSha256: sha(ORIGINAL), phaseRunnerSha256: sha(GUARD) };
}

function validatePhase(cohort, split) {
  if (cohort !== 'swe' || !['pilot', 'confirmation_holdout'].includes(split)) throw new Error('Reviewed parallel scope is SWE pilot or confirmation_holdout');
}

function auditBoundary(context, ledger, decision, prior = []) {
  checkPrior(prior);
  const { known, produced } = auditAccounted(context, ledger);
  if (decision.split === 'confirmation_holdout') requirePilot(context, produced, decision.cohort, read(absolute(decision.pilotReviewPath)));
  const accountedIds = [...known, ...produced.map(row => row.id)], accounted = new Set(accountedIds);
  if (decision.cohort === 'swe' && context.frozen.schedule.some(cell => cell.cohort === 'context' && !accounted.has(cell.id))) throw new Error('Context phase not fully accounted');
  const selected = selectedFor(context, decision.cohort, decision.split);
  return { schemaVersion: 2, modelTerminalIds: produced.map(row => row.id), knownInfraIds: [...known], accountedIds,
    selectedCellIds: selected.map(cell => cell.id), nextCellId: selected.find(cell => !accounted.has(cell.id))?.id ?? null,
    snapshot: snapshotProduced(context, produced),
    counts: { planned: context.frozen.schedule.length, modelTerminal: produced.length, signedPreparationFailures: known.size,
      unvisited: context.frozen.schedule.length - accounted.size },
    selected: { planned: selected.length, modelTerminal: selected.filter(cell => produced.some(row => row.id === cell.id)).length,
      signedPreparationFailures: selected.filter(cell => known.has(cell.id)).length, unvisited: selected.filter(cell => !accounted.has(cell.id)).length } };
}

function authorize(decisionPath) {
  const decision = read(absolute(decisionPath)); assertConfigIdentity(decision.configIdentity); const context = loadContext();
  if (decision.schemaVersion !== 2 || decision.status !== 'root-approved' || decision.approvedBy !== 'root' ||
    decision.suitePath !== SUITE || decision.suiteFreezeSha256 !== sha(context.freezePath) || !equal(decision.artifacts, artifactHashes())) throw new Error('Exact parallel controller approval required');
  validatePhase(decision.cohort, decision.split);
  if (decision.maxConcurrency !== 2 || decision.maxActivePerCampaign !== 1 || decision.schedulingPolicy !== 'frozen-order-distinct-campaign-waves') throw new Error('Reviewed parallel policy required');
  const selected = selectedFor(context, decision.cohort, decision.split);
  if (!equal(decision.selectedCellIds, selected.map(cell => cell.id))) throw new Error('Full frozen phase selection differs');
  const ledger = read(absolute(decision.ledgerPath));
  if (sha(decision.ledgerPath) !== decision.ledgerSha256) throw new Error('Approved infrastructure ledger changed');
  validateKnown(context, ledger);
  const capacity = read(absolute(decision.capacityPath));
  if (sha(decision.capacityPath) !== decision.capacitySha256 || capacity.status !== 'root-approved' || capacity.approvedBy !== 'root' ||
    capacity.cohort !== decision.cohort || capacity.split !== decision.split || capacity.maxConcurrency !== decision.maxConcurrency ||
    !Number.isSafeInteger(capacity.cMinimumBytes) || !Number.isSafeInteger(capacity.dMinimumBytes) ||
    BigInt(capacity.cMinimumBytes) < 20n * GIB || BigInt(capacity.dMinimumBytes) < (20n + 8n * BigInt(decision.maxConcurrency)) * GIB) throw new Error('Explicit parallel capacity approval required');
  const amendment = read(absolute(decision.amendmentPath));
  if (sha(decision.amendmentPath) !== decision.amendmentSha256 || amendment.status !== 'root-approved' || amendment.approvedBy !== 'root' ||
    amendment.suiteFreezeSha256 !== decision.suiteFreezeSha256 || amendment.maxConcurrency !== decision.maxConcurrency ||
    amendment.schedulingPolicy !== decision.schedulingPolicy || amendment.timingRegime !== 'parallel-user-amended' || amendment.priorTimingRegime !== 'serial-original' ||
    !equal(amendment.selectedCellIds, decision.selectedCellIds)) throw new Error('Exact prospective parallel amendment required');
  if (!Array.isArray(amendment.serialOriginalCellIds) || new Set(amendment.serialOriginalCellIds).size !== amendment.serialOriginalCellIds.length ||
    amendment.serialOriginalCellIds.some(id => !decision.selectedCellIds.includes(id))) throw new Error('Explicit historical serial cell identities required');
  if (decision.split === 'confirmation_holdout' && sha(absolute(decision.pilotReviewPath)) !== decision.pilotReviewSha256) throw new Error('Exact pilot review required');
  const node = context.loaded.values().next().value.runtime.node;
  if (path.resolve(process.execPath) !== path.resolve(node)) throw new Error('Frozen parent Node required');
  const out = absolute(decision.executionDir);
  if (path.dirname(path.resolve(out)) !== path.resolve(S, 'execution')) throw new Error('Fresh direct execution child required');
  return { decision, context, ledger, capacity, amendment, selected, node, out };
}

function owned(context, out, decisionPath) {
  const owner = read(path.join(out, 'controller-owner.json')), lock = read(context.suite.lockFile);
  if (owner.pid !== lock.pid || owner.nonce !== lock.nonce || owner.controllerSha256 !== sha(SELF) || owner.decisionSha256 !== sha(decisionPath)) throw new Error('Foreign or changed host lock/decision');
  process.kill(owner.pid, 0);
  return owner;
}

function diskAdmission(out, capacity, waveId, cellId) {
  let c = null, d = null, error = null;
  try { const cs = fs.statfsSync(CONFIG.runtimeVolumePath, { bigint: true }), ds = fs.statfsSync(CONFIG.evidenceVolumePath, { bigint: true }); c = cs.bavail * cs.bsize; d = ds.bavail * ds.bsize; }
  catch (failure) { error = failure.message; }
  const admitted = error === null && c >= BigInt(capacity.cMinimumBytes) && d >= BigInt(capacity.dMinimumBytes);
  fs.appendFileSync(path.join(out, 'parallel-admission.jsonl'), JSON.stringify({ at: new Date().toISOString(), waveId, cellId,
    freeBytes: { c: c?.toString() ?? null, d: d?.toString() ?? null }, minimumBytes: { c: String(capacity.cMinimumBytes), d: String(capacity.dMinimumBytes) },
    reservationBytesPerSweCell: String(8n * GIB), projectionIsNotUpperBound: true, admitted, error }) + '\n');
  if (!admitted) throw new Error('Parallel disk admission denied before new allocation');
}

function stopRequested(out, owner) {
  const file = path.join(out, 'stop-request.json');
  if (!fs.existsSync(file)) return false;
  const request = read(file);
  if (request.schemaVersion !== 1 || request.action !== 'drain' || request.controllerNonce !== owner.nonce || typeof request.reason !== 'string' || !request.reason.trim()) throw new Error('Invalid bound drain request');
  return true;
}

async function worker(decisionPath, reservationPath, reservationSha256) {
  const { decision, context, selected, out } = authorize(decisionPath), owner = owned(context, out, decisionPath);
  absolute(reservationPath);
  if (sha(reservationPath) !== reservationSha256) throw new Error('Reservation hash differs');
  const reservation = read(reservationPath);
  const expectedJob = path.join(out, 'jobs', reservation.jobId);
  if (typeof reservation.jobId !== 'string' || !/^wave-[0-9]{3}-slot-[0-9]{3}$/.test(reservation.jobId) ||
    path.resolve(reservationPath) !== path.resolve(expectedJob, 'reservation.json') || reservation.schemaVersion !== 2 ||
    reservation.controllerNonce !== owner.nonce || reservation.controllerPid !== owner.pid || reservation.decisionSha256 !== sha(decisionPath)) throw new Error('Foreign worker reservation');
  const priorPath = path.join(out, reservation.priorStateFile);
  if (!/^boundary-[0-9]{3}\.json$/.test(reservation.priorStateFile) || sha(priorPath) !== reservation.priorStateSha256) throw new Error('Prior boundary differs');
  const prior = read(priorPath);
  const expected = selectWave(selected, prior.accountedIds, decision.maxConcurrency);
  if (!equal(reservation.waveCellIds, expected.map(cell => cell.id)) || !expected.some(cell => cell.id === reservation.cellId)) throw new Error('Worker is outside exact parent frozen-order wave');
  const cell = selected.find(row => row.id === reservation.cellId);
  if (fs.existsSync(path.dirname(cellMeta(context, cell)))) throw new Error('Fresh allocation required; never retry an existing slot');
  checkPrior(prior.snapshot);
  const manifest = context.loaded.get(cell.campaignId), campaign = context.suite.campaigns.find(row => row.campaignId === cell.campaignId);
  const frozen = read(path.join(manifest.evidenceDir, 'freeze.json'));
  // No global attempt audit while peers are active. Original campaign pins are
  // still checked inside executeCampaign and the official grade callback.
  const [{ executeCampaign }, { createSlotGrader }, { makeGuardedExecute }] = await Promise.all([
    import(pathToFileURL(FRAMEWORK + '/campaign.mjs').href), import(pathToFileURL(FRAMEWORK + '/grade-campaign.mjs').href), import(pathToFileURL(GUARD).href) ]);
  write(path.join(expectedJob, 'timing-regime.json'), { schemaVersion: 1, cellId: cell.id, frozenOrdinal: cell.ordinal,
    timingRegime: 'parallel-user-amended', maxConcurrency: decision.maxConcurrency, maxActivePerCampaign: 1,
    waveId: reservation.waveId, waveCellIds: reservation.waveCellIds, amendmentPath: decision.amendmentPath,
    amendmentSha256: decision.amendmentSha256, startedAt: new Date().toISOString() });
  const grade = createSlotGrader({ manifest, frozen, config: read(campaign.gradingConfigPath), configPath: campaign.gradingConfigPath });
  const guarded = makeGuardedExecute({ runtimeVolumePath: CONFIG.runtimeVolumePath, evidenceVolumePath: CONFIG.evidenceVolumePath, cohort: decision.cohort, gateLogPath: path.join(expectedJob, 'disk-gates.jsonl'), executeCampaign });
  try {
    await guarded(campaign.manifestPath, 'run', cell.slotId, { grade }, decision.split);
    checkPrior(prior.snapshot);
    const produced = auditProducedCells(context.suite, context.loaded, [cell]);
    if (produced.length !== 1 || !terminal(produced[0].meta) || !acceptedGrade(produced[0].meta, cell.cohort)) throw new Error('Own cell outcome requires root review');
    write(path.join(expectedJob, 'result.json'), { schemaVersion: 2, cellId: cell.id, accepted: true, completedAt: new Date().toISOString(),
      snapshot: snapshotProduced(context, produced), metadataHash: produced[0].metadataHash, receiptHash: produced[0].receiptHash, requestHash: produced[0].requestHash });
  } catch (error) {
    write(path.join(expectedJob, 'failure.json'), { at: new Date().toISOString(), cellId: cell.id, message: error.message, stack: error.stack, nativeReceipt: error.receipt ?? null });
    throw error;
  }
}

export function plan(ledgerPath, cohort = 'swe', split = 'pilot', pilotReviewPath = null) {
  absolute(ledgerPath); validatePhase(cohort, split);
  const context = loadContext(), ledger = read(ledgerPath), decision = { cohort, split, pilotReviewPath };
  const initial = auditBoundary(context, ledger, decision), selected = selectedFor(context, cohort, split);
  return { schemaVersion: 2, status: 'plan-only', configIdentity: CONFIG_IDENTITY, suitePath: SUITE, suiteFreezeSha256: sha(context.freezePath), artifacts: artifactHashes(),
    ledgerPath, ledgerSha256: sha(ledgerPath), cohort, split, selectedCellIds: selected.map(cell => cell.id),
    expectedStartingModelTerminalCount: initial.modelTerminalIds.length, expectedNextCellId: initial.nextCellId, initialEvidenceDigest: hash(initial.snapshot),
    maxConcurrency: 2, maxActivePerCampaign: 1, schedulingPolicy: 'frozen-order-distinct-campaign-waves',
    firstWaveCellIds: selectWave(selected, initial.accountedIds, 2).map(cell => cell.id),
    serialOriginalCellIds: selected.filter(cell => initial.modelTerminalIds.includes(cell.id)).map(cell => cell.id),
    counts: initial.counts, selected: initial.selected, pilotReviewPath,
    ...(pilotReviewPath ? { pilotReviewSha256: sha(pilotReviewPath) } : {}),
    requiredParallelCapacity: { cMinimumBytes: Number(20n * GIB), dMinimumBytes: Number(36n * GIB), projectionIsNotUpperBound: true },
    automaticRetry: false, newInfrastructureFailure: 'stop admission; drain all active workers; retain evidence; root review',
    workerSequence: ['full verify eight campaigns', 'distinct-campaign waves; original executor/grader/cleanup/guard per cell', 'global audit only after wave drains', 'full verify eight campaigns'],
    timingRegime: 'parallel-user-amended' };
}

async function run(decisionPath) {
  const { decision, context, ledger, capacity, selected, node, out } = authorize(decisionPath);
  fs.mkdirSync(out); fs.mkdirSync(path.join(out, 'jobs'));
  const owner = { schemaVersion: 2, pid: process.pid, nonce: crypto.randomUUID(), at: new Date().toISOString(), controllerSha256: sha(SELF), decisionPath, decisionSha256: sha(decisionPath) };
  let lock = null, lockWritten = false, status = 'failed-needs-root-review', failure = null, latest = null, boundary = null;
  try {
    lock = fs.openSync(context.suite.lockFile, 'wx'); fs.writeFileSync(lock, JSON.stringify(owner)); lockWritten = true;
    write(path.join(out, 'controller-owner.json'), owner);
    verifySuite(context.suite, SUITE, {});
    boundary = auditBoundary(context, ledger, decision);
    if (boundary.modelTerminalIds.length !== decision.expectedStartingModelTerminalCount || boundary.nextCellId !== decision.expectedNextCellId || hash(boundary.snapshot) !== decision.initialEvidenceDigest) throw new Error('Approved starting boundary differs');
    latest = 'boundary-000.json'; write(path.join(out, latest), boundary);
    const originalTerminalIds = new Set(boundary.modelTerminalIds);
    const serialOriginalIds = new Set(read(decision.amendmentPath).serialOriginalCellIds);
    const initialSelectedTerminalIds = selected.filter(cell => originalTerminalIds.has(cell.id)).map(cell => cell.id);
    // This reviewed transition starts once from the original serial boundary.
    // A later resume must carry verified timing provenance instead of relabeling
    // previous parallel cells as serial based only on their preexistence.
    if (!equal([...serialOriginalIds].sort(), [...initialSelectedTerminalIds].sort())) throw new Error('This approval must start at its exact historical serial boundary; parallel resume needs inherited regime provenance');
    write(path.join(out, 'timing-regime-origin.json'), { schemaVersion: 1, amendmentSha256: decision.amendmentSha256,
      priorTimingRegime: 'serial-original', priorSelectedCellIds: initialSelectedTerminalIds,
      newTimingRegime: 'parallel-user-amended', initialEvidenceDigest: hash(boundary.snapshot), comparisonPolicy: 'report timing separately by regime' });
    let waveNumber = 0;
    while (boundary.nextCellId) {
      if (stopRequested(out, owner)) { status = 'drained-user-request'; break; }
      // Revalidate approval, artifacts and all completed protected evidence at admission.
      authorize(decisionPath); checkPrior(boundary.snapshot);
      const wave = selectWave(selected, boundary.accountedIds, decision.maxConcurrency), waveId = 'wave-' + String(++waveNumber).padStart(3, '0');
      const prior = boundary, priorFile = latest, reservations = new Map();
      for (const [index, cell] of wave.entries()) {
        const jobId = waveId + '-slot-' + String(index + 1).padStart(3, '0'), jobDir = path.join(out, 'jobs', jobId);
        fs.mkdirSync(jobDir);
        const reservationPath = path.join(jobDir, 'reservation.json');
        write(reservationPath, { schemaVersion: 2, jobId, waveId, cellId: cell.id, waveCellIds: wave.map(row => row.id), controllerNonce: owner.nonce,
          controllerPid: owner.pid, decisionSha256: owner.decisionSha256, priorStateFile: priorFile, priorStateSha256: sha(path.join(out, priorFile)),
          reservedAt: new Date().toISOString(), frozenOrdinal: cell.ordinal });
        reservations.set(cell.id, { jobId, reservationPath });
      }
      // drainWave waits for every admitted child even after admission or child failure.
      const drained = await drainWave(wave, { shouldStop: () => stopRequested(out, owner), start: cell => {
        diskAdmission(out, capacity, waveId, cell.id);
        const reservation = reservations.get(cell.id);
        const reservationSha256 = sha(reservation.reservationPath);
        return startWorker({ node, script: SELF, args: withConfig(['--worker', decisionPath, reservation.reservationPath, reservationSha256]), out, label: reservation.jobId,
          details: { reservationPath: reservation.reservationPath, reservationSha256 } });
      } });
      const summary = { schemaVersion: 2, waveId, at: new Date().toISOString(), plannedCellIds: wave.map(cell => cell.id), admittedCellIds: drained.admitted,
        stopRequested: drained.stopRequested, admissionError: drained.admissionError?.stack ?? null,
        results: drained.results.map((result, index) => ({ cellId: drained.admitted[index], status: result.status,
          ...(result.status === 'fulfilled' ? { value: result.value } : { reason: result.reason?.stack ?? String(result.reason) }) })) };
      write(path.join(out, waveId + '-drained.json'), summary);
      if (drained.failed) throw new Error('Wave failed after all admitted workers closed: ' + waveId);
      boundary = auditBoundary(context, ledger, decision, prior.snapshot);
      const added = boundary.modelTerminalIds.filter(id => !prior.modelTerminalIds.includes(id));
      if (!equal([...added].sort(), [...drained.admitted].sort())) throw new Error('Drained boundary differs from exactly admitted cells');
      for (const id of drained.admitted) {
        const result = read(path.join(out, 'jobs', reservations.get(id).jobId, 'result.json'));
        if (result.cellId !== id || result.accepted !== true) throw new Error('Missing accepted worker result');
        checkPrior(result.snapshot);
      }
      latest = 'boundary-' + String(waveNumber).padStart(3, '0') + '.json'; write(path.join(out, latest), boundary);
      if (drained.stopRequested) { status = 'drained-user-request'; break; }
    }
    if (status !== 'drained-user-request') {
      verifySuite(context.suite, SUITE, {});
      boundary = auditBoundary(context, ledger, decision, boundary.snapshot);
      if (boundary.selected.unvisited !== 0) throw new Error('Phase has unvisited cells');
      const { produced } = auditAccounted(context, ledger);
      write(path.join(out, 'phase-outcomes.json'), { schemaVersion: 2, suiteId: context.suite.suiteId, cohort: decision.cohort, split: decision.split,
        timingPolicy: 'Mixed timing regimes; quality outcomes only. Timing comparisons require separate serial and parallel strata.',
        amendmentSha256: decision.amendmentSha256, selectedCellIds: decision.selectedCellIds,
        outcomes: selected.map(cell => {
          const row = produced.find(item => item.id === cell.id);
          return { id: cell.id, campaignId: cell.campaignId, taskId: cell.taskId, modelId: cell.modelId, arm: cell.arm,
            timingRegime: serialOriginalIds.has(cell.id) ? 'serial-original' : 'parallel-user-amended',
            status: row?.meta.status ?? 'signed-preparation-failure', gradeStatus: row?.meta.grade?.status ?? null,
            resolved: row?.meta.grade?.resolved ?? null, metadataHash: row?.metadataHash ?? null, receiptHash: row?.receiptHash ?? null };
        }) });
      write(path.join(out, 'verify-end.json'), { at: new Date().toISOString(), completeSuiteVerified: true, campaignCount: context.suite.campaigns.length, state: boundary });
      status = 'phase-accounted-closure-with-infrastructure';
    } else {
      verifySuite(context.suite, SUITE, {});
      boundary = auditBoundary(context, ledger, decision, boundary.snapshot);
      write(path.join(out, 'drain-verified.json'), { at: new Date().toISOString(), state: boundary, stopRequestSha256: sha(path.join(out, 'stop-request.json')) });
    }
  } catch (error) { failure = { message: error.message, stack: error.stack }; throw error; }
  finally {
    try { write(path.join(out, 'controller-exit.json'), { schemaVersion: 2, status, at: new Date().toISOString(), pid: process.pid, cohort: decision.cohort, split: decision.split,
      failure, finalVerifiedState: latest ? path.join(out, latest) : null, counts: boundary?.counts ?? null, phaseCounts: boundary?.selected ?? null,
      timingRegime: 'parallel-user-amended', allAdmittedChildrenClosedBeforeRelease: true, modelSamplesAreDistinctFromAccountedOutcomes: true,
      failureCosts: ledger.knownInfraCells.flatMap(cell => cell.costRefs), ledgerSha256: sha(decision.ledgerPath) }); }
    finally {
      if (lock !== null) fs.closeSync(lock);
      if (lockWritten) { const live = read(context.suite.lockFile); if (live.nonce !== owner.nonce || live.pid !== owner.pid) throw new Error('Host lock identity changed; retain for root'); fs.unlinkSync(context.suite.lockFile); }
    }
  }
  console.log(JSON.stringify({ status, executionDir: out, state: latest }));
}

async function main(argv) {
  if (argv[0] === '--worker') { if (argv.length !== 4) throw new Error('Worker requires decision, reservation and hash'); return worker(...argv.slice(1)); }
  if (argv[0] === '--run') { if (argv.length !== 2) throw new Error('Run requires exact root decision'); return run(argv[1]); }
  if (argv[0] !== '--plan' || !argv[1]) throw new Error('Usage: --plan ABS_LEDGER [cohort split ABS_PILOT_REVIEW] | --run ABS_DECISION');
  console.log(JSON.stringify(plan(argv[1], argv[2] ?? 'swe', argv[3] ?? 'pilot', argv[4] ?? null), null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main(ARGS).catch(error => { console.error(error.stack); process.exitCode = 1; });
