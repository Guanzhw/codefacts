import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { connectNative, hash, loadSdk, writeJson } from '../rpc.mjs';

export const MAX_BYTES = 16 * 1024;
export const EXEC_WAIT_MS = 1000;
const EXCLUDED = /^(?:\.git|node_modules|\.codegraph.*|\.code-graph.*|\.codefacts.*|indexstate|\.indexstate)$/i;
const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
export const repairTools = [
  { name: 'source_edit', description: 'Edit repository source by exact unique old_text replacement. Empty old_text creates a NEW UTF-8 file only; missing parent directories are created. Paths are repository-relative. Inspection and edits are serialized; while a sandbox command is outstanding, poll it to completion first.', annotations,
    inputSchema: { type: 'object', properties: { file_path: { type: 'string', minLength: 1 }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['file_path', 'old_text', 'new_text'], additionalProperties: false } },
  { name: 'source_delete', description: 'Delete one existing repository source file by repository-relative file_path. While a sandbox command is outstanding, poll it to completion first.', annotations,
    inputSchema: { type: 'object', properties: { file_path: { type: 'string', minLength: 1 } }, required: ['file_path'], additionalProperties: false } },
  { name: 'source_exec', description: 'Run a shell command inside the operator-configured isolated test sandbox. The command is one argument to its fixed bash -lc launcher; no host shell is used. Returns completion or a running job_id after at most 1 second. Visible text starts with JSON job_id/status/exit_code, followed by stdout/stderr; the whole response text is at most 16384 UTF-8 bytes and truncation is explicit. Poll an outstanding job to completion before inspecting or editing source.', annotations,
    inputSchema: { type: 'object', properties: { command: { type: 'string', minLength: 1 } }, required: ['command'], additionalProperties: false } },
  { name: 'source_poll', description: 'Retrieve incremental stdout/stderr and completion of a sandbox job. wait_ms defaults to 1000 and is at most 10000. Visible text starts with JSON job_id/status/exit_code, followed by stdout/stderr; the whole response text is at most 16384 UTF-8 bytes and truncation is explicit. Completion releases source inspection/edit scheduling.', annotations: { ...annotations, destructiveHint: false },
    inputSchema: { type: 'object', properties: { job_id: { type: 'string', minLength: 1 }, wait_ms: { type: 'integer', minimum: 0, maximum: 10000 } }, required: ['job_id'], additionalProperties: false } },
];

function absolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return path.resolve(value);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonicalConfiguredPath(candidate) {
  const missing = [];
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error(`Configured path has no existing filesystem root: ${candidate}`);
    missing.unshift(path.basename(candidate)); candidate = parent;
  }
  return path.join(fs.realpathSync(candidate), ...missing);
}

export function validateConfig(input) {
  const root = fs.realpathSync(absolute(input.root, 'root'));
  if (!fs.statSync(root).isDirectory()) throw new Error('root must be a directory');
  const config = { root, evidenceDir: absolute(input.evidenceDir, 'evidenceDir'), sdkRoot: absolute(input.sdkRoot, 'sdkRoot'),
    nodeCommand: absolute(input.nodeCommand, 'nodeCommand'), innerBridgeEntry: absolute(input.innerBridgeEntry, 'innerBridgeEntry'),
    innerConfig: absolute(input.innerConfig, 'innerConfig') };
  const inner = JSON.parse(fs.readFileSync(config.innerConfig, 'utf8'));
  if (fs.realpathSync(absolute(inner.root, 'innerConfig.root')) !== root) throw new Error('innerConfig.root must match root');
  const sandbox = input.sandbox;
  const command = absolute(sandbox?.command, 'sandbox.command');
  if (!Array.isArray(sandbox.argsPrefix) || sandbox.argsPrefix.some(arg => typeof arg !== 'string')) throw new Error('sandbox.argsPrefix must be a string array');
  if (sandbox.argsPrefix.at(-2) !== 'bash' || sandbox.argsPrefix.at(-1) !== '-lc') throw new Error('sandbox.argsPrefix must end with bash, -lc');
  config.sandbox = { command, argsPrefix: [...sandbox.argsPrefix], cwd: sandbox.cwd === undefined ? root : absolute(sandbox.cwd, 'sandbox.cwd') };
  // Config is operator-owned. These exclusions match the frozen read-only bridge.
  const excluded = [config.evidenceDir, absolute(inner.evidenceDir, 'innerConfig.evidenceDir')];
  for (let i = 0; i < (inner.native?.args?.length ?? 0) - 1; i++) {
    if (inner.native.args[i] === '--state') excluded.push(path.resolve(inner.native.cwd, inner.native.args[i + 1]));
  }
  return { ...config, excluded: excluded.map(canonicalConfiguredPath) };
}

function prefix(text, limit) {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function result(text, metadata = {}, isError = false) {
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text }], structuredContent: metadata };
}

// connectNative records the actual wire before SDK response-schema normalization.
// Recover catalog pages there so even unknown tool fields survive this outer hop.
function rawCatalog(wireFile, startByte) {
  const requests = new Set(), tools = [];
  for (const line of fs.readFileSync(wireFile).subarray(startByte).toString('utf8').trim().split('\n')) {
    const { direction, message } = JSON.parse(line);
    if (direction === 'request' && message.method === 'tools/list') requests.add(message.id);
    if (direction === 'response' && requests.has(message.id) && message.result?.tools) tools.push(...message.result.tools);
  }
  return tools;
}

/** Compose the frozen read-only bridge as an inner MCP process.
 * Scheduling is a controlled benchmark factor: repository dispatch is serialized;
 * any outstanding sandbox job blocks inspection/edit until its completion is returned.
 * The operator owns isolation, remote process deadlines, and container teardown.
 */
export async function createBridge(input, { sdk, signal, execWaitMs = EXEC_WAIT_MS } = {}) {
  const config = validateConfig(input);
  if (!Number.isInteger(execWaitMs) || execWaitMs < 0 || execWaitMs >= 45000) throw new Error('execWaitMs must be an integer below 45000');
  const { root, evidenceDir } = config;
  fs.mkdirSync(evidenceDir, { recursive: true });
  sdk ??= loadSdk(config.sdkRoot);
  const innerEvidence = path.join(evidenceDir, 'inner');
  fs.mkdirSync(innerEvidence, { recursive: true });
  let inner, server, closeTask, closing = false, revision = 0, sequence = 0, eventSequence = 0;
  let queue = Promise.resolve(), activeJob;
  const jobs = new Map();
  const append = (name, value) => fs.appendFileSync(path.join(evidenceDir, name), JSON.stringify(value) + '\n');
  const event = (type, data = {}) => append('events.jsonl', { eventSequence: ++eventSequence, timestamp: new Date().toISOString(), type, revision, ...data });

  function checkFile(file, allowMissing = false) {
    if (path.isAbsolute(file)) throw new Error('file_path must be repository-relative');
    const candidate = path.resolve(root, file);
    if (candidate === root || !inside(root, candidate)) throw new Error('file_path resolves outside the fixed repository');
    const relative = path.relative(root, candidate);
    const parts = relative.split(path.sep);
    if (process.platform === 'win32' && parts.some(part => /[:<>"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('file_path must name a regular Windows source path without device names, aliases, or alternate streams');
    function checkExcluded(target) {
      const targetParts = path.relative(root, target).split(path.sep);
      const key = process.platform === 'win32' ? target.toLowerCase() : target;
      if (targetParts.some(part => EXCLUDED.test(part)) || config.excluded.some(excluded => inside(excluded, target) || key.startsWith(`${process.platform === 'win32' ? excluded.toLowerCase() : excluded}-`))) throw new Error('Source excludes Git, dependencies, index state, and benchmark evidence');
    }
    checkExcluded(candidate);
    let current = root, missing = false;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if (missing) continue;
      let stat;
      try { stat = fs.lstatSync(current); }
      catch (error) { if (allowMissing && error.code === 'ENOENT') { missing = true; continue; } throw error; }
      if (stat.isSymbolicLink()) throw new Error('Source paths must not contain symbolic links or junctions');
      const actual = fs.realpathSync(current);
      if (!inside(root, actual)) throw new Error('file_path resolves outside the fixed repository');
      checkExcluded(actual);
      if (current !== candidate && !stat.isDirectory()) throw new Error('Source parent must be a directory');
      if (current === candidate && !stat.isFile()) throw new Error('file_path must name a source file');
    }
    return candidate;
  }

  function recordEdit(call, operation, file, before, after, delta) {
    revision++;
    const snapshot = bytes => bytes === null ? null : { sha256: hash(bytes), base64: bytes.toString('base64'), text: bytes.toString('utf8') };
    const entry = { sequence: call, revision, operation, file_path: path.relative(root, file).replaceAll('\\', '/'), old: snapshot(before), new: snapshot(after), delta };
    append('edits.jsonl', entry);
    event('source-change', entry);
    return result(`${operation === 'delete' ? 'Deleted' : operation === 'create' ? 'Created' : 'Edited'} ${entry.file_path}`, { file_path: entry.file_path });
  }

  function edit(call, args) {
    const creating = args.old_text === '';
    const file = checkFile(args.file_path, creating);
    if (creating) {
      const after = Buffer.from(args.new_text);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, after, { flag: 'wx' });
      return recordEdit(call, 'create', file, null, after, { old_text: '', new_text: args.new_text });
    }
    const before = fs.readFileSync(file), text = before.toString('utf8');
    if (!Buffer.from(text).equals(before)) throw new Error('source_edit requires a valid UTF-8 source file');
    const position = text.indexOf(args.old_text);
    if (position < 0) throw new Error('old_text was not found');
    if (text.indexOf(args.old_text, position + 1) >= 0) throw new Error('old_text must match exactly once');
    const after = Buffer.from(text.slice(0, position) + args.new_text + text.slice(position + args.old_text.length));
    fs.writeFileSync(file, after);
    return recordEdit(call, 'replace', file, before, after, { old_text: args.old_text, new_text: args.new_text });
  }

  function launch(call, command) {
    const id = randomUUID(), sandbox = config.sandbox;
    const child = spawn(sandbox.command, [...sandbox.argsPrefix, command], { cwd: sandbox.cwd, shell: false, windowsHide: true,
      env: sdk.getDefaultEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    const job = { id, child, command, sequence: call, done: false, stdout: '', stderr: '', truncated: false, exitCode: null, signal: null, error: null };
    jobs.set(id, job); activeJob = job;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    function add(stream, bytes) {
      fs.appendFileSync(path.join(evidenceDir, `${id}-${stream}.log`), bytes);
      const text = decoders[stream].write(bytes);
      const combined = job[stream] + text;
      if (Buffer.byteLength(combined) > MAX_BYTES) job.truncated = true;
      job[stream] = prefix(combined, MAX_BYTES);
      event('sandbox-output', { job_id: id, stream, base64: bytes.toString('base64') });
    }
    child.stdout.on('data', bytes => add('stdout', bytes));
    child.stderr.on('data', bytes => add('stderr', bytes));
    child.once('spawn', () => event('sandbox-spawn', { job_id: id, pid: child.pid }));
    child.once('error', error => { job.error = error.message; event('sandbox-error', { job_id: id, message: error.message }); });
    job.closed = new Promise(resolve => child.once('close', (code, processSignal) => {
      for (const stream of ['stdout', 'stderr']) {
        const ending = decoders[stream].end();
        if (Buffer.byteLength(job[stream] + ending) > MAX_BYTES) job.truncated = true;
        job[stream] = prefix(job[stream] + ending, MAX_BYTES);
      }
      job.done = true; job.exitCode = code; job.signal = processSignal;
      // Arbitrary sandbox commands can mutate source, even when they fail.
      // Advance an observation epoch without inventing per-file edit receipts.
      revision++;
      event('source-observation-epoch', { job_id: id, reason: 'sandbox-command; source changes not individually journaled' });
      event('sandbox-close', { job_id: id, pid: child.pid, exitCode: code, signal: processSignal, error: job.error });
      resolve();
    }));
    event('sandbox-start', { sequence: call, job_id: id, command: sandbox.command, args: [...sandbox.argsPrefix, command], cwd: sandbox.cwd });
    return job;
  }

  async function collect(job, waitMs) {
    if (!job.done && waitMs > 0) {
      let timer;
      try { await Promise.race([job.closed, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]); }
      finally { clearTimeout(timer); }
    }
    const marker = '\n[TRUNCATED: output omitted; narrow the command output]';
    const state = { job_id: job.id, status: job.done ? 'completed' : 'running', exit_code: job.exitCode };
    const header = JSON.stringify({ ...state, ...(job.signal ? { signal: job.signal } : {}) }) + '\n';
    const output = `${job.error ? `error:\n${job.error}\n` : ''}stdout:\n${job.stdout}\nstderr:\n${job.stderr}`;
    const outputLimit = MAX_BYTES - Buffer.byteLength(header);
    const truncated = job.truncated || Buffer.byteLength(output) > outputLimit;
    const text = header + (truncated ? prefix(output, outputLimit - Buffer.byteLength(marker)) + marker : output);
    job.stdout = ''; job.stderr = ''; job.truncated = false;
    const metadata = { ...state, signal: job.signal, truncated, ...(job.error ? { error: job.error } : {}) };
    if (job.done && activeJob === job) { activeJob = undefined; event('sandbox-completion-observed', { job_id: job.id }); }
    return result(text, metadata, Boolean(job.error) || (job.done && job.exitCode !== 0));
  }

  async function close() {
    closeTask ??= (async () => {
      closing = true;
      event('cleanup-start');
      const owned = [...jobs.values()].filter(job => !job.done);
      const settle = async (job, waitMs) => {
        let timer;
        try { await Promise.race([job.closed, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]); }
        finally { clearTimeout(timer); }
      };
      const stop = async job => {
        event('sandbox-cancel', { job_id: job.id, pid: job.child.pid });
        job.child.kill('SIGTERM');
        await settle(job, 1000);
        if (job.done) return;
        event('sandbox-cancel-escalated', { job_id: job.id, pid: job.child.pid, signal: 'SIGKILL' });
        job.child.kill('SIGKILL');
        await settle(job, 1000);
        if (job.done) return;
        // Descendant-held pipe handles can outlive the direct launcher PID.
        // Remote/container descendants belong to operator teardown.
        job.child.stdout.destroy(); job.child.stderr.destroy();
        await settle(job, 1000);
        if (!job.done) throw new Error(`Owned sandbox child did not close after SIGKILL: ${job.child.pid}`);
      };
      const outcomes = await Promise.allSettled([inner?.close(), server?.close(), ...owned.map(stop)]);
      signal?.removeEventListener('abort', abort);
      const failed = outcomes.find(outcome => outcome.status === 'rejected');
      event(failed ? 'cleanup-failed' : 'cleanup-complete', { ownedPids: owned.map(job => job.child.pid), ...(failed ? { error: failed.reason.message } : {}), remoteProcessCleanup: 'Operator owns per-attempt container teardown and remote deadlines.' });
      if (failed) throw failed.reason;
    })();
    return closeTask;
  }
  const abort = () => { void close().catch(error => console.error(error.message)); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    // Wire evidence is append-only; RPC IDs restart on every connection.
    // Slice at the byte boundary before this connection, retaining prior receipts.
    const innerWire = path.join(innerEvidence, 'native-wire.jsonl');
    const innerWireStart = fs.existsSync(innerWire) ? fs.statSync(innerWire).size : 0;
    inner = await connectNative(sdk, { command: config.nodeCommand, args: [config.innerBridgeEntry, '--config', config.innerConfig], cwd: root, env: {} }, innerEvidence, signal);
    signal?.throwIfAborted();
    const innerTools = rawCatalog(innerWire, innerWireStart);
    if (innerTools.length !== inner.tools.length || innerTools.some((tool, i) => tool.name !== inner.tools[i].name)) throw new Error('Inner wire catalog does not match initialized catalog');
    const forwards = new Set(innerTools.map(tool => tool.name));
    if (repairTools.some(tool => forwards.has(tool.name))) throw new Error('Inner catalog collides with repair tools');
    const tools = [...innerTools, ...structuredClone(repairTools)];
    const ajv = new sdk.Ajv({ strict: false, allErrors: true });
    const validators = new Map(tools.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
    async function dispatch(params, call) {
      const name = params.name, args = params.arguments ?? {};
      event('operation-start', { sequence: call, tool: name, arguments: args });
      let response;
      try {
        if (closing) throw new Error('Bridge is closing');
        const validate = validators.get(name);
        if (!validate) throw new Error(`Tool unavailable: ${name}`);
        if (!validate(args)) throw new Error(`Invalid tool arguments: ${ajv.errorsText(validate.errors)}`);
        if (activeJob && name !== 'source_poll') throw new Error(`Sandbox busy: poll job ${activeJob.id} to completion before source inspection, edits, or another execution`);
        if (forwards.has(name)) {
          if (name === 'source_read') checkFile(args.file_path);
          const receipt = {};
          response = await inner.callTool(params, receipt);
          if (!response.isError) append('exposures.jsonl', { sequence: call, tool: name, arguments: args, result: response, revision });
        } else if (name === 'source_edit') response = edit(call, args);
        else if (name === 'source_delete') {
          const file = checkFile(args.file_path), before = fs.readFileSync(file);
          fs.unlinkSync(file);
          response = recordEdit(call, 'delete', file, before, null, { old_text: before.toString('utf8'), new_text: '' });
        } else if (name === 'source_exec') response = await collect(launch(call, args.command), execWaitMs);
        else {
          const job = jobs.get(args.job_id);
          if (!job) throw new Error('Unknown sandbox job_id');
          response = await collect(job, args.wait_ms ?? 1000);
        }
      } catch (error) { response = result(error.message, {}, true); event('operation-error', { sequence: call, tool: name, message: error.message }); }
      event('tool-response', { sequence: call, tool: name, response });
      event('operation-end', { sequence: call, tool: name });
      return response;
    }
    function callTool(params) {
      const call = ++sequence;
      event('tool-request', { sequence: call, request: params });
      const pending = queue.then(() => dispatch(params, call));
      queue = pending.catch(() => {});
      return pending;
    }
    server = new sdk.Server({ name: 'community-repair-bridge', version: '1' }, { capabilities: { tools: {} },
      ...(inner.metadata.instructions !== null ? { instructions: inner.metadata.instructions } : {}) });
    // The Server override normalizes result schemas, dropping unknown content fields.
    // Its inherited public Protocol handler preserves the inner raw result object.
    Object.getPrototypeOf(sdk.Server.prototype).setRequestHandler.call(server, sdk.CallToolRequestSchema, request => callTool(request.params));
    server.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({ tools }));
    writeJson(path.join(evidenceDir, 'bridge-metadata.json'), { config, pid: process.pid, tools, inner: inner.metadata,
      scheduling: 'Serialized repository dispatch. An outstanding sandbox job blocks inspection/edit until its completion is observed by source_exec/source_poll.',
      revisionPolicy: 'Revision is a source observation epoch, advanced by each accepted source_edit/source_delete and every settled sandbox command, including failed commands. Exact per-file receipts cover source_edit/source_delete only. Raw sandbox output is not mapped to source spans.',
      sandboxPolicy: 'Fixed operator command and argv prefix; model command appended as one argv; SDK default environment only. Operator owns container isolation, remote deadlines, and teardown.',
      outputLimitBytes: MAX_BYTES, execInitialWaitMs: execWaitMs, instructionPolicy: 'Inner instructions, tool descriptions, catalogs, and tool results retained verbatim.' });
    event('ready');
    return { config, tools, callTool, close, connect: () => server.connect(new sdk.StdioServerTransport()) };
  } catch (error) {
    await close().catch(cleanup => console.error(`Bridge cleanup failed: ${cleanup.message}`));
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { config: { type: 'string' } }, strict: true });
  const input = JSON.parse(fs.readFileSync(absolute(values.config, '--config'), 'utf8'));
  const controller = new AbortController();
  let bridge, exitSignal;
  const shutdown = async signal => {
    exitSignal ??= signal;
    controller.abort(new Error('Bridge shutdown requested'));
    if (!bridge) return;
    await bridge.close().catch(error => { console.error(error.stack ?? error.message); process.exitCode = 1; });
    if (signal) process.exit(process.exitCode ?? 0);
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.stdin.once('end', () => { void shutdown(); });
  bridge = await createBridge(input, { signal: controller.signal });
  if (controller.signal.aborted) { await shutdown(exitSignal); return; }
  await bridge.connect();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
