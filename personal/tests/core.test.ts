import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Result } from 'better-result';
import { loadConfig } from '../../src/config.js';
import { createServer, type CreateServerOptions } from '../../src/server.js';
import { personalExtensions } from '../../src/personal/index.js';
import { ReplayPool } from '../../src/personal/replay.js';
import { PersonalCodeGraph, type CodeGraphOptions } from '../../src/personal/codegraph.js';
import { PersonalSubagents } from '../../src/personal/subagents.js';
import { AgentDaemonStartupError, AgentDaemonUnavailableError } from '../../src/local-agent-errors.js';
import { WorkspaceRegistry } from '../../src/workspaces.js';

const TOKEN = 'test-only-personal-token-not-a-real-secret';
const execFileAsync = promisify(execFile);
async function fixture(t: TestContext, codegraph: boolean | CodeGraphOptions = false,
  mcpSessionRetention?: CreateServerOptions['mcpSessionRetention']) {
  const root = await mkdtemp(join(tmpdir(), 'personal-core-'));
  const project = join(root, 'project'); await mkdir(project);
  const config = loadConfig({ DEVSPACE_CONFIG_DIR: join(root, 'config'), DEVSPACE_ALLOWED_ROOTS: project,
    DEVSPACE_STATE_DIR: join(root, 'state'), DEVSPACE_WORKTREE_ROOT: join(root, 'worktrees'), DEVSPACE_AGENT_DIR: join(root, 'agents'),
    DEVSPACE_OAUTH_OWNER_TOKEN: 'separate-test-only-oauth-owner-token', DEVSPACE_TOOL_MODE: 'codex', DEVSPACE_WIDGETS: 'off',
    DEVSPACE_SUBAGENTS: 'false', DEVSPACE_LOG_LEVEL: 'error', HOST: '127.0.0.1', PORT: '1', DEVSPACE_PUBLIC_BASE_URL: 'http://127.0.0.1:1' });
  const personalOptions = personalExtensions(config, { apiToken: TOKEN, codegraph: { enabled: Boolean(codegraph), command: join(root, 'missing-codegraph'), args: ['serve', '--mcp'], toolTimeoutMs: 500, startupTimeoutMs: 500, ...(typeof codegraph === 'object' ? codegraph : {}) } });
  const running = createServer(config, { ...personalOptions, ...(mcpSessionRetention ? { mcpSessionRetention } : {}) });
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
  return { root, project, config, endpoint, connect, personalOptions };
}

test('Personal bounds abandoned MCP session retention without changing upstream defaults', async t => {
  const f = await fixture(t, false, { idleTimeoutMs: 20, cleanupIntervalMs: 10 });
  assert.deepEqual(f.personalOptions.mcpSessionRetention, { idleTimeoutMs: 60 * 60_000, cleanupIntervalMs: 5 * 60_000 });
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const init = await fetch(f.endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'retention-regression', version: '1' } } }) });
  assert.equal(init.status, 200);
  const sessionId = init.headers.get('mcp-session-id');
  assert.ok(sessionId);
  await init.text();
  await new Promise(resolve => setTimeout(resolve, 150));
  const stale = await fetch(f.endpoint, { method: 'POST', headers: { ...headers, 'mcp-session-id': sessionId,
    'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) });
  assert.equal(stale.status, 404);
});

test('API token stays separate from OAuth; invalid credentials are rejected', async t => {
  const f = await fixture(t); const client = await f.connect();
  const listedTools = (await client.listTools()).tools;
  const tools = listedTools.map(tool => tool.name);
  assert.ok(tools.includes('exec_command')); assert.ok(tools.includes('apply_patch'));
  assert.equal(tools.some(name => /memory/i.test(name)), false);
  const commandTool = listedTools.find(tool => tool.name === 'exec_command');
  assert.match(commandTool?.description ?? '', /follow the server command-recovery policy/i);
  assert.doesNotMatch(commandTool?.description ?? '', /at least three safe, distinct recovery attempts/i);
  const instructions = client.getInstructions() ?? '';
  const priorityPrefix = instructions.slice(0, 512);
  assert.match(priorityPrefix, /Use DevSpace whenever a software-development answer depends on the user's real local code/i);
  assert.match(priorityPrefix, /one safe diagnostic attempt/i);
  assert.match(priorityPrefix, /use run_agent for the same legitimate objective/i);
  assert.match(priorityPrefix, /Never use recovery to bypass policy/i);
  assert.ok(instructions.indexOf('destructive-action boundaries.') >= 0 && instructions.indexOf('destructive-action boundaries.') < 512);
  assert.doesNotMatch(instructions, /at least three safe, distinct recovery attempts/i);
  assert.match(instructions, /DEVSPACE_EXEC_PROBE_OK/);
  assert.match(instructions, /reuse it with get_agent\/continue_agent/i);
  assert.match(instructions, /normal non-zero exec_command result is a command failure/i);
  await assert.rejects(f.connect('wrong-token'), error => (error as { code?: number }).code === 401);
  const extension = personalExtensions(f.config, { apiToken: TOKEN });
  assert.equal(extension.verifyAccessToken?.('wrong'), undefined);
  assert.equal((await extension.verifyAccessToken?.(TOKEN))?.clientId, 'personal-api-token');
  await extension.dispose?.();
});

test('native subagent tools bridge the existing agent runtime without MCP App metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'personal-subagents-'));
  const project = join(root, 'project'); await mkdir(project);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const loaded = loadConfig({ DEVSPACE_CONFIG_DIR: join(root, 'config'), DEVSPACE_ALLOWED_ROOTS: project,
    DEVSPACE_STATE_DIR: join(root, 'state'), DEVSPACE_WORKTREE_ROOT: join(root, 'worktrees'), DEVSPACE_AGENT_DIR: join(root, 'agents'),
    DEVSPACE_OAUTH_OWNER_TOKEN: 'separate-test-only-oauth-owner-token', DEVSPACE_TOOL_MODE: 'codex', DEVSPACE_WIDGETS: 'off',
    DEVSPACE_SUBAGENTS: 'true', DEVSPACE_LOG_LEVEL: 'error', HOST: '127.0.0.1', PORT: '1', DEVSPACE_PUBLIC_BASE_URL: 'http://127.0.0.1:1' });
  const config = { ...loaded, subagents: { enabled: true, providers: [{ id: 'codex' as const, enabled: true, model: 'gpt-5.6-luna', effort: 'high' }] } };
  const workspaces = new WorkspaceRegistry(config);
  const workspace = (await workspaces.openWorkspace(project)).workspace;
  const baseRecord = { id: 'agt_test', workspaceId: workspace.id, workspaceRoot: project, profileName: 'codex-explorer',
    provider: 'codex', model: 'gpt-5.6-luna', effort: 'high', status: 'running' as const,
    createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z' };
  const calls: string[] = [];
  const subagents = new PersonalSubagents(config, {
    start: async input => { calls.push('start:' + input.target); return Result.ok(baseRecord); },
    get: async id => { calls.push('get:' + id); return Result.ok({ ...baseRecord, status: 'idle' as const, latestResponse: 'EXPLORER_OK' }); },
    continue: async id => { calls.push('continue:' + id); return Result.ok(baseRecord); },
    list: async () => { calls.push('list'); return Result.ok([{ ...baseRecord, status: 'idle' as const }]); },
  });
  const server = new McpServer({ name: 'subagent-test', version: '1' });
  subagents.register(server, workspaces);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'subagent-test-client', version: '1' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(async () => { await client.close(); await server.close(); });

  const tools = (await client.listTools()).tools;
  for (const name of ['run_agent', 'get_agent', 'continue_agent', 'list_agents']) {
    const tool = tools.find(entry => entry.name === name);
    assert.ok(tool, name + ' should be registered');
    assert.doesNotMatch(JSON.stringify(tool), /resourceUri|ui\/resource/i);
  }
  const runAgentTool = tools.find(tool => tool.name === 'run_agent');
  assert.match(runAgentTool?.description ?? '', /use get_agent to inspect it and continue_agent for another turn/i);
  assert.doesNotMatch(runAgentTool?.description ?? '', /exec_command objective remains blocked/i);
  assert.doesNotMatch(runAgentTool?.description ?? '', /reuse that same agent/i);
  assert.match(JSON.stringify(runAgentTool?.inputSchema ?? {}), /high-level objective/i);
  assert.match(JSON.stringify(runAgentTool?.inputSchema ?? {}), /do not include credentials/i);
  const run = await client.callTool({ name: 'run_agent', arguments: { workspaceId: workspace.id, target: 'codex-explorer', prompt: 'inspect' } });
  assert.deepEqual(run.structuredContent, { id: 'agt_test', status: 'running' });
  const get = await client.callTool({ name: 'get_agent', arguments: { workspaceId: workspace.id, agentId: 'agt_test' } });
  assert.equal((get.structuredContent as { status?: string }).status, 'completed');
  assert.equal((get.structuredContent as { response?: string }).response, 'EXPLORER_OK');
  const continued = await client.callTool({ name: 'continue_agent', arguments: { workspaceId: workspace.id, agentId: 'agt_test', prompt: 'follow up' } });
  assert.deepEqual(continued.structuredContent, { id: 'agt_test', status: 'running' });
  const listed = await client.callTool({ name: 'list_agents', arguments: { workspaceId: workspace.id } });
  assert.deepEqual(listed.structuredContent, { agents: [{ id: 'agt_test', status: 'completed', target: 'codex-explorer' }] });
  assert.deepEqual(calls, ['start:codex-explorer', 'get:agt_test', 'continue:agt_test', 'list']);
});

test('run_agent retries one cold daemon startup failure but no other failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'personal-subagent-retry-'));
  const project = join(root, 'project'); await mkdir(project);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const loaded = loadConfig({ DEVSPACE_CONFIG_DIR: join(root, 'config'), DEVSPACE_ALLOWED_ROOTS: project,
    DEVSPACE_STATE_DIR: join(root, 'state'), DEVSPACE_WORKTREE_ROOT: join(root, 'worktrees'), DEVSPACE_AGENT_DIR: join(root, 'agents'),
    DEVSPACE_OAUTH_OWNER_TOKEN: 'separate-test-only-oauth-owner-token', DEVSPACE_TOOL_MODE: 'codex', DEVSPACE_WIDGETS: 'off',
    DEVSPACE_SUBAGENTS: 'true', DEVSPACE_LOG_LEVEL: 'error', HOST: '127.0.0.1', PORT: '1', DEVSPACE_PUBLIC_BASE_URL: 'http://127.0.0.1:1' });
  const config = { ...loaded, subagents: { enabled: true, providers: [{ id: 'codex' as const, enabled: true }] } };
  const workspaces = new WorkspaceRegistry(config);
  const workspace = (await workspaces.openWorkspace(project)).workspace;
  const baseRecord = { id: 'agt_retry', workspaceId: workspace.id, workspaceRoot: project, profileName: 'codex',
    provider: 'codex', status: 'running' as const, createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z' };
  let starts = 0;
  const subagents = new PersonalSubagents(config, {
    start: async () => {
      starts++;
      return starts === 1
        ? Result.err(new AgentDaemonStartupError({ code: 'DAEMON_STARTUP_FAILURE', operation: 'startup', retryable: true, message: 'cold start' }))
        : Result.ok(baseRecord);
    },
    get: async () => Result.ok(baseRecord), continue: async () => Result.ok(baseRecord), list: async () => Result.ok([]),
  });
  const server = new McpServer({ name: 'subagent-retry-test', version: '1' });
  subagents.register(server, workspaces);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'subagent-retry-client', version: '1' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(async () => { await client.close(); await server.close(); });
  const retried = await client.callTool({ name: 'run_agent', arguments: { workspaceId: workspace.id, target: 'codex', prompt: 'inspect' } });
  assert.deepEqual(retried.structuredContent, { id: 'agt_retry', status: 'running' });
  assert.equal(starts, 2);

  let unavailableStarts = 0;
  const noRetrySubagents = new PersonalSubagents(config, {
    start: async () => { unavailableStarts++; return Result.err(new AgentDaemonUnavailableError({
      code: 'DAEMON_UNAVAILABLE', operation: 'agent.start', retryable: true, message: 'unavailable',
    })); },
    get: async () => Result.ok(baseRecord), continue: async () => Result.ok(baseRecord), list: async () => Result.ok([]),
  });
  const noRetryServer = new McpServer({ name: 'subagent-no-retry-test', version: '1' });
  noRetrySubagents.register(noRetryServer, workspaces);
  const [noRetryClientTransport, noRetryServerTransport] = InMemoryTransport.createLinkedPair();
  const noRetryClient = new Client({ name: 'subagent-no-retry-client', version: '1' });
  await Promise.all([noRetryClient.connect(noRetryClientTransport), noRetryServer.connect(noRetryServerTransport)]);
  t.after(async () => { await noRetryClient.close(); await noRetryServer.close(); });
  const failed = await noRetryClient.callTool({ name: 'run_agent', arguments: { workspaceId: workspace.id, target: 'codex', prompt: 'inspect' } });
  assert.equal(failed.isError, true);
  assert.equal(unavailableStarts, 1);
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

test('opening a workspace never waits for CodeGraph; first explore initializes once', async t => {
  const script = resolve('personal/tests/codegraph-fixture.mjs');
  const f = await fixture(t, { command: process.execPath, args: [script, 'serve', '--mcp'], initArgs: [script, 'init'], toolTimeoutMs: 5000, startupTimeoutMs: 5000 });
  const client = await f.connect();
  const first = await client.callTool({ name: 'open_workspace', arguments: { path: f.project } });
  assert.notEqual(first.isError, true);
  await assert.rejects(readFile(join(f.project, '.codegraph/init-count'), 'utf8'));
  const workspaceId = (first.structuredContent as { workspaceId: string }).workspaceId;
  const explored = await client.callTool({ name: 'codegraph_explore', arguments: { workspaceId, query: 'fixture' } });
  assert.notEqual(explored.isError, true);
  assert.equal(await readFile(join(f.project, '.codegraph/init-count'), 'utf8'), 'x');
  const second = await client.callTool({ name: 'open_workspace', arguments: { path: f.project } });
  assert.notEqual(second.isError, true);
  await client.callTool({ name: 'codegraph_explore', arguments: { workspaceId, query: 'fixture again' } });
  assert.equal(await readFile(join(f.project, '.codegraph/init-count'), 'utf8'), 'x');
});

test('checkout and managed worktree each get their own CodeGraph index', async t => {
  const script = resolve('personal/tests/codegraph-fixture.mjs');
  const f = await fixture(t, { command: process.execPath, args: [script, 'serve', '--mcp'], initArgs: [script, 'init'], toolTimeoutMs: 5000, startupTimeoutMs: 5000 });
  await execFileAsync('git', ['init'], { cwd: f.project });
  await writeFile(join(f.project, 'README.md'), 'fixture\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: f.project });
  await execFileAsync('git', ['-c', 'user.name=Personal Test', '-c', 'user.email=personal@example.invalid', 'commit', '-m', 'fixture'], { cwd: f.project });
  const client = await f.connect();
  const checkout = await client.callTool({ name: 'open_workspace', arguments: { path: f.project } });
  assert.notEqual(checkout.isError, true);
  const checkoutId = (checkout.structuredContent as { workspaceId: string }).workspaceId;
  await client.callTool({ name: 'codegraph_explore', arguments: { workspaceId: checkoutId, query: 'checkout' } });
  assert.equal(await readFile(join(f.project, '.codegraph/init-count'), 'utf8'), 'x');
  const worktree = await client.callTool({ name: 'open_workspace', arguments: { path: f.project, mode: 'worktree' } });
  assert.notEqual(worktree.isError, true);
  const worktreeContext = worktree.structuredContent as { root: string; workspaceId: string };
  const root = worktreeContext.root;
  assert.notEqual(root, f.project);
  await client.callTool({ name: 'codegraph_explore', arguments: { workspaceId: worktreeContext.workspaceId, query: 'worktree' } });
  assert.equal(await readFile(join(root, '.codegraph/init-count'), 'utf8'), 'x');
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
  const script = resolve('personal/tests/codegraph-fixture.mjs');
  const graph = new PersonalCodeGraph({ enabled: true, command: process.execPath, args: [script, 'serve', '--mcp'], initArgs: [script, 'init'], toolTimeoutMs: 5000, startupTimeoutMs: 5000 });
  t.after(() => graph.close());
  await Promise.all([graph.ensureInitialized(root), graph.ensureInitialized(root)]);
  assert.equal(await readFile(join(root, '.codegraph/init-count'), 'utf8'), 'x');
  const results = await Promise.all([graph.explore(root, 'alpha'), graph.explore(root, 'beta')]);
  for (const result of results) { assert.equal(result.isError, false); assert.match(result.structuredContent.result, /fixture/); }
});

test('CodeGraph releases its worker after the idle timeout and reconnects on demand', async t => {
  const root = await mkdtemp(join(tmpdir(), 'personal-codegraph-idle-')); t.after(() => rm(root, { recursive: true, force: true }));
  const script = resolve('personal/tests/codegraph-fixture.mjs');
  const graph = new PersonalCodeGraph({ enabled: true, command: process.execPath, args: [script, 'serve', '--mcp'], initArgs: [script, 'init'],
    toolTimeoutMs: 5000, startupTimeoutMs: 5000, idleTimeoutMs: 50 });
  t.after(() => graph.close());
  const first = await graph.explore(root, 'first');
  const firstPid = JSON.parse(first.structuredContent.result).pid;
  await new Promise(resolve => setTimeout(resolve, 150));
  const second = await graph.explore(root, 'second');
  const secondPid = JSON.parse(second.structuredContent.result).pid;
  assert.notEqual(firstPid, secondPid);
});
