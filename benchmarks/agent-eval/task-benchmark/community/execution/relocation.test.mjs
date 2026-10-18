import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadConfig, sha } from './config.mjs';
import { makeGuardedExecute } from './guard.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const cases = path.join(HERE, 'validation', 'synthetic'); fs.mkdirSync(cases, { recursive: true });
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function fixture() {
  const root = fs.mkdtempSync(path.join(cases, 'moved path with spaces-')), relocated = path.join(root, 'portable source'); fs.mkdirSync(relocated);
  for (const file of ['config.mjs', 'guard.mjs']) fs.copyFileSync(path.join(HERE, file), path.join(relocated, file));
  for (const dir of ['accounted-suite-controller-v1', 'parallel-suite-controller-v2', 'rolling-suite-controller-v3']) {
    fs.mkdirSync(path.join(relocated, dir));
    for (const file of fs.readdirSync(path.join(HERE, dir)).filter(name => name.endsWith('.mjs') && !name.includes('.test.'))) fs.copyFileSync(path.join(HERE, dir, file), path.join(relocated, dir, file));
  }
  const framework = path.join(root, 'framework space', 'community'); fs.mkdirSync(framework, { recursive: true });
  fs.writeFileSync(path.join(framework, 'campaign.mjs'), 'export const marker = "local-campaign";\n');
  fs.writeFileSync(path.join(framework, '..', 'rpc.mjs'), 'export const parent = "local-parent";\n');
  fs.writeFileSync(path.join(framework, 'suite.mjs'), `import { marker } from './campaign.mjs';\nimport { parent } from '../rpc.mjs';\nexport const originalURL = import.meta.url;\nexport const imports = [marker,parent];\nfunction verifySuite() {}\nfunction auditProducedCells() { return []; }\nfunction acceptedGrade() { return true; }\nfunction terminal() { return true; }\n`);
  const suite = path.join(root, 'suite.json'); json(suite, {});
  const configPath = path.join(root, 'controller config.json');
  const config = { schemaVersion: 1, suitePath: './suite.json', frameworkDir: './framework space/community', guardModule: './portable source/guard.mjs', sidecarBuildDir: './new generated sidecar', runtimeVolumePath: '.', evidenceVolumePath: '.' };
  json(configPath, config);
  return { root, relocated, framework, configPath, config, build: path.join(root, 'new generated sidecar') };
}
function run(script, args = []) { return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true }); }
function probe(f, body) {
  const script = path.join(f.relocated, 'probe-' + Math.random().toString(16).slice(2) + '.mjs');
  fs.writeFileSync(script, body); return run(script, ['--config', f.configPath]);
}

test('required first config pair; relative paths resolve against config once', () => {
  const f = fixture();
  assert.throws(() => loadConfig([]), /Required first pair/);
  assert.throws(() => loadConfig(['--plan', 'x', '--config', f.configPath]), /Required first pair/);
  const result = loadConfig(['--config', f.configPath, '--worker', 'synthetic']);
  assert.equal(result.config.frameworkDir, f.framework); assert.deepEqual(result.args, ['--worker', 'synthetic']);
  assert.equal(result.identity.configSha256, sha(f.configPath)); assert.equal(result.configArgument, f.configPath);
});

test('both relocated controller modules load generated sidecar with local and parent imports and original URL', () => {
  const f = fixture();
  const result = probe(f, `import { pathToFileURL } from 'node:url';\nimport { runtime } from './config.mjs';\nconst c=runtime();\nconst v2=await import('./parallel-suite-controller-v2/controller.mjs');\nconst v3=await import('./rolling-suite-controller-v3/controller.mjs');\nconst sidecar=await import(pathToFileURL(c.config.sidecarBuildDir+'/suite-exposed.mjs').href);\nconsole.log(JSON.stringify({identity:c.identity,v2:v2.artifactHashes(),v3:v3.artifactHashes(),imports:sidecar.imports,url:sidecar.originalURL}));\n`);
  assert.equal(result.status, 0, result.stderr); const row = JSON.parse(result.stdout);
  assert.deepEqual(row.imports, ['local-campaign', 'local-parent']); assert.equal(row.url, pathToFileURL(path.join(f.framework, 'suite.mjs')).href);
  assert.equal(row.v2.configSha256, sha(f.configPath)); assert.equal(row.v2.configModuleSha256, sha(path.join(f.relocated, 'config.mjs')));
  assert.ok(row.v3.some(pin => pin.path === f.configPath && pin.sha256 === sha(f.configPath)));
  assert.ok(row.v3.some(pin => pin.path === path.join(f.relocated, 'config.mjs')));
  const receipt = read(path.join(f.build, 'sidecar-transform.json')); assert.equal(receipt.originalPath, path.join(f.framework, 'suite.mjs'));
  assert.ok(!fs.readFileSync(path.join(f.build, 'suite-exposed.mjs'), 'utf8').includes('D:/CodexWorktrees'));
});

test('malformed configuration fails both CLI entrypoints before build, allocation or spawn', () => {
  const f = fixture(); delete f.config.evidenceVolumePath; json(f.configPath, f.config);
  for (const dir of ['parallel-suite-controller-v2', 'rolling-suite-controller-v3']) {
    const result = run(path.join(f.relocated, dir, 'controller.mjs'), ['--config', f.configPath, '--run', path.join(f.root, 'decision.json')]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Required configuration path: evidenceVolumePath/);
  }
  assert.equal(fs.existsSync(f.build), false); assert.equal(fs.existsSync(path.join(f.root, 'execution')), false);
});

test('mismatched approved configuration fails both actual CLI entrypoints before suite access/allocation', () => {
  const f = fixture(), decision = path.join(f.root, 'decision.json'); json(decision, { configIdentity: { invalid: true } });
  for (const dir of ['parallel-suite-controller-v2', 'rolling-suite-controller-v3']) {
    const result = run(path.join(f.relocated, dir, 'controller.mjs'), ['--config', f.configPath, '--run', decision]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Approved controller configuration differs/);
  }
  assert.equal(fs.existsSync(path.join(f.root, 'execution')), false);
});

test('raw configuration or config module drift invalidates identity in an already loaded process', () => {
  for (const target of ['config', 'module']) {
    const f = fixture(); const result = probe(f, `import fs from 'node:fs';\nimport {runtime,assertConfigIdentity,CONFIG_MODULE} from './config.mjs';\nconst c=runtime(); fs.appendFileSync(${target === 'module' ? 'CONFIG_MODULE' : 'c.configPath'},'\\n');\ntry {assertConfigIdentity(c.identity); process.exitCode=9;} catch(e) {console.log(e.message);}\n`);
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Approved controller configuration differs/);
  }
});

test('generated sidecar and transform receipt remain exact source bindings', () => {
  for (const target of ['suite-exposed.mjs', 'sidecar-transform.json']) {
    const f = fixture(); let result = probe(f, "import {ensureSidecar} from './accounted-suite-controller-v1/build-sidecar.mjs'; ensureSidecar();"); assert.equal(result.status, 0, result.stderr);
    if (target.endsWith('.mjs')) fs.appendFileSync(path.join(f.build, target), '\n// changed');
    else { const receipt = read(path.join(f.build, target)); receipt.originalSha256 = 'wrong'; json(path.join(f.build, target), receipt); }
    result = probe(f, "import {ensureSidecar} from './accounted-suite-controller-v1/build-sidecar.mjs'; ensureSidecar();");
    assert.notEqual(result.status, 0); assert.match(result.stderr, /sidecar.*differs/i);
  }
});

test('both real synthetic worker processes inherit unchanged config argv and independent namespaces', () => {
  const f = fixture();
  const child = path.join(f.relocated, 'child.mjs'); fs.writeFileSync(child, `import fs from 'node:fs'; import path from 'node:path'; import {runtime} from './config.mjs'; const c=runtime(),dir=c.args[0]; fs.mkdirSync(path.join(dir,'home')); fs.mkdirSync(path.join(dir,'source')); fs.writeFileSync(path.join(dir,'argv.json'),JSON.stringify({argv:process.argv.slice(2),identity:c.identity}));`);
  const result = probe(f, `import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url'; import {runtime,withConfig} from './config.mjs';\nconst c=runtime();\nfor(const [index,version] of ['parallel-suite-controller-v2','rolling-suite-controller-v3'].entries()){const {startWorker}=await import('./'+version+'/worker-process.mjs');const dir=path.join(path.dirname(c.configPath),'namespace-'+index);fs.mkdirSync(dir);await startWorker({node:process.execPath,script:fileURLToPath(new URL('./child.mjs',import.meta.url)),args:withConfig([dir]),out:dir,label:'worker'});}\n`);
  assert.equal(result.status, 0, result.stderr);
  for (const index of [0, 1]) { const dir = path.join(f.root, 'namespace-' + index), row = read(path.join(dir, 'argv.json')); assert.deepEqual(row.argv, ['--config', f.configPath, dir]); assert.equal(row.identity.configPath, f.configPath); assert.ok(fs.existsSync(path.join(dir, 'home'))); assert.ok(fs.existsSync(path.join(dir, 'worker-exit.json'))); }
});

test('portable guard checks configured volume roles with unchanged thresholds before executor', async () => {
  const f = fixture(), roots = [path.join(f.root, 'runtime drive'), path.join(f.root, 'evidence drive')], seen = []; let calls = 0;
  for (const [cohort, minimum] of [['context', 22n], ['swe', 28n]]) {
    const log = path.join(f.root, cohort + '.jsonl'); let available = minimum - 1n;
    const execute = makeGuardedExecute({ cohort, gateLogPath: log, runtimeVolumePath: roots[0], evidenceVolumePath: roots[1], executeCampaign: async () => ++calls,
      statfsSync: volume => { seen.push(volume); return { bavail: volume === roots[0] ? 20n : available, bsize: 1024n ** 3n }; } });
    await assert.rejects(execute('synthetic-manifest', 'run', 'slot'), /Disk admission denied/);
    available = minimum; await execute('synthetic-manifest', 'run', 'slot');
    const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse); assert.deepEqual(rows.map(row => row.admitted), [false, true]); assert.equal(rows[1].policy.dMinimumBytes, String(minimum * 1024n ** 3n)); assert.deepEqual(Object.keys(rows[1].freeBytes), ['c', 'd']);
  }
  assert.equal(calls, 2); assert.deepEqual(seen, [...roots, ...roots, ...roots, ...roots]);
});

test('all portable mapped source hashes match the delivered package', () => {
  const mapping = read(path.join(HERE, 'SOURCE-MAPPING.json'));
  assert.equal(mapping.historicalSources.length, 13, 'The complete portable source mapping must contain 13 files');
  for (const row of mapping.historicalSources) assert.equal(sha(path.join(HERE, row.portablePath)), row.portableSha256, row.portablePath);
});

test('historical original source verification is N/A in the public source package', t => {
  t.skip('Historical source preservation N/A: original source bytes are not distributed; no historical hashes verified. SOURCE-MAPPING.json retains all 13 original source identities.');
});
