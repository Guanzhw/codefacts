import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { archiveSnapshot } from './member-ranking-native.mjs';

test('snapshot audit rejects modified files and extra source outside the archive', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'codefacts-snapshot-audit-'));
  try {
    const root = join(temporary, 'source');
    const archive = join(temporary, 'source.tar');
    mkdirSync(root);
    writeFileSync(join(root, 'index.js'), 'export const value = 1;\n');
    const create = spawnSync('python', ['-c', 'import sys,tarfile; t=tarfile.open(sys.argv[1],"w"); t.add(sys.argv[2],arcname="index.js"); t.close()', archive, join(root, 'index.js')], { windowsHide: true });
    assert.equal(create.status, 0);
    assert.deepEqual(Object.keys(archiveSnapshot(archive, root)), ['index.js']);
    writeFileSync(join(root, 'index.js'), 'export const value = 2;\n');
    assert.throws(() => archiveSnapshot(archive, root), /snapshot file differs/);
    writeFileSync(join(root, 'index.js'), 'export const value = 1;\n');
    writeFileSync(join(root, 'extra.js'), 'export const extra = true;\n');
    assert.throws(() => archiveSnapshot(archive, root), /snapshot file set differs/);
  } finally {
    rmSync(temporary, { recursive: true });
  }
});
