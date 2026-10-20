// Explicit file inventory only. Never discovers campaigns, attempts, model payloads or jobs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { validateMap } from './adapter.mjs';
import { assembleRolling } from './rolling-provenance.mjs';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (value, message) => { if (!value) throw new Error(message); };
const read = ref => {
  check(typeof ref?.path === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256 ?? ''), 'Explicit pinned file reference required');
  const bytes = fs.readFileSync(ref.path); check(digest(bytes) === ref.sha256, 'Timing source SHA-256 mismatch'); return JSON.parse(bytes);
};
const equal = (a, b) => assert.deepStrictEqual(a, b);

/** Inventory is ROOT-approved, summary-bound and names only CLOSED copied receipts.
 * serialGroups: [{conditionId, cohort, split:null|split, closure:{path,sha256}}]
 * executions: [{id, conditionId, decision, amendment, origin, owner, exit,
 *              waves:[{drain, jobs:[{reservation,timing,result}]}]}]
 * All receipt-valued fields use {path,sha256}. No model/raw/patch/trace refs.
 */
export function assembleMap(data, inventory) {
  check(inventory.schemaVersion === 1 && inventory.kind === 'closed-timing-source-inventory' && inventory.suiteId === data.suiteId && inventory.status === 'root-approved' && inventory.approvedBy === 'root', 'ROOT-approved closed timing inventory required');
  const map = { schemaVersion: 1, kind: 'closed-cell-timing-provenance', suiteId: data.suiteId, status: 'root-approved', approvedBy: 'root',
    summarySha256: inventory.summarySha256, suiteFreezeSha256: inventory.suiteFreezeSha256, conditions: [], cells: [], executionIntervals: [] };
  const cells = new Map(), conditions = new Map();
  const addCondition = condition => { if (conditions.has(condition.id)) equal(conditions.get(condition.id), condition); else { conditions.set(condition.id, condition); map.conditions.push(condition); } };
  const serial = (cellId, conditionId, evidenceSha256) => {
    const cell = { cellId, conditionId, evidenceSha256, waveId: null, admittedWaveCellIds: null, timingReceiptSha256: null };
    check(!cells.has(cellId), 'Duplicate/conflicting cell timing assignment'); cells.set(cellId, cell);
  };
  for (const group of inventory.serialGroups) {
    const closure = read(group.closure);
    check(closure.suiteId === data.suiteId && closure.status === 'root-approved', 'Historical serial closure identity differs');
    addCondition({ id: group.conditionId, timingRegime: 'serial-original', maxConcurrency: 1, maxActivePerCampaign: 1, schedulingPolicy: 'serial-original', amendmentSha256: null });
    const selected = data.rows.filter(row => row.cohort === group.cohort && (group.split === null || row.split === group.split));
    check(selected.length > 0, 'Historical serial selector empty');
    for (const row of selected) serial(`${row.campaignId}/${row.slotId}`, group.conditionId, group.closure.sha256);
  }
  for (const execution of inventory.executions) {
    if (read(execution.decision).schemaVersion === 3) {
      const rolling = assembleRolling(data, inventory, execution);
      addCondition(rolling.condition);
      for (const cell of rolling.cells) { check(!cells.has(cell.cellId), 'Duplicate/conflicting rolling timing assignment'); cells.set(cell.cellId, cell); }
      map.executionIntervals.push(rolling.interval); continue;
    }
    const decision = read(execution.decision), amendment = read(execution.amendment), origin = read(execution.origin), owner = read(execution.owner), exit = read(execution.exit);
    check(decision.schemaVersion === 2 && decision.status === 'root-approved' && decision.suiteFreezeSha256 === inventory.suiteFreezeSha256 && decision.amendmentSha256 === execution.amendment.sha256 && decision.maxConcurrency === 2 && decision.maxActivePerCampaign === 1, 'Controller decision policy/binding differs');
    check(amendment.status === 'root-approved' && amendment.suiteFreezeSha256 === inventory.suiteFreezeSha256 && amendment.timingRegime === 'parallel-user-amended', 'Amendment approval/freeze differs');
    check(origin.schemaVersion === 1 && origin.amendmentSha256 === execution.amendment.sha256 && origin.priorTimingRegime === 'serial-original' && origin.newTimingRegime === 'parallel-user-amended', 'Controller origin differs');
    equal([...origin.priorSelectedCellIds].sort(), [...amendment.serialOriginalCellIds].sort());
    equal([...decision.selectedCellIds].sort(), [...amendment.selectedCellIds].sort());
    const phaseIds = data.rows.filter(row => row.cohort === decision.cohort && row.split === decision.split).map(row => `${row.campaignId}/${row.slotId}`).sort();
    equal([...decision.selectedCellIds].sort(), phaseIds);
    check(!data.infrastructure.some(entry => phaseIds.includes(entry.id)), 'Unsupported SWE signed-infrastructure timing provenance: controller origin excludes signed cells; explicit new closure contract required');
    check(owner.schemaVersion === 2 && owner.controllerSha256 === decision.artifacts.controllerSha256 && owner.decisionSha256 === execution.decision.sha256 && exit.schemaVersion === 2 && exit.pid === owner.pid && exit.cohort === decision.cohort && exit.split === decision.split && exit.allAdmittedChildrenClosedBeforeRelease === true && exit.failure === null && ['phase-accounted-closure-with-infrastructure', 'drained-user-request'].includes(exit.status), 'Closed successful controller ownership/exit required');
    const start = Date.parse(owner.at), end = Date.parse(exit.at);
    check(Number.isFinite(start) && Number.isFinite(end) && end >= start, 'Controller interval differs');
    addCondition({ id: execution.conditionId, timingRegime: 'parallel-user-amended', maxConcurrency: 2, maxActivePerCampaign: 1, schedulingPolicy: decision.schedulingPolicy, amendmentSha256: execution.amendment.sha256 });
    if (origin.priorSelectedCellIds.length) {
      addCondition({ id: inventory.originSerialConditionId, timingRegime: 'serial-original', maxConcurrency: 1, maxActivePerCampaign: 1, schedulingPolicy: 'serial-original', amendmentSha256: null });
      for (const cellId of origin.priorSelectedCellIds) serial(cellId, inventory.originSerialConditionId, execution.origin.sha256);
    }
    const admitted = [];
    for (const wave of execution.waves) {
      const drain = read(wave.drain);
      check(drain.schemaVersion === 2 && drain.admissionError === null && drain.results.every(result => result.status === 'fulfilled'), 'Successful closed admitted wave required');
      equal([...drain.admittedCellIds].sort(), drain.results.map(result => result.cellId).sort());
      const jobIds = [];
      for (const job of wave.jobs) {
        const reservation = read(job.reservation), timing = read(job.timing), result = read(job.result);
        check(reservation.schemaVersion === 2 && reservation.controllerNonce === owner.nonce && reservation.controllerPid === owner.pid && reservation.decisionSha256 === execution.decision.sha256, 'Reservation/controller binding differs');
        check(reservation.waveId === drain.waveId && timing.schemaVersion === 1 && timing.waveId === drain.waveId && timing.cellId === reservation.cellId && timing.frozenOrdinal === reservation.frozenOrdinal && timing.amendmentSha256 === execution.amendment.sha256, 'Job timing/reservation binding differs');
        check(timing.timingRegime === 'parallel-user-amended' && timing.maxConcurrency === 2 && timing.maxActivePerCampaign === 1, 'Job timing policy differs');
        equal(reservation.waveCellIds, drain.plannedCellIds); equal(timing.waveCellIds, drain.plannedCellIds);
        check(result.schemaVersion === 2 && result.cellId === timing.cellId && result.accepted === true && Number.isFinite(Date.parse(result.completedAt)), 'Accepted closed job result required');
        const jobStart = Date.parse(timing.startedAt), jobEnd = Date.parse(result.completedAt);
        check(Number.isFinite(jobStart) && jobStart >= start && jobEnd >= jobStart && jobEnd <= end, 'Job time outside owned closed controller interval');
        check(decision.selectedCellIds.includes(timing.cellId) && !origin.priorSelectedCellIds.includes(timing.cellId) && !cells.has(timing.cellId), 'Job cell outside selected future/unique boundary');
        const cell = { cellId: timing.cellId, conditionId: execution.conditionId, evidenceSha256: wave.drain.sha256,
          timingReceiptSha256: job.timing.sha256, waveId: `${execution.id}-${drain.waveId}`, admittedWaveCellIds: drain.admittedCellIds };
        cells.set(cell.cellId, cell); jobIds.push(cell.cellId); admitted.push(cell.cellId);
      }
      equal(jobIds.sort(), [...drain.admittedCellIds].sort());
    }
    if (exit.status === 'phase-accounted-closure-with-infrastructure') equal([...origin.priorSelectedCellIds, ...admitted].sort(), phaseIds);
    map.executionIntervals.push({ id: execution.id, conditionId: execution.conditionId, startedAt: owner.at, completedAt: exit.at, evidenceSha256: execution.exit.sha256 });
  }
  map.cells = [...cells.values()].sort((a, b) => a.cellId.localeCompare(b.cellId));
  validateMap(data, map); return map;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 10 || args[0] !== '--data' || args[2] !== '--data-sha256' || args[4] !== '--inventory' || args[6] !== '--inventory-sha256' || args[8] !== '--output') throw new Error('Usage: --data public-data.json --data-sha256 HASH --inventory closed-inventory.json --inventory-sha256 HASH --output NEW-map.json');
  const map = assembleMap(read({ path: args[1], sha256: args[3] }), read({ path: args[5], sha256: args[7] }));
  const bytes = JSON.stringify(map, null, 2) + '\n'; fs.writeFileSync(args[9], bytes, { flag: 'wx' }); console.log(JSON.stringify({ output: args[9], sha256: digest(bytes), cells: map.cells.length }));
}
