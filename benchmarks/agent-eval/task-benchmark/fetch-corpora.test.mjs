import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  archiveSelection,
  canonicalManifestHash,
  copyVerifiedTree,
  planArchiveExtraction,
  validateArchiveEntries,
  verifyTree,
} from './fetch-corpora.mjs';

async function fixture(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codefacts-corpus-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(source);
  const manifest = [];
  for (const [filePath, value] of Object.entries(files)) {
    const bytes = Buffer.from(value);
    const destination = path.join(source, ...filePath.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    manifest.push({
      path: filePath,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return { root, source, manifest };
}

test('copies only manifest files after verifying exact byte lengths and hashes', async (t) => {
  const { root, source, manifest } = await fixture(t, {
    'src/index.js': 'export const answer = 42;\n',
    'LICENSE': 'MIT\n',
  });
  await writeFile(path.join(source, 'unlisted.txt'), 'ignored');
  const destination = path.join(root, 'corpus');
  const result = await copyVerifiedTree(source, destination, manifest);

  assert.equal(result.fileCount, 2);
  assert.equal(result.canonicalManifestSha256, canonicalManifestHash(manifest));
  assert.equal(await readFile(path.join(destination, 'src', 'index.js'), 'utf8'), 'export const answer = 42;\n');
  await assert.rejects(readFile(path.join(destination, 'unlisted.txt')));
});

test('rejects changed source before creating a corpus destination', async (t) => {
  const { root, source, manifest } = await fixture(t, { 'source.txt': 'frozen' });
  await writeFile(path.join(source, 'source.txt'), 'changed');
  const destination = path.join(root, 'corpus');

  await assert.rejects(verifyTree(source, manifest), /Frozen source mismatch/);
  await assert.rejects(copyVerifiedTree(source, destination, manifest), /Frozen source mismatch/);
  await assert.rejects(readFile(destination));
});

test('rejects unsafe archive entries, unsafe manifest paths, and existing destinations', async (t) => {
  assert.throws(() => validateArchiveEntries(['repo/file', 'repo/../../outside'], 'repo'), /Unsafe/);
  assert.throws(() => validateArchiveEntries(['/repo/file'], 'repo'), /Unsafe/);
  const { root, source, manifest } = await fixture(t, { 'source.txt': 'frozen' });
  assert.throws(() => canonicalManifestHash([{ ...manifest[0], path: '../outside' }]), /Unsafe/);
  assert.throws(() => canonicalManifestHash([{ ...manifest[0], path: 'line\nbreak' }]), /Unsafe/);
  const destination = path.join(root, 'existing');
  await mkdir(destination);
  await assert.rejects(copyVerifiedTree(source, destination, manifest), /already exists|EEXIST/);
});

test('selects frozen regular files and materializes selected symlink targets', () => {
  const manifest = [
    { path: 'src/file.js', bytes: 4, sha256: 'a'.repeat(64) },
    { path: 'HomebrewFormula', bytes: 8, sha256: 'b'.repeat(64) },
  ];
  const archiveEntries = [
    'repo/',
    'repo/src/',
    'repo/src/file.js',
    'repo/HomebrewFormula',
    'repo/unlisted-link',
  ];
  const plan = planArchiveExtraction(manifest, 'repo', archiveEntries, [
    '-rw-r--r-- 0/0 4 2026-10-16 12:00 repo/src/file.js',
    'lrwxrwxrwx 0/0 0 2026-10-16 12:00 repo/HomebrewFormula -> pkg/brew',
    'lrwxrwxrwx 0/0 0 2026-10-16 12:00 repo/unlisted-link -> elsewhere',
  ]);
  assert.deepEqual(plan, {
    files: ['repo/src/file.js'],
    links: [{ archivePath: 'repo/HomebrewFormula', target: 'pkg/brew' }],
  });
  assert.throws(() => archiveSelection(manifest, 'repo', ['repo/']), /missing from archive/);
});
