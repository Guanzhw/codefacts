import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { selectNext } from './scheduler.mjs';
export const hash = value => crypto.createHash('sha256').update(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const sha = file => hash(fs.readFileSync(file));
export const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
export const equal = (a, b) => hash(a) === hash(b);
export const absolute = value => { if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Absolute path required'); return value; };
export function assertPins(pins) { for (const row of pins) if (sha(absolute(row.path)) !== row.sha256) throw new Error('Receipt/source pin differs: ' + row.path); }
export function assertClosedLifecycle(start, exit, observed, reservation, owner, node) {
  if (start.controllerPid !== owner.pid || start.node !== node || start.pid !== observed.pid || !Number.isInteger(start.pid) || start.pid < 1 ||
    path.resolve(start.reservationPath) !== path.resolve(reservation.reservationPath) || start.reservationSha256 !== reservation.reservationSha256 ||
    start.startedAt !== observed.startedAt || exit.startedAt !== observed.startedAt || exit.finishedAt !== observed.finishedAt ||
    exit.pid !== observed.pid || exit.code !== 0 || exit.signal !== null || exit.spawnError !== null || exit.bookkeepingError !== null ||
    !Number.isFinite(Date.parse(exit.startedAt)) || !Number.isFinite(Date.parse(exit.finishedAt)) || Date.parse(exit.finishedAt) < Date.parse(exit.startedAt)) throw new Error('Closed lifecycle receipt differs from observed child close');
}
export function assertPolicy(decision, selected) {
  if (decision.schemaVersion !== 3 || decision.cohort !== 'swe' || decision.split !== 'confirmation_holdout' || selected.length !== 48 ||
    decision.maxConcurrency !== 2 || decision.maxActivePerCampaign !== 1 || decision.schedulingPolicy !== 'frozen-order-distinct-campaign-rolling' ||
    decision.timingRegime !== 'parallel-rolling-user-amended' || decision.freshPhaseOnly !== true || decision.automaticRetry !== false ||
    !equal(decision.selectedCellIds, selected.map(row => row.id)) ||
    !equal(decision.selectedCells, selected.map(row => ({ cellId: row.id, campaignId: row.campaignId, frozenOrdinal: row.ordinal })))) throw new Error('Fresh full SWE confirmation48 rolling policy required; resume/midpilot forbidden');
}
export function assertCapacity(capacity, decision) {
  if (capacity.status !== 'root-approved' || capacity.approvedBy !== 'root' || capacity.cohort !== decision.cohort || capacity.split !== decision.split ||
    capacity.maxConcurrency !== 2 || !Number.isSafeInteger(capacity.cMinimumBytes) || !Number.isSafeInteger(capacity.dMinimumBytes) ||
    capacity.cMinimumBytes < 20 * 1024 ** 3 || capacity.dMinimumBytes < 36 * 1024 ** 3) throw new Error('Root capacity C20/D36GiB required');
}
export function assertAdmission(admission, reservation, selected, owner, decisionSha256) {
  if (admission.schemaVersion !== 3 || reservation.schemaVersion !== 3 || !/^job-[0-9]{4}$/.test(reservation.jobId) ||
    reservation.jobId !== 'job-' + String(reservation.issuanceOrdinal).padStart(4, '0') ||
    admission.issuanceOrdinal !== reservation.issuanceOrdinal || admission.controllerNonce !== owner.nonce || reservation.controllerNonce !== owner.nonce ||
    admission.controllerPid !== owner.pid || reservation.controllerPid !== owner.pid || admission.decisionSha256 !== decisionSha256 ||
    reservation.decisionSha256 !== decisionSha256) throw new Error('Admission owner/decision/ordinal binding differs');
  const active = admission.activeReservations;
  if (active.length > 1 || new Set(active.map(row => row.jobId)).size !== active.length ||
    !equal(reservation.activeAtAdmission, active.map(row => row.jobId)) ||
    !equal(admission.acceptedCellIds, admission.acceptedClosed.map(row => row.cellId)) ||
    admission.acceptedClosed.length + active.length !== reservation.issuanceOrdinal - 1 ||
    new Set([...admission.acceptedClosed, ...active].map(row => row.jobId)).size !== reservation.issuanceOrdinal - 1 ||
    new Set([...admission.acceptedClosed, ...active].map(row => row.cellId)).size !== reservation.issuanceOrdinal - 1 ||
    [...admission.acceptedClosed, ...active].some(row => !selected.some(cell => cell.id === row.cellId)) ||
    active.some(row => selected.find(cell => cell.id === row.cellId).campaignId !== row.campaignId) ||
    [...admission.acceptedClosed, ...active].some(row => !/^job-[0-9]{4}$/.test(row.jobId) || Number(row.jobId.slice(4)) < 1 || Number(row.jobId.slice(4)) >= reservation.issuanceOrdinal)) throw new Error('Exact accepted/active admission inventory differs');
  const expected = selectNext(selected, admission.acceptedCellIds, active);
  if (!expected || expected.id !== reservation.cellId || expected.campaignId !== reservation.campaignId || expected.ordinal !== reservation.frozenOrdinal) throw new Error('Worker differs from earliest frozen eligible admission');
}
export function assertNamespaces(rows) {
  for (const key of ['session', 'home', 'source', 'attempt']) {
    const seen = new Set();
    for (const row of rows) { const value = row.namespace[key]; if (!value || seen.has(value)) throw new Error('Duplicate or missing closed namespace: ' + key); seen.add(value); }
  }
}
/** Presence only: never reads registered active slot metadata. */
export function assertAllocatedInventory(schedule, attemptDir, allowedIds) {
  const allowed = new Set(allowedIds);
  for (const cell of schedule) if (!allowed.has(cell.id) && fs.existsSync(attemptDir(cell))) throw new Error('Unallocated/unknown produced slot: ' + cell.id);
}
