import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { createLifecycle, observeChild, evaluateLifecycle } from './lifecycle.mjs';

function fixture(t, role = 'dummy-child', parentInstanceId = null) {
  const directory = fs.mkdtempSync(path.join(process.env.TASK_BENCHMARK_CALIBRATION_DIR ?? os.tmpdir(), 'task-lifecycle-'));
  if (!process.env.TASK_BENCHMARK_CALIBRATION_DIR) t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return createLifecycle({ directory, role, parentInstanceId, context: { calibration: true } });
}

async function bounded(promise, milliseconds = 5_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Dummy process calibration timed out')), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

function completed(lifecycle, pid = 123) {
  lifecycle.event('child-started', { pid });
  lifecycle.event('child-exit', { pid, code: 0, signal: null });
  lifecycle.event('child-close', { pid, code: 0, signal: null });
  return lifecycle.snapshot();
}

test('UUID receipts append in order and snapshots cannot mutate persisted events', t => {
  const lifecycle = fixture(t);
  const details = { nested: { pid: 12 } };
  const returned = lifecycle.event('observation', details);
  details.nested.pid = 99;
  returned.details.nested.pid = 88;
  const snapshot = lifecycle.snapshot();
  snapshot[0].context.calibration = false;
  assert.equal(lifecycle.snapshot()[1].details.nested.pid, 12);
  assert.equal(lifecycle.snapshot()[0].context.calibration, true);
  const disk = fs.readFileSync(lifecycle.file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(disk, lifecycle.snapshot());
  assert.deepEqual(disk.map(event => event.seq), [1, 2]);
  assert.match(path.basename(lifecycle.file), /^[0-9a-f-]{36}\.jsonl$/);
  assert.equal(disk[1].parentInstanceId, null);
  assert.ok(disk[1].monotonicMs >= disk[0].monotonicMs);
  assert.ok(Number.isFinite(Date.parse(disk[1].wallTime)));
  fs.unlinkSync(lifecycle.file);
  assert.throws(() => lifecycle.event('must-not-recreate'), { code: 'ENOENT' });
});

test('the same reused PID represents distinct child instances and ownership', t => {
  const owner = fixture(t, 'cell-owner');
  const one = createLifecycle({ directory: path.dirname(owner.file), role: 'worker', parentInstanceId: owner.instanceId });
  const two = createLifecycle({ directory: path.dirname(owner.file), role: 'worker', parentInstanceId: owner.instanceId });
  assert.notEqual(one.instanceId, two.instanceId);
  const children = [...completed(one, 42), ...completed(two, 42)];
  owner.event('instance-completed', { code: 0 });
  const result = evaluateLifecycle([...owner.snapshot(), ...children], { expectedInstanceIds: [owner.instanceId, one.instanceId, two.instanceId] });
  assert.equal(result.status, 'PASS');
  assert.equal(result.instances.length, 3);
  assert.equal(result.instances.filter(instance => instance.parentInstanceId === owner.instanceId).length, 2);
});

test('receipt integrity rejects duplicate, missing and out-of-order events', t => {
  const events = completed(fixture(t));
  for (const [name, changed] of [
    ['duplicate-sequence', [...events, events.at(-1)]],
    ['missing-sequence', [events[0], events[2], events[3]]],
    ['out-of-order-sequence', [events[0], events[2], events[1], events[3]]],
  ]) {
    const result = evaluateLifecycle(changed);
    assert.equal(result.status, 'FAIL');
    assert.ok(result.issues.some(issue => issue.code === name), name);
  }
  const duplicateType = structuredClone(events);
  duplicateType.push({ ...duplicateType.at(-1), seq: 5 });
  assert.ok(evaluateLifecycle(duplicateType).issues.some(issue => issue.code === 'duplicate-event'));
  const badTime = structuredClone(events);
  badTime[2].monotonicMs = -1;
  assert.ok(evaluateLifecycle(badTime).issues.some(issue => issue.code === 'out-of-order-time'));
});

test('close return and exit alone preserve UNKNOWN until actual child close', t => {
  const lifecycle = fixture(t);
  lifecycle.event('child-started', { pid: 1 });
  lifecycle.event('close-requested');
  lifecycle.event('close-returned');
  assert.equal(evaluateLifecycle(lifecycle.snapshot()).status, 'UNKNOWN');
  lifecycle.event('child-exit', { code: 0, signal: null });
  assert.equal(evaluateLifecycle(lifecycle.snapshot()).status, 'UNKNOWN');
  lifecycle.event('child-close', { code: 0, signal: null });
  assert.equal(evaluateLifecycle(lifecycle.snapshot()).status, 'PASS');
});

test('public transport onclose permits a bounded PASS with unavailable exit retained', t => {
  const lifecycle = fixture(t);
  lifecycle.event('child-started', { pid: 11, evidence: 'public-stdio-transport-start' });
  lifecycle.event('child-close', { pid: 11, code: null, signal: null, terminationEscalated: null, evidence: 'public-stdio-transport-onclose' });
  const result = evaluateLifecycle(lifecycle.snapshot());
  assert.equal(result.status, 'PASS');
  assert.equal(result.scope, 'owned-direct-children');
  assert.equal(result.instances[0].exited, false);
  assert.equal(result.instances[0].exit, null);
  assert.equal(result.instances[0].close.terminationEscalated, null);
});

test('missing expected instances and explicit descendants retain uncertainty', t => {
  const lifecycle = fixture(t);
  const events = completed(lifecycle);
  const descendants = [{ pid: 321, reason: 'Discovered grandchild has no owned close receipt' }];
  const result = evaluateLifecycle(events, { expectedInstanceIds: ['missing-uuid'], unknownDescendants: descendants });
  assert.equal(result.status, 'UNKNOWN');
  assert.deepEqual(result.unknownDescendants, descendants);
  assert.ok(result.issues.some(issue => issue.code === 'missing-instance'));
  assert.ok(result.issues.some(issue => issue.code === 'unknown-descendants'));
  assert.equal(evaluateLifecycle([]).status, 'UNKNOWN');
});

test('referenced parents must exist and the ownership graph must be acyclic', t => {
  const lifecycle = fixture(t);
  const events = completed(lifecycle);
  const withParent = parentInstanceId => events.map(event => ({ ...event, parentInstanceId }));
  const missing = evaluateLifecycle(withParent('absent-parent'));
  assert.equal(missing.status, 'UNKNOWN');
  assert.deepEqual(missing.issues.find(issue => issue.code === 'missing-parent').detail, { parentInstanceId: 'absent-parent' });
  const self = evaluateLifecycle(withParent(lifecycle.instanceId));
  assert.equal(self.status, 'FAIL');
  assert.ok(self.issues.some(issue => issue.code === 'parent-self'));
  const other = fixture(t);
  const otherEvents = completed(other).map(event => ({ ...event, parentInstanceId: lifecycle.instanceId }));
  const cycle = evaluateLifecycle([...withParent(other.instanceId), ...otherEvents]);
  assert.equal(cycle.status, 'FAIL');
  assert.deepEqual(new Set(cycle.issues.find(issue => issue.code === 'parent-cycle').detail), new Set([lifecycle.instanceId, other.instanceId]));
});

test('malformed or missing parent and context envelope fields fail explicitly', t => {
  const events = completed(fixture(t));
  for (const field of ['parentInstanceId', 'context']) {
    const missing = structuredClone(events);
    delete missing[0][field];
    assert.equal(evaluateLifecycle(missing).status, 'FAIL', `Missing ${field}`);
  }
  for (const fields of [{ parentInstanceId: 42 }, { context: [] }, { context: null }]) {
    const invalid = structuredClone(events);
    Object.assign(invalid[0], fields);
    assert.ok(evaluateLifecycle(invalid).issues.some(issue => issue.code === 'invalid-event'));
  }
});

test('terminal failure receipts preserve their recorded reasons', t => {
  for (const type of ['startup-failed', 'readiness-failed', 'cleanup-failed', 'attempt-failed']) {
    const lifecycle = fixture(t, 'cell-owner');
    const details = { reason: `dummy ${type}`, message: 'Specific calibration error' };
    lifecycle.event(type, details);
    lifecycle.event('instance-completed', { code: 0 });
    const result = evaluateLifecycle(lifecycle.snapshot());
    assert.equal(result.status, 'FAIL');
    assert.deepEqual(result.issues.find(issue => issue.code === type).detail, details);
  }
});

test('a completed HTTP service needs a quiescence receipt', t => {
  const service = fixture(t, 'bridge-service');
  service.event('http-ready', { port: 12345 });
  service.event('instance-completed', { code: 0 });
  const missing = evaluateLifecycle(service.snapshot());
  assert.equal(missing.status, 'UNKNOWN');
  assert.ok(missing.issues.some(issue => issue.code === 'missing-http-quiescent'));
  service.event('http-quiescent', { sessions: 0, handlers: 0, requestCount: 0 });
  assert.equal(evaluateLifecycle(service.snapshot()).status, 'PASS');
});

test('HTTP quiescence verifies counts against request and initialized-session receipts', t => {
  const evaluate = ({ counts = { sessions: 0, handlers: 0, requestCount: 1 }, endRequest = true, endSession = true } = {}) => {
    const service = fixture(t, 'bridge-service');
    service.event('http-ready', { port: 12345 });
    service.event('http-request-start', { requestId: 1 });
    service.event('http-session-start', { sessionId: 'session-one' });
    if (endRequest) service.event('http-request-end', { requestId: 1 });
    if (endSession) service.event('http-session-close', { sessionId: 'session-one' });
    service.event('http-session-close', { sessionId: null });
    service.event('http-quiescent', counts);
    service.event('instance-completed', { code: 0 });
    return evaluateLifecycle(service.snapshot());
  };
  assert.equal(evaluate().status, 'PASS');
  assert.equal(evaluate({ endRequest: false }).status, 'UNKNOWN');
  assert.equal(evaluate({ endSession: false }).status, 'UNKNOWN');
  assert.equal(evaluate({ counts: { sessions: 1, handlers: 0, requestCount: 1 } }).status, 'UNKNOWN');
  assert.equal(evaluate({ counts: { sessions: 0, handlers: 1, requestCount: 1 } }).status, 'UNKNOWN');
  assert.equal(evaluate({ counts: { sessions: 0, handlers: 0, requestCount: 2 } }).status, 'UNKNOWN');
  assert.equal(evaluate({ counts: {} }).status, 'UNKNOWN');
  assert.equal(evaluate({ counts: { sessions: -1, handlers: 0, requestCount: 1 } }).status, 'FAIL');
});

test('HTTP end receipts cannot precede starts or duplicate completed requests', t => {
  const service = fixture(t, 'bridge-service');
  service.event('http-ready');
  service.event('http-request-end', { requestId: 1 });
  service.event('http-request-start', { requestId: 1 });
  service.event('http-request-start', { requestId: 1 });
  service.event('http-request-end', { requestId: 1 });
  service.event('http-quiescent', { sessions: 0, handlers: 0, requestCount: 1 });
  service.event('instance-completed', { code: 0 });
  const result = evaluateLifecycle(service.snapshot());
  assert.equal(result.status, 'FAIL');
  assert.ok(result.issues.some(issue => issue.code === 'unmatched-http-end'));
  assert.ok(result.issues.some(issue => issue.code === 'duplicate-http-start'));
});

test('aggregate ownership checks do not compare different process clocks', t => {
  const owner = fixture(t, 'cell-owner');
  owner.event('instance-completed', { code: 0 });
  const child = createLifecycle({ directory: path.dirname(owner.file), role: 'worker', parentInstanceId: owner.instanceId });
  const childEvents = completed(child).map(event => ({ ...event, monotonicMs: event.seq / 10, wallTime: '2000-01-01T00:00:00.000Z' }));
  const result = evaluateLifecycle([...childEvents, ...owner.snapshot()]);
  assert.equal(result.status, 'PASS');
  assert.equal(result.orderingScope, 'per-instance');
});

test('timeouts and forced pipe cleanup remain explicit after close', t => {
  const lifecycle = fixture(t);
  completed(lifecycle);
  lifecycle.event('child-kill-requested', { signal: 'SIGTERM', reason: 'timeout' });
  assert.equal(evaluateLifecycle(lifecycle.snapshot()).status, 'PASS');
  lifecycle.event('close-await-timeout', { milliseconds: 10 });
  lifecycle.event('forced-pipe-close', { stream: 'stdout' });
  const result = evaluateLifecycle(lifecycle.snapshot());
  assert.equal(result.status, 'UNKNOWN');
  assert.deepEqual(result.forcedCleanup.map(event => event.type), ['child-kill-requested', 'forced-pipe-close']);
});

test('nonzero exit and impossible close order fail', t => {
  const lifecycle = fixture(t);
  lifecycle.event('child-close', { code: 2, signal: null });
  lifecycle.event('child-started', { pid: 2 });
  const result = evaluateLifecycle(lifecycle.snapshot());
  assert.equal(result.status, 'FAIL');
  assert.ok(result.issues.some(issue => issue.code === 'nonzero-exit'));
  assert.ok(result.issues.some(issue => issue.code === 'close-before-start'));
});

test('ripgrep no-match exit is complete while errors and cleanup exits remain failures', t => {
  const observeExit = (role, code, { close = true, kill = false, signal = null } = {}) => {
    const lifecycle = fixture(t, role);
    lifecycle.event('child-started', { pid: 123 });
    if (kill) lifecycle.event('child-kill-requested', { signal: 'SIGTERM', reason: 'output-truncated' });
    lifecycle.event('child-exit', { pid: 123, code, signal });
    if (close) lifecycle.event('child-close', { pid: 123, code, signal });
    return { lifecycle, result: evaluateLifecycle(lifecycle.snapshot()) };
  };

  const noMatch = observeExit('ripgrep', 1);
  assert.equal(noMatch.result.status, 'PASS');
  assert.equal(noMatch.result.instances[0].exit.code, 1);
  assert.equal(noMatch.result.instances[0].close.code, 1);

  assert.equal(observeExit('ripgrep', 2).result.status, 'FAIL');
  assert.equal(observeExit('dummy-child', 1).result.status, 'FAIL');

  const unclosed = observeExit('ripgrep', 1, { close: false });
  assert.equal(unclosed.result.status, 'UNKNOWN');
  assert.equal(unclosed.result.instances[0].exit.code, 1);

  const killed = observeExit('ripgrep', 1, { kill: true });
  assert.equal(killed.result.status, 'FAIL');
  assert.equal(killed.result.forcedCleanup.length, 1);
  assert.ok(killed.result.issues.some(issue => issue.code === 'nonzero-exit'));
});

test('real direct child records start, exit and close without a race', async t => {
  const lifecycle = fixture(t);
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("done");'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const observer = observeChild(child, lifecycle);
  child.stdout.resume();
  child.stderr.resume();
  t.after(() => { if (!observer.didClose) child.kill(); });
  const result = await bounded(observer.closed);
  assert.equal(result.code, 0);
  assert.equal(result.closed, true);
  assert.equal(observer.didClose, true);
  assert.deepEqual(lifecycle.snapshot().map(event => event.type), ['instance-created', 'child-started', 'child-exit', 'child-close']);
  assert.equal(evaluateLifecycle(lifecycle.snapshot()).status, 'PASS');
});

test('real spawn failure is retained and never assessed as success', async t => {
  const lifecycle = fixture(t);
  const child = spawn(path.join(path.dirname(lifecycle.file), 'missing-executable'), [], { stdio: 'pipe' });
  const observer = observeChild(child, lifecycle);
  const closed = await bounded(observer.closed);
  assert.equal(closed.spawnError.code, 'ENOENT');
  assert.equal(evaluateLifecycle(lifecycle.snapshot()).status, 'FAIL');
  assert.ok(lifecycle.snapshot().some(event => event.type === 'spawn-error'));
});

test('real short-lived owned grandchild has its own linked start/exit/close receipts', async t => {
  const parent = fixture(t, 'dummy-A');
  const directory = path.dirname(parent.file);
  const moduleUrl = new URL('./lifecycle.mjs', import.meta.url).href;
  const script = `(async()=>{
    const {spawn}=await import('node:child_process');
    const {createLifecycle,observeChild}=await import(${JSON.stringify(moduleUrl)});
    const lifecycle=createLifecycle({directory:${JSON.stringify(directory)},role:'dummy-B',parentInstanceId:${JSON.stringify(parent.instanceId)},context:{calibration:true}});
    const child=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});
    await observeChild(child,lifecycle).closed;
  })().catch(error=>{console.error(error);process.exitCode=1;});`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ownership = observeChild(child, parent);
  child.stdout.resume(); child.stderr.resume();
  t.after(() => { if (!ownership.didClose) child.kill(); });
  assert.equal((await bounded(ownership.closed)).code, 0);
  const records = fs.readdirSync(directory).flatMap(name => fs.readFileSync(path.join(directory, name), 'utf8').trim().split('\n').map(JSON.parse));
  assert.equal(new Set(records.map(row => row.instanceId)).size, 2);
  const grandchild = records.filter(row => row.role === 'dummy-B');
  assert.ok(grandchild.every(row => row.parentInstanceId === parent.instanceId));
  assert.deepEqual(grandchild.map(row => row.type), ['instance-created', 'child-started', 'child-exit', 'child-close']);
  assert.ok(grandchild.at(-1).monotonicMs - grandchild[0].monotonicMs < 1000, 'Grandchild lifetime is shorter than the old nominal polling interval');
  assert.equal(evaluateLifecycle(records).status, 'PASS');
});

function spawnPipeHolder(milliseconds) {
  const grandchildScript = `setTimeout(() => process.exit(0), ${milliseconds});`;
  const script = `
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { detached: true, stdio: ['ignore', process.stdout, process.stderr] });
    grandchild.once('spawn', () => process.stdout.write(String(grandchild.pid) + '\\n', () => process.exit(0)));
  `;
  return spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
}

test('real short-lived grandchild holds inherited pipes after its parent exits', async t => {
  const lifecycle = fixture(t);
  const child = spawnPipeHolder(350);
  const observer = observeChild(child, lifecycle);
  const exited = once(child, 'exit');
  child.stdout.resume();
  child.stderr.resume();
  t.after(() => { if (!observer.didClose) child.kill(); });
  await bounded(exited);
  assert.equal(observer.didClose, false);
  assert.equal(evaluateLifecycle(lifecycle.snapshot()).status, 'UNKNOWN');
  await bounded(observer.closed);
  assert.equal(evaluateLifecycle(lifecycle.snapshot()).status, 'PASS');
});

test('real inherited pipe holder stays UNKNOWN when pipes are forcibly closed', async t => {
  const lifecycle = fixture(t);
  const child = spawnPipeHolder(3_000);
  const observer = observeChild(child, lifecycle);
  const exited = once(child, 'exit');
  let holderPid;
  t.after(() => {
    if (holderPid) { try { process.kill(holderPid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    if (!observer.didClose) child.kill();
  });
  const [chunk] = await bounded(once(child.stdout, 'data'));
  holderPid = Number(String(chunk).trim());
  assert.ok(Number.isInteger(holderPid) && holderPid > 0);
  child.stderr.resume();
  await bounded(exited);
  assert.equal(observer.didClose, false);
  assert.doesNotThrow(() => process.kill(holderPid, 0), 'Grandchild must still be alive before pipe destruction');
  lifecycle.event('forced-pipe-close', { reason: 'calibration', streams: ['stdout', 'stderr'] });
  child.stdout.destroy();
  child.stderr.destroy();
  await bounded(observer.closed);
  const unknownDescendants = [{ pid: holderPid, reason: 'Still-running grandchild has no owned close receipt' }];
  const result = evaluateLifecycle(lifecycle.snapshot(), { unknownDescendants });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.instances[0].closed, true);
  assert.equal(result.forcedCleanup.length, 1);
  assert.deepEqual(result.unknownDescendants, unknownDescendants);
});

test('real explicit kill retains cleanup signal and actual close receipt', async t => {
  const lifecycle = fixture(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  const observer = observeChild(child, lifecycle);
  t.after(() => { if (!observer.didClose) child.kill(); });
  assert.equal(observer.requestKill('SIGTERM', 'calibration cleanup'), true);
  await bounded(observer.closed);
  const result = evaluateLifecycle(lifecycle.snapshot());
  assert.equal(result.instances[0].closed, true);
  assert.equal(result.forcedCleanup[0].details.signal, 'SIGTERM');
  assert.equal(result.forcedCleanup[0].details.reason, 'calibration cleanup');
});
