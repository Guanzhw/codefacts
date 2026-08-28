import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const visibilityTimeoutMs = 15 * 60 * 1000;
const visibilityPollIntervalMs = 15 * 1000;

function readTarEntry(buffer, wantedName) {
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
    const sizeText = header.subarray(124, 136).toString('utf8').replace(/\0.*$/u, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    const bodyStart = offset + 512;
    if (name === wantedName) return buffer.subarray(bodyStart, bodyStart + size);
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`package archive does not contain ${wantedName}`);
}

export async function packageMetadata(archivePath) {
  const compressed = await readFile(archivePath);
  let metadata;
  try {
    metadata = JSON.parse(readTarEntry(gunzipSync(compressed), 'package/package.json'));
  } catch (error) {
    throw new Error(`cannot read package/package.json from ${archivePath}: ${error.message}`);
  }
  if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string') {
    throw new Error(`package archive ${archivePath} has invalid name/version metadata`);
  }
  return metadata;
}

export async function packageIntegrity(archivePath) {
  const bytes = await readFile(archivePath);
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

async function runNpm(args, { timeoutMs } = {}) {
  try {
    const result = await execFileAsync(npmCommand, args, { encoding: 'utf8', timeout: timeoutMs });
    return { status: 0, stdout: result.stdout || '', stderr: result.stderr || '' };
  } catch (error) {
    return {
      status: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      timedOut: timeoutMs !== undefined && (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM'),
    };
  }
}

function parseIntegrity(stdout) {
  const text = stdout.trim();
  if (!text || text === 'null') return null;
  try {
    const value = JSON.parse(text);
    return typeof value === 'string' ? value : value?.dist?.integrity || null;
  } catch {
    return text.replace(/^"|"$/gu, '');
  }
}

async function publishedIntegrity(name, version, executeNpm, timeoutMs) {
  const result = await executeNpm(['view', `${name}@${version}`, 'dist.integrity', '--json'], { timeoutMs });
  if (result.timedOut) return null;
  if (result.status === 0) return parseIntegrity(result.stdout);
  if (/\bE404\b|\b404\b/u.test(`${result.stdout}\n${result.stderr}`)) return null;
  throw new Error(`npm view failed for ${name}@${version}: ${result.stderr || result.stdout}`.trim());
}

export async function publishArchive(archivePath, { executeNpm = runNpm } = {}) {
  const metadata = await packageMetadata(archivePath);
  const localIntegrity = await packageIntegrity(archivePath);
  const existingIntegrity = await publishedIntegrity(metadata.name, metadata.version, executeNpm);
  if (existingIntegrity !== null) {
    if (existingIntegrity !== localIntegrity) {
      throw new Error(
        `npm package ${metadata.name}@${metadata.version} already exists with integrity ${existingIntegrity}, expected ${localIntegrity}`,
      );
    }
    return { action: 'skipped', name: metadata.name, version: metadata.version, integrity: localIntegrity };
  }
  const result = await executeNpm(['publish', archivePath, '--access', 'public', '--provenance']);
  if (result.status !== 0) {
    throw new Error(`npm publish failed for ${metadata.name}@${metadata.version}: ${result.stderr || result.stdout}`.trim());
  }
  return { action: 'published', name: metadata.name, version: metadata.version, integrity: localIntegrity };
}

export async function verifyArchivePublished(
  archivePath,
  {
    executeNpm = runNpm,
    sleep = (durationMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, durationMs)),
    now = Date.now,
    timeoutMs = visibilityTimeoutMs,
    pollIntervalMs = visibilityPollIntervalMs,
  } = {},
) {
  const metadata = await packageMetadata(archivePath);
  const expectedIntegrity = await packageIntegrity(archivePath);
  const deadline = now() + timeoutMs;
  while (true) {
    const remainingBeforeViewMs = deadline - now();
    if (remainingBeforeViewMs <= 0) break;
    const actualIntegrity = await publishedIntegrity(
      metadata.name,
      metadata.version,
      executeNpm,
      remainingBeforeViewMs,
    );
    if (actualIntegrity === expectedIntegrity && now() <= deadline) {
      return { name: metadata.name, version: metadata.version, integrity: expectedIntegrity };
    }
    if (actualIntegrity !== null) {
      throw new Error(
        `npm package ${metadata.name}@${metadata.version} is not visible with the expected integrity ${expectedIntegrity}`,
      );
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
  throw new Error(
    `npm package ${metadata.name}@${metadata.version} is not visible with the expected integrity ${expectedIntegrity}`,
  );
}

async function packageArchives(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const archives = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      archives.push(...await packageArchives(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.tgz')) {
      archives.push(entryPath);
    }
  }
  return archives;
}

export async function publishReleasePackages({ platformArchives, mainArchive, expectedPlatforms, executeNpm = runNpm }) {
  const platforms = await Promise.all(platformArchives.map(async (archivePath) => ({
    archivePath,
    metadata: await packageMetadata(archivePath),
  })));
  const expectedNames = Object.values(expectedPlatforms).map((asset) => asset.packageName).sort();
  const actualNames = platforms.map(({ metadata }) => metadata.name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`platform archives must contain exactly: ${expectedNames.join(', ')}`);
  }
  const version = (await packageMetadata(mainArchive)).version;
  if (platforms.some(({ metadata }) => metadata.version !== version)) {
    throw new Error(`all platform packages must use main package version ${version}`);
  }
  for (const { archivePath } of platforms) {
    await publishArchive(archivePath, { executeNpm });
  }
  for (const { archivePath } of platforms) {
    await verifyArchivePublished(archivePath, { executeNpm });
  }
  return publishArchive(mainArchive, { executeNpm });
}

async function main() {
  const args = process.argv.slice(2);
  const platformDirectoryIndex = args.indexOf('--platform-dir');
  const mainIndex = args.indexOf('--main');
  if (platformDirectoryIndex < 0 || mainIndex < 0 || !args[platformDirectoryIndex + 1] || !args[mainIndex + 1]) {
    throw new Error('Usage: node publish-packages.mjs --platform-dir <directory> --main <main-package.tgz>');
  }
  const npmDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const expectedPlatforms = JSON.parse(await readFile(join(npmDirectory, 'assets.json'), 'utf8'));
  const platforms = await packageArchives(resolve(args[platformDirectoryIndex + 1]));
  const result = await publishReleasePackages({
    platformArchives: platforms,
    mainArchive: resolve(args[mainIndex + 1]),
    expectedPlatforms,
  });
  process.stdout.write(`Main package ${result.action}: ${result.name}@${result.version}.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
