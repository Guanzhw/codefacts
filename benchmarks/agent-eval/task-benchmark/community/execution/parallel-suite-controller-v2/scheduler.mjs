/** Pure scheduling policy. A wave is audited only after every admitted child closes. */
export function selectWave(selected, accountedIds, maxConcurrency) {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 2) throw new Error('Reviewed concurrency range is 1..2');
  const accounted = new Set(accountedIds), campaigns = new Set(), wave = [];
  for (const cell of selected) {
    if (accounted.has(cell.id) || campaigns.has(cell.campaignId)) continue;
    wave.push(cell); campaigns.add(cell.campaignId);
    if (wave.length === maxConcurrency) break;
  }
  return wave;
}

/** Never rejects until all children already returned by start() have settled. */
export async function drainWave(cells, { start, shouldStop = () => false }) {
  const running = [], admitted = []; let admissionError = null, stopRequested = false;
  for (const cell of cells) {
    try {
      if (shouldStop()) { stopRequested = true; break; }
      const promise = Promise.resolve(start(cell));
      // Attach rejection handling immediately, including while later admission runs.
      promise.catch(() => {});
      running.push(promise); admitted.push(cell.id);
    } catch (error) { admissionError = error; break; }
  }
  const results = await Promise.allSettled(running);
  return { admitted, results, admissionError, stopRequested,
    failed: admissionError !== null || results.some(result => result.status === 'rejected') };
}
