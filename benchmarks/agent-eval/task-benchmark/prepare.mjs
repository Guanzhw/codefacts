import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { loadSdk, connectNative, hash, writeJson } from './rpc.mjs';

export const GENERATED = /^(?:\.git|\.codegraph.*|\.code-graph.*)$/i;
export const canonicalEntries = entries => entries.map(({ path: file, bytes, sha256 }) => ({ path: file, bytes, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
export function readSourceManifest(corpus) {
  const raw = JSON.parse(fs.readFileSync(corpus.manifestFile, 'utf8'));
  const selected = Array.isArray(raw) ? { entries: raw } : raw.entries ? raw : raw[corpus.id] ?? (corpus.id === 'ghcli' ? raw.go : undefined);
  if (!Array.isArray(selected?.entries)) throw new Error(`Missing source entries: ${corpus.id}`);
  const entries = canonicalEntries(selected.entries);
  if (new Set(entries.map(row => row.path)).size !== entries.length) throw new Error('Duplicate source manifest path');
  for (const row of entries) {
    if (typeof row.path !== 'string' || path.isAbsolute(row.path) || row.path.split(/[\\/]/).some(part => part === '..' || GENERATED.test(part)) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('Invalid frozen source entry');
  }
  const digest = hash(entries);
  if (digest !== corpus.manifestSha256) throw new Error(`Canonical source manifest hash mismatch: ${corpus.id}`);
  return { entries, digest, manifestFileSha256: hash(fs.readFileSync(corpus.manifestFile)) };
}

export function verifySource(root, entries, { exact = false } = {}) {
  for (const row of entries) {
    const file = path.join(root, row.path);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Source symlink: ${row.path}`);
    const bytes = fs.readFileSync(file);
    if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw new Error(`Source drift: ${root}: ${row.path}`);
  }
  if (exact) {
    const actual = [];
    function walk(dir, prefix = '') {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (GENERATED.test(item.name)) continue;
        const relative = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isSymbolicLink()) throw new Error(`Source symlink: ${relative}`);
        if (item.isDirectory()) walk(path.join(dir, item.name), relative);
        else if (item.isFile()) actual.push(relative);
      }
    }
    walk(root);
    if (JSON.stringify(actual.sort()) !== JSON.stringify(entries.map(row => row.path).sort())) throw new Error(`Source inventory drift: ${root}`);
  }
  return { files: entries.length, digest: hash(canonicalEntries(entries)) };
}

export function nativeConfig(arm, root, state, setup = false) {
  if (arm.id === 'ordinary') return null;
  if (arm.id === 'codegraph') return { command: arm.node, args: ['--liftoff-only', '--disable-warning=ExperimentalWarning', arm.cli, 'serve', '--mcp', '--no-watch', '--path', root], cwd: root,
    env: { CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_DOWNLOAD: '1', CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1' } };
  return { command: arm.executable, args: ['mcp', '--root', root, '--state', state, '--lsp', 'off', ...(setup && arm.id === 'codefacts022' ? ['--tools', 'all'] : [])], cwd: root, env: {} };
}

export function assertNativeVersion(metadata, arm) {
  if (metadata.serverInfo?.version !== arm.version) throw new Error(`Native MCP version mismatch for ${arm.id}: expected ${arm.version}, observed ${metadata.serverInfo?.version ?? 'missing'}`);
}

async function loggedCommand(command, args, cwd, dir, timeoutMs) {
  const started = performance.now();
  const allowed = new Set(['PATH', 'TEMP', 'TMP', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SYSTEMDRIVE', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)']);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
  const child = spawn(command, args, { cwd, windowsHide: true, env: { ...environment, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_DOWNLOAD: '1', CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = fs.openSync(path.join(dir, 'init-stdout.log'), 'wx'), err = fs.openSync(path.join(dir, 'init-stderr.log'), 'wx');
  child.stdout.on('data', value => fs.writeSync(out, value)); child.stderr.on('data', value => fs.writeSync(err, value));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }).finally(() => { clearTimeout(timer); fs.closeSync(out); fs.closeSync(err); });
  const receipt = { command, args, cwd, ...result, timedOut, durationMs: performance.now() - started };
  writeJson(path.join(dir, 'init-receipt.json'), receipt);
  if (result.code !== 0 || timedOut) throw new Error('CodeGraph setup failed');
  return receipt;
}

/** Every attempt owns its copy and indexes; originals are read only. */
export async function prepareSlot(manifest, slot, dir, corpus) {
  const started = performance.now();
  const frozen = readSourceManifest(corpus);
  verifySource(corpus.root, frozen.entries);
  const root = path.join(dir, 'source'); fs.mkdirSync(root);
  for (const row of frozen.entries) { const to = path.join(root, row.path); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(corpus.root, row.path), to, fs.constants.COPYFILE_EXCL); }
  verifySource(root, frozen.entries, { exact: true });
  // A private repository boundary prevents discovery of the owning checkout.
  for (const name of ['objects', 'refs/heads', 'hooks']) fs.mkdirSync(path.join(root, '.git', name), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/benchmark\n');
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n repositoryformatversion = 0\n bare = false\n');
  const arm = manifest.arms.find(row => row.id === slot.arm), state = path.join(dir, 'state.sqlite');
  const setupDir = path.join(dir, 'setup'); fs.mkdirSync(setupDir);
  const native = nativeConfig(arm, root, state);
  const sourcePreparationMs = performance.now() - started, indexStarted = performance.now();
  let setupReceipt = null;
  if (arm.id === 'codegraph') setupReceipt = await loggedCommand(arm.node, ['--liftoff-only', '--disable-warning=ExperimentalWarning', arm.cli, 'init', root, '--yes'], root, setupDir, manifest.timeoutMs);
  if (native) {
    const sdk = loadSdk(manifest.runtime.sdkRoot);
    const client = await connectNative(sdk, nativeConfig(arm, root, state, true), setupDir);
    try {
      assertNativeVersion(client.metadata, arm);
      if (arm.id === 'codegraph') setupReceipt = { init: setupReceipt, native: client.metadata };
      else {
        const wire = {};
        const result = await client.callTool({ name: 'map', arguments: arm.id === 'codefacts022' ? { format: 'full' } : {} }, wire);
        writeJson(path.join(setupDir, 'map.json'), { result, wire });
        if (result.isError) throw new Error('CodeFacts setup map failed');
        setupReceipt = { native: client.metadata, mapResultPath: path.join(setupDir, 'map.json') };
      }
    } finally { await client.close(); }
  }
  const indexDurationMs = native ? performance.now() - indexStarted : 0;
  verifySource(corpus.root, frozen.entries); verifySource(root, frozen.entries, { exact: true });
  const setup = { durationMs: performance.now() - started, sourcePreparationMs, indexDurationMs, sourceFiles: frozen.entries.length, native: setupReceipt, indexPolicy: arm.id === 'codegraph' ? 'CLI init inside private repository; any installed hooks remain private and are not executed' : 'external SQLite state' };
  writeJson(path.join(dir, 'setup.json'), setup);
  const bridge = { root, evidenceDir: path.join(dir, 'bridge'), rgCommand: manifest.runtime.rg, sdkRoot: manifest.runtime.sdkRoot, arm: arm.id, native };
  const bridgeConfig = path.join(dir, 'bridge-config.json'); writeJson(bridgeConfig, bridge);
  return { root, setup, bridgeConfig, sourceHash: frozen.digest, entries: frozen.entries };
}
