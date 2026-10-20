import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// Each writer owns one UUID file. Synchronous appends preserve receipt order
// even when a process exits immediately after emitting its final event.
export function createLifecycle({ directory, role, parentInstanceId = null, context = {} }) {
  fs.mkdirSync(directory, { recursive: true });
  const instanceId = randomUUID();
  const file = path.join(directory, `${instanceId}.jsonl`);
  fs.closeSync(fs.openSync(file, 'wx'));
  const records = [];
  const fixedContext = structuredClone(context);
  const event = (type, details = {}) => {
    const record = {
      schemaVersion: 1, instanceId, parentInstanceId, role,
      seq: records.length + 1, type, wallTime: new Date().toISOString(),
      monotonicMs: performance.now(), context: fixedContext, details,
    };
    // The bytes on disk and the in-memory snapshot describe the same event;
    // later mutation of caller-owned details cannot change a receipt.
    const line = JSON.stringify(record);
    fs.appendFileSync(file, `${line}\n`, { encoding: 'utf8', flag: fs.constants.O_WRONLY | fs.constants.O_APPEND });
    records.push(JSON.parse(line));
    return structuredClone(records.at(-1));
  };
  event('instance-created', { ownerPid: process.pid });
  return { instanceId, file, event, snapshot: () => structuredClone(records) };
}

// Supply a dedicated lifecycle for this direct child, linked to its owner by
// parentInstanceId. Attach immediately after spawn(), before awaiting anything.
export function observeChild(child, lifecycle) {
  let started = false, didClose = false, spawnError = null;
  const killRequests = [];
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const start = () => {
    if (started) return;
    started = true;
    lifecycle.event('child-started', { pid: child.pid ?? null });
  };
  child.once('spawn', start);
  child.on('error', error => {
    const details = { pid: child.pid ?? null, name: error.name, code: error.code ?? null, message: error.message };
    if (!started) spawnError = details;
    lifecycle.event(started ? 'child-error' : 'spawn-error', details);
  });
  child.once('exit', (code, signal) => {
    lifecycle.event('child-exit', { pid: child.pid ?? null, code, signal });
  });
  child.once('close', (code, signal) => {
    didClose = true;
    const details = { instanceId: lifecycle.instanceId, pid: child.pid ?? null, code, signal, spawnError, killRequests: structuredClone(killRequests), closed: true };
    lifecycle.event('child-close', details);
    resolveClosed(details);
  });
  // A PID returned by spawn() already identifies a successfully created child;
  // recording it now also covers callers attaching after the spawn event.
  if (child.pid != null) start();
  return {
    closed,
    get didClose() { return didClose; },
    requestKill(signal = 'SIGTERM', reason = 'cleanup') {
      const request = { pid: child.pid ?? null, signal, reason, afterClose: didClose };
      killRequests.push(request);
      lifecycle.event('child-kill-requested', request);
      try {
        const sent = child.kill(signal);
        lifecycle.event('child-kill-result', { ...request, sent });
        return sent;
      } catch (error) {
        lifecycle.event('child-kill-result', { ...request, sent: false, error: error.message });
        throw error;
      }
    },
  };
}

/** Assess the recorded owned direct children, without inferring a process tree. */
export function evaluateLifecycle(events, { expectedInstanceIds = [], unknownDescendants = [] } = {}) {
  const issues = [], instances = new Map(), forcedCleanup = [];
  const issue = (status, code, instanceId, detail) => issues.push({ status, code, instanceId, detail });
  for (const record of events) {
    if (!record || typeof record.instanceId !== 'string' || !record.instanceId || !Number.isInteger(record.seq) || record.seq < 1 || typeof record.type !== 'string' || !Number.isFinite(record.monotonicMs)
      || (record.parentInstanceId !== null && (typeof record.parentInstanceId !== 'string' || !record.parentInstanceId))
      || !record.context || typeof record.context !== 'object' || Array.isArray(record.context)) {
      issue('FAIL', 'invalid-event', record?.instanceId ?? null, 'Receipt identity, parent, context, sequence, type, or monotonic time is invalid');
      continue;
    }
    let instance = instances.get(record.instanceId);
    if (!instance) {
      instance = { instanceId: record.instanceId, role: record.role, parentInstanceId: record.parentInstanceId, events: [], seen: new Set() };
      instances.set(record.instanceId, instance);
    }
    const previous = instance.events.at(-1);
    if (instance.seen.has(record.seq)) issue('FAIL', 'duplicate-sequence', record.instanceId, record.seq);
    else if (record.seq !== (previous?.seq ?? 0) + 1) issue('FAIL', record.seq < (previous?.seq ?? 0) ? 'out-of-order-sequence' : 'missing-sequence', record.instanceId, { previous: previous?.seq ?? 0, current: record.seq });
    if (previous && record.monotonicMs < previous.monotonicMs) issue('FAIL', 'out-of-order-time', record.instanceId, record.seq);
    if (record.role !== instance.role || record.parentInstanceId !== instance.parentInstanceId) issue('FAIL', 'identity-changed', record.instanceId, record.seq);
    instance.seen.add(record.seq);
    instance.events.push(record);
    if (['child-kill-requested', 'forced-pipe-close', 'forced-pipe-destroy'].includes(record.type)) forcedCleanup.push(structuredClone(record));
  }
  for (const instanceId of expectedInstanceIds) {
    if (!instances.has(instanceId)) issue('UNKNOWN', 'missing-instance', instanceId, 'Expected lifecycle receipt is absent');
  }
  if (!instances.size) issue('UNKNOWN', 'no-events', null, 'No lifecycle receipts were available');
  const graphChecked = new Set();
  for (const instance of instances.values()) {
    if (instance.parentInstanceId === instance.instanceId) {
      issue('FAIL', 'parent-self', instance.instanceId, 'Instance names itself as its parent');
      graphChecked.add(instance.instanceId);
    } else if (instance.parentInstanceId !== null && !instances.has(instance.parentInstanceId)) {
      issue('UNKNOWN', 'missing-parent', instance.instanceId, { parentInstanceId: instance.parentInstanceId });
    }
  }
  for (const instance of instances.values()) {
    const chain = [], positions = new Map();
    let current = instance.instanceId;
    while (current !== null && instances.has(current) && !graphChecked.has(current)) {
      if (positions.has(current)) {
        issue('FAIL', 'parent-cycle', instance.instanceId, chain.slice(positions.get(current)));
        break;
      }
      positions.set(current, chain.length);
      chain.push(current);
      current = instances.get(current).parentInstanceId;
    }
    for (const instanceId of chain) graphChecked.add(instanceId);
  }
  const summaries = [];
  for (const instance of instances.values()) {
    const records = instance.events;
    const count = type => records.filter(record => record.type === type);
    const starts = count('child-started'), exits = count('child-exit'), closes = count('child-close');
    const completed = count('instance-completed');
    if (records[0].type !== 'instance-created') issue('FAIL', 'missing-creation', instance.instanceId, 'First receipt must establish the instance');
    for (const type of ['instance-created', 'child-started', 'child-exit', 'child-close', 'instance-completed']) {
      if (count(type).length > 1) issue('FAIL', 'duplicate-event', instance.instanceId, type);
    }
    if (count('spawn-error').length) issue('FAIL', 'spawn-error', instance.instanceId, count('spawn-error').map(record => record.details));
    if (count('child-error').length) issue('FAIL', 'child-error', instance.instanceId, count('child-error').map(record => record.details));
    if (closes.length && !starts.length && !count('spawn-error').length) issue('FAIL', 'close-without-start', instance.instanceId, 'Close has no confirmed child start');
    if (starts.length && closes.length && closes[0].seq < starts[0].seq) issue('FAIL', 'close-before-start', instance.instanceId, 'Child close precedes child start');
    if (exits.length && (!starts.length || exits[0].seq < starts[0].seq || (closes.length && exits[0].seq > closes[0].seq))) issue('FAIL', 'invalid-exit-order', instance.instanceId, 'Child exit is outside its start/close interval');
    const knownPids = new Set([...starts, ...exits, ...closes].map(record => record.details?.pid).filter(pid => pid != null));
    if (knownPids.size > 1) issue('FAIL', 'pid-changed', instance.instanceId, [...knownPids]);
    if (starts.length && !closes.length) issue('UNKNOWN', 'missing-child-close', instance.instanceId, 'Child exit or close() return does not establish closed pipes');
    if (!starts.length && !closes.length && !completed.length && !count('spawn-error').length) issue('UNKNOWN', 'missing-completion', instance.instanceId, 'Instance has no completion receipt');
    // runRg accepts code 1 as no matches; raw codes and closure checks remain intact.
    const cleanRipgrepNoMatch = instance.role === 'ripgrep' && !count('child-kill-requested').length;
    for (const record of [...exits, ...closes, ...completed]) {
      const acceptedRipgrepNoMatch = cleanRipgrepNoMatch
        && ['child-exit', 'child-close'].includes(record.type)
        && record.details?.code === 1
        && record.details.signal === null;
      if (typeof record.details?.code === 'number' && record.details.code !== 0 && !acceptedRipgrepNoMatch) issue('FAIL', 'nonzero-exit', instance.instanceId, record.details);
    }
    for (const record of records) {
      if (['close-await-timeout', 'forced-pipe-close', 'forced-pipe-destroy'].includes(record.type)) issue('UNKNOWN', record.type, instance.instanceId, record.details);
      if (['startup-failed', 'readiness-failed', 'cleanup-failed', 'attempt-failed'].includes(record.type)) issue('FAIL', record.type, instance.instanceId, record.details);
    }
    if (instance.role === 'bridge-service' && count('http-ready').length && completed.length && !count('http-quiescent').length) issue('UNKNOWN', 'missing-http-quiescent', instance.instanceId, 'Completed HTTP service has no quiescence receipt');
    for (const quiescent of count('http-quiescent')) {
      const details = quiescent.details ?? {};
      for (const name of ['sessions', 'handlers', 'requestCount']) {
        if (details[name] == null) issue('UNKNOWN', 'missing-http-count', instance.instanceId, { name });
        else if (!Number.isInteger(details[name]) || details[name] < 0) issue('FAIL', 'invalid-http-count', instance.instanceId, { name, value: details[name] });
      }
      if (details.sessions > 0 || details.handlers > 0) issue('UNKNOWN', 'http-not-quiescent', instance.instanceId, details);
      for (const [kind, startType, endType, key] of [
        ['request', 'http-request-start', 'http-request-end', 'requestId'],
        ['session', 'http-session-start', 'http-session-close', 'sessionId'],
      ]) {
        const active = new Set(), seen = new Set();
        for (const record of records.filter(record => record.seq < quiescent.seq && [startType, endType].includes(record.type))) {
          const id = record.details?.[key];
          // A rejected initialization can close a transport without creating a session.
          if (kind === 'session' && record.type === endType && id == null) continue;
          if (id == null) { issue('FAIL', 'missing-http-identity', instance.instanceId, { kind, type: record.type }); continue; }
          if (record.type === startType) {
            if (seen.has(id)) issue('FAIL', 'duplicate-http-start', instance.instanceId, { kind, id });
            seen.add(id); active.add(id);
          } else if (!active.delete(id)) issue('FAIL', 'unmatched-http-end', instance.instanceId, { kind, id });
        }
        if (active.size) issue('UNKNOWN', 'unclosed-http-work', instance.instanceId, { kind, ids: [...active] });
        if (kind === 'request' && Number.isInteger(details.requestCount) && details.requestCount !== seen.size) issue('UNKNOWN', 'http-request-count-mismatch', instance.instanceId, { reported: details.requestCount, observed: seen.size });
      }
    }
    summaries.push({ instanceId: instance.instanceId, parentInstanceId: instance.parentInstanceId, role: instance.role, started: starts.length > 0, exited: exits.length > 0, closed: closes.length > 0, completed: completed.length > 0, exit: exits[0]?.details ?? null, close: closes[0]?.details ?? null });
  }
  const unresolved = unknownDescendants === true ? [{ reason: 'Descendant ownership is unresolved' }] : unknownDescendants || [];
  if (unresolved.length) issue('UNKNOWN', 'unknown-descendants', null, structuredClone(unresolved));
  return {
    status: issues.some(entry => entry.status === 'FAIL') ? 'FAIL' : issues.length ? 'UNKNOWN' : 'PASS',
    scope: 'owned-direct-children', issues, forcedCleanup,
    // Node monotonic clocks have process-local origins; wall clocks can move.
    // Aggregating receipts establishes ownership, not cross-process chronology.
    orderingScope: 'per-instance',
    unknownDescendants: structuredClone(unresolved), instances: summaries,
  };
}
