import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../../src/config.js';
import { createServer } from '../../src/server.js';
import { personalExtensions } from '../../src/personal/index.js';
import { ReplayPool } from '../../src/personal/replay.js';
import { PersonalCodeGraph } from '../../src/personal/codegraph.js';
import { WorkspaceRegistry } from '../../src/workspaces.js';

const TOKEN = 'test-only-personal-token-not-a-real-secret';
async function fixture(t: TestContext, codegraph: boolean | { command: string } = false) {
  const root = await mkdtemp(join(tmpdir(), 'personal-core-'));
  const project = join(root, 'project'); await mkdir(project);
  const config = loadConfig({ DEVSPACE_CONFIG_DIR: join(root, 'config'), DEVSPACE_ALLOWED_ROOTS: project,
    DEVSPACE_STATE_DIR: join(root, 'state'), DEVSPACE_WORKTREE_ROOT: join(root, 'worktrees'), DEVSPACE_AGENT_DIR: join(root, 'agents'),
    DEVSPACE_OAUTH_OWNER_TOKEN: 'separate-test-only-oauth-owner-token', DEVSPACE_TOOL_MODE: 'codex', DEVSPACE_WIDGETS: 'off',
    DEVSPACE_SUBAGENTS: 'false', DEVSPACE_LOG_LEVEL: 'error', HOST: '127.0.0.1', PORT: '1', DEVSPACE_PUBLIC_BASE_URL: 'http://127.0.0.1:1' });
  const running = createServer(config, personalExtensions(config, { apiToken: TOKEN, codegraph: { enabled: Boolean(codegraph), command: join(root, 'missing-codegraph'), args: ['serve', '--mcp'], toolTimeoutMs: 500, startupTimeoutMs: 500, ...(typeof codegraph === 'object' ? codegraph : {}) } }));
  const http = running.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { http.once('listening', resolve); http.once('error', reject); });
  const endpoint = new URL(`http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`);
  const clients: Client[] = [];
  t.after(async () => { for (const client of clients) await client.close().catch(() => {}); await running.close();
    http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  async function connect(token = TOKEN, fetchImpl: typeof fetch = fetch) {
    const client = new Client({ name: 'personal-regression', version: '1' }); clients.push(client); client.onerror = () => {};
    const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } }, fetch: fetchImpl,
      reconnectionOptions: { initialReconnectionDelay: 20, maxReconnectionDelay: 100, reconnectionDelayGrowFactor: 1.2, maxRetries: 5 } });
    await client.connect(transport); return client;
  }
  return { root, project, config, endpoint, connect };
}

test('API token stays separate from OAuth; invalid credentials are rejected', async t => {
  const f = await fixture(t); const client = await f.connect();
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(tools.includes('exec_command')); assert.ok(tools.includes('apply_patch'));
  assert.equal(tools.some(name => /memory/i.test(name)), false);
  await assert.rejects(f.connect('wrong-token'), error => (error as { code?: number }).code === 401);
  const extension = personalExtensions(f.config, { apiToken: TOKEN });
  assert.equal(extension.verifyAccessToken?.('wrong'), undefined);
  assert.equal((await extension.verifyAccessToken?.(TOKEN))?.clientId, 'personal-api-token');
  await extension.dispose?.();
});

test('failed optional CodeGraph cannot block core open/read/command tools', async t => {
  const f = await fixture(t, true); const client = await f.connect();
  const opened = await client.callTool({ name: 'open_workspace', arguments: { path: f.project } });
  const workspaceId = (opened.structuredContent as { workspaceId: string }).workspaceId;
  const graph = await client.callTool({ name: 'codegraph_explore', arguments: { workspaceId, query: 'functions' } });
  assert.equal(graph.isError, true);
  const result = await client.callTool({ name: 'exec_command', arguments: { workspaceId, cmd: 'echo CORE_STILL_AVAILABLE', waitTimeMs: 1000 } });
  assert.match(JSON.stringify(result), /CORE_STILL_AVAILABLE/); assert.notEqual(result.isError, true);
});

test('malformed optional CodeGraph configuration cannot prevent core startup', async t => {
  const f = await fixture(t, { command: '' }); const client = await f.connect();
  const opened = await client.callTool({ name: 'open_workspace', arguments: { path: f.project } });
  assert.notEqual(opened.isError, true);
  const graph = await client.callTool({ name: 'codegraph_explore', arguments: { workspaceId: (opened.structuredContent as { workspaceId: string }).workspaceId, query: 'fixture' } });
  assert.equal(graph.isError, true); assert.match(JSON.stringify(graph), /CodeGraph is unavailable/);
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'exec_command'));
});

test('wait alias is deterministic; conflicting aliases never execute a command', async t => {
  const f = await fixture(t); const client = await f.connect();
  const opened = await client.callTool({ name: 'open_workspace', arguments: { path: f.project } });
  const workspaceId = (opened.structuredContent as { workspaceId: string }).workspaceId;
  for (const timing of [{ waitTimeMs: 1000 }, { yieldTimeMs: 1000 }, { waitTimeMs: 1000, yieldTimeMs: 1000 }]) {
    const result = await client.callTool({ name: 'exec_command', arguments: { workspaceId, cmd: 'echo WAIT_OK', ...timing } });
    assert.notEqual(result.isError, true); assert.match(JSON.stringify(result), /WAIT_OK/);
  }
  const rejected = await client.callTool({ name: 'exec_command', arguments: { workspaceId, cmd: 'echo forbidden>must-not-exist.txt', waitTimeMs: 0, yieldTimeMs: 1000 } });
  assert.equal(rejected.isError, true); await assert.rejects(access(join(f.project, 'must-not-exist.txt')));
});

test('native shell redirection works without a private command-rewriting parser', async t => {
  const f = await fixture(t); const client = await f.connect();
  const opened = await client.callTool({ name: 'open_workspace', arguments: { path: f.project } });
  const workspaceId = (opened.structuredContent as { workspaceId: string }).workspaceId;
  const command = process.platform === 'win32' ? 'echo HIDDEN>NUL && echo VISIBLE' : 'echo HIDDEN>/dev/null && echo VISIBLE';
  const result = await client.callTool({ name: 'exec_command', arguments: { workspaceId, cmd: command, waitTimeMs: 1000 } });
  assert.match(JSON.stringify(result.structuredContent), /VISIBLE/); assert.doesNotMatch(JSON.stringify(result.structuredContent), /HIDDEN/);
});

test('home-relative skill reads are constrained to registered/activated skills', async t => {
  const f = await fixture(t); const registry = new WorkspaceRegistry(f.config);
  const { workspace } = await registry.openWorkspace(f.project);
  const baseDir = join(homedir(), '.agents/skills/__personal_regression__');
  workspace.skills.push({ name: '__personal_regression__', description: 'fixture', filePath: join(baseDir, 'SKILL.md'), baseDir, source: 'user' } as never);
  assert.equal(registry.resolveReadPath(workspace, '~/.agents/skills/__personal_regression__/SKILL.md').absolutePath, join(baseDir, 'SKILL.md'));
  assert.throws(() => registry.resolveReadPath(workspace, '~/unregistered-private-file.txt'));
  assert.throws(() => registry.resolveReadPath(workspace, '~/.agents/skills/__personal_regression__/../../private.txt'));
});

test('response replay is globally bounded, ordered, expiring and session/stream isolated', async () => {
  let now = 0; const pool = new ReplayPool({ bytes: 4096, events: 4, ttlMs: 100 }, () => now);
  const a = pool.createStore(), b = pool.createStore();
  const message = (n: number) => ({ jsonrpc: '2.0' as const, id: n, result: { n } });
  const cursor = await a.storeEvent('one', message(1)); await a.storeEvent('two', message(2)); await a.storeEvent('one', message(3));
  const received: unknown[] = []; await a.replayEventsAfter(cursor, { send: async (_id, value) => { received.push(value); } });
  assert.deepEqual(received, [message(3)]); assert.equal(await b.getStreamIdForEventId?.(cursor), undefined);
  await assert.rejects(b.replayEventsAfter(cursor, { send: async () => {} }), /another MCP session/);
  for (let n = 4; n < 20; n++) await b.storeEvent('one', message(n));
  assert.ok(pool.size.events <= 4); assert.ok(pool.size.bytes <= 4096);
  await assert.rejects(a.replayEventsAfter(cursor, { send: async () => {} }), /expired/);
  now = 101; assert.deepEqual(pool.size, { bytes: 0, events: 0 });
  a.close(); b.close(); pool.close();
});

function dropFirstEvent(response: Response) {
  const reader = response.body!.getReader(); const decoder = new TextDecoder(); let text = '';
  return new Response(new ReadableStream({
    async pull(controller) {
      const value = await reader.read(); if (value.done) { controller.close(); return; }
      text += decoder.decode(value.value, { stream: true }); const end = text.indexOf('\n\n');
      if (end < 0) return;
      assert.match(text.slice(0, end), /id:/, 'SDK must prime a resumable cursor');
      controller.enqueue(new TextEncoder().encode(text.slice(0, end + 2)));
      await reader.cancel(); controller.error(new Error('Injected transport loss after priming'));
    }, async cancel() { await reader.cancel(); },
  }), { status: response.status, headers: response.headers });
}

test('SDK resumes fast and delayed responses without repeating side effects', { timeout: 20000 }, async t => {
  const f = await fixture(t); let drop = false; let reconnects = 0;
  const injected: typeof fetch = async (input, init) => {
    if (init?.method === 'GET' && new Headers(init.headers).has('last-event-id')) reconnects++;
    const response = await fetch(input, init);
    if (drop && init?.method === 'POST' && response.headers.get('content-type')?.includes('text/event-stream')) { drop = false; return dropFirstEvent(response); }
    return response;
  };
  const client = await f.connect(TOKEN, injected);
  const opened = await client.callTool({ name: 'open_workspace', arguments: { path: f.project } });
  const workspaceId = (opened.structuredContent as { workspaceId: string }).workspaceId;
  for (const delay of [0, 200]) {
    const script = join(f.project, `effect-${delay}.cjs`);
    await writeFile(script, `require('fs').appendFileSync(__filename+'.count','x');setTimeout(()=>console.log('SIDE_EFFECT_DONE_${delay}'),${delay});`);
    drop = true;
    const result = await client.callTool({ name: 'exec_command', arguments: { workspaceId, cmd: `"${process.execPath}" "${script}"`, waitTimeMs: 1000 } }, undefined, { timeout: 7000 });
    assert.match(JSON.stringify(result), new RegExp(`SIDE_EFFECT_DONE_${delay}`));
    assert.equal(await readFile(`${script}.count`, 'utf8'), 'x');
  }
  assert.ok(reconnects >= 2);
});

test('oversize event invalidates its stream cursor instead of replaying across a gap', async () => {
  const pool = new ReplayPool({ bytes: 1024, events: 10, ttlMs: 1000 });
  const store = pool.createStore();
  const cursor = await store.storeEvent('stream', { jsonrpc: '2.0', id: 1, result: {} });
  await store.storeEvent('stream', { jsonrpc: '2.0', id: 2, result: { text: 'x'.repeat(2000) } });
  assert.equal(await store.getStreamIdForEventId?.(cursor), undefined);
  await assert.rejects(store.replayEventsAfter(cursor, { send: async () => assert.fail('Partial replay') }), /expired/);
  pool.close();
});

test('CodeGraph isolates configuration and initializes once for concurrent callers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'personal-codegraph-')); t.after(() => rm(root, { recursive: true, force: true }));
  const graph = new PersonalCodeGraph({ enabled: true, command: process.execPath, args: [resolve('personal/tests/codegraph-fixture.mjs'), 'serve', '--mcp'], toolTimeoutMs: 5000, startupTimeoutMs: 5000 });
  t.after(() => graph.close());
  const results = await Promise.all([graph.explore(root, 'alpha'), graph.explore(root, 'beta')]);
  assert.equal(await readFile(join(root, '.codegraph/init-count'), 'utf8'), 'x');
  for (const result of results) { assert.equal(result.isError, false); assert.match(result.structuredContent.result, /fixture/); }
});
