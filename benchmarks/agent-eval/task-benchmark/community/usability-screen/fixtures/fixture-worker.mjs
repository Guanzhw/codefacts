import fs from 'node:fs';
import { spawn } from 'node:child_process';

const [mode, output] = process.argv.slice(2);
const send = value => process.send?.({ ...value, atMs: Date.now() });
send({ type: 'ready', mode });
if (mode === 'block') {
  const until = performance.now() + 1400;
  while (performance.now() < until) {}
  send({ type: 'block-ended' });
} else if (mode === 'sibling') {
  await new Promise(resolve => setTimeout(resolve, 80));
  send({ type: 'handshake' });
  fs.writeFileSync(output, JSON.stringify({ exact: null, duration: null, status: 'attempt-failed' }));
} else if (mode === 'fail') {
  process.stderr.write('deliberate failure\n');
  process.exitCode = 7;
} else if (mode === 'logs') {
  const secret = process.env.OPENCODE_API_KEY ?? 'fixture';
  process.stdout.write(secret.slice(0, 8));
  await new Promise(resolve => setTimeout(resolve, 30));
  process.stdout.write(secret.slice(8));
  process.stdout.write('x'.repeat(200_000));
  process.stderr.write('y'.repeat(200_000));
} else if (mode === 'descendant') {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  fs.writeFileSync(output, String(descendant.pid));
  send({ type: 'descendant', pid: descendant.pid });
  setInterval(() => {}, 1000);
} else if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (mode === 'escaped-pipe') {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  fs.writeFileSync(output, String(descendant.pid));
  await new Promise(resolve => setTimeout(resolve, 100));
  descendant.unref(); process.disconnect?.(); process.exit(0);
}
if (!['hang', 'descendant'].includes(mode)) process.disconnect?.();
