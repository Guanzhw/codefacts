'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');

const packageMetadata = require('../package.json');
const packagedAssets = require('../assets.json');

const PACKAGE_VERSION = packageMetadata.version;
const PACKAGE_REQUIRE = createRequire(__filename);

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

function platformPackageFor(platform = process.platform, arch = process.arch) {
  const asset = assetForPlatform(platform, arch);
  return { ...asset, packageName: asset.packageName };
}

function packageDirectoryFor(asset, packageDirectory, packageVersion = PACKAGE_VERSION) {
  if (packageDirectory) {
    return path.resolve(packageDirectory);
  }
  try {
    return path.dirname(PACKAGE_REQUIRE.resolve(`${asset.packageName}/package.json`));
  } catch {
    throw new Error(
      `CodeFacts native package ${asset.packageName}@${packageVersion} is not installed for ${asset.key}; reinstall codefacts without --no-optional or install that optional dependency explicitly`,
    );
  }
}

function binaryLocation({
  platform = process.platform,
  arch = process.arch,
  packageVersion = PACKAGE_VERSION,
  packageDirectory,
} = {}) {
  const asset = assetForPlatform(platform, arch);
  const directory = packageDirectoryFor(asset, packageDirectory, packageVersion);
  return {
    asset,
    packageName: asset.packageName,
    directory,
    packageJsonPath: path.join(directory, 'package.json'),
    binaryPath: path.join(directory, asset.executableName),
    packageVersion,
  };
}

async function readPackageMetadata(packageJsonPath) {
  let source;
  try {
    source = await fsp.readFile(packageJsonPath, 'utf8');
  } catch (error) {
    throw new Error(`CodeFacts native package metadata is unavailable at ${packageJsonPath}: ${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`CodeFacts native package metadata is invalid at ${packageJsonPath}: ${error.message}`);
  }
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

async function ensureBinary({
  platform = process.platform,
  arch = process.arch,
  packageVersion = PACKAGE_VERSION,
  packageDirectory,
} = {}) {
  const location = binaryLocation({ platform, arch, packageVersion, packageDirectory });
  const metadata = await readPackageMetadata(location.packageJsonPath);
  if (metadata.name !== location.packageName) {
    throw new Error(
      `CodeFacts native package name mismatch: expected ${location.packageName}, received ${metadata.name || 'none'}`,
    );
  }
  if (metadata.version !== packageVersion) {
    throw new Error(
      `CodeFacts native package version mismatch: expected ${packageVersion}, received ${metadata.version || 'none'}`,
    );
  }
  if (!Array.isArray(metadata.os) || !metadata.os.includes(location.asset.os) ||
      !Array.isArray(metadata.cpu) || !metadata.cpu.includes(location.asset.cpu)) {
    throw new Error(
      `CodeFacts native package ${location.packageName} is not constrained to ${location.asset.key}`,
    );
  }
  const descriptor = metadata.codefacts;
  if (!descriptor || descriptor.platform !== location.asset.key ||
      descriptor.assetName !== location.asset.assetName) {
    throw new Error(
      `CodeFacts native package ${location.packageName} does not contain the expected ${location.asset.key} binary`,
    );
  }
  if (descriptor.executableName !== location.asset.executableName) {
    throw new Error(`CodeFacts native package ${location.packageName} has an unexpected executable name`);
  }
  try {
    const file = await fsp.stat(location.binaryPath);
    if (!file.isFile()) {
      throw new Error('not a regular file');
    }
  } catch (error) {
    throw new Error(`CodeFacts native binary is missing from ${location.packageName}: ${error.message}`);
  }
  const expected = typeof descriptor.sha256 === 'string' ? descriptor.sha256.toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error(`CodeFacts native package ${location.packageName} has an invalid SHA-256`);
  }
  const actual = await sha256File(location.binaryPath);
  if (!hashesMatch(actual, expected)) {
    throw new Error(
      `SHA-256 verification failed for ${location.asset.assetName}; expected ${expected}, received ${actual}`,
    );
  }
  return location.binaryPath;
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
  ensureBinary,
  hashesMatch,
  platformKey,
  platformPackageFor,
  runBinary,
  sha256File,
};
