import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { packageIntegrity, publishArchive, verifyArchivePublished } from '../scripts/publish-packages.mjs';

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

test('waits for npm registry visibility after publishing without real sleeps', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'codefacts-publish-helper-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const archivePath = join(root, 'package.tgz');
  await writeFile(archivePath, packageArchive({ name: '@acetamido/example', version: '0.1.11' }));
  const expected = await packageIntegrity(archivePath);
  const responses = [
    { status: 1, stdout: '', stderr: 'npm ERR! code E404' },
    { status: 0, stdout: 'null', stderr: '' },
    { status: 0, stdout: JSON.stringify(expected), stderr: '' },
  ];
  const calls = [];
  const sleeps = [];
  let currentTime = 1000;
  const result = await verifyArchivePublished(archivePath, {
    executeNpm: async (args) => {
      calls.push(args);
      return responses.shift();
    },
    sleep: async (durationMs) => {
      sleeps.push(durationMs);
      currentTime += durationMs;
    },
    now: () => currentTime,
    timeoutMs: 10_000,
    pollIntervalMs: 3_000,
  });
  assert.deepEqual(result, { name: '@acetamido/example', version: '0.1.11', integrity: expected });
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [3_000, 3_000]);
});

test('times out absent registry visibility and preserves integrity mismatch failures', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'codefacts-publish-helper-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const archivePath = join(root, 'package.tgz');
  await writeFile(archivePath, packageArchive({ name: '@acetamido/example', version: '0.1.11' }));
  const sleeps = [];
  let currentTime = 0;
  await assert.rejects(
    verifyArchivePublished(archivePath, {
      executeNpm: async () => ({ status: 1, stdout: '', stderr: 'npm ERR! code E404' }),
      sleep: async (durationMs) => {
        sleeps.push(durationMs);
        currentTime += durationMs;
      },
      now: () => currentTime,
      timeoutMs: 5_000,
      pollIntervalMs: 2_000,
    }),
    /is not visible with the expected integrity/,
  );
  assert.deepEqual(sleeps, [2_000, 2_000, 1_000]);

  await assert.rejects(
    verifyArchivePublished(archivePath, {
      executeNpm: async () => ({ status: 0, stdout: JSON.stringify('sha512-wrong'), stderr: '' }),
      sleep: async () => assert.fail('integrity mismatches must not be retried'),
      timeoutMs: 5_000,
    }),
    /is not visible with the expected integrity/,
  );
});

test('bounds each npm view and rejects a result that arrives after the deadline', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'codefacts-publish-helper-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const archivePath = join(root, 'package.tgz');
  await writeFile(archivePath, packageArchive({ name: '@acetamido/example', version: '0.1.11' }));
  const expected = await packageIntegrity(archivePath);
  let currentTime = 0;
  const viewTimeouts = [];
  await assert.rejects(
    verifyArchivePublished(archivePath, {
      executeNpm: async (_args, options) => {
        viewTimeouts.push(options.timeoutMs);
        return { status: 1, stdout: '', stderr: '', timedOut: true };
      },
      sleep: async (durationMs) => {
        currentTime += durationMs;
      },
      now: () => currentTime,
      timeoutMs: 5_000,
      pollIntervalMs: 2_000,
    }),
    /is not visible with the expected integrity/,
  );
  assert.deepEqual(viewTimeouts, [5_000, 3_000, 1_000]);

  currentTime = 0;
  await assert.rejects(
    verifyArchivePublished(archivePath, {
      executeNpm: async () => {
        currentTime = 5_001;
        return { status: 0, stdout: JSON.stringify(expected), stderr: '' };
      },
      now: () => currentTime,
      timeoutMs: 5_000,
    }),
    /is not visible with the expected integrity/,
  );
});
