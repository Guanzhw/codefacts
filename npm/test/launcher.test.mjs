import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const launcher = require('../lib/launcher.js');
const testDirectory = dirname(fileURLToPath(import.meta.url));
const npmDirectory = resolve(testDirectory, '..');
const repositoryRoot = resolve(npmDirectory, '..');
const stageScript = resolve(npmDirectory, 'scripts', 'stage-package.mjs');
const fixtureRoot = resolve(repositoryRoot, 'tests', 'fixtures', 'eval-project');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function commandResult(command, args, options = {}) {
  const isWindowsCommand = process.platform === 'win32' && command.endsWith('.cmd');
  const executable = isWindowsCommand ? process.env.ComSpec || 'cmd.exe' : command;
  const quoteForCmd = (argument) => {
    const text = String(argument);
    return /[\s"]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const commandArguments = isWindowsCommand
    ? ['/d', '/s', '/c', [command, ...args.map(quoteForCmd)].join(' ')]
    : args;
  const result = spawnSync(executable, commandArguments, {
    ...options,
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed:\n${result.stderr || ''}${result.stdout || ''}`,
  );
  return result;
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function startReleaseServer(assetPath, expectedPath) {
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.url !== expectedPath) {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    requests += 1;
    response.statusCode = 200;
    createReadStream(assetPath).pipe(response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v${launcher.PACKAGE_VERSION}`,
    getRequests: () => requests,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
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
      if (!line.trim()) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        for (const { reject } of pending.values()) {
          reject(new Error(`launcher corrupted MCP stdout with ${line}: ${error.message}`));
        }
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
  child.stderr.on('data', (chunk) => {
    errorOutput += chunk;
  });
  child.once('close', (code) => {
    for (const { reject } of pending.values()) {
      reject(new Error(`CodeFacts exited with ${code}; stderr: ${errorOutput}`));
    }
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

test('maps supported native assets and rejects unsupported platforms', () => {
  assert.deepEqual(launcher.assetForPlatform('win32', 'x64'), {
    key: 'win32-x64',
    assetName: 'codefacts-windows-x86_64.exe',
    executableName: 'codefacts.exe',
  });
  assert.deepEqual(launcher.assetForPlatform('darwin', 'arm64'), {
    key: 'darwin-arm64',
    assetName: 'codefacts-macos-aarch64',
    executableName: 'codefacts',
  });
  assert.throws(() => launcher.assetForPlatform('freebsd', 'x64'), /does not publish a binary/);
});

test('refuses a downloaded binary whose embedded checksum does not match', async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'codefacts-launcher-mismatch-'));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const asset = launcher.assetForPlatform();
  const assetPath = join(temporaryDirectory, asset.assetName);
  await writeFile(assetPath, 'not a CodeFacts binary');
  const server = await startReleaseServer(assetPath, `/v${launcher.PACKAGE_VERSION}/${asset.assetName}`);
  context.after(() => server.close());

  const environment = {
    ...process.env,
    CODEFACTS_CACHE_DIR: join(temporaryDirectory, 'cache'),
    CODEFACTS_DOWNLOAD_BASE_URL: server.baseUrl,
  };
  await assert.rejects(
    launcher.ensureBinary({
      env: environment,
      checksumDocument: {
        version: launcher.PACKAGE_VERSION,
        assets: { [asset.assetName]: '0'.repeat(64) },
      },
      onProgress: () => {},
    }),
    /SHA-256 verification failed/,
  );
  const location = launcher.binaryLocation({ env: environment });
  await assert.rejects(access(location.binaryPath));
  assert.equal(server.getRequests(), 1);
});

test('packed launcher downloads a release-like binary and speaks MCP over stdio', async (context) => {
  const executableName = process.platform === 'win32' ? 'codefacts.exe' : 'codefacts';
  const nativeBinary = resolve(repositoryRoot, 'target', 'release', executableName);
  try {
    await stat(nativeBinary);
  } catch {
    context.skip(`requires cargo build --release --bin codefacts at ${nativeBinary}`);
    return;
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'codefacts-launcher-protocol-'));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const asset = launcher.assetForPlatform();
  const releaseDirectory = join(temporaryDirectory, 'release');
  const assetPath = join(releaseDirectory, asset.assetName);
  await (await import('node:fs/promises')).mkdir(releaseDirectory, { recursive: true });
  await copyFile(nativeBinary, assetPath);
  const checksum = await sha256(assetPath);
  const checksumFile = join(temporaryDirectory, 'SHA256SUMS');
  const checksumLines = Object.values(launcher.PLATFORM_ASSETS)
    .map(({ assetName }) => `${assetName === asset.assetName ? checksum : '0'.repeat(64)}  ${assetName}`)
    .join('\n');
  await writeFile(checksumFile, `${checksumLines}\n`);

  const stagedPackage = join(temporaryDirectory, 'staged-package');
  commandResult(process.execPath, [
    stageScript,
    '--version', launcher.PACKAGE_VERSION,
    '--checksums', checksumFile,
    '--output', stagedPackage,
  ]);
  const packOutput = commandResult(npmCommand, ['pack', '--json'], { cwd: stagedPackage });
  const [{ filename }] = JSON.parse(packOutput.stdout);
  const archivePath = join(stagedPackage, filename);
  const installationRoot = join(temporaryDirectory, 'installation');
  commandResult(npmCommand, [
    'install',
    '--prefix', installationRoot,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    archivePath,
  ]);

  const installedLauncher = join(
    installationRoot,
    'node_modules',
    'codefacts',
    'bin',
    'codefacts.js',
  );
  await access(installedLauncher);
  const server = await startReleaseServer(assetPath, `/v${launcher.PACKAGE_VERSION}/${asset.assetName}`);
  context.after(() => server.close());
  const statePath = join(temporaryDirectory, 'state.sqlite');
  const environment = {
    ...process.env,
    CODEFACTS_CACHE_DIR: join(temporaryDirectory, 'cache'),
    CODEFACTS_DOWNLOAD_BASE_URL: server.baseUrl,
  };

  const client = startMcp(installedLauncher, [
    'mcp',
    '--root', fixtureRoot,
    '--state', statePath,
  ], environment);
  const initialized = await client.request(1, 'initialize');
  assert.equal(initialized.result.serverInfo.name, 'codefacts');
  client.notify('notifications/initialized');
  const tools = await client.request(2, 'tools/list');
  assert.deepEqual(
    tools.result.tools.map((tool) => tool.name),
    ['map', 'search', 'outline', 'expand', 'path'],
  );
  const search = await client.request(3, 'tools/call', {
    name: 'search',
    arguments: { query: 'AuthService' },
  });
  assert.equal(search.result.isError, false);
  assert.match(search.result.content[0].text, /AuthService/);
  const stderr = await client.close();
  assert.match(stderr, /downloading CodeFacts/);

  const location = launcher.binaryLocation({ env: environment });
  assert.equal(await sha256(location.binaryPath), checksum);
  assert.equal(server.getRequests(), 1);

  const cachedClient = startMcp(installedLauncher, [
    'mcp',
    '--root', fixtureRoot,
    '--state', join(temporaryDirectory, 'cached-state.sqlite'),
  ], environment);
  const cachedInitialized = await cachedClient.request(4, 'initialize');
  assert.equal(cachedInitialized.result.serverInfo.name, 'codefacts');
  await cachedClient.close();
  assert.equal(server.getRequests(), 1, 'a verified cache avoids a second download');
});
