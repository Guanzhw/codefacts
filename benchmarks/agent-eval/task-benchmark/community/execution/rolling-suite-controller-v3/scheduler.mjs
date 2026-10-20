/** Earliest frozen eligible cell; a campaign remains active until close validation. */
export function selectNext(selected, acceptedCellIds, activeReservations) {
  const accepted = new Set(acceptedCellIds), activeIds = new Set(activeReservations.map(row => row.cellId));
  const campaigns = new Set(activeReservations.map(row => row.campaignId));
  if (activeReservations.length >= 2) return null;
  return selected.find(cell => !accepted.has(cell.id) && !activeIds.has(cell.id) && !campaigns.has(cell.campaignId)) ?? null;
}

/** Every promise returned by start is immediately owned and rejection-handled.
 * All callback/admission/stop/close failures converge on the same complete drain.
 * start must synchronously return its child-close promise (never launch then throw).
 */
export async function runRolling(selected, { start, closed, shouldStop = () => false, stopped = () => {}, allClosed = () => {} }) {
  const active = new Map(), admitted = [], accepted = [], failures = [];
  let stopRequested = false, stopNotified = false;
  const state = () => ({ acceptedCellIds: accepted.map(job => job.cell.id),
    acceptedJobIds: accepted.map(job => job.jobId),
    activeReservations: [...active.values()].map(({ job }) => ({ jobId: job.jobId, cellId: job.cell.id, campaignId: job.cell.campaignId })) });
  const fail = error => { failures.push(error); };
  const stop = () => {
    if (!stopNotified) { stopNotified = true; try { stopped({ stopRequested, failures }); } catch (error) { fail(error); } }
  };
  const consume = async entry => {
    const outcome = await entry.settled;
    try {
      if (outcome.status === 'rejected') fail(outcome.reason);
      await closed(entry.job, outcome, state());
      if (outcome.status === 'fulfilled') accepted.push(entry.job);
    } catch (error) { fail(error); }
    finally { active.delete(entry.job.jobId); }
  };
  try {
    while (active.size || accepted.length < selected.length) {
      // A peer may have settled in the same turn as the previously consumed child.
      // Validate every already observed close before spending a replacement slot.
      while ([...active.values()].some(entry => entry.outcome !== null)) {
        for (const entry of [...active.values()].filter(row => row.outcome !== null)) await consume(entry);
      }
      try { if (shouldStop()) stopRequested = true; } catch (error) { fail(error); }
      if (stopRequested || failures.length) stop();
      while (!stopRequested && !failures.length && active.size < 2) {
        const before = state(), cell = selectNext(selected, before.acceptedCellIds, before.activeReservations);
        if (!cell) break;
        const job = { jobId: 'job-' + String(admitted.length + 1).padStart(4, '0'), issuanceOrdinal: admitted.length + 1, cell,
          activeAtAdmission: before.activeReservations.map(row => row.jobId) };
        try {
          if (shouldStop()) { stopRequested = true; stop(); break; }
          const promise = Promise.resolve(start(job, before));
          const entry = { job, settled: null, outcome: null };
          entry.settled = promise.then(value => { entry.outcome = { status: 'fulfilled', value }; return entry.outcome; },
            reason => { entry.outcome = { status: 'rejected', reason }; return entry.outcome; });
          active.set(job.jobId, entry); admitted.push(job);
        } catch (error) { fail(error); stop(); }
      }
      if (failures.length || stopRequested) break;
      if (!active.size) {
        if (accepted.length !== selected.length) fail(new Error('Unallocated frozen cell remains without an eligible job'));
        break;
      }
      const next = await Promise.race([...active.values()].map(entry => entry.settled.then(() => entry)).concat([
        new Promise(resolve => { const timer = setTimeout(() => resolve(null), 40); timer.unref?.(); }) ]));
      if (next) await consume(next);
    }
  } catch (error) { fail(error); }
  finally {
    if (failures.length || stopRequested) stop();
    // Validation errors during this drain cannot interrupt another child's drain.
    for (const entry of [...active.values()]) await consume(entry);
    try { await allClosed({ admitted, accepted, failures, stopRequested }); } catch (error) { fail(error); }
  }
  return { admitted, accepted, failures, stopRequested, failed: failures.length !== 0 };
}
