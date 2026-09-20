import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const launcher = require('../lib/launcher.js');
const npmDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(npmDirectory, '..');
const fixtureRoot = resolve(repositoryRoot, 'tests', 'fixtures', 'eval-project');
const stagePlatformScript = resolve(npmDirectory, 'scripts', 'stage-platform-package.mjs');
const stageMainScript = resolve(npmDirectory, 'scripts', 'stage-package.mjs');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function commandResult(command, args, options = {}) {
  const isWindowsCommand = process.platform === 'win32' && command.endsWith('.cmd');
  const executable = isWindowsCommand ? process.env.ComSpec || 'cmd.exe' : command;
  const commandArguments = isWindowsCommand
    ? ['/d', '/s', '/c', [command, ...args.map((argument) => {
      const text = String(argument);
      return /[\s"]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    })].join(' ')]
    : args;
  const result = spawnSync(executable, commandArguments, { ...options, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stderr || ''}${result.stdout || ''}`);
  return result;
}

function startMcp(launcherPath, args, environment) {
  const child = spawn(process.execPath, [launcherPath, ...args], {
    cwd: fixtureRoot,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let outputBuffer = '';
  let errorOutput = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    outputBuffer += chunk;
    let newline;
    while ((newline = outputBuffer.indexOf('\n')) >= 0) {
      const line = outputBuffer.slice(0, newline);
      outputBuffer = outputBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        for (const { reject } of pending.values()) reject(new Error(`invalid MCP stdout: ${error.message}`));
        pending.clear();
        return;
      }
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        entry.resolve(message);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { errorOutput += chunk; });
  child.once('close', (code) => {
    for (const { reject } of pending.values()) reject(new Error(`CodeFacts exited with ${code}: ${errorOutput}`));
    pending.clear();
  });
  return {
    request(id, method, params = {}) {
      return new Promise((resolveResponse, rejectResponse) => {
        pending.set(id, { resolve: resolveResponse, reject: rejectResponse });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    async close() {
      child.stdin.end();
      const closed = once(child, 'close');
      const timeout = setTimeout(() => child.kill(), 10_000);
      await closed;
      clearTimeout(timeout);
      return errorOutput;
    },
  };
}

async function temporaryNativePackage(context, platform, binary = 'native binary') {
  const root = await mkdtemp(join(tmpdir(), 'codefacts-native-package-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const asset = launcher.assetForPlatform(platform, platform === 'win32' ? 'x64' : process.arch);
  const binaryPath = join(root, asset.executableName);
  await writeFile(binaryPath, binary);
  const checksum = createHash('sha256').update(binary).digest('hex');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: asset.packageName,
    version: launcher.PACKAGE_VERSION,
    os: [asset.os],
    cpu: [asset.cpu],
    codefacts: {
      platform: asset.key,
      assetName: asset.assetName,
      executableName: asset.executableName,
      sha256: checksum,
    },
  }));
  return { root, asset, binaryPath, checksum };
}

test('maps supported native packages and rejects unsupported platforms', () => {
  assert.equal(
    launcher.platformPackageFor('win32', 'x64').packageName,
    '@acetamido/codefacts-win32-x64',
  );
  assert.deepEqual(launcher.assetForPlatform('darwin', 'arm64'), {
    packageName: '@acetamido/codefacts-darwin-arm64',
    os: 'darwin',
    cpu: 'arm64',
    key: 'darwin-arm64',
    assetName: 'codefacts-macos-aarch64',
    executableName: 'codefacts',
  });
  assert.throws(() => launcher.assetForPlatform('freebsd', 'x64'), /does not publish a binary/);
});

test('resolves and checksum-verifies the installed native package without downloading', async (context) => {
  const fixture = await temporaryNativePackage(context, process.platform);
  const resolved = await launcher.ensureBinary({ packageDirectory: fixture.root });
  assert.equal(resolved, fixture.binaryPath);
  assert.equal(await readFile(resolved, 'utf8'), 'native binary');
});

test('fails explicitly when the matching optional dependency is absent', async () => {
  await assert.rejects(
    launcher.ensureBinary({
      platform: 'linux',
      arch: 'x64',
      packageDirectory: join(tmpdir(), 'codefacts-no-such-native-package'),
    }),
    /native package metadata is unavailable/,
  );
});

test('rejects a tampered installed native package', async (context) => {
  const fixture = await temporaryNativePackage(context, process.platform);
  await writeFile(fixture.binaryPath, 'tampered binary');
  await assert.rejects(
    launcher.ensureBinary({ packageDirectory: fixture.root }),
    /SHA-256 verification failed/,
  );
});

test('requires the staged asset identity and checksum metadata', async (context) => {
  const fixture = await temporaryNativePackage(context, process.platform);
  const metadataPath = join(fixture.root, 'package.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  delete metadata.codefacts.sha256;
  await writeFile(metadataPath, JSON.stringify(metadata));
  await assert.rejects(launcher.ensureBinary({ packageDirectory: fixture.root }), /invalid SHA-256/);

  metadata.codefacts.sha256 = fixture.checksum;
  metadata.codefacts.assetName = 'wrong-asset';
  await writeFile(metadataPath, JSON.stringify(metadata));
  await assert.rejects(
    launcher.ensureBinary({ packageDirectory: fixture.root }),
    /does not contain the expected/,
  );
});

test('stage metadata points at a package-local executable', async (context) => {
  const fixture = await temporaryNativePackage(context, process.platform);
  const location = launcher.binaryLocation({ packageDirectory: fixture.root });
  await access(location.packageJsonPath);
  assert.equal(location.directory, fixture.root);
});

test('packed launcher installs the matching optional package and speaks MCP', async (context) => {
  const executableName = process.platform === 'win32' ? 'codefacts.exe' : 'codefacts';
  const nativeBinary = resolve(repositoryRoot, 'target', 'release', executableName);
  try {
    await stat(nativeBinary);
  } catch {
    context.skip(`requires cargo build --release --bin codefacts at ${nativeBinary}`);
    return;
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'codefacts-packed-install-'));
  context.after(() => rm(temporaryDirectory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  }));
  const platform = launcher.platformPackageFor();
  const platformStage = join(temporaryDirectory, 'platform-package');
  commandResult(process.execPath, [
    stagePlatformScript,
    '--version', launcher.PACKAGE_VERSION,
    '--platform', platform.key,
    '--binary', nativeBinary,
    '--output', platformStage,
  ]);
  const [{ filename: platformFilename }] = JSON.parse(
    commandResult(npmCommand, ['pack', platformStage, '--pack-destination', temporaryDirectory, '--json']).stdout,
  );

  const mainStage = join(temporaryDirectory, 'main-package');
  commandResult(process.execPath, [
    stageMainScript,
    '--version', launcher.PACKAGE_VERSION,
    '--output', mainStage,
  ]);
  const [{ filename: mainFilename }] = JSON.parse(
    commandResult(npmCommand, ['pack', mainStage, '--pack-destination', temporaryDirectory, '--json']).stdout,
  );

  const installationRoot = join(temporaryDirectory, 'installation');
  commandResult(npmCommand, [
    'install',
    '--prefix', installationRoot,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    join(temporaryDirectory, mainFilename),
    join(temporaryDirectory, platformFilename),
  ]);
  const installedLauncher = join(installationRoot, 'node_modules', 'codefacts', 'bin', 'codefacts.js');
  await access(installedLauncher);

  const client = startMcp(installedLauncher, [
    'mcp',
    '--root', fixtureRoot,
    '--state', join(temporaryDirectory, 'state.sqlite'),
  ], process.env);
  const initialized = await client.request(1, 'initialize');
  assert.equal(initialized.result.serverInfo.name, 'codefacts');
  assert.equal(initialized.result.serverInfo.version, launcher.PACKAGE_VERSION);
  client.notify('notifications/initialized');
  const tools = await client.request(2, 'tools/list');
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), ['map', 'search', 'outline', 'expand', 'path']);
  const search = await client.request(3, 'tools/call', {
    name: 'search',
    arguments: { query: 'AuthService' },
  });
  assert.equal(search.result.isError, false);
  assert.match(search.result.content[0].text, /AuthService/);
  const markdown = await client.request(4, 'tools/call', {
    name: 'search',
    arguments: { query: 'AuthService', format: 'markdown' },
  });
  assert.equal(markdown.result.isError, false);
  assert.equal(markdown.result.structuredContent, undefined);
  assert.match(markdown.result.content[0].text, /AuthService/);
  assert.match(markdown.result.content[0].text, /format: markdown/);
  await client.close();
});
