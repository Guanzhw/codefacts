import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadSdk, connectNative, checkedFlags, hash, writeJson } from './rpc.mjs';
import { createLifecycle, observeChild } from './lifecycle.mjs';

export const MAX_BYTES = 16 * 1024;
export const MAX_READ_LINES = 300;
const EXCLUDED_PART = /^(?:\.git|node_modules|\.codegraph.*|\.code-graph.*|\.codefacts.*|indexstate|\.indexstate)$/i;
const EXCLUDE_GLOBS = ['!.git', '!node_modules', '!.codegraph*', '!.code-graph*', '!.codefacts*', '!indexstate', '!.indexstate'];
const EXPECTED = { codefacts017: ['map', 'search', 'outline', 'expand', 'path'], codefacts022: ['explore', 'expand', 'impact'], codegraph: ['codegraph_explore'] };
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const sourceTools = [
  { name: 'source_search', description: 'Search current repository source with ripgrep. Regex by default; literal=true uses fixed strings. Optional glob filters paths. Results include file paths and one-based line numbers. At most 16384 UTF-8 text bytes; truncation is explicit.', annotations,
    inputSchema: { type: 'object', properties: { pattern: { type: 'string', minLength: 1 }, literal: { type: 'boolean' }, glob: { type: 'string', minLength: 1 } }, required: ['pattern'], additionalProperties: false } },
  { name: 'source_read', description: 'Read current repository source by relative file_path and one-based inclusive start_line/end_line. Returns numbered lines. At most 300 lines and 16384 UTF-8 text bytes; truncation is explicit.', annotations,
    inputSchema: { type: 'object', properties: { file_path: { type: 'string', minLength: 1 }, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } }, required: ['file_path', 'start_line', 'end_line'], additionalProperties: false } },
  { name: 'source_list', description: 'List current repository source files with ripgrep --files. Optional glob filters repository-relative paths. At most 16384 UTF-8 text bytes; truncation is explicit.', annotations,
    inputSchema: { type: 'object', properties: { glob: { type: 'string', minLength: 1 } }, additionalProperties: false } },
];

export function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function absolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return value;
}

export function validateConfig(input) {
  const root = fs.realpathSync(absolute(input.root, 'root'));
  if (!fs.statSync(root).isDirectory()) throw new Error('root must be a directory');
  const evidenceDir = absolute(input.evidenceDir, 'evidenceDir');
  const rgCommand = absolute(input.rgCommand, 'rgCommand');
  const sdkRoot = fs.realpathSync(absolute(input.sdkRoot, 'sdkRoot'));
  if (!['ordinary', ...Object.keys(EXPECTED)].includes(input.arm)) throw new Error('Unknown benchmark arm');
  if (input.arm === 'ordinary' && input.native != null) throw new Error('ordinary must have native:null');
  let native = null;
  if (input.arm !== 'ordinary') {
    if (!input.native) throw new Error(`${input.arm} requires native config`);
    const { command, args, cwd, env = {} } = input.native;
    absolute(command, 'native.command');
    absolute(cwd, 'native.cwd');
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('native.args must be a string array');
    native = { command, args, cwd, env: checkedFlags({ ...checkedFlags(env), ...checkedFlags(input.nativeEnv) }) };
  } else if (input.nativeEnv && Object.keys(input.nativeEnv).length) throw new Error('ordinary has no nativeEnv');
  return { root, evidenceDir, rgCommand, sdkRoot, arm: input.arm, native, ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}) };
}

function utf8Prefix(text, limit) {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function boundedText(text, metadata, alreadyTruncated = false) {
  const truncated = alreadyTruncated || Buffer.byteLength(text) > MAX_BYTES;
  const marker = '\n[TRUNCATED: narrow the query or line range]';
  const body = truncated ? utf8Prefix(text, MAX_BYTES - Buffer.byteLength(marker)) + marker : text;
  return { content: [{ type: 'text', text: body }], structuredContent: { ...metadata, truncated } };
}

function fixedTool(tool, arm) {
  const result = structuredClone(tool);
  result.name = arm === 'codegraph' ? tool.name : `codefacts_${tool.name}`;
  for (const rootKey of ['repository_root', 'projectPath']) {
    delete result.inputSchema.properties?.[rootKey];
    if (result.inputSchema.required) result.inputSchema.required = result.inputSchema.required.filter(name => name !== rootKey);
  }
  result.inputSchema.additionalProperties = false;
  return result;
}

export async function createBridge(input, { sdk = undefined, signal = undefined } = {}) {
  const config = validateConfig(input);
  const { root, evidenceDir, arm } = config;
  fs.mkdirSync(evidenceDir, { recursive: true });
  sdk ??= loadSdk(config.sdkRoot);
  let native, closeTask;
  const servers = new Set(), activeCalls = new Set();
  const sourceChildren = new Map();
  const lifecycle = config.lifecycle && createLifecycle({ ...config.lifecycle, role: 'bridge-service' });
  const childOptions = lifecycle && { ...config.lifecycle, parentInstanceId: lifecycle.instanceId };
  const excludedFiles = new Set();
  if (config.native) {
    for (let i = 0; i < config.native.args.length - 1; i++) {
      if (config.native.args[i] === '--state') excludedFiles.add(path.resolve(config.native.cwd, config.native.args[i + 1]));
    }
  }
  if (inside(root, path.resolve(evidenceDir))) excludedFiles.add(path.resolve(evidenceDir));
  function checkFile(file) {
    if (path.isAbsolute(file)) throw new Error('file_path must be repository-relative');
    const requested = path.resolve(root, file);
    const actual = fs.realpathSync(requested);
    if (!inside(root, actual)) throw new Error('file_path resolves outside the fixed repository');
    for (const candidate of [requested, actual]) {
      const relative = path.relative(root, candidate);
      if (relative.split(path.sep).some(part => EXCLUDED_PART.test(part)) || [...excludedFiles].some(excluded => inside(excluded, candidate))) throw new Error('Source excludes Git, dependencies, benchmark evidence, and index state');
    }
    if (!fs.statSync(actual).isFile()) throw new Error('file_path must name a source file');
    return actual;
  }
  async function runRg(args) {
    const rgArgs = [...args];
    for (const glob of EXCLUDE_GLOBS) rgArgs.push('--glob', glob);
    for (const excluded of excludedFiles) if (inside(root, excluded)) {
      const relative = path.relative(root, excluded).replaceAll('\\', '/');
      rgArgs.push('--glob', `!/${relative}`, '--glob', `!/${relative}/**`, '--glob', `!/${relative}-*`);
    }
    const receipt = lifecycle && createLifecycle({ ...childOptions, role: 'ripgrep' });
    const child = spawn(config.rgCommand, [...rgArgs, '--', '.'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: sdk.getDefaultEnvironment() });
    const ownership = receipt && observeChild(child, receipt);
    sourceChildren.set(child, ownership);
    const kill = reason => ownership ? ownership.requestKill('SIGTERM', reason) : child.kill();
    const chunks = [];
    let bytes = 0, stderr = '', truncated = false, timedOut = false;
    child.stdout.on('data', chunk => {
      const remaining = MAX_BYTES + 4 - bytes;
      if (remaining > 0) { const part = chunk.subarray(0, remaining); chunks.push(part); bytes += part.length; }
      if (bytes > MAX_BYTES && !truncated) { truncated = true; kill('output-truncated'); }
    });
    child.stderr.on('data', chunk => { stderr = utf8Prefix(stderr + chunk.toString(), MAX_BYTES); });
    const timer = setTimeout(() => { timedOut = true; kill('source-timeout'); }, 15_000);
    let exit;
    try {
      exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    } finally { clearTimeout(timer); sourceChildren.delete(child); }
    if (timedOut) throw new Error('ripgrep timed out after 15 seconds');
    if (!truncated && ![0, 1].includes(exit.code)) throw new Error(`ripgrep failed (${exit.code}): ${stderr.trim()}`);
    return { text: Buffer.concat(chunks).toString('utf8'), truncated, exitCode: exit.code };
  }
  async function sourceCall(name, args) {
    if (name === 'source_read') {
      if (args.end_line < args.start_line) throw new Error('Read range must be ascending');
      const file = checkFile(args.file_path);
      const bytes = fs.readFileSync(file);
      const lines = bytes.toString('utf8').split(/\r?\n/);
      if (lines.at(-1) === '') lines.pop();
      const end = Math.min(args.end_line, args.start_line + MAX_READ_LINES - 1, lines.length);
      const body = lines.slice(args.start_line - 1, end).map((line, index) => `${args.start_line + index}\t${line}`).join('\n');
      return boundedText(body, { file_path: path.relative(root, file).replaceAll('\\', '/'), start_line: args.start_line, end_line: end }, end < Math.min(args.end_line, lines.length));
    }
    const command = ['--hidden', '--color', 'never'];
    if (name === 'source_search') {
      command.push('--line-number', '--no-heading');
      if (args.literal) command.push('--fixed-strings');
      // --regexp keeps a leading dash in the untrusted pattern out of option parsing.
      command.push('--regexp', args.pattern);
    } else command.push('--files');
    if (args.glob) command.push('--glob', args.glob);
    const result = await runRg(command);
    return boundedText(result.text, {}, result.truncated);
  }
  async function close() {
    closeTask ??= (async () => {
      const children = [...sourceChildren];
      for (const [child, ownership] of children) ownership ? ownership.requestKill('SIGTERM', 'bridge-shutdown') : child.kill();
      const outcomes = await Promise.allSettled([...activeCalls, ...[...servers].map(server => server.close()), ...children.map(([child, ownership]) => ownership?.closed ?? new Promise(resolve => child.once('close', resolve)))]);
      try { await native?.close(); } catch (error) { outcomes.push({ status: 'rejected', reason: error }); }
      const failure = outcomes.find(outcome => outcome.status === 'rejected');
      lifecycle?.event(failure ? 'cleanup-failed' : 'instance-completed', failure ? { message: failure.reason.message } : {});
      if (failure) throw failure.reason;
    })();
    return closeTask;
  }
  try {
    signal?.throwIfAborted();
    if (config.native) native = await connectNative(sdk, config.native, evidenceDir, signal, childOptions);
    signal?.throwIfAborted();
    if (native) {
      const actual = native.tools.map(tool => tool.name);
      if (actual.length !== EXPECTED[arm].length || EXPECTED[arm].some(name => !actual.includes(name))) throw new Error(`Native ${arm} menu mismatch: expected ${EXPECTED[arm].join(', ')}; got ${actual.join(', ')}`);
    }
    const tools = [...structuredClone(sourceTools), ...(native?.tools.map(tool => fixedTool(tool, arm)) ?? [])];
    const forwards = new Map(native?.tools.map(tool => [arm === 'codegraph' ? tool.name : `codefacts_${tool.name}`, tool.name]));
    const ajv = new sdk.Ajv({ strict: false, allErrors: true });
    const validators = new Map(tools.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
    writeJson(path.join(evidenceDir, 'bridge-metadata.json'), { config, pid: process.pid, tools, sourceToolsSha256: hash(sourceTools),
      sourceBounds: { textBytes: MAX_BYTES, readLines: MAX_READ_LINES }, native: native?.metadata ?? null,
      instructionPolicy: 'Native server instructions passed verbatim through MCP initialization when present. Native tool descriptions retained verbatim; root selectors fixed by bridge.' });
    let serial = 0;
    async function dispatch(params) {
      const call = ++serial;
      const id = String(call).padStart(4, '0');
      const started = Date.now();
      const name = params.name, args = params.arguments ?? {};
      const request = { name, arguments: args };
      writeJson(path.join(evidenceDir, `${id}-request.json`), request);
      let response, error, forwarded;
      const nativeReceipt = {};
      try {
        const validate = validators.get(name);
        if (!validate) throw new Error(`Tool unavailable in ${arm} arm: ${name}`);
        if (!validate(args)) throw new Error(`Invalid tool arguments: ${ajv.errorsText(validate.errors)}`);
        if (forwards.has(name)) {
          forwarded = { name: forwards.get(name), arguments: { ...args, [arm === 'codegraph' ? 'projectPath' : 'repository_root']: root } };
          writeJson(path.join(evidenceDir, `${id}-native-request.json`), forwarded);
          response = await native.callTool(forwarded, nativeReceipt);
        } else response = await sourceCall(name, args);
      } catch (failure) {
        error = { name: failure.name, message: failure.message, ...(failure.code === undefined ? {} : { code: failure.code }), ...(failure.data === undefined ? {} : { data: failure.data }) };
        response = { isError: true, content: [{ type: 'text', text: failure.message }] };
      }
      writeJson(path.join(evidenceDir, `${id}-response.json`), response);
      writeJson(path.join(evidenceDir, `${id}-receipt.json`), { call, arm, name, elapsedMs: Date.now() - started, error,
        requestBytes: Buffer.byteLength(JSON.stringify(request)), requestSha256: hash(request), responseBytes: Buffer.byteLength(JSON.stringify(response)), responseSha256: hash(response),
        isError: response.isError ?? false, nativeResponseUnmodified: Boolean(forwarded && !error), ...(forwarded ? { native: nativeReceipt } : {}) });
      return response;
    }
    function callTool(params) {
      const task = dispatch(params); activeCalls.add(task);
      task.then(() => activeCalls.delete(task), () => activeCalls.delete(task));
      return task;
    }
    function createServer() {
      const server = new sdk.Server({ name: 'task-benchmark-readonly', version: '1' }, {
        capabilities: { tools: {} },
        ...(native?.metadata.instructions != null ? { instructions: native.metadata.instructions } : {}),
      });
      server.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({ tools }));
      server.setRequestHandler(sdk.CallToolRequestSchema, request => callTool(request.params));
      servers.add(server);
      server.onclose = () => servers.delete(server);
      return server;
    }
    return { config, tools, callTool, close, createServer, lifecycle, connect: () => createServer().connect(new sdk.StdioServerTransport()) };
  } catch (error) {
    try { await close(); } catch (cleanupError) { console.error(`Bridge cleanup failed: ${cleanupError.message}`); }
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { config: { type: 'string' } }, strict: true });
  absolute(values.config, '--config');
  const input = JSON.parse(fs.readFileSync(values.config, 'utf8'));
  const controller = new AbortController();
  let bridge, exitSignal;
  const shutdown = async signal => {
    exitSignal ??= signal;
    controller.abort(new Error('Bridge shutdown requested'));
    if (!bridge) return;
    try { await bridge.close(); }
    catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
    if (signal) process.exit(process.exitCode ?? 0);
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.stdin.once('end', () => { void shutdown(); });
  try {
    bridge = await createBridge(input, { signal: controller.signal });
    if (controller.signal.aborted) { await shutdown(exitSignal); return; }
    await bridge.connect();
  } catch (error) {
    await bridge?.close().catch(cleanup => console.error(cleanup.message));
    if (controller.signal.aborted) { if (exitSignal) process.exit(process.exitCode ?? 0); return; }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
