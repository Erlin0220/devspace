// Explicit native acceptance harness. Only an owned fixture home/tasks are touched.
// It never sends a message to a paid model or starts a persistent process under MCP.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { atomicJson, readJson, secureStateDirectory } from '../state.mjs';
import { registerJobs, jobAction } from '../desktop/platform.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const home = join(root, '.personal-review/live-home');
const API_TOKEN = 'personal-native-acceptance-fixture-token-not-real';
const action = process.argv[2] ?? 'verify';
process.env.PERSONAL_DEVSPACE_HOME = home;
const marker = () => readJson(join(home, 'fixture.json'));
async function unusedPort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
try {
  if (action === 'prepare') {
    await secureStateDirectory(home);
    const existing = await readJson(join(home, 'fixture.json'), null);
    if (existing && existing.owner !== 'personal-native-acceptance') throw new Error('Unknown fixture owner');
    if (existing) for (const component of ['runtime', 'desktop']) await jobAction(home, component, 'stop');
    const port = existing?.port ?? await unusedPort();
    const project = join(home, 'project'); await mkdir(project, { recursive: true });
    await writeFile(join(project, 'sample.js'), 'export function personalAcceptance(value) { return value + 1; }\n');
    await atomicJson(join(home, 'fixture.json'), { owner: 'personal-native-acceptance', port });
    await atomicJson(join(home, 'upstream/config.json'), { host: '127.0.0.1', port, publicBaseUrl: `http://127.0.0.1:${port}`, allowedRoots: [project],
      stateDir: join(home, 'state'), worktreeRoot: join(home, 'worktrees'), subagents: false });
    await atomicJson(join(home, 'upstream/auth.json'), { ownerToken: 'native-fixture-upstream-owner-not-real' });
    await atomicJson(join(home, 'auth.json'), { apiToken: API_TOKEN });
    await atomicJson(join(home, 'personal.json'), { schema: 1, runtimeConfigDir: join(home, 'upstream'), projectRoot: project,
      sourceRoot: root, codegraph: { enabled: true } });
    await atomicJson(join(home, 'intent.json'), { paused: false });
    // Synthetic credential for this explicitly owned, temporary acceptance instance.
    // Never use this fixture's home, keys or scheduled tasks as a real installation.
    await atomicJson(join(home, 'control-capability.json'), { schema: 1, token: 'PersonalDevSpaceFixtureCapabilityForTests01' });
    await registerJobs(home, root, ['runtime', 'desktop'], { record: false });
    await atomicJson(join(home, 'install.json'), { schema: 1, owner: 'personal-devspace', packageRoot: root });
    await jobAction(home, 'runtime', 'start'); await jobAction(home, 'desktop', 'start');
    for (let i = 0; i < 100; i++) {
      const ready = await readJson(join(home, 'control-capability.json'), null);
      if (ready?.port) { const response = await fetch(`http://127.0.0.1:${ready.port}/api/state`, { headers: { Authorization: `Bearer ${ready.token}` }, signal: AbortSignal.timeout(1000) }).catch(() => null);
        const runtimeReady = await fetch(`http://127.0.0.1:${port}/personal-healthz`, { signal: AbortSignal.timeout(1000) }).then(response => response.ok, () => false);
        if (response?.ok && runtimeReady) {
          console.log(JSON.stringify({ home, runtimePort: port, controlOrigin: `http://127.0.0.1:${ready.port}` })); break;
        } }
      if (i === 99) throw new Error('Control Center did not start'); await sleep(200);
    }
  } else {
    const fixture = await marker(); assert.equal(fixture.owner, 'personal-native-acceptance');
    if (action === 'stop') {
      for (const component of ['runtime', 'desktop']) await jobAction(home, component, 'remove');
      console.log('Fixture tasks removed; evidence retained in .personal-review/live-home');
    } else if (action === 'lifecycle') {
      const capability = await readJson(join(home, 'control-capability.json'));
      const origin = `http://127.0.0.1:${capability.port}`;
      const headers = { Authorization: `Bearer ${capability.token}`, Origin: origin, 'Content-Type': 'application/json' };
      const perform = async action => {
        const response = await fetch(`${origin}/api/action`, { method: 'POST', headers, body: JSON.stringify({ action }), signal: AbortSignal.timeout(60000) });
        const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
      };
      const state = async () => (await fetch(`${origin}/api/state`, { headers })).json();
      if ((await state()).paused) await perform('resume');
      await perform('suspend'); const paused = await state(); assert.equal(paused.paused, true); assert.equal(paused.running, false);
      await perform('restart'); const retained = await state(); assert.equal(retained.paused, true); assert.equal(retained.running, false);
      await perform('resume'); const resumed = await state(); assert.equal(resumed.running, true); assert.equal(resumed.paused, false);
      const evidence = { pause: true, restartPreservesPause: true, resume: true, controllerSurvivesRuntimeStop: true, checkedAt: new Date().toISOString() };
      await atomicJson(join(home, 'lifecycle.json'), evidence); console.log(JSON.stringify(evidence));
    } else {
      const client = new Client({ name: 'personal-native-acceptance', version: '1' });
      const endpoint = new URL(`http://127.0.0.1:${fixture.port}/mcp`);
      await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${API_TOKEN}` } } }));
      try {
        const tools = (await client.listTools()).tools.map(tool => tool.name);
        assert.equal(tools.some(name => /memory/i.test(name)), false);
        const project = join(home, 'project');
        const opened = await client.callTool({ name: 'open_workspace', arguments: { path: project } });
        const workspaceId = opened.structuredContent.workspaceId;
        const command = await client.callTool({ name: 'exec_command', arguments: { workspaceId, cmd: 'echo NATIVE_RUNTIME_VERIFIED', waitTimeMs: 1000 } });
        assert.match(JSON.stringify(command), /NATIVE_RUNTIME_VERIFIED/);
        const patch = await client.callTool({ name: 'apply_patch', arguments: { workspaceId, patch: '*** Begin Patch\n*** Add File: native-proof.txt\n+NATIVE_PATCH_VERIFIED\n*** End Patch' } });
        assert.notEqual(patch.isError, true); assert.match(await readFile(join(project, 'native-proof.txt'), 'utf8'), /NATIVE_PATCH_VERIFIED/);
        const graph = await client.callTool({ name: 'codegraph_explore', arguments: { workspaceId, query: 'personalAcceptance function', maxFiles: 2 } }, undefined, { timeout: 90000 });
        assert.notEqual(graph.isError, true, JSON.stringify(graph));
        const desktop = await readJson(join(home, 'desktop-status.json'));
        assert.equal(desktop.control, true); assert.equal(desktop.tray, true);
        const trayLog = await readFile(join(home, 'logs/desktop.log'), 'utf8'); assert.match(trayLog, /Personal tray visible/);
        const evidence = { runtime: true, tools, command: true, patch: true, realCodeGraph: true, trayVisibleHandshake: true, control: true, checkedAt: new Date().toISOString() };
        await atomicJson(join(home, 'acceptance.json'), evidence); console.log(JSON.stringify(evidence, null, 2));
      } finally { await client.close(); }
    }
  }
} catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
