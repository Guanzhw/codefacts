import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const suiteDir = path.resolve(scriptDir, 'suites', 'source-investigation-v1');
const metadataPath = path.join(suiteDir, 'corpora.json');

export function canonicalManifestHash(manifest) {
  validateManifest(manifest);
  const canonical = manifest
    .map(({ path: filePath, bytes, sha256 }) => ({ path: filePath, bytes, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function validateManifest(manifest) {
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error('Manifest must contain at least one file.');
  }
  const paths = new Set();
  for (const entry of manifest) {
    if (!entry || typeof entry.path !== 'string' || entry.path.includes('\\') || /[\r\n]/.test(entry.path) ||
        entry.path.startsWith('/') || /^[A-Za-z]:/.test(entry.path) ||
        entry.path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`Unsafe manifest path: ${entry?.path}`);
    }
    if (paths.has(entry.path)) throw new Error(`Duplicate manifest path: ${entry.path}`);
    paths.add(entry.path);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
        !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`Invalid manifest entry: ${entry.path}`);
    }
  }
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function manifestPath(root, relative) {
  return path.join(root, ...relative.split('/'));
}

export async function verifyTree(sourceRoot, manifest) {
  validateManifest(manifest);
  const root = await realpath(sourceRoot);
  const contents = [];
  for (const entry of manifest) {
    const source = manifestPath(root, entry.path);
    const resolved = await realpath(source);
    if (!isWithin(root, resolved) || !(await stat(resolved)).isFile()) {
      throw new Error(`Manifest entry is not a regular file inside the source tree: ${entry.path}`);
    }
    const bytes = await readFile(resolved);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== entry.bytes || sha256 !== entry.sha256) {
      throw new Error(`Frozen source mismatch: ${entry.path}`);
    }
    contents.push({ entry, bytes });
  }

  return {
    files: contents,
    fileCount: contents.length,
    sourceBytes: contents.reduce((sum, { entry }) => sum + entry.bytes, 0),
    canonicalManifestSha256: canonicalManifestHash(manifest),
  };
}

export async function copyVerifiedTree(sourceRoot, destinationRoot, manifest) {
  const verified = await verifyTree(sourceRoot, manifest);
  await mkdir(destinationRoot);
  for (const { entry, bytes } of verified.files) {
    const destination = manifestPath(destinationRoot, entry.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx' });
  }
  return {
    fileCount: verified.fileCount,
    sourceBytes: verified.sourceBytes,
    canonicalManifestSha256: verified.canonicalManifestSha256,
  };
}

export function validateArchiveEntries(entries, archiveRoot) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Archive has no entries.');
  for (const raw of entries) {
    const entry = raw.replace(/\/+$/, '');
    const parts = entry.split('/');
    if (!entry || entry.includes('\\') || entry.startsWith('/') ||
        /^[A-Za-z]:/.test(entry) || parts.some((part) => !part || part === '.' || part === '..') ||
        parts[0] !== archiveRoot) {
      throw new Error(`Unsafe or unexpected archive entry: ${raw}`);
    }
  }
}

export function archiveSelection(manifest, archiveRoot, archiveEntries) {
  validateManifest(manifest);
  const listedEntries = new Map();
  for (const entry of archiveEntries) {
    const normalized = entry.replace(/\/+$/, '');
    listedEntries.set(normalized, (listedEntries.get(normalized) ?? 0) + 1);
  }
  return manifest.map(({ path: filePath }) => {
    const archivePath = `${archiveRoot}/${filePath}`;
    const count = listedEntries.get(archivePath) ?? 0;
    if (count === 0) throw new Error(`Frozen file is missing from archive: ${archivePath}`);
    if (count !== 1) throw new Error(`Frozen file appears multiple times in archive: ${archivePath}`);
    return archivePath;
  });
}

export function planArchiveExtraction(manifest, archiveRoot, archiveEntries, verboseEntries) {
  const selected = archiveSelection(manifest, archiveRoot, archiveEntries);
  const files = [];
  const links = [];
  for (const archivePath of selected) {
    const matches = verboseEntries.filter((line) => line[0] === 'l'
      ? line.includes(`${archivePath} -> `)
      : line[0] === '-' && line.endsWith(archivePath));
    if (matches.length !== 1) throw new Error(`Could not identify archive member type: ${archivePath}`);
    const line = matches[0];
    if (line[0] === '-') {
      files.push(archivePath);
      continue;
    }
    const marker = `${archivePath} -> `;
    const target = line.slice(line.indexOf(marker) + marker.length);
    if (!target) throw new Error(`Archive symlink has no target: ${archivePath}`);
    links.push({ archivePath, target });
  }
  return { files, links };
}

function runTar(tar, args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(tar, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`tar failed (${code}): ${Buffer.concat(stderr).toString('utf8').trim()}`));
      } else {
        resolve(capture ? Buffer.concat(stdout).toString('utf8').split(/\r?\n/).filter(Boolean) : undefined);
      }
    });
  });
}

async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Archive download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx' }));
  return hashFile(destination);
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--output' && args[i + 1]) options.output = args[++i];
    else if (args[i] === '--tar' && args[i + 1]) options.tar = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') options.help = true;
    else throw new Error(`Unknown or incomplete option: ${args[i]}`);
  }
  if (options.output && !path.isAbsolute(options.output)) throw new Error('--output must be an absolute path.');
  if (options.tar && !path.isAbsolute(options.tar)) throw new Error('--tar must be an absolute path.');
  return options;
}

async function fetchCorpus(corpus, suiteDir, outputRoot, tar) {
  const manifest = JSON.parse(await readFile(path.join(suiteDir, corpus.manifest), 'utf8'));
  const manifestHash = canonicalManifestHash(manifest);
  if (manifestHash !== corpus.canonicalManifestSha256 || manifest.length !== corpus.fileCount) {
    throw new Error(`Tracked manifest metadata mismatch for ${corpus.id}.`);
  }

  const archivePath = path.join(outputRoot, 'archives', `${corpus.id}-${corpus.commit}.tar.gz`);
  const receiptPath = path.join(outputRoot, 'receipts', `${corpus.id}.download.json`);
  const stagingRoot = path.join(outputRoot, 'staging', corpus.id);
  const destinationRoot = path.join(outputRoot, 'corpora', corpus.id);
  const receipt = {
    schemaVersion: 1,
    corpus: corpus.id,
    repository: corpus.repository,
    commit: corpus.commit,
    archiveUrl: corpus.archiveUrl,
    frozenManifestSha256: corpus.frozenManifestSha256,
    canonicalManifestSha256: manifestHash,
    status: 'started',
  };
  try {
    const archive = await download(corpus.archiveUrl, archivePath);
    Object.assign(receipt, {
      archiveSha256: archive.sha256,
      archiveBytes: archive.bytes,
      archiveComplete: true,
      downloadedAt: new Date().toISOString(),
    });
    const entries = await runTar(tar, ['-tzf', archivePath], true);
    validateArchiveEntries(entries, corpus.archiveRoot);
    const verboseEntries = await runTar(tar, ['-tvzf', archivePath], true);
    await mkdir(stagingRoot);
    const selection = planArchiveExtraction(manifest, corpus.archiveRoot, entries, verboseEntries);
    const selectionPath = path.join(stagingRoot, 'files-from.txt');
    if (selection.files.some((entry) => /[\r\n]/.test(entry))) {
      throw new Error('Archive file paths cannot contain newlines.');
    }
    await writeFile(selectionPath, `${selection.files.join('\n')}${selection.files.length ? '\n' : ''}`, { flag: 'wx' });
    if (selection.files.length) {
      await runTar(tar, ['-xzf', archivePath, '-C', stagingRoot, '-T', selectionPath]);
    }
    const extractedRoot = path.join(stagingRoot, corpus.archiveRoot);
    for (const link of selection.links) {
      const relativePath = link.archivePath.slice(corpus.archiveRoot.length + 1);
      const destination = manifestPath(extractedRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, link.target, { flag: 'wx' });
    }
    const verified = await copyVerifiedTree(extractedRoot, destinationRoot, manifest);
    Object.assign(receipt, {
      status: 'verified',
      fileCount: verified.fileCount,
      sourceBytes: verified.sourceBytes,
      output: path.relative(outputRoot, destinationRoot).split(path.sep).join('/'),
    });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    return receipt;
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = error instanceof Error ? error.message : String(error);
    if (error?.cause?.code) receipt.causeCode = error.cause.code;
    try {
      const partialArchive = await hashFile(archivePath);
      receipt.archiveSha256 ??= partialArchive.sha256;
      receipt.archiveBytes ??= partialArchive.bytes;
      receipt.archiveComplete ??= false;
    } catch {
      // No archive was created; preserve the failure in the receipt below.
    }
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    process.stdout.write('Usage: node benchmarks/agent-eval/task-benchmark/fetch-corpora.mjs --output ABSOLUTE_NEW_DIRECTORY [--tar ABSOLUTE_TAR]\n');
    return;
  }
  if (!options.output) throw new Error('--output is required.');
  await mkdir(options.output);
  for (const directory of ['archives', 'receipts', 'staging', 'corpora']) {
    await mkdir(path.join(options.output, directory));
  }
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const results = [];
  for (const corpus of metadata.corpora) {
    results.push(await fetchCorpus(corpus, suiteDir, options.output, options.tar ?? 'tar'));
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
