import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createBridge } from './bridge.mjs';
import { loadSdk } from './rpc.mjs';

/** One cell's backend survives HTTP session disposal/reconnect. No semantic preflight. */
export async function serveHttpBridge(input, { signal, sdk = loadSdk(input.sdkRoot) } = {}) {
  const bridge = await createBridge(input, { sdk, signal });
  const sessions = new Map(), handlers = new Set();
  const endpointPath = `/mcp/${randomUUID()}`;
  let closing = false, closeTask, requests = 0;
  const event = (type, details) => bridge.lifecycle?.event(type, details);
  const listener = http.createServer((req, res) => {
    const requestId = ++requests;
    event('http-request-start', { requestId, method: req.method, sessionId: req.headers['mcp-session-id'] ?? null });
    let ended = false;
    const end = () => { if (!ended) { ended = true; event('http-request-end', { requestId, statusCode: res.statusCode }); } };
    res.once('close', end);
    const task = (async () => {
      if (closing || req.url !== endpointPath) { res.writeHead(closing ? 503 : 404).end(); return; }
      const sessionId = req.headers['mcp-session-id'];
      let transport = sessions.get(sessionId);
      if (!transport && sessionId) { res.writeHead(404).end(); return; }
      if (!transport) {
        if (req.method !== 'POST') { res.writeHead(400).end(); return; }
        // SDK validates initialization and protocol versions. Read only to select
        // the public session transport; never initialize or call the native tool.
        const chunks = []; let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) { res.writeHead(413).end(); return; }
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { res.writeHead(400).end(); return; }
        event('http-session-request', { requestId, method: body.method ?? null });
        if (!sdk.isInitializeRequest(body)) { res.writeHead(400).end(); return; }
        transport = new sdk.StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
          onsessioninitialized: id => { sessions.set(id, transport); event('http-session-start', { sessionId: id }); } });
        const server = bridge.createServer();
        await server.connect(transport);
        const protocolClose = transport.onclose;
        transport.onclose = () => {
          sessions.delete(transport.sessionId);
          event('http-session-close', { sessionId: transport.sessionId ?? null });
          protocolClose?.();
        };
        await transport.handleRequest(req, res, body);
        // Invalid initialization must not retain an unregistered transport.
        if (!transport.sessionId) await server.close();
      } else await transport.handleRequest(req, res);
    })();
    handlers.add(task);
    task.catch(error => { event('http-request-error', { requestId, message: error.message }); if (!res.headersSent) res.writeHead(500); res.end(); })
      .finally(() => handlers.delete(task));
  });
  try {
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  } catch (error) { await bridge.close(); throw error; }
  const url = `http://127.0.0.1:${listener.address().port}${endpointPath}`;
  event('http-ready', { url, pid: process.pid });
  async function close() {
    closeTask ??= (async () => {
      closing = true; event('http-shutdown-requested', { sessions: sessions.size, handlers: handlers.size });
      const listenerClosed = new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
      await Promise.all([...sessions.values()].map(transport => transport.close()));
      await Promise.allSettled([...handlers]);
      listener.closeIdleConnections();
      await listenerClosed;
      event('http-quiescent', { sessions: sessions.size, handlers: handlers.size, requestCount: requests });
      await bridge.close();
    })();
    return closeTask;
  }
  return { url, close, bridge };
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { config: { type: 'string' } }, strict: true });
  if (!path.isAbsolute(values.config ?? '')) throw new Error('--config must be absolute');
  const input = JSON.parse(fs.readFileSync(values.config, 'utf8'));
  const controller = new AbortController();
  let service, stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    if (!service) { controller.abort(new Error('HTTP bridge shutdown requested')); return; }
    try { await service.close(); process.send?.({ type: 'http-bridge-stopped' }); }
    catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
    process.disconnect?.();
  };
  process.on('message', message => { if (message?.type === 'http-bridge-shutdown') void shutdown(); });
  process.once('disconnect', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  try {
    service = await serveHttpBridge(input, { signal: controller.signal });
    if (stopping) { stopping = false; await shutdown(); return; }
    process.send?.({ type: 'http-bridge-ready', url: service.url, pid: process.pid });
  } catch (error) { process.disconnect?.(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
