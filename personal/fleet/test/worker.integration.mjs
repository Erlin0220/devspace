import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, Log, LogLevel, Response as MfResponse } from 'miniflare';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CLIENT_TOKEN, bindings, fakeDevices } from './fixtures.mjs';

test('real workerd + SQLite Durable Object: concurrent routing, isolate restart, bindings and offline isolation', { timeout: 60_000 }, async t => {
  const persist = await mkdtemp(join(tmpdir(), 'personal-fleet-worker-'));
  const backend = fakeDevices(); let worker;
  const outboundSeen = [];
  const start = async (deviceBindings = bindings()) => {
    worker = new Miniflare({
      name: 'personal-fleet-test', modules: true,
      scriptPath: fileURLToPath(new URL('../.build/worker.js', import.meta.url)), compatibilityDate: '2026-07-30',
      bindings: { FLEET_CLIENT_TOKEN: CLIENT_TOKEN, FLEET_DEVICE_BINDINGS: JSON.stringify(deviceBindings) },
      durableObjects: { FLEET: { className: 'PersonalFleet', useSQLite: true } }, durableObjectsPersist: persist,
      log: new Log(LogLevel.NONE), cf: false,
      outboundService: async req => {
        outboundSeen.push(req.url);
        const r = await backend.fetch(req.url, { method: req.method, headers: req.headers,
          redirect: 'manual', ...(req.method === 'POST' ? { body: await req.text() } : {}) });
        return new MfResponse(await r.arrayBuffer(), { status: r.status, headers: r.headers });
      },
    });
    await worker.ready;
  };
  t.after(async () => { await worker?.dispose(); await rm(persist, { recursive: true, force: true }); });
  const connect = async () => {
    const c = new Client({ name: 'real-worker-host', version: '1' }); c.onerror = () => {};
    await c.connect(new StreamableHTTPClientTransport(new URL('https://fleet.fixture.invalid/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${CLIENT_TOKEN}` } }, fetch: (url, init) => worker.dispatchFetch(url, init),
    }));
    return c;
  };
  const call = (c, name, args = {}) => c.callTool({ name, arguments: args });
  await start();
  assert.equal((await worker.dispatchFetch('https://fleet.fixture.invalid/mcp')).status, 401);
  let c = await connect();
  assert.equal((await c.listTools()).tools.length, 7);
  const [a, b] = await Promise.all(['macmini', 'lecoo'].map(deviceId => call(c, 'open_workspace', { deviceId, path: '/fixture' })));
  assert.notEqual(a.isError, true, JSON.stringify({ result: a, outboundSeen })); assert.notEqual(b.isError, true, JSON.stringify({ result: b, outboundSeen }));
  const wa = a.structuredContent.workspaceId, wb = b.structuredContent.workspaceId;
  const [pa, pb] = await Promise.all([wa, wb].map(workspaceId => call(c, 'exec_command', { workspaceId, cmd: 'one command per device' })));
  assert.notEqual(pa.isError, true, JSON.stringify(pa)); assert.notEqual(pb.isError, true, JSON.stringify(pb));
  assert.notEqual(pa.structuredContent.sessionId, pb.structuredContent.sessionId);
  const rawHeaders = { Authorization: `Bearer ${CLIENT_TOKEN}`, 'Content-Type': 'application/json' };
  const rawInit = await worker.dispatchFetch('https://fleet.fixture.invalid/mcp', { method: 'POST', headers: rawHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) });
  const rawSession = rawInit.headers.get('mcp-session-id'); await rawInit.arrayBuffer();
  await c.close(); await worker.dispose(); await start();
  const resumed = await worker.dispatchFetch('https://fleet.fixture.invalid/mcp', { method: 'POST', headers: { ...rawHeaders, 'Mcp-Session-Id': rawSession },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) });
  assert.equal(resumed.status, 200); assert.deepEqual((await resumed.json()).result, {});
  c = await connect();
  assert.equal((await call(c, 'write_stdin', { workspaceId: wa, sessionId: pa.structuredContent.sessionId })).structuredContent.sessionId, pa.structuredContent.sessionId);
  backend.devices[1].offline = true;
  assert.equal((await call(c, 'read', { workspaceId: wb, path: 'fixture' })).structuredContent.error.code, 'DEVICE_OFFLINE');
  assert.notEqual((await call(c, 'read', { workspaceId: wa, path: 'fixture' })).isError, true);
  await c.close(); await worker.dispose();
  const rebound = bindings(); rebound[0].bindingId = 'new_macmini_binding_001';
  await start(rebound); c = await connect();
  assert.equal((await call(c, 'read', { workspaceId: wa, path: 'fixture' })).structuredContent.error.code, 'DEVICE_REBOUND');
  await c.close();
});
