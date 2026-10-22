import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Miniflare, Log, LogLevel, Response as MfResponse } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../../dist/server.js';
import { loadConfig } from '../../../dist/config.js';
import { personalExtensions } from '../../../dist/personal/index.js';
import { CLIENT_TOKEN, OWNER_A, OWNER_B } from './fixtures.mjs';

test('two real isolated DevSpace Runtimes: files, commands, process polling and offline peer', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'personal-fleet-runtimes-'));
  const runtimes = []; let worker;
  t.after(async () => {
    await worker?.dispose();
    for (const r of runtimes) { if (r.closed) continue; await r.running.close(); r.http.closeAllConnections(); await new Promise(resolve => r.http.close(resolve)); }
    await rm(root, { recursive: true, force: true });
  });
  for (const [id, owner] of [['fixture-a', OWNER_A], ['fixture-b', OWNER_B]]) {
    const project = join(root, id, 'project'); await mkdir(project, { recursive: true });
    const token = `private-${id}-acceptance-token-not-real-000`;
    const config = loadConfig({ DEVSPACE_CONFIG_DIR: join(root, id, 'config'), DEVSPACE_ALLOWED_ROOTS: project,
      DEVSPACE_STATE_DIR: join(root, id, 'state'), DEVSPACE_WORKTREE_ROOT: join(root, id, 'worktrees'),
      DEVSPACE_OAUTH_OWNER_TOKEN: 'fleet-upstream-fixture-owner-not-real', DEVSPACE_SUBAGENTS: 'false',
      DEVSPACE_TOOL_MODE: 'codex', DEVSPACE_WIDGETS: 'off', HOST: '127.0.0.1', PORT: '1', DEVSPACE_PUBLIC_BASE_URL: 'http://127.0.0.1:1', DEVSPACE_LOG_LEVEL: 'error' });
    const running = createServer(config, personalExtensions(config, { apiToken: token }));
    running.app.get('/personal-healthz', (_req, res) => res.json({ name: 'personal-devspace', owner, version: '1.0.8' }));
    const http = running.app.listen(0, '127.0.0.1'); await new Promise(resolve => http.once('listening', resolve));
    runtimes.push({ running, http, project, upstream: `http://127.0.0.1:${http.address().port}`, binding: { id, name: id, platform: 'darwin', bindingId: `binding_${id}_000001`,
      runtimeOwner: owner, apiToken: token, endpoint: `https://${id}.fleet.invalid/mcp` } });
  }
  worker = new Miniflare({
    name: 'personal-fleet-real-runtimes', modules: true,
    scriptPath: fileURLToPath(new URL('../.build/worker.js', import.meta.url)), compatibilityDate: '2026-07-30',
    bindings: { FLEET_CLIENT_TOKEN: CLIENT_TOKEN, FLEET_DEVICE_BINDINGS: JSON.stringify(runtimes.map(r => r.binding)) },
    durableObjects: { FLEET: { className: 'PersonalFleet', useSQLite: true } },
    durableObjectsPersist: join(root, 'gateway-storage'), log: new Log(LogLevel.NONE), cf: false,
    outboundService: async req => {
      const url = new URL(req.url), runtime = runtimes.find(r => new URL(r.binding.endpoint).hostname === url.hostname);
      assert.ok(runtime, 'No unexpected outbound target');
      const response = await fetch(new URL(url.pathname, runtime.upstream), { method: req.method, headers: req.headers,
        redirect: 'manual', ...(req.method === 'POST' ? { body: await req.text() } : {}) });
      return new MfResponse(await response.arrayBuffer(), { status: response.status, headers: response.headers });
    },
  });
  await worker.ready;
  const c = new Client({ name: 'real-runtime-fleet-host', version: '1' }); c.onerror = () => {}; t.after(() => c.close());
  await c.connect(new StreamableHTTPClientTransport(new URL('https://fleet.fixture.invalid/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${CLIENT_TOKEN}` } },
    fetch: (url, init) => worker.dispatchFetch(url, init),
  }));
  await c.listTools();
  const call = (name, args) => c.callTool({ name, arguments: args });
  const opened = await Promise.all(runtimes.map(r => call('open_workspace', { deviceId: r.binding.id, path: r.project })));
  for (const r of opened) assert.notEqual(r.isError, true, JSON.stringify(r));
  const [a, b] = opened.map(r => r.structuredContent.workspaceId);
  await Promise.all([a, b].map((workspaceId, i) => call('apply_patch', { workspaceId, patch: `*** Begin Patch\n*** Add File: proof.txt\n+DEVICE_${i}\n*** End Patch` })));
  const files = await Promise.all([a, b].map(workspaceId => call('read', { workspaceId, path: 'proof.txt' })));
  assert.match(JSON.stringify(files[0]), /DEVICE_0/); assert.match(JSON.stringify(files[1]), /DEVICE_1/);
  const forbidden = await call('open_workspace', { deviceId: 'fixture-a', path: runtimes[1].project });
  assert.equal(forbidden.isError, true);
  const processes = await Promise.all([a, b].map((workspaceId, i) => call('exec_command', { workspaceId, cmd: `sleep 0.4; printf PROCESS_${i}`, waitTimeMs: 1 })));
  for (const p of processes) { assert.notEqual(p.isError, true, JSON.stringify(p)); assert.match(p.structuredContent.sessionId, /^fp_/); }
  const polled = await Promise.all([a, b].map((workspaceId, i) => call('write_stdin', { workspaceId, sessionId: processes[i].structuredContent.sessionId, waitTimeMs: 1000 })));
  assert.match(JSON.stringify(polled[0]), /PROCESS_0/); assert.match(JSON.stringify(polled[1]), /PROCESS_1/);
  await runtimes[1].running.close(); runtimes[1].http.closeAllConnections(); await new Promise(resolve => runtimes[1].http.close(resolve));
  runtimes[1].closed = true;
  assert.equal((await call('read', { workspaceId: b, path: 'proof.txt' })).structuredContent.error.code, 'DEVICE_OFFLINE');
  assert.match(JSON.stringify(await call('read', { workspaceId: a, path: 'proof.txt' })), /DEVICE_0/);
});
