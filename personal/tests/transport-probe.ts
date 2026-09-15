import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

// Directly exercise the SDK locked by the given upstream worktree, with its
// exact default transport options. A late response after a real client abort
// must not be claimed as recoverable without an event cursor.
const root = resolve(process.argv[2] ?? '.');
const sdk = (name: string) => import(pathToFileURL(join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm', `${name}.js`)).href);
const [{ McpServer }, { StreamableHTTPServerTransport }] = await Promise.all([sdk('server/mcp'), sdk('server/streamableHttp')]);
const mcp = new McpServer({ name: 'stable-drop-probe', version: '1' });
let executions = 0;
let release!: () => void;
let started!: () => void;
const called = new Promise<void>(resolve => { started = resolve; });
const ready = new Promise<void>(resolve => { release = resolve; });
mcp.registerTool('side_effect', { inputSchema: {} }, async () => { executions++; started(); await ready;
  return { content: [{ type: 'text', text: 'SIDE_EFFECT_COMPLETED' }] }; });
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
await mcp.connect(transport);
const http = createServer(async (req, res) => {
  try { let body = ''; for await (const chunk of req) body += chunk;
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined); }
  catch { if (!res.headersSent) res.writeHead(500).end(); }
});
await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
try {
  const init = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } }) });
  headers['mcp-session-id'] = init.headers.get('mcp-session-id')!; headers['mcp-protocol-version'] = '2025-11-25'; await init.text();
  await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  const abort = new AbortController();
  const pending = fetch(endpoint, { method: 'POST', headers, signal: abort.signal, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'side_effect', arguments: {} } }) });
  const outcome = pending.then(async response => ({ headersReceived: true, body: await response.text() }), () => ({ headersReceived: false, body: '' }));
  await called; abort.abort(); await outcome; release(); await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(executions, 1);
  console.log(JSON.stringify({ root, executions, responseDelivered: false, cursorAvailableBeforeCompletion: false,
    conclusion: 'Pristine stable executes after disconnect but configures no event store; no response replay guarantee.' }, null, 2));
} finally { release(); await mcp.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
