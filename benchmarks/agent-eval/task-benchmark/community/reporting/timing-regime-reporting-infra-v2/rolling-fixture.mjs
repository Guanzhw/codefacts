// Pure fake288 receipt construction. Receipts are written only by the caller's isolated writer.
import crypto from 'node:crypto';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = n => new Date(Date.parse('2026-02-01T00:00:00.000Z') + n).toISOString();
export function rollingFixture(data, oldInventory, write, load) {
  const inventory = structuredClone(oldInventory);
  inventory.executions = inventory.executions.filter(execution => execution.id !== 'confirmation');
  const selected = data.rows.filter(row => row.cohort === 'swe' && row.split === 'confirmation_holdout').map((row, i) => ({ id: `${row.campaignId}/${row.slotId}`, campaignId: row.campaignId, ordinal: i + 241, cohort: 'swe', split: 'confirmation_holdout' }));
  const selectedIds = selected.map(row => row.id), prior = data.rows.filter(row => !selectedIds.includes(`${row.campaignId}/${row.slotId}`)).map(row => `${row.campaignId}/${row.slotId}`);
  const known = data.infrastructure.map(row => row.id), modelTerminalIds = prior.filter(id => !known.includes(id));
  const initialObject = { schemaVersion: 3, modelTerminalIds, knownInfraIds: known, accountedIds: [...known, ...modelTerminalIds], selectedCellIds: selectedIds, snapshot: [],
    selected: { unvisited: 48, modelTerminal: 0, signedPreparationFailures: 0 }, counts: { unvisited: 48 } };
  const freeze = write('rolling-freeze.json', { schedule: selected });
  // The inventory's fake freeze pin must also bind the old pilot's fake approval.
  inventory.suiteFreezeSha256 = freeze.sha256;
  const pilot = inventory.executions[0];
  // Only synthetic receipt objects are copied/rebound; original v1 fixture remains unchanged.
  const oldAmendment = load(pilot.amendment); oldAmendment.suiteFreezeSha256 = freeze.sha256; pilot.amendment = write('rolling-old-pilot-amendment.json', oldAmendment);
  const oldDecision = load(pilot.decision); oldDecision.suiteFreezeSha256 = freeze.sha256; oldDecision.amendmentSha256 = pilot.amendment.sha256; pilot.decision = write('rolling-old-pilot-decision.json', oldDecision);
  const oldOrigin = load(pilot.origin); oldOrigin.amendmentSha256 = pilot.amendment.sha256; pilot.origin = write('rolling-old-pilot-origin.json', oldOrigin);
  const oldOwner = load(pilot.owner); oldOwner.decisionSha256 = pilot.decision.sha256; pilot.owner = write('rolling-old-pilot-owner.json', oldOwner);
  for (const [wi, wave] of pilot.waves.entries()) for (const [ji, job] of wave.jobs.entries()) {
    const reservation = load(job.reservation); reservation.decisionSha256 = pilot.decision.sha256; job.reservation = write(`rolling-old-${wi}-${ji}-reservation.json`, reservation);
    const timing = load(job.timing); timing.amendmentSha256 = pilot.amendment.sha256; job.timing = write(`rolling-old-${wi}-${ji}-timing.json`, timing);
  }
  const capacity = write('rolling-capacity.json', { status: 'root-approved', approvedBy: 'root', cohort: 'swe', split: 'confirmation_holdout', maxConcurrency: 2, cMinimumBytes: 20 * 1024 ** 3, dMinimumBytes: 36 * 1024 ** 3 });
  const ledger = write('rolling-ledger.json', { status: 'root-approved' }), pilotReview = write('rolling-pilot-review.json', { status: 'root-reviewed-pilot', approvedBy: 'root' });
  const controller = write('execution/rolling-suite-controller-v3/controller.mjs', { synthetic: 'controller' });
  const amendment = write('rolling-amendment.json', { schemaVersion: 3, status: 'root-approved', approvedBy: 'root', suiteFreezeSha256: freeze.sha256, selectedCellIds: selectedIds,
    timingRegime: 'parallel-rolling-user-amended', schedulingPolicy: 'frozen-order-distinct-campaign-rolling', maxConcurrency: 2, maxActivePerCampaign: 1, freshPhaseOnly: true,
    priorEvidencePolicy: 'immutable-quality-only; inherited timing regimes unchanged', initialEvidenceDigest: hash(initialObject.snapshot) });
  const decision = write('rolling-decision.json', { schemaVersion: 3, status: 'root-approved', approvedBy: 'root', suiteFreezeSha256: freeze.sha256, cohort: 'swe', split: 'confirmation_holdout',
    freshPhaseOnly: true, automaticRetry: false, maxConcurrency: 2, maxActivePerCampaign: 1, timingRegime: 'parallel-rolling-user-amended', schedulingPolicy: 'frozen-order-distinct-campaign-rolling',
    selectedCellIds: selectedIds, selectedCells: selected.map(row => ({ cellId: row.id, campaignId: row.campaignId, frozenOrdinal: row.ordinal })), artifacts: [controller],
    initialAccountedIds: initialObject.accountedIds, expectedStartingModelTerminalCount: modelTerminalIds.length, initialEvidenceDigest: hash(initialObject.snapshot),
    amendmentSha256: amendment.sha256, capacitySha256: capacity.sha256, ledgerSha256: ledger.sha256, pilotReviewSha256: pilotReview.sha256 });
  const ownerObject = { schemaVersion: 3, pid: 321, nonce: 'fake-rolling-owner', at: iso(0), controllerSha256: controller.sha256, decisionSha256: decision.sha256 };
  const initialBoundary = write('rolling-boundary.json', initialObject);
  const execution = { id: 'fresh-confirmation-v3', conditionId: 'rolling-confirmation-v3', decision, amendment, freeze, capacity, ledger, pilotReview, artifactFiles: [controller], controllerArtifact: controller,
    owner: write('rolling-owner.json', ownerObject), initialBoundary,
    origin: write('rolling-origin.json', { schemaVersion: 3, initialBoundarySha256: initialBoundary.sha256, initialEvidenceDigest: hash(initialObject.snapshot),
      priorEvidencePolicy: 'immutable-quality-only; inherited timing regimes unchanged', priorModelTerminalIds: modelTerminalIds, priorKnownInfraIds: known, newTimingRegime: 'parallel-rolling-user-amended', selectedCellIds: selectedIds, amendmentSha256: amendment.sha256 }), jobs: [] };
  const issued = [], active = [], accepted = [], journal = [], capacityRows = [];
  let now = 10, sequence = 0;
  const event = (type, fields) => journal.push({ schemaVersion: 3, sequence: ++sequence, at: iso(now), controllerNonce: ownerObject.nonce, event: type, ...fields });
  while (accepted.length < 48) {
    const candidate = active.length < 2 && selected.find(cell => !issued.includes(cell.id) && !active.some(job => job.cell.campaignId === cell.campaignId));
    if (candidate) {
      const ordinal = issued.length + 1, jobId = `job-${String(ordinal).padStart(4, '0')}`, activeIds = active.map(job => job.jobId);
      const admissionFile = `admission-${String(ordinal).padStart(4, '0')}.json`;
      const admission = write(admissionFile, { schemaVersion: 3, controllerNonce: ownerObject.nonce, controllerPid: ownerObject.pid, decisionSha256: decision.sha256, issuanceOrdinal: ordinal,
        acceptedClosed: accepted.map(job => ({ jobId: job.jobId, cellId: job.cell.id, reservationPath: job.refs.reservation.path, reservationSha256: job.refs.reservation.sha256, resultPath: job.refs.result.path, resultSha256: job.refs.result.sha256 })),
        activeReservations: active.map(job => ({ jobId: job.jobId, cellId: job.cell.id, campaignId: job.cell.campaignId, reservationPath: job.refs.reservation.path, reservationSha256: job.refs.reservation.sha256 })), acceptedCellIds: accepted.map(job => job.cell.id), protectedSnapshot: [] });
      const reservation = write(`${jobId}-reservation.json`, { schemaVersion: 3, jobId, cellId: candidate.id, campaignId: candidate.campaignId, frozenOrdinal: candidate.ordinal, issuanceOrdinal: ordinal,
        controllerNonce: ownerObject.nonce, controllerPid: ownerObject.pid, decisionSha256: decision.sha256, admissionFile, admissionSha256: admission.sha256, reservedAt: iso(now), activeAtAdmission: activeIds });
      const finished = now + (ordinal === 1 ? 1000 : 10), namespace = Object.fromEntries(['session', 'home', 'source', 'attempt'].map(key => [key, `${key}-${jobId}`]));
      const resultObject = { schemaVersion: 3, jobId, cellId: candidate.id, accepted: true, completedAt: iso(finished - 1), reservationSha256: reservation.sha256, snapshot: [], metadataHash: 'a'.repeat(64), receiptHash: 'b'.repeat(64), requestHash: 'c'.repeat(64), namespace };
      const refs = { admission, reservation,
        timing: write(`${jobId}-timing.json`, { schemaVersion: 3, jobId, cellId: candidate.id, frozenOrdinal: candidate.ordinal, timingRegime: 'parallel-rolling-user-amended', schedulingPolicy: 'frozen-order-distinct-campaign-rolling', maxConcurrency: 2, maxActivePerCampaign: 1, activeAtAdmission: activeIds, reservationSha256: reservation.sha256, amendmentSha256: amendment.sha256, startedAt: iso(now + 2) }),
        start: write(`${jobId}-start.json`, { pid: 1000 + ordinal, controllerPid: ownerObject.pid, node: 'synthetic-node', startedAt: iso(now + 1), reservationPath: reservation.path, reservationSha256: reservation.sha256 }),
        exit: write(`${jobId}-exit.json`, { pid: 1000 + ordinal, code: 0, signal: null, spawnError: null, bookkeepingError: null, startedAt: iso(now + 1), finishedAt: iso(finished) }),
        result: write(`${jobId}-result.json`, resultObject) };
      const job = { cell: candidate, jobId, refs, finished, result: resultObject };
      event('admission-issued', { jobId, cellId: candidate.id, reservationSha256: reservation.sha256, activeAtAdmission: activeIds });
      capacityRows.push({ issuanceOrdinal: ordinal, cellId: candidate.id, admitted: true, error: null, freeBytes: { c: String(30 * 1024 ** 3), d: String(50 * 1024 ** 3) }, minimumBytes: { c: String(20 * 1024 ** 3), d: String(36 * 1024 ** 3) } });
      issued.push(candidate.id); active.push(job); now++;
    } else {
      active.sort((a, b) => a.finished - b.finished); const job = active.shift(); now = job.finished;
      event('worker-closed', { jobId: job.jobId, cellId: job.cell.id, status: 'fulfilled', ...load(job.refs.exit) }); now++;
      job.refs.accepted = write(`${job.jobId}-accepted.json`, { schemaVersion: 3, jobId: job.jobId, cellId: job.cell.id, closedAt: iso(job.finished), acceptedAt: iso(now),
        reservationPath: job.refs.reservation.path, reservationSha256: job.refs.reservation.sha256, resultPath: job.refs.result.path, resultSha256: job.refs.result.sha256, resultEvidenceDigest: hash(job.result.snapshot), namespace: job.result.namespace });
      event('result-accepted', { jobId: job.jobId, cellId: job.cell.id, resultSha256: job.refs.result.sha256 }); accepted.push(job); now++;
    }
  }
  event('all-children-closed', { admittedJobIds: issued.map(id => [...accepted, ...active].find(job => job.cell.id === id).jobId), acceptedJobIds: accepted.map(job => job.jobId) });
  const state = { modelTerminalIds: [...modelTerminalIds, ...selectedIds], knownInfraIds: known, accountedIds: [...initialObject.accountedIds, ...selectedIds], counts: { unvisited: 0 }, selected: { planned: 48, modelTerminal: 48, signedPreparationFailures: 0, unvisited: 0 } };
  execution.verifyEnd = write('rolling-verify-end.json', { completeSuiteVerified: true, campaignCount: 8, state, admittedCellIds: issued, acceptedCellIds: accepted.map(job => job.cell.id), exactlyAddedSelectedCellIds: selectedIds,
    acceptedReceipts: accepted.map(job => ({ path: job.refs.accepted.path, sha256: job.refs.accepted.sha256 })) });
  execution.phaseOutcomes = write('rolling-phase-outcomes.json', { schemaVersion: 3, timingRegime: 'parallel-rolling-user-amended', amendmentSha256: amendment.sha256, selectedCellIds: selectedIds,
    outcomes: accepted.map(job => { const row = data.rows.find(row => `${row.campaignId}/${row.slotId}` === job.cell.id); return { id: job.cell.id, campaignId: row.campaignId, taskId: row.taskId, modelId: row.modelId, arm: row.arm,
      jobId: job.jobId, timingRegime: 'parallel-rolling-user-amended', metadataHash: job.result.metadataHash, receiptHash: job.result.receiptHash }; }) });
  execution.receiptJournal = write('rolling-receipt-journal.jsonl', journal, true); execution.capacityLedger = write('rolling-capacity-ledger.jsonl', capacityRows, true);
  execution.exit = write('rolling-exit.json', { schemaVersion: 3, status: 'phase-accounted-closure-with-infrastructure', pid: ownerObject.pid, at: iso(now + 5), cohort: 'swe', split: 'confirmation_holdout', failure: null,
    controllerNonce: ownerObject.nonce, allAdmittedChildrenClosedBeforeRelease: true, timingRegime: 'parallel-rolling-user-amended', admittedJobIds: accepted.map(job => job.jobId), acceptedJobIds: accepted.map(job => job.jobId), finalVerifiedState: execution.verifyEnd.path,
    finalPins: [execution.verifyEnd, execution.phaseOutcomes, execution.initialBoundary, execution.origin, execution.receiptJournal], ledgerSha256: ledger.sha256 });
  execution.jobs = accepted.map(job => job.refs); inventory.executions.push(execution); return inventory;
}
