import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ARMS, buildSchedule, buildPrompt, validateManifest, assertFrozen, assertReusable, auditAttempt, main } from './campaign.mjs';
import { canonicalEntries, readSourceManifest, verifySource, nativeConfig, assertNativeVersion } from './prepare.mjs';
import { hash } from './rpc.mjs';

const tasks = Array.from({ length: 6 }, (_, index) => ({ id: `t${index}`, corpus: `c${index % 3}`, question: 'Inspect source.' }));
test('96 slots are deterministic and counterbalance arm position within task and overall', () => {
  const rows = buildSchedule(tasks, { 'guided-use': 3, 'natural-choice': 1 });
  assert.equal(rows.length, 96); assert.equal(new Set(rows.map(row => row.id)).size, 96);
  assert.deepEqual(rows, buildSchedule(tasks, { 'guided-use': 3, 'natural-choice': 1 }));
  for (const task of tasks) for (const arm of ARMS) {
    const slots = rows.filter(row => row.taskId === task.id && row.arm === arm);
    assert.deepEqual(slots.map(row => row.position).sort(), [1, 2, 3, 4]);
  }
  for (const arm of ARMS) for (let position = 1; position <= 4; position++) assert.equal(rows.filter(row => row.arm === arm && row.position === position).length, 6);
  assert.equal(rows.filter(row => row.condition === 'guided-use').length, 72);
  assert.equal(rows.filter(row => row.condition === 'natural-choice').length, 24);
});
test('guided prompts share exact bytes across arms and natural prompts preserve optional query', () => {
  const suite = { scope: 'Read-only', answerContract: 'Cite source.' };
  assert.equal(buildPrompt(suite, tasks[0], 'guided-use'), buildPrompt(suite, tasks[0], 'guided-use'));
  assert.match(buildPrompt(suite, tasks[0], 'guided-use'), /first assistant step/);
  assert.match(buildPrompt(suite, tasks[0], 'natural-choice'), /query is optional/);
});
test('CLI and manifest fail explicitly without required frozen identity', async () => {
  await assert.rejects(main([]), /manifest and --mode required/);
  assert.throws(() => validateManifest({}), /identity/);
  assert.throws(() => validateManifest({ schemaVersion: 1, campaignId: 'a', suite: 'relative' }), /absolute/);
});
test('drift and prior failures cannot be silently resumed', () => {
  const manifest = { id: 'x' }, pins = [{ path: '/x', sha256: '123' }], frozen = { manifestHash: hash(manifest), pins };
  assert.doesNotThrow(() => assertFrozen(manifest, frozen, pins));
  assert.throws(() => assertFrozen({ id: 'y' }, frozen, pins), /drifted/);
  assert.throws(() => assertFrozen(manifest, frozen, []), /drifted/);
  const slot = { id: 'slot' };
  assert.throws(() => assertReusable({ freezeHash: hash(frozen), slot, status: 'infrastructure-failed' }, frozen, slot), /failed or incomplete/);
  assert.throws(() => assertReusable({ freezeHash: 'different', slot }, frozen, slot), /different frozen/);
});
test('manifest digest uses canonical sorted entries and private copies detect added/changed files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-campaign-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'README.md'), 'hello');
  const entries = [{ path: 'README.md', bytes: 5, sha256: hash('hello') }];
  const manifestFile = path.join(root, 'manifest.json'); fs.writeFileSync(manifestFile, JSON.stringify({ entries }, null, 2));
  const corpus = { id: 'router', manifestFile, manifestSha256: hash(canonicalEntries(entries)) };
  assert.equal(readSourceManifest(corpus).digest, corpus.manifestSha256);
  fs.writeFileSync(manifestFile, JSON.stringify(entries));
  assert.equal(readSourceManifest(corpus).digest, corpus.manifestSha256);
  assert.throws(() => verifySource(root, entries, { exact: true }), /inventory drift/);
  fs.unlinkSync(manifestFile); assert.doesNotThrow(() => verifySource(root, entries, { exact: true }));
  fs.mkdirSync(path.join(root, '.codegraph')); fs.writeFileSync(path.join(root, '.codegraph', 'generated'), 'index');
  assert.doesNotThrow(() => verifySource(root, entries, { exact: true }));
  fs.writeFileSync(path.join(root, 'README.md'), 'drift'); assert.throws(() => verifySource(root, entries), /Source drift/);
});
test('native configuration isolates 022 full setup from default model menu', () => {
  const arm = { id: 'codefacts022', executable: '/cf' };
  assert.deepEqual(nativeConfig(arm, '/src', '/state', true).args.slice(-2), ['--tools', 'all']);
  assert.ok(!nativeConfig(arm, '/src', '/state').args.includes('--tools'));
  assert.equal(nativeConfig({ id: 'ordinary' }, '/src', '/state'), null);
  assert.ok(nativeConfig({ id: 'codegraph', node: '/node', cli: '/cg' }, '/src', '/state').args.includes('--no-watch'));
});
test('actual MCP server version must match the arm before model dispatch', () => {
  assert.doesNotThrow(() => assertNativeVersion({ serverInfo: { version: '1.6.2' } }, { id: 'codegraph', version: '1.6.2' }));
  assert.throws(() => assertNativeVersion({ serverInfo: { version: '0.2.1' } }, { id: 'codefacts022', version: '0.2.2' }), /version mismatch/);
  assert.throws(() => assertNativeVersion({}, { id: 'codegraph', version: '1.6.2' }), /observed missing/);
});
test('readiness requires actual exact catalog, provider usage and body source calls', () => {
  const receipt = { status: 'attempt-completed', headerAudit: true, exactTurnUsage: { totalTokens: 1 }, catalogs: [['source_list', 'source_search', 'source_read'].map(name => ({ name: `mcp__repo__${name}` }))], toolCalls: [{ name: 'mcp__repo__source_read' }] };
  assert.equal(auditAttempt(receipt, 'ordinary').infrastructureValid, true);
  assert.equal(auditAttempt({ ...receipt, toolCalls: [] }, 'ordinary', { canary: true }).infrastructureValid, false);
  assert.equal(auditAttempt({ ...receipt, exactTurnUsage: null }, 'ordinary', { canary: true }).infrastructureValid, false);
  assert.equal(auditAttempt(receipt, 'codefacts022').infrastructureValid, false);
});
test('native canary needs successful source-bearing results linked to its actual call ID', () => {
  const names = ['source_list', 'source_search', 'source_read', 'codegraph_explore'];
  const receipt = { status: 'attempt-completed', headerAudit: true, exactTurnUsage: { totalTokens: 2 }, catalogs: [names.map(name => ({ name: `mcp__repo__${name}` }))], toolCalls: [{ callId: 'n1', name: 'mcp__repo__codegraph_explore' }], toolResults: [] };
  assert.equal(auditAttempt(receipt, 'codegraph', { canary: true }).infrastructureValid, false);
  receipt.toolResults.push({ message: { toolCallId: 'n1', isError: false, content: [{ type: 'text', text: 'README.md:12-16: routing examples' }] } });
  assert.equal(auditAttempt(receipt, 'codegraph', { canary: true }).infrastructureValid, true);
  receipt.toolResults[0].message.isError = true;
  assert.equal(auditAttempt(receipt, 'codegraph', { canary: true }).infrastructureValid, false);
});
test('valid model failures retain their allocated receipt and permit later formal slots', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-campaign-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const receiptPath = path.join(dir, 'receipt.json');
  const receipt = { status: 'attempt-failed', timedOut: true, headerAudit: true, catalogs: [['source_list', 'source_search', 'source_read'].map(name => ({ name: `mcp__repo__${name}` }))], toolCalls: [], exactTurnUsage: null };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  const audit = auditAttempt(receipt, 'ordinary');
  assert.equal(audit.infrastructureValid, true); assert.equal(audit.taskSucceeded, false);
  const frozen = { id: 'freeze' }, slot = { id: 'slot', taskId: 'real-task' };
  assert.doesNotThrow(() => assertReusable({ freezeHash: hash(frozen), slot, status: 'task-failed', audit, receiptPath }, frozen, slot));
  assert.equal(auditAttempt({ ...receipt, headerAudit: false }, 'ordinary').infrastructureValid, false);
});
