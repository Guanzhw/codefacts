// Closed v3 receipt boundary. Explicit pins only; no campaign/job discovery.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { ROLLING, ROLLING_POLICY } from './adapter.mjs';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hash = value => digest(JSON.stringify(value));
const check = (value, message) => { if (!value) throw new Error(message); };
const equal = (a, b) => assert.deepStrictEqual(a, b);
const sorted = values => [...values].sort();
const time = value => { const n = Date.parse(value); check(Number.isFinite(n), 'Closed rolling timestamp required'); return n; };
const bytes = ref => {
  check(typeof ref?.path === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256 ?? ''), 'Explicit rolling source pin required');
  const value = fs.readFileSync(ref.path); check(digest(value) === ref.sha256, 'Rolling source SHA-256 mismatch'); return value;
};
const read = ref => JSON.parse(bytes(ref));
const lines = ref => bytes(ref).toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));

export function assembleRolling(data, inventory, execution) {
  const decision = read(execution.decision), amendment = read(execution.amendment), owner = read(execution.owner), exit = read(execution.exit);
  const origin = read(execution.origin), initial = read(execution.initialBoundary), final = read(execution.verifyEnd), outcomes = read(execution.phaseOutcomes);
  const freeze = read(execution.freeze), capacity = read(execution.capacity), ledger = read(execution.ledger), pilotReview = read(execution.pilotReview);
  check(decision.schemaVersion === 3 && decision.status === 'root-approved' && decision.approvedBy === 'root' && decision.cohort === 'swe' && decision.split === 'confirmation_holdout' &&
    decision.freshPhaseOnly === true && decision.automaticRetry === false && decision.maxConcurrency === 2 && decision.maxActivePerCampaign === 1 &&
    decision.schedulingPolicy === ROLLING_POLICY && decision.timingRegime === ROLLING, 'Fresh confirmation48 rolling decision required; midpilot/resume unsupported');
  check(execution.freeze.sha256 === inventory.suiteFreezeSha256 && decision.suiteFreezeSha256 === inventory.suiteFreezeSha256, 'Rolling frozen schedule binding differs');
  const selected = freeze.schedule.filter(cell => cell.cohort === 'swe' && cell.split === 'confirmation_holdout');
  const phaseIds = data.rows.filter(row => row.cohort === 'swe' && row.split === 'confirmation_holdout').map(row => `${row.campaignId}/${row.slotId}`);
  check(selected.length === 48 && new Set(selected.map(cell => cell.id)).size === 48, 'Fresh frozen confirmation48 required');
  equal(decision.selectedCellIds, selected.map(cell => cell.id)); equal(sorted(decision.selectedCellIds), sorted(phaseIds));
  equal(decision.selectedCells, selected.map(cell => ({ cellId: cell.id, campaignId: cell.campaignId, frozenOrdinal: cell.ordinal })));
  check(!data.infrastructure.some(entry => phaseIds.includes(entry.id)), 'Unsupported SWE signed-infrastructure rolling timing provenance');
  check(decision.amendmentSha256 === execution.amendment.sha256 && amendment.schemaVersion === 3 && amendment.status === 'root-approved' && amendment.approvedBy === 'root' &&
    amendment.suiteFreezeSha256 === inventory.suiteFreezeSha256 && amendment.timingRegime === ROLLING && amendment.schedulingPolicy === ROLLING_POLICY && amendment.maxConcurrency === 2 && amendment.maxActivePerCampaign === 1 && amendment.freshPhaseOnly === true &&
    amendment.priorEvidencePolicy === 'immutable-quality-only; inherited timing regimes unchanged' && amendment.initialEvidenceDigest === decision.initialEvidenceDigest,
    'Rolling amendment approval/policy differs');
  equal(amendment.selectedCellIds, decision.selectedCellIds);
  equal(execution.artifactFiles, decision.artifacts);
  for (const ref of execution.artifactFiles) bytes(ref);
  check(decision.artifacts.some(ref => ref.path === execution.controllerArtifact.path && ref.sha256 === execution.controllerArtifact.sha256), 'Rolling controller artifact missing from approval');
  check(execution.controllerArtifact.path.replaceAll('\\', '/').endsWith('/execution/rolling-suite-controller-v3/controller.mjs'), 'Exact v3 controller artifact required');
  for (const [name, ref] of [['capacity', execution.capacity], ['ledger', execution.ledger], ['pilotReview', execution.pilotReview]]) check(decision[`${name}Sha256`] === ref.sha256, 'Rolling approved prerequisite binding differs');
  check(capacity.status === 'root-approved' && capacity.approvedBy === 'root' && capacity.cohort === 'swe' && capacity.split === 'confirmation_holdout' && capacity.maxConcurrency === 2 &&
    Number.isSafeInteger(capacity.cMinimumBytes) && Number.isSafeInteger(capacity.dMinimumBytes) && capacity.cMinimumBytes >= 20 * 1024 ** 3 && capacity.dMinimumBytes >= 36 * 1024 ** 3, 'Rolling root capacity C20/D36GiB required');
  check(ledger.status === 'root-approved' && pilotReview.status === 'root-reviewed-pilot' && pilotReview.approvedBy === 'root', 'Closed rolling ledger/root-reviewed pilot required');
  check(owner.schemaVersion === 3 && owner.controllerSha256 === execution.controllerArtifact.sha256 && owner.decisionSha256 === execution.decision.sha256 &&
    exit.schemaVersion === 3 && exit.pid === owner.pid && exit.controllerNonce === owner.nonce && exit.cohort === 'swe' && exit.split === 'confirmation_holdout' && exit.timingRegime === ROLLING && exit.failure === null &&
    exit.allAdmittedChildrenClosedBeforeRelease === true && exit.status === 'phase-accounted-closure-with-infrastructure', 'Closed successful rolling ownership/exit required');
  const start = time(owner.at), end = time(exit.at); check(end >= start, 'Rolling controller interval differs');
  check(initial.selected.unvisited === 48 && initial.selected.modelTerminal === 0 && initial.selected.signedPreparationFailures === 0, 'Rolling fresh initial phase required; resume unsupported');
  equal(initial.selectedCellIds, decision.selectedCellIds);
  equal(initial.accountedIds, decision.initialAccountedIds);
  equal(sorted(initial.accountedIds), sorted(data.rows.filter(row => !phaseIds.includes(`${row.campaignId}/${row.slotId}`)).map(row => `${row.campaignId}/${row.slotId}`)));
  equal(sorted(initial.knownInfraIds), sorted(data.infrastructure.map(row => row.id)));
  equal(sorted([...initial.modelTerminalIds, ...initial.knownInfraIds]), sorted(initial.accountedIds));
  check(initial.modelTerminalIds.length === decision.expectedStartingModelTerminalCount && hash(initial.snapshot) === decision.initialEvidenceDigest, 'Exact approved initial boundary differs');
  check(origin.schemaVersion === 3 && origin.initialBoundarySha256 === execution.initialBoundary.sha256 && origin.initialEvidenceDigest === hash(initial.snapshot) &&
    origin.priorEvidencePolicy === 'immutable-quality-only; inherited timing regimes unchanged' && origin.newTimingRegime === ROLLING && origin.amendmentSha256 === execution.amendment.sha256,
    'Rolling quality-only origin differs; prior timings must retain original authority');
  equal(origin.selectedCellIds, decision.selectedCellIds); equal(origin.priorModelTerminalIds, initial.modelTerminalIds); equal(origin.priorKnownInfraIds, initial.knownInfraIds);
  check(final.completeSuiteVerified === true && final.campaignCount === 8 && final.state && final.state.counts.unvisited === 0, 'Full all-closed rolling phase verification required');
  equal(final.state.selected, { planned: 48, modelTerminal: 48, signedPreparationFailures: 0, unvisited: 0 });
  equal(sorted(final.state.modelTerminalIds), sorted([...initial.modelTerminalIds, ...phaseIds]));
  equal(final.state.knownInfraIds, initial.knownInfraIds);
  equal(sorted(final.state.accountedIds), sorted(data.rows.map(row => `${row.campaignId}/${row.slotId}`)));
  equal(sorted(final.admittedCellIds), sorted(phaseIds)); equal(sorted(final.acceptedCellIds), sorted(phaseIds)); equal(sorted(final.exactlyAddedSelectedCellIds), sorted(phaseIds));
  check(outcomes.schemaVersion === 3 && outcomes.timingRegime === ROLLING, 'Rolling phase outcomes required');
  check(execution.jobs.length === 48, 'Every48 rolling child receipt chain required');
  const jobs = execution.jobs.map(job => ({ refs: job, admission: read(job.admission), reservation: read(job.reservation), timing: read(job.timing), start: read(job.start), exit: read(job.exit), result: read(job.result), accepted: read(job.accepted) }));
  const byJob = new Map(jobs.map(job => [job.reservation.jobId, job]));
  check(byJob.size === 48, 'Duplicate rolling job');
  const journal = lines(execution.receiptJournal), capacityRows = lines(execution.capacityLedger);
  check(journal.every((event, index) => event.schemaVersion === 3 && event.sequence === index + 1 && event.controllerNonce === owner.nonce), 'Ordered owner-bound rolling journal required');
  check(journal.every(event => time(event.at) >= start && time(event.at) <= end), 'Rolling journal outside owned controller interval');
  for (let i = 1; i < journal.length; i++) check(time(journal[i].at) >= time(journal[i - 1].at), 'Rolling journal chronology differs');
  const issued = new Set(), closed = new Set(), accepted = new Set(), records = new Map();
  for (const event of journal) {
    if (event.event === 'admission-issued') {
      const job = byJob.get(event.jobId), r = job?.reservation, a = job?.admission;
      check(job && r.issuanceOrdinal === issued.size + 1 && r.jobId === `job-${String(r.issuanceOrdinal).padStart(4, '0')}` && !issued.has(r.jobId), 'Rolling journal issuance order differs');
      check(a.schemaVersion === 3 && r.schemaVersion === 3 && a.issuanceOrdinal === r.issuanceOrdinal && a.controllerNonce === owner.nonce && r.controllerNonce === owner.nonce &&
        a.controllerPid === owner.pid && r.controllerPid === owner.pid && a.decisionSha256 === execution.decision.sha256 && r.decisionSha256 === execution.decision.sha256 &&
        r.admissionSha256 === job.refs.admission.sha256 && r.admissionFile === path.basename(job.refs.admission.path), 'Rolling admission owner/decision binding differs');
      const active = [...issued].filter(id => !accepted.has(id));
      check(active.length < 2, 'Rolling admission exceeds capacity');
      equal(a.activeReservations.map(row => row.jobId), active); equal(r.activeAtAdmission, active); equal(event.activeAtAdmission, active);
      equal(a.acceptedCellIds, [...accepted].map(id => byJob.get(id).reservation.cellId));
      equal(a.acceptedClosed.map(row => row.jobId), [...accepted]);
      for (const entry of [...a.activeReservations, ...a.acceptedClosed]) {
        const prior = byJob.get(entry.jobId); check(entry.cellId === prior.reservation.cellId && entry.reservationPath === prior.refs.reservation.path && entry.reservationSha256 === prior.refs.reservation.sha256, 'Rolling admission prior reservation differs');
        if (accepted.has(entry.jobId)) check(entry.resultPath === prior.refs.result.path && entry.resultSha256 === prior.refs.result.sha256, 'Rolling admission accepted result differs');
      }
      const protectedExpected = [...initial.snapshot, ...[...accepted].flatMap(id => byJob.get(id).result.snapshot)];
      equal(a.protectedSnapshot, protectedExpected);
      const activeCampaigns = new Set(active.map(id => byJob.get(id).reservation.campaignId));
      const candidate = selected.find(cell => ![...issued].some(id => byJob.get(id).reservation.cellId === cell.id) && !activeCampaigns.has(cell.campaignId));
      check(candidate && candidate.id === r.cellId && candidate.campaignId === r.campaignId && candidate.ordinal === r.frozenOrdinal && event.cellId === r.cellId && event.reservationSha256 === job.refs.reservation.sha256,
        'Rolling earliest frozen eligible reservation differs');
      const disk = capacityRows[r.issuanceOrdinal - 1];
      check(disk && disk.issuanceOrdinal === r.issuanceOrdinal && disk.cellId === r.cellId && disk.admitted === true && disk.error === null &&
        BigInt(disk.minimumBytes.c) === BigInt(capacity.cMinimumBytes) && BigInt(disk.minimumBytes.d) === BigInt(capacity.dMinimumBytes) &&
        BigInt(disk.freeBytes.c) >= BigInt(disk.minimumBytes.c) && BigInt(disk.freeBytes.d) >= BigInt(disk.minimumBytes.d), 'Rolling disk admission capacity differs');
      const t = job.timing, result = job.result, s = job.start, x = job.exit, receipt = job.accepted;
      check(t.schemaVersion === 3 && t.jobId === r.jobId && t.cellId === r.cellId && t.frozenOrdinal === r.frozenOrdinal && t.reservationSha256 === job.refs.reservation.sha256 &&
        t.amendmentSha256 === execution.amendment.sha256 && t.timingRegime === ROLLING && t.schedulingPolicy === ROLLING_POLICY && t.maxConcurrency === 2 && t.maxActivePerCampaign === 1, 'Rolling job timing binding differs');
      equal(t.activeAtAdmission, active);
      check(Number.isSafeInteger(s.pid) && s.pid > 0 && s.pid === x.pid && s.controllerPid === owner.pid && s.reservationPath === job.refs.reservation.path && s.reservationSha256 === job.refs.reservation.sha256 && s.startedAt === x.startedAt && x.code === 0 && x.signal === null && x.spawnError === null && x.bookkeepingError === null,
        'Exact owned successful rolling worker start/exit required');
      check(start <= time(r.reservedAt) && time(r.reservedAt) <= time(event.at) && time(event.at) <= time(s.startedAt) && time(s.startedAt) <= time(t.startedAt) && time(t.startedAt) <= time(result.completedAt) && time(result.completedAt) <= time(x.finishedAt) && time(x.finishedAt) <= end && time(x.finishedAt) > time(s.startedAt), 'Rolling closed worker interval chronology differs');
      check(result.schemaVersion === 3 && result.jobId === r.jobId && result.cellId === r.cellId && result.accepted === true && result.reservationSha256 === job.refs.reservation.sha256 &&
        receipt.schemaVersion === 3 && receipt.jobId === r.jobId && receipt.cellId === r.cellId && receipt.closedAt === x.finishedAt && receipt.reservationPath === job.refs.reservation.path && receipt.reservationSha256 === job.refs.reservation.sha256 && receipt.resultPath === job.refs.result.path && receipt.resultSha256 === job.refs.result.sha256 && receipt.resultEvidenceDigest === hash(result.snapshot), 'Rolling closed accepted result binding differs');
      equal(receipt.namespace, result.namespace);
      records.set(r.jobId, { job, cell: { cellId: r.cellId, conditionId: execution.conditionId, executionId: execution.id, jobId: r.jobId,
        evidenceSha256: execution.verifyEnd.sha256, timingReceiptSha256: job.refs.timing.sha256, admissionSha256: job.refs.admission.sha256, acceptedSha256: job.refs.accepted.sha256,
        startReceiptSha256: job.refs.start.sha256, exitReceiptSha256: job.refs.exit.sha256, waveId: null, admittedWaveCellIds: null,
        activeAtAdmission: r.activeAtAdmission, workerStartedAt: s.startedAt, workerClosedAt: x.finishedAt } });
      issued.add(r.jobId);
    } else if (event.event === 'worker-closed') {
      const record = records.get(event.jobId); check(record && !closed.has(event.jobId) && event.cellId === record.cell.cellId && event.status === 'fulfilled' && event.pid === record.job.exit.pid && event.code === 0 && event.signal === null && event.spawnError === null && event.bookkeepingError === null && event.startedAt === record.job.start.startedAt && event.finishedAt === record.job.exit.finishedAt, 'Rolling worker close journal differs');
      check(time(event.at) >= time(record.job.exit.finishedAt), 'Rolling worker journal precedes close'); closed.add(event.jobId);
    } else if (event.event === 'result-accepted') {
      const record = records.get(event.jobId); check(record && closed.has(event.jobId) && !accepted.has(event.jobId) && event.cellId === record.cell.cellId && event.resultSha256 === record.job.refs.result.sha256 && time(record.job.accepted.acceptedAt) >= time(record.job.exit.finishedAt) && time(event.at) >= time(record.job.accepted.acceptedAt), 'Rolling acceptance precedes close or result differs');
      accepted.add(event.jobId);
    } else {
      check(event.event === 'all-children-closed' && closed.size === 48 && accepted.size === 48, 'Unsupported stopped/failed or unclosed rolling journal');
      equal(event.admittedJobIds, [...issued]); equal(event.acceptedJobIds, [...accepted]);
    }
  }
  check(journal.at(-1).event === 'all-children-closed' && issued.size === 48 && accepted.size === 48 && capacityRows.length === 48, 'Complete rolling journal closure required');
  equal(sorted(exit.admittedJobIds), sorted([...issued])); equal(sorted(exit.acceptedJobIds), sorted([...accepted]));
  check(exit.finalVerifiedState === execution.verifyEnd.path && exit.ledgerSha256 === execution.ledger.sha256, 'Rolling final verified state/ledger binding differs');
  equal(exit.finalPins, [execution.verifyEnd, execution.phaseOutcomes, execution.initialBoundary, execution.origin, execution.receiptJournal]);
  equal(final.acceptedReceipts, [...accepted].map(jobId => ({ path: byJob.get(jobId).refs.accepted.path, sha256: byJob.get(jobId).refs.accepted.sha256 })));
  equal(outcomes.selectedCellIds, decision.selectedCellIds);
  check(outcomes.amendmentSha256 === execution.amendment.sha256 && outcomes.outcomes.length === 48, 'Rolling phase outcomes binding differs');
  for (const row of outcomes.outcomes) {
    const job = byJob.get(row.jobId); check(job && row.id === job.reservation.cellId && row.metadataHash === job.result.metadataHash && row.receiptHash === job.result.receiptHash && row.timingRegime === ROLLING, 'Rolling phase outcome/result binding differs');
    const sourceRow = data.rows.find(item => `${item.campaignId}/${item.slotId}` === row.id);
    check(row.campaignId === sourceRow.campaignId && row.taskId === sourceRow.taskId && row.modelId === sourceRow.modelId && row.arm === sourceRow.arm, 'Rolling phase outcome/public row identity differs');
  }
  equal(sorted(outcomes.outcomes.map(row => row.id)), sorted(phaseIds));
  equal(sorted([...records.values()].map(record => record.cell.cellId)), sorted(phaseIds));
  for (const key of ['session', 'home', 'source', 'attempt']) check(new Set(jobs.map(job => job.result.namespace[key])).size === 48 && jobs.every(job => job.result.namespace[key]), 'Rolling duplicate/missing closed namespace');
  return { condition: { id: execution.conditionId, timingRegime: ROLLING, maxConcurrency: 2, maxActivePerCampaign: 1, schedulingPolicy: ROLLING_POLICY, amendmentSha256: execution.amendment.sha256 },
    cells: [...records.values()].map(record => record.cell), interval: { id: execution.id, conditionId: execution.conditionId, startedAt: owner.at, completedAt: exit.at, evidenceSha256: execution.exit.sha256 } };
}
