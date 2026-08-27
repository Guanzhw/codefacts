import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const npmDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const stageScript = resolve(npmDirectory, 'scripts', 'stage-platform-package.mjs');
const packageMetadata = JSON.parse(await readFile(resolve(npmDirectory, 'package.json'), 'utf8'));

test('stages a versioned, platform-constrained native package', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'codefacts-stage-platform-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const binaryPath = join(root, 'native');
  const outputDirectory = join(root, 'package');
  await writeFile(binaryPath, 'native bytes');
  const result = spawnSync(process.execPath, [
    stageScript,
    '--version', packageMetadata.version,
    '--platform', 'linux-x64',
    '--binary', binaryPath,
    '--output', outputDirectory,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(await readFile(join(outputDirectory, 'package.json'), 'utf8'));
  assert.equal(metadata.name, '@acetamido/codefacts-linux-x64');
  assert.equal(metadata.version, packageMetadata.version);
  assert.deepEqual(metadata.os, ['linux']);
  assert.deepEqual(metadata.cpu, ['x64']);
  assert.equal(metadata.codefacts.platform, 'linux-x64');
  assert.equal(await readFile(join(outputDirectory, 'codefacts'), 'utf8'), 'native bytes');
});
