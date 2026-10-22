import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FleetGateway } from '../gateway.mjs';
import { DeviceTransport, parseDevices } from '../upstream.mjs';
import { CLIENT_TOKEN, MemoryStorage, bindings, fakeDevices } from './fixtures.mjs';

function setup({ storage = new MemoryStorage(), clock, deviceBindings = bindings(), backend = fakeDevices() } = {}) {
  const gateway = new FleetGateway({ storage, now: clock ? () => clock.time : Date.now, clientToken: CLIENT_TOKEN,
    bindings: JSON.stringify(deviceBindings), transport: new DeviceTransport({ fetch: backend.fetch }) });
  return { gateway, storage, backend, deviceBindings };
}
async function client(t, gateway) {
  const c = new Client({ name: 'fleet-host-test', version: '1' });
  c.onerror = () => {};
  const transport = new StreamableHTTPClientTransport(new URL('https://fleet.fixture.invalid/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${CLIENT_TOKEN}` } },
    fetch: (input, init) => gateway.fetch(input instanceof Request ? input : new Request(input, init)),
  });
  await c.connect(transport); t.after(() => c.close()); await c.listTools(); return c;
}
const call = (c, name, args = {}, meta) => c.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
async function open(c, deviceId, path = '/project') { const r = await call(c, 'open_workspace', { deviceId, path }); assert.notEqual(r.isError, true, JSON.stringify(r)); return r.structuredContent.workspaceId; }

test('bindings reject duplicates, non-HTTPS endpoints, URL credentials and ambiguous identity', () => {
  for (const edit of [d => [...d, d[0]], d => [{ ...d[0], endpoint: 'http://untrusted.invalid/mcp' }], d => [{ ...d[0], endpoint: 'https://secret@mac.fixture.invalid/mcp' }], d => [{ ...d[0], runtimeOwner: '' }]]) assert.throws(() => parseDevices(JSON.stringify(edit(bindings()))));
  assert.equal(parseDevices(JSON.stringify(bindings())).length, 2);
});

test('authentication and origin checks happen before dispatch; no private binding data is advertised', async t => {
  const f = setup();
  assert.equal((await f.gateway.fetch(new Request('https://fleet.fixture.invalid/mcp', { method: 'POST', body: 'not-json' }))).status, 401);
  assert.equal((await f.gateway.fetch(new Request('https://fleet.fixture.invalid/mcp', { headers: { Authorization: `Bearer ${CLIENT_TOKEN}`, Origin: 'https://evil.invalid' } }))).status, 403);
  assert.equal(f.backend.devices.flatMap(d => d.posts).length, 0);
  const c = await client(t, f.gateway);
  const catalog = await c.listTools();
  assert.deepEqual(catalog.tools.map(t => t.name), ['list_devices', 'open_workspace', 'read', 'apply_patch', 'exec_command', 'write_stdin', 'codegraph_explore']);
  assert.equal(catalog.tools.find(t => t.name === 'write_stdin').inputSchema.properties.sessionId.type, 'string');
  const result = await call(c, 'list_devices');
  assert.equal(result.structuredContent.devices.every(d => d.online), true);
  for (const device of f.deviceBindings) { assert.ok(!JSON.stringify(result).includes(device.apiToken)); assert.ok(!JSON.stringify(result).includes(device.endpoint)); }
  f.backend.devices[1].unauthorized = true;
  const rejected = await call(c, 'list_devices');
  assert.equal(rejected.structuredContent.devices[1].online, false);
  assert.equal(rejected.structuredContent.devices[1].reason, 'DEVICE_AUTH_FAILED');
});

test('colliding workspace and process ids remain bound; metadata survives and numeric output is preserved', async t => {
  const f = setup(), c = await client(t, f.gateway);
  const [a, b] = await Promise.all([open(c, 'macmini'), open(c, 'lecoo', 'C:\\project')]);
  assert.notEqual(a, b);
  const [ra, rb] = await Promise.all([
    call(c, 'exec_command', { workspaceId: a, cmd: 'echo one' }, { 'openai/session': 'conversation-A' }),
    call(c, 'exec_command', { workspaceId: b, cmd: 'echo two' }),
  ]);
  const pa = ra.structuredContent.sessionId, pb = rb.structuredContent.sessionId;
  assert.match(pa, /^fp_/); assert.notEqual(pa, pb);
  assert.match(ra.content[0].text, /output 7 remains untouched/);
  assert.ok(ra.content[0].text.includes(pa)); assert.ok(!ra.content[0].text.includes('session ID 7.'));
  assert.equal(ra._meta, undefined);
  assert.equal(f.backend.devices[0].posts.find(p => p.params?.name === 'exec_command').params._meta['openai/session'], 'conversation-A');
  assert.equal((await call(c, 'write_stdin', { workspaceId: a, sessionId: pa })).structuredContent.sessionId, pa);
  const count = f.backend.devices[1].posts.length;
  const wrong = await call(c, 'write_stdin', { workspaceId: b, sessionId: pa });
  assert.equal(wrong.structuredContent.error.code, 'SESSION_WORKSPACE_MISMATCH');
  assert.equal(f.backend.devices[1].posts.length, count);
  const override = await call(c, 'read', { workspaceId: a, path: 'x', deviceId: 'lecoo' });
  assert.equal(override.isError, true);
});

test('a device going offline does not block its peer or dispatch to it as fallback', async t => {
  const f = setup(), c = await client(t, f.gateway);
  const a = await open(c, 'macmini'), b = await open(c, 'lecoo');
  f.backend.devices[1].offline = true;
  const failed = await call(c, 'exec_command', { workspaceId: b, cmd: 'must not run elsewhere' });
  assert.equal(failed.structuredContent.error.code, 'DEVICE_OFFLINE');
  assert.deepEqual(f.backend.devices.map(d => d.commands), [0, 0]);
  assert.equal((await call(c, 'exec_command', { workspaceId: a, cmd: 'works independently' })).isError, undefined);
  assert.deepEqual(f.backend.devices.map(d => d.commands), [1, 0]);
});

test('uncertain command outcomes are not replayed, including redirects and credential failures', async t => {
  const f = setup(), c = await client(t, f.gateway), a = await open(c, 'macmini');
  f.backend.devices[0].outcomeUnknown = true;
  const r = await call(c, 'exec_command', { workspaceId: a, cmd: 'execute exactly once' });
  assert.equal(r.structuredContent.error.code, 'OPERATION_OUTCOME_UNKNOWN');
  assert.deepEqual(f.backend.devices.map(d => d.commands), [1, 0]);
  f.backend.devices[0].redirect = true;
  assert.equal((await call(c, 'read', { workspaceId: a, path: 'file' })).structuredContent.error.code, 'OPERATION_OUTCOME_UNKNOWN');
  f.backend.devices[0].redirect = false; f.backend.devices[0].unauthorized = true;
  const denied = await call(c, 'read', { workspaceId: a, path: 'file' });
  assert.equal(denied.structuredContent.error.code, 'DEVICE_AUTH_FAILED');
  assert.ok(!JSON.stringify(denied).includes(f.deviceBindings[0].apiToken));
});

test('persisted routes survive gateway and host reconnect, but never survive a device rebind', async t => {
  const f = setup(), c = await client(t, f.gateway), a = await open(c, 'macmini');
  const r = await call(c, 'exec_command', { workspaceId: a, cmd: 'same running process' });
  const reloaded = setup({ storage: f.storage, backend: f.backend });
  const next = await client(t, reloaded.gateway);
  assert.equal((await call(next, 'write_stdin', { workspaceId: a, sessionId: r.structuredContent.sessionId })).structuredContent.sessionId, r.structuredContent.sessionId);
  const changed = bindings(); changed[0].bindingId = 'replacement_binding_0001';
  const rebound = await client(t, setup({ storage: f.storage, backend: f.backend, deviceBindings: changed }).gateway);
  assert.equal((await call(rebound, 'read', { workspaceId: a, path: 'file' })).structuredContent.error.code, 'DEVICE_REBOUND');
});

test('Runtime identity changes and lost upstream sessions fail closed without reinitializing or replaying', async t => {
  const f = setup(), c = await client(t, f.gateway), a = await open(c, 'macmini');
  f.backend.devices[0].ownerMismatch = true;
  assert.equal((await call(c, 'read', { workspaceId: a, path: 'file' })).structuredContent.error.code, 'DEVICE_BINDING_MISMATCH');
  f.backend.devices[0].ownerMismatch = false; f.backend.devices[0].lostSession = true;
  assert.equal((await call(c, 'exec_command', { workspaceId: a, cmd: 'not replayed' })).structuredContent.error.code, 'DEVICE_SESSION_LOST');
  assert.equal(f.backend.devices[0].posts.filter(p => p.method === 'initialize').length, 1);
  assert.equal(f.backend.devices[0].commands, 0);
});

test('expired frontend sessions are rejected before any local command is dispatched', async () => {
  const clock = { time: 0 }, f = setup({ clock });
  const headers = { Authorization: `Bearer ${CLIENT_TOKEN}`, 'Content-Type': 'application/json' };
  const init = await f.gateway.fetch(new Request('https://fleet.fixture.invalid/mcp', { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) }));
  clock.time += 60 * 60_000 + 1;
  const response = await f.gateway.fetch(new Request('https://fleet.fixture.invalid/mcp', { method: 'POST', headers: { ...headers, 'Mcp-Session-Id': init.headers.get('mcp-session-id') },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'exec_command', arguments: {} } }) }));
  assert.equal(response.status, 404); assert.equal(f.backend.devices.flatMap(d => d.posts).length, 0);
});

test('parallel opens on the same device share one upstream MCP handshake', async t => {
  const f = setup(), c = await client(t, f.gateway);
  const workspaces = await Promise.all(Array.from({ length: 5 }, () => open(c, 'macmini')));
  assert.equal(new Set(workspaces).size, 5);
  assert.equal(f.backend.devices[0].posts.filter(p => p.method === 'initialize').length, 1);
});

test('handle capacity is checked before dispatching commands or creating workspaces', async t => {
  const f = setup(), c = await client(t, f.gateway), workspaceId = await open(c, 'macmini');
  const expiry = Date.now() + 60_000;
  for (let i = 0; i < 8192; i++) await f.storage.put('p:full-' + i, { expiresAt: expiry });
  const result = await call(c, 'exec_command', { workspaceId, cmd: 'must never start' });
  assert.equal(result.structuredContent.error.code, 'FLEET_CAPACITY');
  assert.equal(f.backend.devices[0].commands, 0);
  for (let i = 0; i < 4095; i++) await f.storage.put('w:full-' + i, { expiresAt: expiry });
  const count = f.backend.devices[0].posts.length;
  const opened = await call(c, 'open_workspace', { deviceId: 'macmini', path: '/project', mode: 'worktree' });
  assert.equal(opened.structuredContent.error.code, 'FLEET_CAPACITY');
  assert.equal(f.backend.devices[0].posts.length, count);
});
