// Pure reporting boundary. Inputs are explicitly supplied closed public projections.
import assert from 'node:assert/strict';

export const TIMES = ['modelTurnMs', 'dshDurationMs', 'slotWallMs', 'preparationAndSandboxMs', 'sourcePreparationMs', 'indexDurationMs', 'gradeDurationMs'];
const ARMS = ['ordinary', 'codefacts022', 'codegraph'];
const id = row => `${row.campaignId}/${row.slotId}`;
const key = row => JSON.stringify([row.modelId, row.cohort, row.split, row.taskId]);
const check = (value, message) => { if (!value) throw new Error(message); };
const num = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value);
const unique = values => new Set(values).size === values.length;
export const ROLLING = 'parallel-rolling-user-amended';
export const ROLLING_POLICY = 'frozen-order-distinct-campaign-rolling';

// Strict positive overlap: an exit and next start at the same instant share no time.
// A long job may meet several sequential peers; count the peak, not peer count.
export function observedOverlap(intervals) {
  return new Map(intervals.map(job => {
    const a = Date.parse(job.startedAt), b = Date.parse(job.completedAt);
    check(Number.isFinite(a) && Number.isFinite(b) && b > a, 'Positive closed worker interval required');
    const peers = intervals.filter(other => other !== job && Math.max(a, Date.parse(other.startedAt)) < Math.min(b, Date.parse(other.completedAt)));
    const events = [[a, 1], [b, -1]];
    for (const peer of peers) events.push([Math.max(a, Date.parse(peer.startedAt)), 1], [Math.min(b, Date.parse(peer.completedAt)), -1]);
    events.sort(([at, delta], [bt, other]) => at - bt || delta - other);
    let active = 0, peak = 0;
    for (const [, delta] of events) { active += delta; peak = Math.max(peak, active); }
    return [job.cellId, { actualOverlapConcurrency: peak, overlapPeerCellIds: peers.map(peer => peer.cellId).sort() }];
  }));
}
const avail = values => {
  const known = values.filter(num), sum = known.reduce((a, b) => a + b, 0);
  return { total: known.length === values.length && values.length ? sum : null, knownTotal: known.length ? sum : null, known: known.length, missing: values.length - known.length, knownMean: known.length ? sum / known.length : null };
};

// Clear time metrics throughout both primary and sensitivity/language panels and macros.
// Used for the equality assertion: every non-time accepted value must survive unchanged.
export function omitTimes(value) {
  if (Array.isArray(value)) return value.map(omitTimes);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([name]) => !TIMES.includes(name)).map(([name, child]) => [name, omitTimes(child)]));
  return value;
}

export function maskTiming(data) {
  const result = structuredClone(data);
  for (const row of result.rows) for (const metric of TIMES) row[metric] = null;
  return result;
}

/** Map authority belongs to ROOT. A hash authenticates bytes, not truth of the declaration.
 * Historical groups must explicitly enumerate IDs. Prospective cells carry job receipt
 * and drained-wave evidence; existing cells are never inferred serial by their age.
 */
export function validateMap(data, map) {
  check(map.schemaVersion === 1 && map.kind === 'closed-cell-timing-provenance' && map.suiteId === data.suiteId, 'Timing map identity differs');
  check(map.status === 'root-approved' && map.approvedBy === 'root' && hash(map.summarySha256) && hash(map.suiteFreezeSha256), 'ROOT-approved summary/freeze-bound timing map required');
  check(Array.isArray(map.conditions) && map.conditions.length && unique(map.conditions.map(c => c.id)), 'Unique timing conditions required');
  const conditions = new Map();
  for (const condition of map.conditions) {
    check(token(condition.id), 'Public condition ID required');
    check(['serial-original', 'parallel-user-amended', ROLLING].includes(condition.timingRegime), 'Unknown timing regime');
    check(condition.maxActivePerCampaign === 1, 'Single active cell per campaign required');
    if (condition.timingRegime === 'serial-original') check(condition.maxConcurrency === 1 && condition.schedulingPolicy === 'serial-original' && condition.amendmentSha256 === null, 'Serial condition differs');
    else check(condition.maxConcurrency === 2 && condition.schedulingPolicy === (condition.timingRegime === ROLLING ? ROLLING_POLICY : 'frozen-order-distinct-campaign-waves') && hash(condition.amendmentSha256), 'Parallel condition differs');
    // condition.id is explicit execution stratum: do not pool independent amendments.
    conditions.set(condition.id, condition);
  }
  check(Array.isArray(map.cells) && map.cells.length === data.rows.length && unique(map.cells.map(c => c.cellId)), 'One explicit timing entry per planned cell required');
  const rows = new Map(data.rows.map(row => [id(row), row]));
  const cells = new Map(map.cells.map(cell => [cell.cellId, cell]));
  for (const cell of map.cells) {
    const row = rows.get(cell.cellId), condition = conditions.get(cell.conditionId);
    check(row && condition && hash(cell.evidenceSha256), 'Unknown cell/condition or missing evidence hash');
    if (condition.timingRegime === 'serial-original') {
      check(cell.waveId === null && cell.admittedWaveCellIds === null && cell.timingReceiptSha256 === null, 'Serial cell cannot carry parallel wave data');
    } else if (condition.timingRegime === ROLLING) {
      check(cell.waveId === null && cell.admittedWaveCellIds === null && hash(cell.timingReceiptSha256), 'Rolling cannot carry wave membership');
      check(token(cell.executionId) && token(cell.jobId) && Array.isArray(cell.activeAtAdmission), 'Rolling admission context required');
      check(hash(cell.startReceiptSha256) && hash(cell.exitReceiptSha256) && hash(cell.admissionSha256) && hash(cell.acceptedSha256), 'Rolling closed worker evidence required');
    } else {
      check(token(cell.waveId) && hash(cell.timingReceiptSha256), 'Parallel job timing receipt required');
      const wave = cell.admittedWaveCellIds;
      check(Array.isArray(wave) && wave.length >= 1 && wave.length <= 2 && unique(wave) && wave.includes(cell.cellId), 'Explicit actual admitted wave required');
      check(wave.every(other => cells.get(other)?.conditionId === cell.conditionId && cells.get(other)?.waveId === cell.waveId), 'Wave members differ from cell timing mapping');
      check(wave.every(other => JSON.stringify(cells.get(other).admittedWaveCellIds) === JSON.stringify(wave)), 'Wave membership differs between cells');
      check(unique(wave.map(other => rows.get(other)?.campaignId)), 'Wave cannot share a campaign');
    }
  }
  const regimeRows = cohort => data.rows.filter(row => row.cohort === cohort).map(row => ({ row, regime: conditions.get(cells.get(id(row)).conditionId).timingRegime }));
  const context = regimeRows('context'), swe = regimeRows('swe');
  check(context.length === 144 && context.every(entry => entry.regime === 'serial-original'), 'Frozen timing amendment requires Context144 historical serial cells');
  check(swe.filter(entry => entry.row.split === 'pilot' && entry.regime === 'serial-original').length === 46, 'Frozen timing amendment requires exactly46 historical serial SWE pilot cells');
  const confirmation = swe.filter(entry => entry.row.split === 'confirmation_holdout');
  check(confirmation.every(entry => ['parallel-user-amended', ROLLING].includes(entry.regime)), 'Frozen SWE confirmation must be entirely prospective parallel');
  check(new Set(confirmation.map(entry => entry.regime)).size === 1, 'Midphase rolling switch/resume provenance unsupported');
  check(swe.filter(entry => entry.row.split === 'pilot').every(entry => entry.regime !== ROLLING), 'Midpilot rolling switch/resume provenance unsupported');
  check(Array.isArray(map.executionIntervals), 'Explicit execution intervals array required (may be empty)');
  for (const interval of map.executionIntervals) {
    check(token(interval.id) && conditions.has(interval.conditionId) && hash(interval.evidenceSha256), 'Execution interval provenance required');
    const start = Date.parse(interval.startedAt), end = Date.parse(interval.completedAt);
    check(Number.isFinite(start) && Number.isFinite(end) && end >= start, 'Closed execution interval required');
  }
  check(unique(map.executionIntervals.map(interval => interval.id)), 'Duplicate execution interval');
  const rolling = map.cells.filter(cell => conditions.get(cell.conditionId).timingRegime === ROLLING);
  if (rolling.length) {
    check(rolling.length === 48 && new Set(rolling.map(cell => cell.executionId)).size === 1 && new Set(rolling.map(cell => cell.conditionId)).size === 1, 'One fresh complete48 rolling confirmation required');
    check(unique(rolling.map(cell => cell.jobId)), 'Duplicate rolling worker identity');
    const intervals = rolling.map(cell => ({ cellId: cell.cellId, startedAt: cell.workerStartedAt, completedAt: cell.workerClosedAt }));
    const overlaps = observedOverlap(intervals);
    for (const cell of rolling) {
      const interval = map.executionIntervals.find(entry => entry.id === cell.executionId && entry.conditionId === cell.conditionId);
      check(interval && Date.parse(cell.workerStartedAt) >= Date.parse(interval.startedAt) && Date.parse(cell.workerClosedAt) <= Date.parse(interval.completedAt), 'Rolling worker outside owned controller interval');
      check(overlaps.get(cell.cellId).actualOverlapConcurrency <= 2, 'Rolling owned worker capacity exceeded');
      const campaign = rows.get(cell.cellId).campaignId;
      check(overlaps.get(cell.cellId).overlapPeerCellIds.every(peer => rows.get(peer).campaignId !== campaign), 'Rolling campaign workers overlap');
    }
  }
  return { conditions, cells };
}

export function deriveTiming(data, map) {
  const { conditions, cells } = validateMap(data, map);
  const infrastructure = new Set(data.infrastructure.map(entry => entry.id));
  const overlaps = observedOverlap(map.cells.filter(cell => conditions.get(cell.conditionId).timingRegime === ROLLING).map(cell => ({ cellId: cell.cellId, startedAt: cell.workerStartedAt, completedAt: cell.workerClosedAt })));
  const rows = data.rows.map(row => {
    const mapping = cells.get(id(row)), condition = conditions.get(mapping.conditionId);
    const rolling = condition.timingRegime === ROLLING;
    const admittedConcurrency = rolling ? overlaps.get(id(row)).actualOverlapConcurrency : mapping.admittedWaveCellIds?.length ?? 1;
    return { cellId: id(row), modelId: row.modelId, cohort: row.cohort, split: row.split, taskId: row.taskId, instanceId: row.instanceId, language: row.language, arm: row.arm,
      status: row.status, signedInfrastructure: infrastructure.has(id(row)), timingRegime: condition.timingRegime, conditionId: condition.id,
      // A two-cell wave and one-cell tail are different observed contention conditions.
      comparisonKey: JSON.stringify(rolling ? [condition.id, 'actual-owned-worker-overlap-peak', admittedConcurrency] : [condition.id, admittedConcurrency]), admittedConcurrency, waveId: mapping.waveId,
      ...(rolling ? { concurrencyBasis: 'actual-owned-worker-overlap-peak', configuredMaxConcurrency: 2, ...overlaps.get(id(row)), activeAtAdmission: mapping.activeAtAdmission,
        executionId: mapping.executionId, jobId: mapping.jobId, workerStartedAt: mapping.workerStartedAt, workerClosedAt: mapping.workerClosedAt } : {}),
      clocks: Object.fromEntries(TIMES.map(metric => { check(row[metric] === null || num(row[metric]), `Invalid ${metric}`); return [metric, row[metric]]; })) };
  });
  const tasks = new Map();
  for (const row of rows) { const k = key(row); if (!tasks.has(k)) tasks.set(k, []); tasks.get(k).push(row); }
  const pairs = [];
  for (const task of tasks.values()) {
    check(task.length === 3 && unique(task.map(row => row.arm)) && ARMS.every(arm => task.some(row => row.arm === arm)), 'Complete task/model/arm identities required');
    const ordinary = task.find(row => row.arm === 'ordinary');
    for (const arm of ARMS.slice(1)) {
      const treatment = task.find(row => row.arm === arm);
      const same = ordinary.comparisonKey === treatment.comparisonKey;
      const exclusion = ordinary.signedInfrastructure || treatment.signedInfrastructure ? 'signed-infrastructure-before-model' : !same ? 'cross-timing-condition' : null;
      const clocks = Object.fromEntries(TIMES.map(metric => {
        const a = ordinary.clocks[metric], b = treatment.clocks[metric];
        const reason = exclusion ?? (a === null || b === null ? 'missing-clock' : a === 0 ? 'zero-baseline' : null);
        return [metric, { ordinary: a, treatment: b, ratio: reason === null ? b / a : null, reason }];
      }));
      pairs.push({ modelId: ordinary.modelId, cohort: ordinary.cohort, split: ordinary.split, taskId: ordinary.taskId, arm, ordinaryCellId: ordinary.cellId, treatmentCellId: treatment.cellId,
        ordinaryComparisonKey: ordinary.comparisonKey, treatmentComparisonKey: treatment.comparisonKey, sameTimingCondition: same, exclusion, clocks });
    }
  }
  const groups = [];
  for (const modelId of data.models.map(model => model.modelId)) for (const cohort of ['context', 'swe']) for (const split of ['pilot', 'confirmation_holdout']) {
    const selected = rows.filter(row => row.modelId === modelId && row.cohort === cohort && row.split === split);
    for (const comparisonKey of [...new Set(selected.map(row => row.comparisonKey))].sort()) {
      const stratum = selected.filter(row => row.comparisonKey === comparisonKey);
      groups.push({ modelId, cohort, split, comparisonKey, timingRegime: stratum[0].timingRegime, conditionId: stratum[0].conditionId, admittedConcurrency: stratum[0].admittedConcurrency,
        ...(stratum[0].timingRegime === ROLLING ? { concurrencyBasis: 'actual-owned-worker-overlap-peak', actualOverlapConcurrency: stratum[0].actualOverlapConcurrency, configuredMaxConcurrency: 2 } : {}),
        arms: Object.fromEntries(ARMS.map(arm => { const armRows = stratum.filter(row => row.arm === arm); return [arm, { planned: armRows.length, signedInfrastructure: armRows.filter(row => row.signedInfrastructure).length,
          clocks: Object.fromEntries(TIMES.map(metric => [metric, avail(armRows.map(row => row.clocks[metric]))])) }]; })),
        paired: ARMS.slice(1).map(arm => {
          const candidates = pairs.filter(pair => pair.modelId === modelId && pair.cohort === cohort && pair.split === split && pair.arm === arm && (pair.ordinaryComparisonKey === comparisonKey || pair.treatmentComparisonKey === comparisonKey));
          const same = candidates.filter(pair => pair.sameTimingCondition);
          return { arm, touchingTaskPairs: candidates.length, sameConditionTaskPairs: same.length, crossConditionTaskPairs: candidates.length - same.length,
            clocks: Object.fromEntries(TIMES.map(metric => {
              const complete = same.filter(pair => pair.exclusion === null && pair.clocks[metric].ordinary !== null && pair.clocks[metric].treatment !== null);
              const a = avail(complete.map(pair => pair.clocks[metric].ordinary)), b = avail(complete.map(pair => pair.clocks[metric].treatment));
              // Missing clock or infrastructure in a same-condition pair withholds the full-stratum ratio.
              const ratio = same.length > 0 && complete.length === same.length && a.total > 0 ? b.total / a.total : null;
              return [metric, { plannedSameConditionPairs: same.length, completePairs: complete.length, missingPairs: same.length - complete.length, ordinaryPaired: a, treatmentPaired: b, ratio,
                taskIds: same.map(pair => pair.taskId), direction: 'treatment / ordinary; matched tasks only' }];
            })) };
        }) });
    }
  }
  return { schemaVersion: 1, policy: 'condition and observed concurrency basis matched within model/cohort/split/task; rolling uses strict-positive owned-worker overlap peak; descriptive only; no pooled timing macro', conditions: structuredClone(map.conditions), rows, pairs, groups,
    infrastructureCosts: structuredClone(data.infrastructure),
    executionIntervals: map.executionIntervals.map(interval => ({ ...interval, elapsedMs: Date.parse(interval.completedAt) - Date.parse(interval.startedAt) })),
    durationAccounting: 'Clocks overlap and are retained independently. Cell-wall sums are work totals, not suite makespan. Execution intervals are actual controller wall observations; never sum overlapping intervals or failed-history/canonical costs.' };
}

export function adapt(data, expected, map, recompute, core) {
  const nonTimingData = maskTiming(data), nonTimingExpected = recompute(nonTimingData, core);
  assert.deepStrictEqual(omitTimes(nonTimingExpected), omitTimes(expected), 'Non-time quality/token/allocation/failure-cost values changed');
  return { schemaVersion: 1, kind: 'timing-regime-adapted-public-results', nonTimingData, nonTimingExpected,
    timingMap: structuredClone(map), timing: deriveTiming(data, map) };
}

// Public verification reconstructs the full rows from their separately preserved raw clocks.
export function verifyAdapted(adapted, validateData, recompute, core) {
  check(adapted.schemaVersion === 1 && adapted.kind === 'timing-regime-adapted-public-results', 'Adapted schema differs');
  check(adapted.nonTimingData.rows.every(row => TIMES.every(metric => row[metric] === null)), 'Legacy timing channel must be masked');
  const clocks = new Map(adapted.timing.rows.map(row => [row.cellId, row.clocks]));
  check(clocks.size === adapted.nonTimingData.rows.length && adapted.timing.rows.length === clocks.size, 'Timing row inventory differs');
  const restored = structuredClone(adapted.nonTimingData);
  for (const row of restored.rows) { check(clocks.has(id(row)), 'Missing raw clocks'); Object.assign(row, clocks.get(id(row))); }
  // The original external boundary validates real clocks, including the signed
  // canonical-wall overlap. Only its arithmetic receives the masked projection.
  validateData(restored);
  assert.deepStrictEqual(recompute(maskTiming(restored), core), adapted.nonTimingExpected, 'Non-timing arithmetic differs');
  assert.deepStrictEqual(deriveTiming(restored, adapted.timingMap), adapted.timing, 'Timing arithmetic/provenance differs');
  return { status: 'passed', plannedCells: restored.rows.length, actualModelTerminal: adapted.nonTimingExpected.overallExecution.actualModelTerminal, signedInfrastructure: adapted.nonTimingData.infrastructure.length,
    crossConditionPairs: adapted.timing.pairs.filter(pair => !pair.sameTimingCondition).length };
}
