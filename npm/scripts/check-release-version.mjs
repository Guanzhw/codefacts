import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const npmDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(npmDirectory, '..');
const requestedVersion = process.argv[2]?.replace(/^v/, '');

const [cargoToml, packageJson] = await Promise.all([
  readFile(resolve(repositoryRoot, 'Cargo.toml'), 'utf8'),
  readFile(resolve(npmDirectory, 'package.json'), 'utf8'),
]);
const serverJson = JSON.parse(await readFile(resolve(repositoryRoot, 'server.json'), 'utf8'));
const cargoMatch = cargoToml.match(/^version\s*=\s*"([^"]+)"$/m);
if (!cargoMatch) {
  throw new Error('could not determine package version from Cargo.toml');
}
const cargoVersion = cargoMatch[1];
const npmMetadata = JSON.parse(packageJson);
const npmVersion = npmMetadata.version;

if (cargoVersion !== npmVersion) {
  throw new Error(`Cargo.toml (${cargoVersion}) and npm/package.json (${npmVersion}) must match`);
}
if (requestedVersion && requestedVersion !== cargoVersion) {
  throw new Error(`release tag (${requestedVersion}) and package version (${cargoVersion}) must match`);
}
if (serverJson.version !== cargoVersion) {
  throw new Error(`server.json (${serverJson.version}) and package version (${cargoVersion}) must match`);
}
if (npmMetadata.mcpName !== serverJson.name) {
  throw new Error(`npm mcpName (${npmMetadata.mcpName}) and server name (${serverJson.name}) must match`);
}
const npmPackage = serverJson.packages?.find((entry) => entry.registryType === 'npm');
if (!npmPackage || npmPackage.identifier !== npmMetadata.name || npmPackage.version !== cargoVersion) {
  throw new Error('server.json must reference the exact released npm package and version');
}

process.stdout.write(`CodeFacts release version ${cargoVersion} is synchronized.\n`);
