import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { S, SUITE, loadContext, validateKnown, auditAccounted, snapshotProduced, checkPrior, requirePilot } from '../accounted-suite-controller-v1/controller.mjs';
import { runtime, withConfig, assertConfigIdentity, CONFIG_MODULE } from '../config.mjs';
const { config: CONFIG, identity: CONFIG_IDENTITY, configPath: CONFIG_PATH, args: ARGS } = runtime();
const { verifySuite, auditProducedCells, acceptedGrade, terminal } = await import(pathToFileURL(ensureSidecar()).href);
import { transform, ORIGINAL, ensureSidecar } from '../accounted-suite-controller-v1/build-sidecar.mjs';
import { runRolling } from './scheduler.mjs';
import { startWorker } from './worker-process.mjs';
import { read, write, sha, hash, equal, absolute, assertPins, assertClosedLifecycle, assertPolicy, assertCapacity, assertAdmission, assertNamespaces, assertAllocatedInventory } from './receipts.mjs';

const SELF = fileURLToPath(import.meta.url), HERE = path.dirname(SELF), LEGACY = path.resolve(HERE, '../accounted-suite-controller-v1');
const FRAMEWORK = CONFIG.frameworkDir;
const GUARD = CONFIG.guardModule;
const POLICY = 'frozen-order-distinct-campaign-rolling', REGIME = 'parallel-rolling-user-amended';
const attemptDir = (context, cell) => path.join(context.loaded.get(cell.campaignId).evidenceDir, 'attempts', cell.slotId);
const selectedFor = context => context.frozen.schedule.filter(cell => cell.cohort === 'swe' && cell.split === 'confirmation_holdout');
const pin = file => ({ path: file, sha256: sha(file) });
const namespace = row => ({ session: read(row.meta.receiptPath).sessionId, home: path.join(path.dirname(row.meta.receiptPath), 'home'), source: row.meta.sourceRoot, attempt: path.dirname(row.meta.receiptPath) });

export function artifactHashes() {
  const sidecar = path.join(CONFIG.sidecarBuildDir, 'suite-exposed.mjs');
  if (fs.readFileSync(sidecar, 'utf8') !== transform(fs.readFileSync(ORIGINAL, 'utf8')).output) throw new Error('Reviewed mechanical sidecar differs');
  const files = ['controller.mjs', 'scheduler.mjs', 'worker-process.mjs', 'receipts.mjs'].map(name => path.join(HERE, name));
  files.push(...['controller.mjs', 'build-sidecar.mjs'].map(name => path.join(LEGACY, name)), ...['suite-exposed.mjs', 'sidecar-transform.json'].map(name => path.join(CONFIG.sidecarBuildDir, name)), GUARD, CONFIG_MODULE, CONFIG_PATH);
  files.push(...fs.readdirSync(FRAMEWORK).filter(name => !name.includes('.test.') && /\.(mjs|py|txt|json)$/.test(name)).sort().map(name => path.join(FRAMEWORK, name)));
  return files.map(pin);
}

function boundary(context, ledger, decision, prior = []) {
  checkPrior(prior);
  const { known, produced } = auditAccounted(context, ledger);
  requirePilot(context, produced, 'swe', read(absolute(decision.pilotReviewPath)));
  const accountedIds = [...known, ...produced.map(row => row.id)], accounted = new Set(accountedIds), selected = selectedFor(context);
  if (context.frozen.schedule.some(cell => cell.cohort === 'context' && !accounted.has(cell.id))) throw new Error('Context phase not fully accounted');
  return { schemaVersion: 3, modelTerminalIds: produced.map(row => row.id), knownInfraIds: [...known], accountedIds,
    selectedCellIds: selected.map(row => row.id), snapshot: snapshotProduced(context, produced),
    counts: { planned: context.frozen.schedule.length, modelTerminal: produced.length, signedPreparationFailures: known.size, unvisited: context.frozen.schedule.length - accounted.size },
    selected: { planned: selected.length, modelTerminal: selected.filter(cell => produced.some(row => row.id === cell.id)).length,
      signedPreparationFailures: selected.filter(cell => known.has(cell.id)).length, unvisited: selected.filter(cell => !accounted.has(cell.id)).length } };
}

function authorize(decisionPath) {
  const decision = read(absolute(decisionPath)); assertConfigIdentity(decision.configIdentity); const context = loadContext(), selected = selectedFor(context);
  assertPolicy(decision, selected);
  if (decision.status !== 'root-approved' || decision.approvedBy !== 'root' || decision.suitePath !== SUITE ||
    decision.suiteFreezeSha256 !== sha(context.freezePath) || !equal(decision.artifacts, artifactHashes())) throw new Error('Exact rolling controller source/artifact approval required');
  if (context.suite.campaigns.length !== 8) throw new Error('Exactly eight frozen campaigns required');
  // Frozen input hashes are safe to check during peers; no attempt metadata audit.
  assertPins(context.frozen.pins);
  const ledger = read(absolute(decision.ledgerPath));
  if (sha(decision.ledgerPath) !== decision.ledgerSha256) throw new Error('Approved signed infrastructure ledger changed');
  validateKnown(context, ledger);
  const capacity = read(absolute(decision.capacityPath));
  if (sha(decision.capacityPath) !== decision.capacitySha256) throw new Error('Approved capacity pin differs');
  assertCapacity(capacity, decision);
  const amendment = read(absolute(decision.amendmentPath));
  if (sha(decision.amendmentPath) !== decision.amendmentSha256 || amendment.schemaVersion !== 3 || amendment.status !== 'root-approved' || amendment.approvedBy !== 'root' ||
    amendment.suiteFreezeSha256 !== decision.suiteFreezeSha256 || amendment.maxConcurrency !== 2 || amendment.maxActivePerCampaign !== 1 ||
    amendment.schedulingPolicy !== POLICY || amendment.timingRegime !== REGIME || amendment.freshPhaseOnly !== true ||
    amendment.priorEvidencePolicy !== 'immutable-quality-only; inherited timing regimes unchanged' || !equal(amendment.selectedCellIds, decision.selectedCellIds) ||
    amendment.initialEvidenceDigest !== decision.initialEvidenceDigest) throw new Error('Exact prospective fresh confirmation rolling amendment required');
  if (sha(absolute(decision.pilotReviewPath)) !== decision.pilotReviewSha256) throw new Error('Exact pilot review pin required');
  const node = context.loaded.values().next().value.runtime.node, out = absolute(decision.executionDir);
  if (path.resolve(process.execPath) !== path.resolve(node)) throw new Error('Frozen parent Node required');
  if (path.dirname(path.resolve(out)) !== path.resolve(S, 'execution')) throw new Error('Fresh direct execution child required');
  return { decision, context, selected, ledger, capacity, node, out };
}

function owned(context, out, decisionPath) {
  const owner = read(path.join(out, 'controller-owner.json')), lock = read(context.suite.lockFile);
  if (owner.pid !== lock.pid || owner.nonce !== lock.nonce || owner.controllerSha256 !== sha(SELF) || owner.decisionSha256 !== sha(decisionPath)) throw new Error('Foreign or changed parent lock/decision');
  process.kill(owner.pid, 0); return owner;
}
function stopRequested(out, owner) {
  const file = path.join(out, 'stop-request.json'); if (!fs.existsSync(file)) return false;
  const request = read(file);
  if (request.schemaVersion !== 1 || request.action !== 'drain' || request.controllerNonce !== owner.nonce || typeof request.reason !== 'string' || !request.reason.trim()) throw new Error('Invalid bound drain request');
  return true;
}
function diskAdmission(out, capacity, job) {
  let c = null, d = null, error = null;
  try { const cs = fs.statfsSync(CONFIG.runtimeVolumePath, { bigint: true }), ds = fs.statfsSync(CONFIG.evidenceVolumePath, { bigint: true }); c = cs.bavail * cs.bsize; d = ds.bavail * ds.bsize; }
  catch (failure) { error = failure.message; }
  const admitted = error === null && c >= BigInt(capacity.cMinimumBytes) && d >= BigInt(capacity.dMinimumBytes);
  fs.appendFileSync(path.join(out, 'rolling-admission.jsonl'), JSON.stringify({ at: new Date().toISOString(), issuanceOrdinal: job.issuanceOrdinal, cellId: job.cell.id,
    freeBytes: { c: c?.toString() ?? null, d: d?.toString() ?? null }, minimumBytes: { c: String(capacity.cMinimumBytes), d: String(capacity.dMinimumBytes) },
    reservationBytesPerSweCell: String(8 * 1024 ** 3), projectionIsNotUpperBound: true, admitted, error }) + '\n');
  if (!admitted) throw new Error('Rolling disk admission denied before allocation');
}
function verifyAdmissionFiles(out, admission, reservation, selected, owner, decisionPath) {
  assertAdmission(admission, reservation, selected, owner, sha(decisionPath));
  for (const entry of [...admission.acceptedClosed, ...admission.activeReservations]) {
    const expected = path.join(out, 'jobs', entry.jobId, 'reservation.json');
    if (path.resolve(entry.reservationPath) !== path.resolve(expected) || sha(expected) !== entry.reservationSha256) throw new Error('Admission reservation pin differs');
    const prior = read(expected);
    if (prior.cellId !== entry.cellId || (entry.campaignId && prior.campaignId !== entry.campaignId) || prior.controllerNonce !== owner.nonce || prior.controllerPid !== owner.pid || prior.decisionSha256 !== sha(decisionPath)) throw new Error('Admission reservation identity differs');
  }
  for (const entry of admission.acceptedClosed) {
    if (path.resolve(entry.resultPath) !== path.resolve(out, 'jobs', entry.jobId, 'result.json') || sha(entry.resultPath) !== entry.resultSha256) throw new Error('Accepted result pin differs');
  }
  checkPrior(admission.protectedSnapshot);
}

async function worker(decisionPath, reservationPath, reservationSha256) {
  const { decision, context, selected, out } = authorize(decisionPath), owner = owned(context, out, decisionPath);
  if (sha(absolute(reservationPath)) !== reservationSha256) throw new Error('Reservation hash differs');
  const reservation = read(reservationPath), jobDir = path.join(out, 'jobs', reservation.jobId);
  if (!/^job-[0-9]{4}$/.test(reservation.jobId) || path.resolve(reservationPath) !== path.resolve(jobDir, 'reservation.json') ||
    reservation.admissionFile !== 'admission-' + String(reservation.issuanceOrdinal).padStart(4, '0') + '.json') throw new Error('Foreign worker reservation path');
  const admissionPath = path.join(out, reservation.admissionFile);
  if (sha(admissionPath) !== reservation.admissionSha256) throw new Error('Admission state hash differs');
  const admission = read(admissionPath);
  verifyAdmissionFiles(out, admission, reservation, selected, owner, decisionPath);
  const cell = selected.find(row => row.id === reservation.cellId);
  if (fs.existsSync(attemptDir(context, cell))) throw new Error('Fresh allocation required; never retry or resume');
  const manifest = context.loaded.get(cell.campaignId), campaign = context.suite.campaigns.find(row => row.campaignId === cell.campaignId), frozen = read(path.join(manifest.evidenceDir, 'freeze.json'));
  assertPins(frozen.pins);
  const [{ executeCampaign }, { createSlotGrader }, { makeGuardedExecute }] = await Promise.all([
    import(pathToFileURL(FRAMEWORK + '/campaign.mjs').href), import(pathToFileURL(FRAMEWORK + '/grade-campaign.mjs').href), import(pathToFileURL(GUARD).href) ]);
  write(path.join(jobDir, 'timing-regime.json'), { schemaVersion: 3, jobId: reservation.jobId, cellId: cell.id, frozenOrdinal: cell.ordinal,
    timingRegime: REGIME, schedulingPolicy: POLICY, maxConcurrency: 2, maxActivePerCampaign: 1, activeAtAdmission: reservation.activeAtAdmission,
    reservationSha256, amendmentPath: decision.amendmentPath, amendmentSha256: decision.amendmentSha256, startedAt: new Date().toISOString() });
  const grade = createSlotGrader({ manifest, frozen, config: read(campaign.gradingConfigPath), configPath: campaign.gradingConfigPath });
  const guarded = makeGuardedExecute({ runtimeVolumePath: CONFIG.runtimeVolumePath, evidenceVolumePath: CONFIG.evidenceVolumePath, cohort: 'swe', gateLogPath: path.join(jobDir, 'disk-gates.jsonl'), executeCampaign });
  try {
    await guarded(campaign.manifestPath, 'run', cell.slotId, { grade }, 'confirmation_holdout');
    checkPrior(admission.protectedSnapshot);
    const produced = auditProducedCells(context.suite, context.loaded, [cell]);
    if (produced.length !== 1 || !terminal(produced[0].meta) || !acceptedGrade(produced[0].meta, 'swe')) throw new Error('Own outcome requires root review');
    const row = produced[0];
    write(path.join(jobDir, 'result.json'), { schemaVersion: 3, jobId: reservation.jobId, cellId: cell.id, accepted: true, completedAt: new Date().toISOString(),
      reservationSha256, snapshot: snapshotProduced(context, produced), metadataHash: row.metadataHash, receiptHash: row.receiptHash, requestHash: row.requestHash, namespace: namespace(row) });
  } catch (error) {
    write(path.join(jobDir, 'failure.json'), { at: new Date().toISOString(), cellId: cell.id, message: error.message, stack: error.stack, nativeReceipt: error.receipt ?? null }); throw error;
  }
}

export function plan(ledgerPath, pilotReviewPath) {
  const context = loadContext(), ledger = read(absolute(ledgerPath));
  absolute(pilotReviewPath);
  const selected = selectedFor(context), initial = boundary(context, ledger, { pilotReviewPath });
  if (selected.length !== 48 || selected.some(cell => fs.existsSync(attemptDir(context, cell)))) throw new Error('Fresh confirmation48 required; resume/midpilot forbidden');
  return { schemaVersion: 3, status: 'plan-only', configIdentity: CONFIG_IDENTITY, suitePath: SUITE, suiteFreezeSha256: sha(context.freezePath), artifacts: artifactHashes(),
    ledgerPath, ledgerSha256: sha(ledgerPath), pilotReviewPath, pilotReviewSha256: sha(pilotReviewPath), cohort: 'swe', split: 'confirmation_holdout',
    selectedCellIds: selected.map(row => row.id), selectedCells: selected.map(row => ({ cellId: row.id, campaignId: row.campaignId, frozenOrdinal: row.ordinal })),
    expectedStartingModelTerminalCount: initial.modelTerminalIds.length, initialEvidenceDigest: hash(initial.snapshot), initialAccountedIds: initial.accountedIds,
    maxConcurrency: 2, maxActivePerCampaign: 1, schedulingPolicy: POLICY, timingRegime: REGIME, freshPhaseOnly: true, automaticRetry: false,
    requiredCapacity: { cMinimumBytes: 20 * 1024 ** 3, dMinimumBytes: 36 * 1024 ** 3, projectionIsNotUpperBound: true },
    priorEvidencePolicy: 'immutable-quality-only; inherited timing regimes unchanged', counts: initial.counts, selected: initial.selected };
}

async function run(decisionPath) {
  const { decision, context, ledger, capacity, selected, node, out } = authorize(decisionPath);
  fs.mkdirSync(out); fs.mkdirSync(path.join(out, 'jobs'));
  const owner = { schemaVersion: 3, pid: process.pid, nonce: crypto.randomUUID(), at: new Date().toISOString(), controllerSha256: sha(SELF), decisionPath, decisionSha256: sha(decisionPath) };
  let lock = null, lockWritten = false, status = 'failed-needs-root-review', failure = null, initial = null, finalState = null, rolling = null, sequence = 0;
  const allAdmittedChildrenClosedBeforeRelease = true;
  let stopSignal = null;
  const onInterrupt = () => { stopSignal = 'SIGINT'; }, onTerminate = () => { stopSignal = 'SIGTERM'; };
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  const issued = new Map(), accepted = [], acceptedPins = [], closedNamespaces = [];
  const journal = (event, details = {}) => fs.appendFileSync(path.join(out, 'receipt-journal.jsonl'), JSON.stringify({ schemaVersion: 3, sequence: ++sequence, at: new Date().toISOString(), controllerNonce: owner.nonce, event, ...details }) + '\n');
  const protectedSnapshot = () => [...initial.snapshot, ...accepted.flatMap(row => row.result.snapshot)];
  const protectedCheck = () => { checkPrior(protectedSnapshot()); assertPins(acceptedPins); };
  const inventory = active => assertAllocatedInventory(context.frozen.schedule, cell => attemptDir(context, cell), [...initial.accountedIds, ...accepted.map(row => row.cellId), ...active.map(row => row.cellId)]);
  try {
    lock = fs.openSync(context.suite.lockFile, 'wx'); lockWritten = true; fs.writeFileSync(lock, JSON.stringify(owner));
    write(path.join(out, 'controller-owner.json'), owner);
    verifySuite(context.suite, SUITE, {});
    initial = boundary(context, ledger, decision);
    if (initial.modelTerminalIds.length !== decision.expectedStartingModelTerminalCount || hash(initial.snapshot) !== decision.initialEvidenceDigest ||
      !equal(initial.accountedIds, decision.initialAccountedIds) || selected.some(cell => fs.existsSync(attemptDir(context, cell)))) throw new Error('Fresh exact approved initial boundary differs; resume/midpilot forbidden');
    write(path.join(out, 'boundary-000.json'), initial);
    const initialRows = auditProducedCells(context.suite, context.loaded, context.frozen.schedule.filter(cell => initial.modelTerminalIds.includes(cell.id)));
    closedNamespaces.push(...initialRows.map(row => ({ cellId: row.id, namespace: namespace(row) })));
    assertNamespaces(closedNamespaces);
    write(path.join(out, 'timing-regime-origin.json'), { schemaVersion: 3, initialBoundarySha256: sha(path.join(out, 'boundary-000.json')),
      initialEvidenceDigest: hash(initial.snapshot), priorEvidencePolicy: 'immutable-quality-only; inherited timing regimes unchanged',
      priorModelTerminalIds: initial.modelTerminalIds, priorKnownInfraIds: initial.knownInfraIds, newTimingRegime: REGIME, selectedCellIds: decision.selectedCellIds, amendmentSha256: decision.amendmentSha256 });
    acceptedPins.push(...['controller-owner.json', 'boundary-000.json', 'timing-regime-origin.json'].map(name => pin(path.join(out, name))));
    rolling = await runRolling(selected, {
      shouldStop: () => stopSignal !== null || stopRequested(out, owner),
      stopped: details => journal('admission-stopped', { stopRequested: details.stopRequested, errors: details.failures.map(error => error.message) }),
      start: (job, state) => {
        authorize(decisionPath); owned(context, out, decisionPath); protectedCheck(); inventory(state.activeReservations);
        if (fs.existsSync(attemptDir(context, job.cell))) throw new Error('Fresh selected cell allocation required');
        assertPins(read(path.join(context.loaded.get(job.cell.campaignId).evidenceDir, 'freeze.json')).pins);
        diskAdmission(out, capacity, job);
        const admissionFile = 'admission-' + String(job.issuanceOrdinal).padStart(4, '0') + '.json', jobDir = path.join(out, 'jobs', job.jobId);
        const admission = { schemaVersion: 3, controllerNonce: owner.nonce, controllerPid: owner.pid, decisionSha256: owner.decisionSha256,
          issuanceOrdinal: job.issuanceOrdinal, acceptedClosed: accepted.map(({ result, ...row }) => row),
          activeReservations: state.activeReservations.map(row => ({ ...row, reservationPath: issued.get(row.jobId).reservationPath, reservationSha256: issued.get(row.jobId).reservationSha256 })),
          acceptedCellIds: state.acceptedCellIds, protectedSnapshot: protectedSnapshot() };
        write(path.join(out, admissionFile), admission); fs.mkdirSync(jobDir);
        const reservationPath = path.join(jobDir, 'reservation.json'), reservation = { schemaVersion: 3, jobId: job.jobId, cellId: job.cell.id,
          campaignId: job.cell.campaignId, frozenOrdinal: job.cell.ordinal, issuanceOrdinal: job.issuanceOrdinal, controllerNonce: owner.nonce, controllerPid: owner.pid,
          decisionSha256: owner.decisionSha256, admissionFile, admissionSha256: sha(path.join(out, admissionFile)), reservedAt: new Date().toISOString(), activeAtAdmission: job.activeAtAdmission };
        assertAdmission(admission, reservation, selected, owner, owner.decisionSha256);
        write(reservationPath, reservation);
        const reservationSha256 = sha(reservationPath); issued.set(job.jobId, { reservationPath, reservationSha256 });
        acceptedPins.push(pin(path.join(out, admissionFile)), pin(reservationPath));
        journal('admission-issued', { jobId: job.jobId, cellId: job.cell.id, reservationSha256, activeAtAdmission: job.activeAtAdmission });
        // The worker function owns all failures after spawn and returns only at close.
        return startWorker({ node, script: SELF, args: withConfig(['--worker', decisionPath, reservationPath, reservationSha256]), out, label: job.jobId, details: { reservationPath, reservationSha256 } });
      },
      closed: (job, outcome, state) => {
        const refs = issued.get(job.jobId), exitPath = path.join(out, job.jobId + '-exit.json');
        journal('worker-closed', { jobId: job.jobId, cellId: job.cell.id, status: outcome.status, ...(fs.existsSync(exitPath) ? read(exitPath) : { error: outcome.reason?.message ?? 'Missing worker exit receipt' }) });
        if (outcome.status !== 'fulfilled') return;
        assertClosedLifecycle(read(path.join(out, job.jobId + '-start.json')), read(exitPath), outcome.value, refs, owner, node);
        protectedCheck(); inventory(state.activeReservations);
        const resultPath = path.join(out, 'jobs', job.jobId, 'result.json'), result = read(resultPath);
        const rows = auditProducedCells(context.suite, context.loaded, [job.cell]);
        if (rows.length !== 1 || !terminal(rows[0].meta) || !acceptedGrade(rows[0].meta, 'swe')) throw new Error('Closed own cell failed original audit');
        const row = rows[0], resultSnapshot = snapshotProduced(context, rows), ownNamespace = namespace(row);
        if (result.schemaVersion !== 3 || result.jobId !== job.jobId || result.cellId !== job.cell.id || result.accepted !== true ||
          result.reservationSha256 !== refs.reservationSha256 || !equal(result.snapshot, resultSnapshot) || result.metadataHash !== row.metadataHash ||
          result.receiptHash !== row.receiptHash || result.requestHash !== row.requestHash || !equal(result.namespace, ownNamespace)) throw new Error('Closed worker result identity/pins differ');
        checkPrior(result.snapshot); assertNamespaces([...closedNamespaces, { cellId: job.cell.id, namespace: ownNamespace }]);
        const acceptedPath = path.join(out, 'accepted-' + String(job.issuanceOrdinal).padStart(4, '0') + '.json');
        const receipt = { schemaVersion: 3, jobId: job.jobId, cellId: job.cell.id, closedAt: outcome.value.finishedAt, acceptedAt: new Date().toISOString(),
          ...refs, resultPath, resultSha256: sha(resultPath), resultEvidenceDigest: hash(result.snapshot), namespace: ownNamespace };
        write(acceptedPath, receipt); journal('result-accepted', { jobId: job.jobId, cellId: job.cell.id, resultSha256: receipt.resultSha256 });
        accepted.push({ jobId: job.jobId, cellId: job.cell.id, ...refs, resultPath, resultSha256: receipt.resultSha256, result });
        acceptedPins.push(pin(resultPath), pin(refs.reservationPath), pin(acceptedPath), pin(exitPath), pin(path.join(out, job.jobId + '-start.json')));
        closedNamespaces.push({ cellId: job.cell.id, namespace: ownNamespace });
      },
      allClosed: details => { journal('all-children-closed', { admittedJobIds: details.admitted.map(job => job.jobId), acceptedJobIds: details.accepted.map(job => job.jobId) }); }
    });
    // Global original verification is only reached after runRolling drained all children.
    authorize(decisionPath); protectedCheck();
    verifySuite(context.suite, SUITE, {}); finalState = boundary(context, ledger, decision, protectedSnapshot());
    if (rolling.failed) throw new AggregateError(rolling.failures, 'Rolling execution failed after all children closed');
    if (rolling.stopRequested) { status = 'drained-user-request'; write(path.join(out, 'drain-verified.json'), { at: new Date().toISOString(), state: finalState, stopSignal,
      stopRequestSha256: fs.existsSync(path.join(out, 'stop-request.json')) ? sha(path.join(out, 'stop-request.json')) : null }); }
    else {
      const added = finalState.modelTerminalIds.filter(id => !initial.modelTerminalIds.includes(id));
      if (rolling.admitted.length !== 48 || accepted.length !== 48 || finalState.selected.unvisited !== 0 ||
        !equal([...added].sort(), [...decision.selectedCellIds].sort()) || !equal(rolling.accepted.map(job => job.cell.id).sort(), [...decision.selectedCellIds].sort())) throw new Error('Full closure must exactly add48 selected accepted results');
      const { produced } = auditAccounted(context, ledger);
      write(path.join(out, 'phase-outcomes.json'), { schemaVersion: 3, suiteId: context.suite.suiteId, cohort: 'swe', split: 'confirmation_holdout',
        timingPolicy: 'Rolling descriptive timing only; inherited evidence quality-only and original timing regimes unchanged', timingRegime: REGIME,
        amendmentSha256: decision.amendmentSha256, selectedCellIds: decision.selectedCellIds, outcomes: selected.map(cell => {
          const row = produced.find(item => item.id === cell.id), job = accepted.find(item => item.cellId === cell.id);
          return { id: cell.id, campaignId: cell.campaignId, taskId: cell.taskId, modelId: cell.modelId, arm: cell.arm, jobId: job.jobId,
            timingRegime: REGIME, status: row.meta.status, gradeStatus: row.meta.grade?.status ?? null, resolved: row.meta.grade?.resolved ?? null, metadataHash: row.metadataHash, receiptHash: row.receiptHash };
        }) });
      write(path.join(out, 'verify-end.json'), { schemaVersion: 3, at: new Date().toISOString(), completeSuiteVerified: true, campaignCount: 8, state: finalState,
        admittedCellIds: rolling.admitted.map(job => job.cell.id), acceptedCellIds: accepted.map(row => row.cellId), exactlyAddedSelectedCellIds: added,
        acceptedReceipts: accepted.map(row => pin(path.join(out, 'accepted-' + row.jobId.slice(4) + '.json'))) });
      status = 'phase-accounted-closure-with-infrastructure';
    }
  } catch (error) {
    failure = { message: error.message, stack: error.stack, errors: error.errors?.map(item => ({ message: item.message, stack: item.stack })) ?? null };
    // Pre-dispatch failures have no children. Dispatch failures return through runRolling's complete drain.
    // Retain a separate failed all-closed full audit rather than hiding the first error.
    if (initial && !finalState) {
      try { verifySuite(context.suite, SUITE, {}); finalState = boundary(context, ledger, decision, initial.snapshot); write(path.join(out, 'failed-drain-audit.json'), { at: new Date().toISOString(), state: finalState }); }
      catch (auditError) { failure.finalAuditError = { message: auditError.message, stack: auditError.stack }; }
    }
    throw error;
  } finally {
    try {
      const finalPins = ['verify-end.json', 'phase-outcomes.json', 'boundary-000.json', 'timing-regime-origin.json', 'receipt-journal.jsonl'].filter(name => fs.existsSync(path.join(out, name))).map(name => pin(path.join(out, name)));
      write(path.join(out, 'controller-exit.json'), { schemaVersion: 3, status, at: new Date().toISOString(), pid: process.pid, controllerNonce: owner.nonce,
        cohort: 'swe', split: 'confirmation_holdout', failure, allAdmittedChildrenClosedBeforeRelease,
        admittedJobIds: rolling?.admitted.map(job => job.jobId) ?? [], acceptedJobIds: accepted.map(row => row.jobId),
        finalVerifiedState: fs.existsSync(path.join(out, 'verify-end.json')) ? path.join(out, 'verify-end.json') : null, finalPins,
        counts: finalState?.counts ?? null, phaseCounts: finalState?.selected ?? null, timingRegime: REGIME,
        failureCosts: ledger.knownInfraCells.flatMap(cell => cell.costRefs), ledgerSha256: sha(decision.ledgerPath) });
    } finally {
      process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
      if (lock !== null) fs.closeSync(lock);
      if (lockWritten) { const live = read(context.suite.lockFile); if (live.nonce !== owner.nonce || live.pid !== owner.pid) throw new Error('Host lock identity changed; retain for root'); fs.unlinkSync(context.suite.lockFile); }
    }
  }
  console.log(JSON.stringify({ status, executionDir: out }));
}

async function main(argv) {
  if (argv[0] === '--worker' && argv.length === 4) return worker(...argv.slice(1));
  if (argv[0] === '--run' && argv.length === 2) return run(argv[1]);
  if (argv[0] === '--plan' && argv.length === 3) { console.log(JSON.stringify(plan(argv[1], argv[2]), null, 2)); return; }
  throw new Error('Usage: --plan ABS_SIGNED_LEDGER ABS_ROOT_PILOT_REVIEW | --run ABS_ROOT_DECISION | internal --worker DECISION RESERVATION HASH');
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main(ARGS).catch(error => { console.error(error.stack); process.exitCode = 1; });
