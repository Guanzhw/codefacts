'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const packageMetadata = require('../package.json');
const packagedAssets = require('../assets.json');
const packagedChecksums = require('../checksums.json');

const PACKAGE_VERSION = packageMetadata.version;
const DEFAULT_RELEASE_BASE_URL =
  `https://github.com/Guanzhw/codefacts/releases/download/v${PACKAGE_VERSION}`;
const LOCK_TIMEOUT_MS = 120_000;
const STALE_LOCK_MS = 5 * 60_000;

const PLATFORM_ASSETS = Object.freeze(
  Object.fromEntries(
    Object.entries(packagedAssets).map(([key, asset]) => [key, Object.freeze({ ...asset })]),
  ),
);

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function assetForPlatform(platform = process.platform, arch = process.arch) {
  const key = platformKey(platform, arch);
  const asset = PLATFORM_ASSETS[key];
  if (!asset) {
    throw new Error(
      `CodeFacts does not publish a binary for ${key}. Supported platforms: ${Object.keys(PLATFORM_ASSETS).join(', ')}`,
    );
  }
  return { key, ...asset };
}

function cacheRoot(
  env = process.env,
  platform = process.platform,
  homeDirectory = os.homedir(),
) {
  if (env.CODEFACTS_CACHE_DIR) {
    return path.resolve(env.CODEFACTS_CACHE_DIR);
  }
  if (platform === 'win32') {
    return path.join(
      env.LOCALAPPDATA || path.join(homeDirectory, 'AppData', 'Local'),
      'CodeFacts',
      'bin',
    );
  }
  if (platform === 'darwin') {
    return path.join(homeDirectory, 'Library', 'Caches', 'codefacts', 'bin');
  }
  return path.join(env.XDG_CACHE_HOME || path.join(homeDirectory, '.cache'), 'codefacts', 'bin');
}

function binaryLocation({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  homeDirectory = os.homedir(),
  packageVersion = PACKAGE_VERSION,
} = {}) {
  const asset = assetForPlatform(platform, arch);
  const directory = path.join(cacheRoot(env, platform, homeDirectory), packageVersion, asset.key);
  return {
    asset,
    directory,
    binaryPath: path.join(directory, asset.executableName),
    lockPath: path.join(directory, '.download.lock'),
  };
}

function releaseBaseUrl(env = process.env, packageVersion = PACKAGE_VERSION) {
  const configured = env.CODEFACTS_DOWNLOAD_BASE_URL;
  const base = configured ||
    `https://github.com/Guanzhw/codefacts/releases/download/v${packageVersion}`;
  return base.replace(/\/+$/, '');
}

function expectedChecksum(assetName, checksumDocument, packageVersion) {
  if (checksumDocument.version !== packageVersion) {
    throw new Error(
      `launcher/package version mismatch: expected ${packageVersion}, received ${checksumDocument.version || 'none'}`,
    );
  }
  const checksum = checksumDocument.assets && checksumDocument.assets[assetName];
  if (!/^[a-f0-9]{64}$/i.test(checksum || '')) {
    throw new Error(
      `no embedded SHA-256 exists for ${assetName}; use a published CodeFacts npm package rather than this unstaged source checkout`,
    );
  }
  return checksum.toLowerCase();
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.once('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('end', () => resolve(hash.digest('hex')));
  });
}

function hashesMatch(actual, expected) {
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

async function isValidBinary(binaryPath, checksum) {
  try {
    const actual = await sha256File(binaryPath);
    return hashesMatch(actual, checksum);
  } catch {
    return false;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireDownloadLock(lockPath, isReady) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const handle = await fsp.open(lockPath, 'wx');
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      return handle;
    } catch (error) {
      if (error && error.code !== 'EEXIST') {
        throw error;
      }
      if (await isReady()) {
        return null;
      }
      try {
        const status = await fsp.stat(lockPath);
        if (Date.now() - status.mtimeMs > STALE_LOCK_MS) {
          await fsp.rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (!statError || statError.code !== 'ENOENT') {
          throw statError;
        }
      }
      await sleep(100);
    }
  }
  throw new Error(`timed out waiting for another CodeFacts download to finish at ${lockPath}`);
}

function downloadToFile(url, destination, redirects = 0) {
  if (redirects > 5) {
    return Promise.reject(new Error(`too many redirects while downloading ${url}`));
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return Promise.reject(new Error(`invalid CodeFacts release URL ${url}: ${error.message}`));
  }
  const client = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
  if (!client) {
    return Promise.reject(new Error(`unsupported download protocol ${parsed.protocol}`));
  }

  return new Promise((resolve, reject) => {
    const request = client.get(parsed, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        downloadToFile(new URL(response.headers.location, parsed).toString(), destination, redirects + 1)
          .then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`download failed with HTTP ${status} for ${url}`));
        return;
      }

      const output = fs.createWriteStream(destination, { flags: 'wx' });
      let settled = false;
      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        response.destroy();
        output.destroy();
        fsp.rm(destination, { force: true }).finally(() => reject(error));
      };

      response.once('error', fail);
      output.once('error', fail);
      output.once('finish', () => {
        output.close((error) => {
          if (error) {
            fail(error);
            return;
          }
          if (!settled) {
            settled = true;
            resolve();
          }
        });
      });
      response.pipe(output);
    });
    request.once('error', reject);
  });
}

function emitProgress(message, onProgress) {
  onProgress(`codefacts: ${message}\n`);
}

async function ensureBinary({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  homeDirectory = os.homedir(),
  packageVersion = PACKAGE_VERSION,
  checksumDocument = packagedChecksums,
  onProgress = (message) => process.stderr.write(message),
} = {}) {
  const location = binaryLocation({ env, platform, arch, homeDirectory, packageVersion });
  const checksum = expectedChecksum(location.asset.assetName, checksumDocument, packageVersion);
  const isReady = () => isValidBinary(location.binaryPath, checksum);

  await fsp.mkdir(location.directory, { recursive: true });
  if (await isReady()) {
    return location.binaryPath;
  }

  const lock = await acquireDownloadLock(location.lockPath, isReady);
  if (!lock) {
    return location.binaryPath;
  }

  const temporaryPath = `${location.binaryPath}.${process.pid}.${crypto.randomUUID()}.partial`;
  try {
    if (await isReady()) {
      return location.binaryPath;
    }
    await fsp.rm(location.binaryPath, { force: true });

    const url = `${releaseBaseUrl(env, packageVersion)}/${location.asset.assetName}`;
    emitProgress(`downloading CodeFacts v${packageVersion} for ${location.asset.key}…`, onProgress);
    await downloadToFile(url, temporaryPath);

    const actualChecksum = await sha256File(temporaryPath);
    if (!hashesMatch(actualChecksum, checksum)) {
      throw new Error(
        `SHA-256 verification failed for ${location.asset.assetName}; expected ${checksum}, received ${actualChecksum}`,
      );
    }
    if (platform !== 'win32') {
      await fsp.chmod(temporaryPath, 0o755);
    }
    await fsp.rename(temporaryPath, location.binaryPath);
    if (!await isReady()) {
      throw new Error(`cached binary verification failed for ${location.binaryPath}`);
    }
    emitProgress(`installed checksum-verified CodeFacts v${packageVersion}.`, onProgress);
    return location.binaryPath;
  } finally {
    await fsp.rm(temporaryPath, { force: true });
    await lock.close().catch(() => undefined);
    await fsp.rm(location.lockPath, { force: true });
  }
}

function runBinary(binaryPath, args, { env = process.env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      cwd,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code) => resolve(code === null ? 1 : code));
  });
}

module.exports = {
  PACKAGE_VERSION,
  PLATFORM_ASSETS,
  assetForPlatform,
  binaryLocation,
  cacheRoot,
  ensureBinary,
  expectedChecksum,
  hashesMatch,
  platformKey,
  releaseBaseUrl,
  runBinary,
  sha256File,
};
