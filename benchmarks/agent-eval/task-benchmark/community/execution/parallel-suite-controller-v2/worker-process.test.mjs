import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startWorker } from './worker-process.mjs';
import { drainWave } from './scheduler.mjs';

const stub = `import fs from 'node:fs'; import path from 'node:path';
const [dir, code] = process.argv.slice(2);
fs.mkdirSync(path.join(dir, 'dsh-home')); fs.writeFileSync(path.join(dir, 'source.txt'), dir);
fs.writeFileSync(path.join(dir, 'state.sqlite.stub'), dir); fs.writeFileSync(path.join(dir, 'ready'), String(process.pid));
const timer = setInterval(() => { if (fs.existsSync(path.join(dir, 'allow-cleanup'))) {
  clearInterval(timer); fs.writeFileSync(path.join(dir, 'cleanup-completed'), 'owned-resource-absent'); process.exitCode = Number(code);
} }, 10);
setTimeout(() => { if (!fs.existsSync(path.join(dir, 'cleanup-completed'))) { clearInterval(timer); process.exitCode = 9; } }, 5000).unref();`;

async function waitFor(file) {
  const deadline = Date.now() + 4000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error('Stub did not reach expected state: ' + file);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codefacts-parallel-stub-'));
  const script = path.join(root, 'stub.mjs'); fs.writeFileSync(script, stub);
  // The temp root is an explicit mkdtemp-owned test path.
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const job = id => { const dir = path.join(root, id); fs.mkdirSync(dir); return dir; };
  return { root, script, job };
}

test('real child processes overlap in independent namespaces and drain after owned cleanup', async t => {
  const { root, script, job } = fixture(t), first = job('first'), second = job('second');
  const cells = [{ id: 'a', campaignId: 'a', dir: first, code: 1 }, { id: 'b', campaignId: 'b', dir: second, code: 0 }];
  const lock = path.join(root, 'host.lock'); fs.writeFileSync(lock, 'parent-owned'); let returned = false;
  const running = drainWave(cells, { start: cell => startWorker({ node: process.execPath, script, args: [cell.dir, String(cell.code)], out: root, label: cell.id }) })
    .then(result => { returned = true; return result; });
  await Promise.all([waitFor(path.join(first, 'ready')), waitFor(path.join(second, 'ready'))]);
  assert.notEqual(fs.readFileSync(path.join(first, 'ready'), 'utf8'), fs.readFileSync(path.join(second, 'ready'), 'utf8'));
  fs.writeFileSync(path.join(first, 'allow-cleanup'), 'yes');
  await waitFor(path.join(first, 'cleanup-completed'));
  assert.equal(returned, false); assert.equal(fs.existsSync(lock), true);
  assert.equal(fs.existsSync(path.join(second, 'cleanup-completed')), false);
  fs.writeFileSync(path.join(second, 'allow-cleanup'), 'yes');
  const result = await running;
  assert.equal(result.failed, true);
  assert.deepEqual(result.results.map(row => row.status), ['rejected', 'fulfilled']);
  for (const dir of [first, second]) {
    assert.equal(fs.existsSync(path.join(dir, 'cleanup-completed')), true);
    assert.equal(fs.readFileSync(path.join(dir, 'state.sqlite.stub'), 'utf8'), dir);
    assert.equal(fs.existsSync(path.join(dir, 'dsh-home')), true);
  }
  fs.unlinkSync(lock);
});
test('bookkeeping failure waits for child cleanup and close before rejecting', async t => {
  const { root, script, job } = fixture(t), dir = job('owned');
  fs.writeFileSync(path.join(root, 'owned-start.json'), 'preexisting');
  let returned = false;
  const running = startWorker({ node: process.execPath, script, args: [dir, '0'], out: root, label: 'owned' })
    .then(() => { throw new Error('Expected bookkeeping failure'); }, error => { returned = true; return error; });
  await waitFor(path.join(dir, 'ready'));
  assert.equal(returned, false);
  fs.writeFileSync(path.join(dir, 'allow-cleanup'), 'yes');
  const error = await running;
  assert.equal(error.code, 'EEXIST');
  assert.equal(fs.existsSync(path.join(dir, 'cleanup-completed')), true);
  const exit = JSON.parse(fs.readFileSync(path.join(root, 'owned-exit.json'), 'utf8'));
  assert.equal(exit.code, 0); assert.match(exit.bookkeepingError, /EEXIST/);
});
test('spawn failure records explicit exit and releases no unobserved child', async t => {
  const { root, script } = fixture(t);
  await assert.rejects(startWorker({ node: path.join(root, 'missing-node'), script, args: [], out: root, label: 'missing' }), /failed/);
  const exit = JSON.parse(fs.readFileSync(path.join(root, 'missing-exit.json'), 'utf8'));
  assert.match(exit.spawnError, /ENOENT/);
  assert.notEqual(exit.code, 0);
});
