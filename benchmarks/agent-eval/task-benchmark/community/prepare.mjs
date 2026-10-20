import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { nativeConfig, assertNativeVersion, GENERATED } from '../prepare.mjs';
import { loadSdk, connectNative, hash, writeJson } from '../rpc.mjs';

const order = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const excluded = file => file.split('/').some(part => GENERATED.test(part));
const patchPaths = ['.', ':(exclude,glob)**/.codegraph*', ':(exclude,glob).codegraph*', ':(exclude,glob)**/.code-graph*', ':(exclude,glob).code-graph*'];
const text = bytes => bytes.toString('utf8').replace(/\0.*$/s, '');

function safePath(file) {
  if (!file || file.includes('\\') || file.startsWith('/') || file.split('/').some(part => part === '..' || part.toLowerCase() === '.git' || /[:\x00-\x1f]/.test(part))) throw new Error(`Unsafe archive path: ${file}`);
  if (process.platform === 'win32' && file.split('/').some(part => /[<>"|?*]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error(`NTFS-ineligible archive path: ${file}`);
  return file;
}

function paxFields(bytes) {
  const fields = {};
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset), length = Number(bytes.subarray(offset, space).toString());
    if (space < 0 || !Number.isSafeInteger(length) || length <= space - offset || offset + length > bytes.length) throw new Error('Invalid PAX record');
    const row = bytes.subarray(space + 1, offset + length - 1).toString('utf8'), equal = row.indexOf('=');
    fields[row.slice(0, equal)] = row.slice(equal + 1); offset += length;
  }
  return fields;
}

/** Inspect the complete archive before writing any path. No upstream history is fetched. */
export function inspectArchive(gzip) {
  const tar = gunzipSync(gzip), rows = []; let pending = {}, global = {}, top;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) break;
    const checksum = parseInt(text(header.subarray(148, 156)).trim(), 8);
    const actual = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (checksum !== actual) throw new Error('Archive header checksum mismatch');
    const size = parseInt(text(header.subarray(124, 136)).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > tar.length) throw new Error('Invalid archive member size');
    const bytes = tar.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    const type = text(header.subarray(156, 157)) || '0';
    if (type === 'x') { pending = { ...pending, ...paxFields(bytes) }; continue; }
    if (type === 'g') { global = { ...global, ...paxFields(bytes) }; continue; }
    if (type === 'L' || type === 'K') { pending[type === 'L' ? 'path' : 'linkpath'] = text(bytes).replace(/\n$/, ''); continue; }
    const fields = { ...global, ...pending }; pending = {};
    const prefix = text(header.subarray(345, 500));
    const full = (fields.path ?? `${prefix ? `${prefix}/` : ''}${text(header.subarray(0, 100))}`).replace(/\/$/, '');
    safePath(full); const parts = full.split('/'); top ??= parts[0];
    if (parts[0] !== top) throw new Error('Archive has multiple top-level roots');
    if (parts.length === 1) { if (type !== '5') throw new Error('Archive root is not a directory'); continue; }
    const file = safePath(parts.slice(1).join('/'));
    if (type === '5') continue;
    if (!['0', '2'].includes(type)) throw new Error(`Unsupported archive member type ${type}: ${file}`);
    const target = type === '2' ? fields.linkpath ?? text(header.subarray(157, 257)) : null;
    if (target !== null) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
      if (target.includes('\\') || path.posix.isAbsolute(target) || resolved === '..' || resolved.startsWith('../')) throw new Error(`Escaping source symlink: ${file}`);
    }
    const mode = type === '2' ? '120000' : (parseInt(text(header.subarray(100, 108)).trim(), 8) & 0o111) ? '100755' : '100644';
    const content = target === null ? bytes : Buffer.from(target);
    rows.push({ path: file, bytes: content.length, sha256: hash(content), mode, ...(target === null ? { content } : { target }) });
  }
  rows.sort(order); const seen = new Map(), directoryNames = new Map(), links = new Set(rows.filter(row => row.target !== undefined).map(row => row.path));
  for (const row of rows) {
    const key = process.platform === 'win32' ? row.path.toLowerCase() : row.path;
    if (seen.has(key)) throw new Error(`Source path collision: ${seen.get(key)} / ${row.path}`);
    seen.set(key, row.path);
    const parts = row.path.split('/'); parts.pop();
    while (parts.length) {
      const directory = parts.join('/');
      if (links.has(directory)) throw new Error(`Source member descends through symlink: ${row.path}`);
      if (process.platform === 'win32') {
        const prior = directoryNames.get(directory.toLowerCase());
        if (prior !== undefined && prior !== directory) throw new Error(`Source directory case collision: ${prior} / ${directory}`);
        directoryNames.set(directory.toLowerCase(), directory);
      }
      parts.pop();
    }
  }
  return { top, rows };
}

function manifestEntries(rows) { return rows.map(({ content, ...row }) => row).sort(order); }

function linuxPath(file) {
  if (!/^[a-z]:[\\/]/i.test(file)) throw new Error(`WSL LX links require a Windows drive path: ${file}`);
  return `/mnt/${file[0].toLowerCase()}/${file.slice(3).replaceAll('\\', '/')}`;
}

async function createSourceLinks(root, links, runtime = {}) {
  if (!links.length) return { strategy: 'none', links: 0 };
  if (process.platform === 'win32' && runtime.symlinkStrategy === 'wsl-lx') {
    if (!path.isAbsolute(runtime.wsl ?? '')) throw new Error('wsl-lx symlink strategy requires an absolute runtime.wsl');
    const script = 'import os,sys,json\nroot=sys.argv[1]\nfor row in json.loads(sys.argv[2]):\n p=os.path.join(root,row["path"])\n if os.path.lexists(p):\n  assert os.path.islink(p) and os.readlink(p)==row["target"], p\n else:\n  os.symlink(row["target"],p)\n';
    await command(runtime.wsl, ['-d', runtime.wslDistro ?? 'Ubuntu', '--exec', 'python3', '-c', script, linuxPath(root), JSON.stringify(links.map(({ path, target }) => ({ path, target })))], path.dirname(root));
    return { strategy: 'wsl-lx', links: links.length, wsl: runtime.wsl, distro: runtime.wslDistro ?? 'Ubuntu', windowsLinkTargetFollowingSupported: false, gitStrategy: 'wsl-git' };
  }
  for (const row of links) {
    const file = path.join(root, row.path);
    const existing = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!existing) fs.symlinkSync(row.target, file);
    else if (!existing.isSymbolicLink() || fs.readlinkSync(file) !== row.target) throw new Error(`Existing source link drift: ${row.path}`);
  }
  return { strategy: 'native', links: links.length };
}

const publicAddresses = new Map();
async function publicDownload(url, redirects = 0) {
  const address = new URL(url);
  if (address.protocol !== 'https:' || redirects > 5) throw new Error('Invalid source download redirect');
  if (!publicAddresses.has(address.hostname)) {
    const response = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(address.hostname)}&type=A`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Public DNS HTTP ${response.status}`);
    const record = (await response.json()).Answer?.find(row => row.type === 1);
    if (!record) throw new Error(`Public IPv4 address unavailable: ${address.hostname}`);
    publicAddresses.set(address.hostname, record.data);
  }
  const ip = publicAddresses.get(address.hostname);
  const response = await new Promise((resolve, reject) => {
    const request = https.get(url, { family: 4, autoSelectFamily: false, lookup: (_host, _options, callback) => callback(null, ip, 4), signal: AbortSignal.timeout(180_000) }, resolve);
    request.once('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) { response.resume(); return publicDownload(new URL(response.headers.location, url).href, redirects + 1); }
  if (response.statusCode !== 200) { response.resume(); throw new Error(`Source download HTTP ${response.statusCode}`); }
  const chunks = []; for await (const chunk of response) chunks.push(chunk);
  return { bytes: Buffer.concat(chunks), resolvedUrl: url, httpStatus: response.statusCode, publicAddress: ip };
}

export function verifyCommunitySource(root, entries, { exact = true } = {}) {
  for (const row of entries) {
    const file = path.join(root, row.path), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() !== (row.target !== undefined)) throw new Error(`Source type drift: ${row.path}`);
    const bytes = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(file)) : fs.readFileSync(file);
    if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw new Error(`Source byte drift: ${row.path}`);
  }
  if (exact) {
    const actual = [];
    function walk(dir, prefix = '') {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = prefix ? `${prefix}/${item.name}` : item.name;
        if (excluded(file)) continue;
        if (item.isDirectory()) walk(path.join(dir, item.name), file); else actual.push(file);
      }
    }
    walk(root);
    if (JSON.stringify(actual.sort()) !== JSON.stringify(entries.filter(row => !excluded(row.path)).map(row => row.path).sort())) throw new Error('Source inventory drift');
  }
  return { files: entries.length, digest: hash(entries) };
}

export async function downloadCommunitySources(plan, { sourcesDir, evidenceDir, concurrency = 2, readinessFile = path.join(evidenceDir, 'readiness.json'), symlinkStrategy, wsl, wslDistro }) {
  fs.mkdirSync(sourcesDir, { recursive: true }); fs.mkdirSync(evidenceDir, { recursive: true });
  const selections = plan.selections, results = new Array(selections.length); let next = 0;
  async function worker() {
    while (next < selections.length) {
      const index = next++, task = selections[index], taskDir = path.join(sourcesDir, task.dataset, task.id);
      const evidence = path.join(evidenceDir, `${task.dataset}__${task.id}`), sourceRoot = path.join(taskDir, 'source');
      fs.mkdirSync(evidence, { recursive: true }); fs.mkdirSync(taskDir, { recursive: true });
      const previousReceipt = path.join(evidence, 'receipt.json'), previous = fs.existsSync(previousReceipt) ? JSON.parse(fs.readFileSync(previousReceipt, 'utf8')) : {};
      if (previous.error) writeJson(path.join(evidence, `previous-failure-${Date.now()}.json`), previous);
      const receipt = { ...previous, dataset: task.dataset, instanceId: task.id, repo: task.repo, baseCommit: task.base_commit, sourceRoot, manifestFile: path.join(taskDir, 'manifest.json'), eligible: false, startedAt: new Date().toISOString() };
      delete receipt.error;
      try {
        const archive = path.join(evidence, 'base.tar.gz');
        // This metadata alias is a repository rename; the pinned commit is unchanged.
        const canonicalRepo = task.repo === 'mui/material' ? 'mui/material-ui' : task.repo;
        receipt.requestedRepo = task.repo; receipt.downloadRepo = canonicalRepo;
        const url = `https://codeload.github.com/${canonicalRepo}/tar.gz/${task.base_commit}`; receipt.requestedUrl = url;
        let gzip;
        if (fs.existsSync(archive)) { gzip = fs.readFileSync(archive); receipt.archiveCache = true; }
        else {
          let response; receipt.downloadAttempts ??= [];
          for (let attempt = 1; attempt <= 3; attempt++) {
            const startedAt = new Date().toISOString();
            try { response = await publicDownload(url); receipt.downloadAttempts.push({ attempt, startedAt, finishedAt: new Date().toISOString(), httpStatus: response.httpStatus }); break; }
            catch (error) {
              receipt.downloadAttempts.push({ attempt, startedAt, finishedAt: new Date().toISOString(), error: { message: error.message, code: error.code ?? null } });
              writeJson(path.join(evidence, 'download-attempts.json'), receipt.downloadAttempts);
              if (attempt === 3 || !['ECONNRESET', 'ETIMEDOUT', 'ABORT_ERR'].includes(error.code) && error.name !== 'TimeoutError') throw error;
            }
          }
          receipt.resolvedUrl = response.resolvedUrl; receipt.httpStatus = response.httpStatus; receipt.publicAddress = response.publicAddress; receipt.downloadRoute = 'per-request public DNS; original HTTPS hostname and certificate verification';
          gzip = response.bytes; fs.writeFileSync(archive, gzip, { flag: 'wx' });
        }
        receipt.archiveSha256 = hash(gzip); receipt.archiveBytes = gzip.length;
        const { top, rows } = inspectArchive(gzip); receipt.archiveRoot = top;
        if (!top.endsWith(`-${task.base_commit}`)) throw new Error('Archive root does not match pinned base commit');
        const entries = manifestEntries(rows), manifest = { schemaVersion: 1, dataset: task.dataset, instanceId: task.id, repo: task.repo, baseCommit: task.base_commit, archiveSha256: receipt.archiveSha256, entries, digest: hash(entries) };
        writeJson(receipt.manifestFile, manifest);
        fs.mkdirSync(sourceRoot, { recursive: true });
        for (const row of rows) {
          const file = path.join(sourceRoot, row.path); fs.mkdirSync(path.dirname(file), { recursive: true });
          if (row.target !== undefined) continue;
          if (fs.existsSync(file)) {
            if (!fs.lstatSync(file).isFile() || hash(fs.readFileSync(file)) !== row.sha256) throw new Error(`Existing snapshot byte drift: ${row.path}`);
          } else fs.writeFileSync(file, row.content, { flag: 'wx' });
          if (process.platform !== 'win32') fs.chmodSync(file, row.mode === '100755' ? 0o755 : 0o644);
        }
        receipt.sourceRepresentation = await createSourceLinks(sourceRoot, rows.filter(row => row.target !== undefined), { symlinkStrategy, wsl, wslDistro });
        manifest.sourceRepresentation = receipt.sourceRepresentation; writeJson(receipt.manifestFile, manifest);
        receipt.verification = verifyCommunitySource(sourceRoot, entries); receipt.eligible = true;
        receipt.sourceBytes = entries.reduce((sum, row) => sum + row.bytes, 0); receipt.symlinks = entries.filter(row => row.target !== undefined).length;
      } catch (error) { receipt.error = { name: error.name, message: error.message, code: error.code ?? null }; }
      receipt.finishedAt = new Date().toISOString(); writeJson(path.join(evidence, 'receipt.json'), receipt); results[index] = receipt;
      writeJson(readinessFile, { selected: selections.length, completed: results.filter(Boolean).length, eligible: results.filter(row => row?.eligible).length, tasks: results.filter(Boolean) });
      console.log(JSON.stringify({ source: task.id, dataset: task.dataset, eligible: receipt.eligible, error: receipt.error?.message, files: receipt.verification?.files }));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker)); return results;
}

async function command(command, args, cwd, timeoutMs = 120_000, env = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API.?KEY|TOKEN|PASSWORD|SECRET|AUTHORIZATION|COOKIE|CREDENTIAL|^GIT_)/i.test(key)));
  const child = spawn(command, args, { cwd, windowsHide: true, env: { ...inherited, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = []; child.stdout.on('data', b => stdout.push(b)); child.stderr.on('data', b => stderr.push(b));
  let timedOut = false; const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }).finally(() => clearTimeout(timer));
  const receipt = { command, args, cwd, ...result, timedOut, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
  Object.defineProperty(receipt, 'stdoutBytes', { value: Buffer.concat(stdout) });
  if (result.code !== 0 || timedOut) throw Object.assign(new Error(`${command} failed (${result.code}): ${receipt.stderr}`), { receipt });
  return receipt;
}

const validUtf8 = bytes => { try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch { return false; } };

async function gitCommand(root, args, timeoutMs = 120_000) {
  const runtimeFile = path.join(path.dirname(root), 'git-runtime.json');
  if (fs.existsSync(runtimeFile)) {
    const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    return command(runtime.wsl, ['-d', runtime.wslDistro ?? 'Ubuntu', '--exec', 'env', 'GIT_CONFIG_NOSYSTEM=1', 'GIT_CONFIG_GLOBAL=/dev/null', 'git', '-C', linuxPath(root), ...args], root, timeoutMs);
  }
  return command('git', args, root, timeoutMs);
}

export async function collectPatch(root, { createdPaths = [] } = {}) {
  await gitCommand(root, ['add', '--intent-to-add', '--', '.']);
  // Only the edit journal can opt an ignored NEW source path into the patch.
  // Ignored build output created by a test command retains normal Git semantics.
  for (const file of new Set(createdPaths)) {
    const relative = path.relative(root, path.resolve(root, file)).replaceAll('\\', '/');
    if (!relative || relative.startsWith('../') || path.isAbsolute(relative) || relative.split('/').some(part => /^(?:\.git|node_modules|\.codegraph.*|\.code-graph.*|\.codefacts.*|indexstate|\.indexstate)$/i.test(part))) throw new Error(`Excluded created source path: ${file}`);
    const absolute = path.join(root, relative);
    if (fs.existsSync(absolute) && fs.lstatSync(absolute).isFile()) await gitCommand(root, ['add', '--intent-to-add', '--force', '--', `:(literal)${relative}`]);
  }
  const diff = async () => (await gitCommand(root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ...patchPaths])).stdoutBytes;
  let bytes = await diff();
  if (!validUtf8(bytes)) {
    const changed = (await gitCommand(root, ['diff', '--name-only', '--no-ext-diff', '-z', 'HEAD', '--', ...patchPaths])).stdout.split('\0').filter(Boolean);
    const tracked = new Set((await gitCommand(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD'])).stdout.split('\0').filter(Boolean));
    const binaryPaths = [];
    for (const file of changed) {
      const absolute = path.join(root, file);
      const current = fs.existsSync(absolute) ? (fs.lstatSync(absolute).isSymbolicLink() ? Buffer.from(fs.readlinkSync(absolute)) : fs.readFileSync(absolute)) : Buffer.alloc(0);
      const base = tracked.has(file) ? (await gitCommand(root, ['show', `HEAD:${file}`])).stdoutBytes : Buffer.alloc(0);
      if (!validUtf8(current) || !validUtf8(base)) binaryPaths.push(file);
    }
    fs.appendFileSync(path.join(root, '.git', 'info', 'attributes'), binaryPaths.map(file => `${JSON.stringify('/' + file.replace(/[\\*?\[\]]/g, '\\$&'))} binary\n`).join(''));
    bytes = await diff();
  }
  if (!validUtf8(bytes)) throw new Error('Git patch cannot be represented losslessly as UTF-8');
  return bytes.toString('utf8');
}

function logicalBytes(root) {
  if (!fs.existsSync(root)) return 0;
  const stat = fs.lstatSync(root); if (!stat.isDirectory()) return stat.size;
  return fs.readdirSync(root).reduce((sum, file) => sum + logicalBytes(path.join(root, file)), 0);
}

/** Fresh attempt: exact base bytes, a private Git boundary, independent native index. */
export async function prepareCommunitySlot({ task, arm, runtime, dir, timeoutMs = 180_000 }) {
  const started = performance.now(), manifestFile = task.manifestFile ?? path.join(path.dirname(task.sourceRoot), 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')), entries = manifest.entries;
  if (manifest.repo !== task.repo || manifest.baseCommit !== task.baseCommit || manifest.instanceId !== task.instanceId || hash(entries) !== manifest.digest) throw new Error('Community source identity mismatch');
  verifyCommunitySource(task.sourceRoot, entries);
  fs.mkdirSync(dir, { recursive: true }); const root = path.join(dir, 'source'); fs.mkdirSync(root);
  const sourceMaterialization = task.cohort === 'context' && runtime.contextSourceMode === 'hardlink' ? 'read-only-hardlinks' : 'independent-copy';
  const gitMode = task.cohort === 'context' && runtime.contextGitMode === 'boundary-only' ? 'boundary-only' : 'synthetic-commit';
  for (const row of entries) {
    const file = path.join(root, row.path); fs.mkdirSync(path.dirname(file), { recursive: true });
    if (row.target === undefined) {
      if (sourceMaterialization === 'read-only-hardlinks') fs.linkSync(path.join(task.sourceRoot, row.path), file);
      else fs.copyFileSync(path.join(task.sourceRoot, row.path), file, fs.constants.COPYFILE_EXCL);
    }
  }
  const sourceRepresentation = await createSourceLinks(root, entries.filter(row => row.target !== undefined), runtime);
  if (gitMode === 'boundary-only' && sourceRepresentation.gitStrategy) sourceRepresentation.gitStrategy = 'boundary-only';
  verifyCommunitySource(root, entries);
  const setupDir = path.join(dir, 'setup'), hooks = path.join(dir, 'disabled-hooks'); fs.mkdirSync(setupDir); fs.mkdirSync(hooks);
  const gitReceipts = [];
  let baselineCommit = null;
  if (gitMode === 'boundary-only') {
    // Read-only Context needs a repository discovery boundary, without hashing
    // every file again into Git objects or creating a per-attempt Git index.
    for (const name of ['objects', 'refs/heads', 'hooks']) fs.mkdirSync(path.join(root, '.git', name), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/benchmark\n');
    fs.writeFileSync(path.join(root, '.git', 'config'), `[core]\n repositoryformatversion = 0\n bare = false\n hooksPath = ${JSON.stringify(hooks.replaceAll('\\', '/'))}\n`);
  } else {
    if (process.platform === 'win32' && runtime.symlinkStrategy === 'wsl-lx') writeJson(path.join(dir, 'git-runtime.json'), { wsl: runtime.wsl, wslDistro: runtime.wslDistro ?? 'Ubuntu' });
    const git = async args => { const receipt = await gitCommand(root, args, timeoutMs); gitReceipts.push(receipt); return receipt; };
    await git(['-c', 'init.templateDir=', 'init', '--initial-branch=benchmark']);
    const hooksPath = process.platform === 'win32' && runtime.symlinkStrategy === 'wsl-lx' ? linuxPath(hooks) : hooks;
    for (const [key, value] of Object.entries({ 'core.hooksPath': hooksPath, 'core.autocrlf': 'false', 'core.safecrlf': 'false', 'core.symlinks': 'true', 'core.filemode': 'false', 'commit.gpgSign': 'false', 'gc.auto': '0', 'maintenance.auto': 'false', 'user.name': 'Community benchmark', 'user.email': 'benchmark@invalid' })) await git(['config', key, value]);
    fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'info', 'attributes'), '* -text -filter -ident -working-tree-encoding\n');
    fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), '.codegraph*\n.code-graph*\n');
    await git(['add', '--force', '--all', '--', ...patchPaths]);
    const executable = entries.filter(row => row.mode === '100755').map(row => row.path);
    for (let i = 0; i < executable.length; i += 100) await git(['update-index', '--chmod=+x', '--', ...executable.slice(i, i + 100)]);
    await git(['-c', 'core.hooksPath=' + hooksPath, 'commit', '--quiet', '--allow-empty', '--no-verify', '-m', 'Synthetic source-only benchmark baseline']);
    baselineCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  }
  writeJson(path.join(setupDir, 'git-baseline.json'), { mode: gitMode, upstream: { repo: task.repo, baseCommit: task.baseCommit }, syntheticCommit: baselineCommit, receipts: gitReceipts });
  const sourcePreparationMs = performance.now() - started, indexStarted = performance.now(), state = path.join(dir, 'state.sqlite'), native = nativeConfig(arm, root, state);
  let nativeReceipt = null;
  if (arm.id === 'codegraph') {
    nativeReceipt = { init: await command(arm.node, ['--liftoff-only', '--disable-warning=ExperimentalWarning', arm.cli, 'init', root, '--yes'], root, timeoutMs, { CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_DOWNLOAD: '1', CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1' }) };
    writeJson(path.join(setupDir, 'init-receipt.json'), nativeReceipt.init);
  }
  if (native) {
    const client = await connectNative(loadSdk(runtime.sdkRoot), nativeConfig(arm, root, state, true), setupDir);
    try {
      assertNativeVersion(client.metadata, arm); nativeReceipt = { ...nativeReceipt, metadata: client.metadata };
      if (arm.id !== 'codegraph') {
        // Cold indexing follows the campaign's preparation allowance rather
        // than the frozen read-only bridge's 60-second warm-query deadline.
        // connectNative still records the complete request/response wire log.
        const result = await client.client.callTool({ name: 'map', arguments: arm.id === 'codefacts022' ? { format: 'full' } : {} }, undefined, { timeout: timeoutMs });
        writeJson(path.join(setupDir, 'map.json'), { result }); if (result.isError) throw new Error('CodeFacts setup map failed');
      }
    } finally { await client.close(); }
  }
  const indexDurationMs = native ? performance.now() - indexStarted : 0;
  verifyCommunitySource(task.sourceRoot, entries); verifyCommunitySource(root, entries);
  if (gitMode !== 'boundary-only' && (await collectPatch(root)).length) throw new Error('Native setup changed baseline source');
  const sourceIdentity = { repo: task.repo, baseCommit: task.baseCommit, instanceId: task.instanceId, manifestFile, manifestSha256: hash(fs.readFileSync(manifestFile)), sourceHash: manifest.digest, syntheticCommit: baselineCommit };
  const indexDiskBytes = arm.id === 'codegraph' ? fs.readdirSync(root).filter(name => /^\.code-?graph/.test(name)).reduce((sum, name) => sum + logicalBytes(path.join(root, name)), 0) : [state, `${state}-wal`, `${state}-shm`].reduce((sum, file) => sum + logicalBytes(file), 0);
  const setup = { durationMs: performance.now() - started, sourcePreparationMs, indexDurationMs, indexDiskBytes, sourceFiles: entries.length, sourceIdentity, sourceRepresentation, sourceMaterialization, gitMode, native: nativeReceipt, indexPolicy: arm.id === 'codegraph' ? 'Private generated .codegraph state excluded from patch; hooks disabled' : 'External SQLite state; hooks disabled' };
  writeJson(path.join(dir, 'setup.json'), setup);
  const bridgeConfig = path.join(dir, 'bridge-config.json'); writeJson(bridgeConfig, { root, evidenceDir: path.join(dir, 'inner-bridge'), rgCommand: runtime.rg, sdkRoot: runtime.sdkRoot, arm: arm.id, native });
  return { root, setup, bridgeConfig, sourceIdentity, sourceHash: manifest.digest, entries };
}
