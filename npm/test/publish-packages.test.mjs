import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { packageIntegrity, publishArchive } from '../scripts/publish-packages.mjs';

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100, 'utf8');
  header.write('0000000\0', 108, 'utf8');
  header.write('0000000\0', 116, 'utf8');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'utf8');
  header.write('00000000000\0', 136, 'utf8');
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257, 'utf8');
  return header;
}

function packageArchive(metadata) {
  const body = Buffer.from(JSON.stringify(metadata));
  const entry = Buffer.concat([
    tarHeader('package/package.json', body.length),
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
    Buffer.alloc(1024),
  ]);
  return gzipSync(entry);
}

test('publishes absent packages, skips exact integrity matches, and rejects mismatches', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'codefacts-publish-helper-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const archivePath = join(root, 'package.tgz');
  await writeFile(archivePath, packageArchive({ name: '@acetamido/example', version: '0.1.11' }));
  const expected = await packageIntegrity(archivePath);
  const calls = [];
  const absentRunner = async (args) => {
    calls.push(args);
    return args[0] === 'view'
      ? { status: 1, stdout: '', stderr: 'npm ERR! code E404' }
      : { status: 0, stdout: '', stderr: '' };
  };
  assert.equal((await publishArchive(archivePath, { executeNpm: absentRunner })).action, 'published');
  assert.deepEqual(calls.map((args) => args[0]), ['view', 'publish']);

  const exact = await publishArchive(archivePath, {
    executeNpm: async (args) => ({
      status: 0,
      stdout: args[0] === 'view' ? JSON.stringify(expected) : '',
      stderr: '',
    }),
  });
  assert.equal(exact.action, 'skipped');

  await assert.rejects(
    publishArchive(archivePath, {
      executeNpm: async () => ({ status: 0, stdout: JSON.stringify(`sha512-${createHash('sha512').update('other').digest('base64')}`), stderr: '' }),
    }),
    /already exists with integrity/,
  );
});
