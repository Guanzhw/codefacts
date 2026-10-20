import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { hash, writeJson } from '../rpc.mjs';
import { inspectArchive, verifyCommunitySource, prepareCommunitySlot, collectPatch } from './prepare.mjs';

function tar(rows) {
  const chunks = [];
  for (const row of rows) {
    const header = Buffer.alloc(512), bytes = Buffer.from(row.content ?? '');
    header.write(row.path, 0, 100); header.write('0000644\0', 100, 8); header.write('0000000\0', 108, 8); header.write('0000000\0', 116, 8);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12); header.fill(32, 148, 156);
    header.write(row.type ?? '0', 156, 1); if (row.target) header.write(row.target, 157, 100);
    header.write('ustar\0', 257, 6);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

test('archive inspection preserves exact bytes and link metadata', () => {
  const content = Buffer.from([0, 255, 13, 10, 42]);
  const { top, rows } = inspectArchive(tar([{ path: 'repo/src/file', content }, { path: 'repo/link', type: '2', target: 'src/file' }]));
  assert.equal(top, 'repo'); assert.equal(rows.length, 2);
  assert.equal(rows[0].path, 'link'); assert.equal(rows[0].target, 'src/file'); assert.equal(rows[0].mode, '120000');
  assert.deepEqual(rows[1].content, content); assert.equal(rows[1].sha256, hash(content));
});

test('archive inspection rejects escape, symlink traversal and case aliases', () => {
  assert.throws(() => inspectArchive(tar([{ path: 'repo/../outside' }])), /Unsafe archive path/);
  assert.throws(() => inspectArchive(tar([{ path: 'repo/link', type: '2', target: '../../outside' }])), /Escaping source symlink/);
  assert.throws(() => inspectArchive(tar([{ path: 'repo/link', type: '2', target: 'other' }, { path: 'repo/link/child' }])), /descends through symlink/);
  if (process.platform === 'win32') assert.throws(() => inspectArchive(tar([{ path: 'repo/A' }, { path: 'repo/a' }])), /collision/);
});

test('real Git baseline preserves CRLF, captures new and deleted files, excludes native index', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-prepare-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourceRoot = path.join(dir, 'snapshot', 'source'); fs.mkdirSync(sourceRoot, { recursive: true });
  const files = { '.gitattributes': '* text eol=lf\n', '.gitignore': 'ignored/\n', 'old.txt': 'delete me\r\n', 'keep.txt': 'original\r\n', 'binary.bin': Buffer.from([0, 255, 13, 10]), 'latin[1].txt': Buffer.from([61, 233, 10]) };
  const entries = Object.entries(files).map(([file, content]) => {
    const bytes = Buffer.from(content); fs.writeFileSync(path.join(sourceRoot, file), bytes);
    return { path: file, bytes: bytes.length, sha256: hash(bytes), mode: '100644' };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const task = { instanceId: 'fixture-1', repo: 'fixture/repo', baseCommit: 'a'.repeat(40), sourceRoot };
  writeJson(path.join(dir, 'snapshot', 'manifest.json'), { ...task, entries, digest: hash(entries) });
  const attempt = await prepareCommunitySlot({ task, arm: { id: 'ordinary', version: 'none' }, runtime: { sdkRoot: dir, rg: 'rg' }, dir: path.join(dir, 'attempt') });
  assert.equal(await collectPatch(attempt.root), '');
  assert.deepEqual(fs.readFileSync(path.join(attempt.root, 'keep.txt')), Buffer.from('original\r\n'));
  assert.deepEqual(spawnSync('git', ['show', 'HEAD:keep.txt'], { cwd: attempt.root }).stdout, Buffer.from('original\r\n'));
  assert.deepEqual(spawnSync('git', ['show', 'HEAD:binary.bin'], { cwd: attempt.root }).stdout, files['binary.bin']);
  assert.equal(spawnSync('git', ['remote'], { cwd: attempt.root, encoding: 'utf8' }).stdout, '');
  assert.equal(spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: attempt.root, encoding: 'utf8' }).stdout.trim(), '1');
  fs.unlinkSync(path.join(attempt.root, 'old.txt')); fs.writeFileSync(path.join(attempt.root, 'keep.txt'), 'updated\r\n');
  fs.writeFileSync(path.join(attempt.root, 'new.txt'), 'brand new\n');
  fs.mkdirSync(path.join(attempt.root, '.codegraph')); fs.writeFileSync(path.join(attempt.root, '.codegraph', 'db'), 'generated');
  const patch = await collectPatch(attempt.root);
  assert.match(patch, /new file mode 100644/); assert.match(patch, /deleted file mode 100644/); assert.match(patch, /brand new/); assert.match(patch, /updated/); assert.doesNotMatch(patch, /generated|\.codegraph/);
  assert.equal(attempt.setup.indexDurationMs, 0); assert.equal(attempt.setup.indexDiskBytes, 0); assert.equal(attempt.sourceIdentity.baseCommit, task.baseCommit);
  verifyCommunitySource(sourceRoot, entries);
  fs.writeFileSync(path.join(attempt.root, 'binary.bin'), Buffer.from([0, 254, 13, 10]));
  assert.match(await collectPatch(attempt.root), /GIT binary patch/);
  fs.mkdirSync(path.join(attempt.root, 'ignored')); fs.writeFileSync(path.join(attempt.root, 'ignored', 'source.js'), 'new source\n');
  fs.writeFileSync(path.join(attempt.root, 'ignored', 'build-output'), 'generated by test\n');
  assert.doesNotMatch(await collectPatch(attempt.root), /ignored\/source.js/);
  const latin = Buffer.from([62, 233, 10]); fs.writeFileSync(path.join(attempt.root, 'latin[1].txt'), latin);
  const finalPatch = await collectPatch(attempt.root, { createdPaths: ['ignored/source.js'] });
  assert.match(finalPatch, /ignored\/source.js/); assert.doesNotMatch(finalPatch, /build-output/); assert.doesNotMatch(finalPatch, /\ufffd/);
  const git = args => { const result = spawnSync('git', args, { cwd: attempt.root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git(['reset', '--hard', 'HEAD']); fs.rmSync(path.join(attempt.root, 'ignored'), { recursive: true, force: true });
  const patchFile = path.join(dir, 'final.patch'); fs.writeFileSync(patchFile, finalPatch);
  git(['apply', '--binary', patchFile]);
  assert.deepEqual(fs.readFileSync(path.join(attempt.root, 'latin[1].txt')), latin);
  assert.equal(fs.readFileSync(path.join(attempt.root, 'ignored', 'source.js'), 'utf8'), 'new source\n');
});

test('source verification reports unexpected source and byte drift', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-verify-'));
  try {
    fs.writeFileSync(path.join(dir, 'one'), 'x'); const entries = [{ path: 'one', bytes: 1, sha256: hash('x'), mode: '100644' }];
    fs.writeFileSync(path.join(dir, 'two'), 'x'); assert.throws(() => verifyCommunitySource(dir, entries), /inventory drift/);
    fs.unlinkSync(path.join(dir, 'two')); fs.writeFileSync(path.join(dir, 'one'), 'y'); assert.throws(() => verifyCommunitySource(dir, entries), /byte drift/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('read-only Context can share immutable bytes while repair sources remain independent', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-materialize-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourceRoot = path.join(dir, 'snapshot', 'source'); fs.mkdirSync(sourceRoot, { recursive: true });
  const original = 'immutable source\n'; fs.writeFileSync(path.join(sourceRoot, 'x.txt'), original);
  const entries = [{ path: 'x.txt', bytes: Buffer.byteLength(original), sha256: hash(original), mode: '100644' }];
  const task = { instanceId: 'fixture', repo: 'fixture/repo', baseCommit: 'a'.repeat(40), sourceRoot };
  writeJson(path.join(dir, 'snapshot', 'manifest.json'), { ...task, entries, digest: hash(entries) });
  const runtime = { sdkRoot: dir, rg: 'rg', contextSourceMode: 'hardlink' };
  const context = await prepareCommunitySlot({ task: { ...task, cohort: 'context' }, arm: { id: 'ordinary' }, runtime, dir: path.join(dir, 'context') });
  assert.equal(context.setup.sourceMaterialization, 'read-only-hardlinks');
  assert.ok(fs.statSync(path.join(sourceRoot, 'x.txt')).nlink >= 2);
  const repair = await prepareCommunitySlot({ task: { ...task, cohort: 'swe' }, arm: { id: 'ordinary' }, runtime, dir: path.join(dir, 'repair') });
  assert.equal(repair.setup.sourceMaterialization, 'independent-copy');
  fs.writeFileSync(path.join(repair.root, 'x.txt'), 'actual repair\n');
  assert.equal(fs.readFileSync(path.join(sourceRoot, 'x.txt'), 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(context.root, 'x.txt'), 'utf8'), original);
});

test('explicit Context boundary mode creates no Git commit, index or objects; SWE keeps real Git', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-git-boundary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourceRoot = path.join(dir, 'snapshot', 'source'); fs.mkdirSync(sourceRoot, { recursive: true });
  const content = 'export function example() { return 1; }\n'; fs.writeFileSync(path.join(sourceRoot, 'example.js'), content);
  const entries = [{ path: 'example.js', bytes: Buffer.byteLength(content), sha256: hash(content), mode: '100644' }];
  const task = { instanceId: 'boundary-fixture', repo: 'fixture/repo', baseCommit: 'a'.repeat(40), sourceRoot };
  writeJson(path.join(dir, 'snapshot', 'manifest.json'), { ...task, entries, digest: hash(entries) });
  const runtime = { sdkRoot: dir, rg: 'rg', contextSourceMode: 'hardlink', contextGitMode: 'boundary-only' };
  const context = await prepareCommunitySlot({ task: { ...task, cohort: 'context' }, arm: { id: 'ordinary' }, runtime, dir: path.join(dir, 'context') });
  assert.equal(context.setup.gitMode, 'boundary-only'); assert.equal(context.sourceIdentity.syntheticCommit, null);
  assert.equal(fs.existsSync(path.join(context.root, '.git', 'index')), false);
  assert.deepEqual(fs.readdirSync(path.join(context.root, '.git', 'objects')), []);
  assert.notEqual(spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: context.root }).status, 0);
  assert.equal(spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: context.root, encoding: 'utf8' }).stdout.trim().replaceAll('\\', '/'), fs.realpathSync.native(context.root).replaceAll('\\', '/'));
  const configuredHooks = spawnSync('git', ['config', 'core.hooksPath'], { cwd: context.root, encoding: 'utf8' });
  assert.equal(configuredHooks.status, 0); assert.deepEqual(fs.readdirSync(configuredHooks.stdout.trim()), []);
  verifyCommunitySource(sourceRoot, entries); verifyCommunitySource(context.root, entries);
  const repair = await prepareCommunitySlot({ task: { ...task, cohort: 'swe' }, arm: { id: 'ordinary' }, runtime, dir: path.join(dir, 'repair') });
  assert.equal(repair.setup.gitMode, 'synthetic-commit'); assert.match(repair.sourceIdentity.syntheticCommit, /^[a-f0-9]{40}$/);
  fs.writeFileSync(path.join(repair.root, 'example.js'), content.replace('return 1', 'return 2'));
  fs.writeFileSync(path.join(repair.root, 'new.js'), 'export const added = true;\n');
  const patch = await collectPatch(repair.root); assert.match(patch, /return 2/); assert.match(patch, /new file mode/);
  assert.equal(fs.readFileSync(path.join(sourceRoot, 'example.js'), 'utf8'), content);
});
