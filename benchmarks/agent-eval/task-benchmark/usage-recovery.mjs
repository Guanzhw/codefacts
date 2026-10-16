const accountingEvent = (type, turn, step) => ({ type,
  data: { turn, ...(step === undefined ? {} : { step }) }, accountingBoundary: true });

/**
 * Recover a lower bound from one benchmark turn's durable request settlements.
 * `deriveTurnTokenUsage` is the installed DSH helper, supplied by the collector.
 * Its temporary closures are accounting boundaries, never observed SDK events.
 */
export function recoverKnownUsage(events, deriveTurnTokenUsage) {
  const method = 'dsh-settled-attempt-lower-bound-v1';
  const requests = [];
  let turnStart, active, closedThroughStep = null, closedThroughEvent = null;
  let observedTurnEnd = false, lifecycleIssue = null;
  for (const [eventIndex, event] of events.entries()) {
    const { type, data } = event;
    if (type === 'turn/start') {
      if (turnStart) { lifecycleIssue = { eventIndex, reason: 'additional-turn-start' }; break; }
      turnStart = event;
      continue;
    }
    if (!turnStart) continue; // SDK initialization events precede the turn.
    if (type === 'turn/end') {
      if (data.turn !== turnStart.data.turn) lifecycleIssue = { eventIndex, reason: 'foreign-turn-end' };
      else observedTurnEnd = true;
      break;
    }
    if (type === 'step/start') {
      if (active || data.turn !== turnStart.data.turn) {
        lifecycleIssue = { eventIndex, reason: 'unexpected-step-start' }; break;
      }
      active = { turn: data.turn, step: data.step, attempt: 0, startEventIndex: eventIndex,
        startType: type, settlements: [], retryClosed: false };
      requests.push(active);
      continue;
    }
    if (!['assistant/attempt', 'assistant/message', 'llm/retry', 'llm/retry-started', 'step/end'].includes(type)) continue;
    if (!active || data.turn !== active.turn || data.step !== active.step) {
      lifecycleIssue = { eventIndex, reason: 'missing-matching-step-start' }; break;
    }
    if (type === 'llm/retry-started') {
      if (!active.retryClosed) { lifecycleIssue = { eventIndex, reason: 'missing-retry-boundary' }; break; }
      active = { turn: active.turn, step: active.step, attempt: active.attempt + 1,
        startEventIndex: eventIndex, startType: type, settlements: [], retryClosed: false };
      requests.push(active);
    } else if (type === 'llm/retry') {
      active.retryClosed = true;
    } else if (type === 'step/end') {
      closedThroughStep = active.step;
      closedThroughEvent = { eventIndex, ...(event.seq === undefined ? {} : { seq: event.seq }) };
      active = null;
    } else {
      if (active.retryClosed) { lifecycleIssue = { eventIndex, reason: 'settlement-after-retry-boundary' }; break; }
      active.settlements.push({ event, eventIndex });
    }
  }

  const accounting = turnStart ? [turnStart] : [];
  const provenance = requests.map(request => {
    const { turn, step, attempt, startEventIndex, startType, settlements } = request;
    const start = accountingEvent('step/start', turn, step);
    const end = accountingEvent('step/end', turn, step);
    const turnEnd = accountingEvent('turn/end', turn);
    let selected;
    for (const settlement of settlements) {
      const usage = deriveTurnTokenUsage([turnStart, start, settlement.event, end, turnEnd]);
      // Failed DSH settlements may manufacture zero counters. They prove no
      // exact zero-cost request and contribute nothing to the known lower bound.
      if (usage?.totalTokens > 0 && (!selected || usage.totalTokens > selected.usage.totalTokens ||
        (usage.totalTokens === selected.usage.totalTokens && settlement.event.type === 'assistant/message'))) {
        selected = { ...settlement, usage };
      }
    }
    if (selected) accounting.push(start, selected.event, end);
    return { turn, step, attempt, startEventIndex, startType,
      settlementEventIndices: settlements.map(row => row.eventIndex),
      counted: Boolean(selected),
      ...(selected ? { selectedEventIndex: selected.eventIndex, selectedType: selected.event.type,
        ...(selected.event.seq === undefined ? {} : { selectedEventSeq: selected.event.seq }),
        totalTokens: selected.usage.totalTokens } : { reason: 'no-positive-validated-settlement' }) };
  });
  if (turnStart) accounting.push(accountingEvent('turn/end', turnStart.data.turn));
  const usage = accounting.length > 2 ? deriveTurnTokenUsage(accounting) : undefined;
  return { exactTurnUsage: null, knownUsageLowerBound: usage ?? null,
    usageAvailability: usage ? 'known-lower-bound' : 'unavailable', method, closedThroughStep,
    provenance: { observedTurnEnd, closedThroughEvent, lifecycleIssue,
      selection: 'maximum-valid-settlement-total-per-lifecycle-attempt',
      internalAccountingBoundaries: ['step/start', 'step/end', 'turn/end'],
      unknownRemainder: true, requests: provenance } };
}
