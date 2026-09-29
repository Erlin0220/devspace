import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { createDesktopController } from '../desktop/controller.mjs';
import { startLocalControl, bindPort } from '../desktop/local-control.mjs';
import { atomicJson } from '../state.mjs';
import { bindPersonalSourceRoot, runtimeEnvironment, readPersonalConfig } from '../config.mjs';
import { operations } from '../desktop/main.mjs';
import { discoverCodexCommand, taskXml, ownerId } from '../desktop/platform.mjs';
import { runtimeSnapshot, waitForRuntime } from '../runtime.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const exec = promisify(execFile);
test('runtime health separates endpoint response from owned readiness and never follows redirects', async t => {
  const home = join(tmpdir(), 'personal-health-fixture');
  let status = 200;
  let body = JSON.stringify({ name: 'personal-devspace', owner: ownerId(home), runningProcesses: 2 });
  const server = createServer((_request, response) => {
    response.writeHead(status, status === 302 ? { Location: 'http://127.0.0.1:1/other' } : {});
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const known = { personal: {}, config: { port: server.address().port } };
  const ready = await runtimeSnapshot(home, known);
  assert.equal(ready.responding, true); assert.equal(ready.running, true); assert.equal(ready.runningProcesses, 2);
  for (const [code, content] of [[500, 'failure'], [503, body], [200, 'not JSON'], [200, 'null'],
    [200, JSON.stringify({ name: 'personal-devspace', owner: 'another-install' })], [302, 'redirect']]) {
    status = code; body = content;
    const snapshot = await runtimeSnapshot(home, known);
    assert.equal(snapshot.responding, true, `HTTP ${code} must not prove a stopped endpoint`);
    assert.equal(snapshot.running, false); assert.equal(snapshot.owned, false);
    assert.equal(snapshot.runningProcesses, 0);
    await assert.rejects(waitForRuntime(home, value => !value.responding, {
      known, attempts: 1, intervalMs: 0, errorMessage: 'Endpoint is still responding',
    }), /still responding/);
  }
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  const stopped = await runtimeSnapshot(home, known);
  assert.equal(stopped.responding, false); assert.equal(stopped.running, false);
});

test('observer failures and failed status projections cannot reverse a successful operation', async () => {
  let stopped = false;
  const controller = createDesktopController({ status: async () => { throw new Error('status unavailable'); }, suspend: async () => { stopped = true; } }, { noticeTtl: 10 });
  controller.subscribe(() => { throw new Error('broken tray'); }); controller.subscribe(async () => { throw new Error('broken async observer'); });
  await controller.dispatch('suspend'); assert.equal(stopped, true); assert.match(controller.snapshot().alert, /操作已完成/);
  await controller.dispose();
});
test('mutations serialize, exit waits for the mutation, and stale refresh cannot overwrite it', async () => {
  const operation = deferred(); let exited = false;
  const controller = createDesktopController({ status: async () => ({ running: false, paused: true }),
    suspend: () => operation.promise, resume: async () => {}, exit: async () => { exited = true; } });
  const pending = controller.dispatch('suspend'); await tick(); assert.equal(controller.snapshot().busy, true);
  await assert.rejects(controller.dispatch('resume'), /已有操作/);
  const exiting = controller.dispatch('exit'); await tick(); assert.equal(exited, false);
  operation.resolve(); await pending; await exiting; assert.equal(exited, true); await controller.dispose();
});
test('transient notices expire rather than becoming permanent error-looking banners', async () => {
  const controller = createDesktopController({ status: async () => ({ running: true }), restart: async () => {} }, { noticeTtl: 10 });
  await controller.dispatch('restart'); assert.equal(controller.snapshot().notice, '操作已完成');
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(controller.snapshot().notice, undefined); await controller.dispose();
});
test('upstream settings remain separate and pause corruption fails closed', async t => {
  const home = await mkdtemp(join(tmpdir(), 'personal-config-')); t.after(() => rm(home, { recursive: true, force: true }));
  const config = { runtimeConfigDir: home, projectRoot: home, runtimeEnv: { DEVSPACE_SUBAGENTS: 'retired-snapshot' } };
  const runtime = runtimeEnvironment(config, { DEVSPACE_SUBAGENTS: 'true', DEVSPACE_TOOL_MODE: 'other', DEVSPACE_WIDGETS: 'changes',
    DEVSPACE_CONFIG_DIR: 'wrong', DEVSPACE_ALLOWED_ROOTS: 'wrong' });
  assert.equal(runtime.DEVSPACE_SUBAGENTS, 'true'); assert.equal(runtime.DEVSPACE_CONFIG_DIR, home);
  assert.equal(runtime.DEVSPACE_TOOL_MODE, 'codex'); assert.equal(runtime.DEVSPACE_WIDGETS, 'off'); assert.equal(runtime.DEVSPACE_ALLOWED_ROOTS, home);
  await atomicJson(join(home, 'intent.json'), { paused: 'invalid' }); await assert.rejects(readPersonalConfig(home), /pause intent/);
});
test('Personal sourceRoot binding is explicit and update prepare fails clearly when it is absent', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'personal-source-root-'));
  const home = join(fixture, 'home'), source = join(fixture, 'source');
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(source, 'personal'), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@waishnav/devspace' }));
  await writeFile(join(source, 'personal', 'upstream.json'), '{}');
  await exec('git', ['init', '--quiet'], { cwd: source, windowsHide: true });
  await atomicJson(join(home, 'personal.json'), { schema: 1, projectRoot: home, futureSetting: 'preserve' });
  await atomicJson(join(home, 'intent.json'), { paused: false });
  await assert.rejects(
    operations(home)['update-prepare']({ onProgress: () => {} }),
    /未配置 Personal 源码目录/,
  );
  assert.equal(await bindPersonalSourceRoot(home, source), source);
  const stored = JSON.parse(await readFile(join(home, 'personal.json'), 'utf8'));
  assert.equal(stored.sourceRoot, source);
  assert.equal(stored.futureSetting, 'preserve');
  assert.equal((await operations(home).status()).sourceRoot, source);
  await assert.rejects(bindPersonalSourceRoot(home, home), /Personal DevSpace Git checkout/);
});
test('native task identity is independent of API tokens and uses current-user GUI launcher ownership', () => {
  const home = join(tmpdir(), 'personal-example'); const text = taskXml({ home, root: 'C:\\example', node: 'C:\\node.exe', component: 'runtime', sid: 'S-1-5-21-123-456-789-1001', codexCommand: 'C:\\tools\\codex.cmd' });
  assert.ok(text.includes(`PersonalDevSpace:${ownerId(home)}:runtime`)); assert.match(text, /HighestAvailable/); assert.match(text, /InteractiveToken/);
  assert.match(text, /personal-launcher\.exe/); assert.doesNotMatch(text, /TeamDevSpace|TDS|apiToken|ownerToken/);
  assert.match(text, /DEVSPACE_API_TOKEN=/, 'managed profiles clear inherited API credentials and use their own private file');
  assert.match(text, /CODEX_COMMAND=C:\\tools\\codex\.cmd/, 'runtime task pins the discovered Codex CLI path');
  const desktop = taskXml({ home, root: 'C:\\example', node: 'C:\\node.exe', component: 'desktop', sid: 'S-1-5-21-123-456-789-1001', codexCommand: 'C:\\tools\\codex.cmd' });
  assert.doesNotMatch(desktop, /CODEX_COMMAND=/, 'desktop task does not inherit provider-specific runtime settings');
});
test('managed runtime discovers an absolute Codex command without hardcoding machine paths', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-codex-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const command = join(directory, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await writeFile(command, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
  if (process.platform !== 'win32') await chmod(command, 0o700);
  const fakeNode = join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
  const resolved = await discoverCodexCommand({ PATH: join(directory, 'missing') }, process.platform, fakeNode);
  assert.equal(resolved, command);
  assert.equal(await discoverCodexCommand({ PATH: [directory, join(directory, 'missing')].join(delimiter) }, process.platform, join(directory, 'elsewhere', 'node')), command);
  assert.equal(await discoverCodexCommand({ PATH: join(directory, 'missing') }, process.platform, join(directory, 'elsewhere', 'node')), undefined);
});
test('Control Center uses the Personal logo and keeps manual status checks out of transient banners', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('../desktop/control.html', import.meta.url), 'utf8'),
    readFile(new URL('../desktop/control.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /personal-devspace-logo\.png/); assert.match(html, /id="check-status"/);
  assert.doesNotMatch(html, /launch-qoder/);
  assert.match(script, /if \(name !== 'check'\) feedback\('正在处理…'\)/);
  assert.match(script, /requestAction === 'check'/);
});

async function webFixture(t, { collide = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'personal-control-'));
  const blocker = createServer((_req, res) => res.end('other application'));
  let port;
  for (let attempt = 0; attempt < 16 && !port; attempt++) {
    await bindPort(blocker, 0);
    const candidate = blocker.address().port;
    if (candidate >= 49152 && candidate <= 65535) port = candidate;
    else await new Promise(resolve => blocker.close(resolve));
  }
  if (!port) throw new Error('OS did not allocate a valid Personal control port');
  if (!collide) await new Promise(resolve => blocker.close(resolve));
  const events = [];
  const controller = { snapshot: () => ({ status: 'ready', running: true }), dispatch: async (action, value) => { events.push([action, value]); return action === 'choose-folder' ? 'C:\\project' : { ok: true }; } };
  const web = await startLocalControl(controller, { home, preferredPort: port, retryAttempts: 1, retryDelayMs: 1 });
  const token = web.url.split('#')[1];
  t.after(async () => { await web.close(); if (collide) await new Promise(resolve => blocker.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const request = (path, options = {}) => fetch(`${web.origin}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
  return { home, port, web, token, request, events };
}
test('Control Center enforces capability, origin, host, content type and bounded inputs', async t => {
  const f = await webFixture(t);
  assert.equal((await fetch(`${f.web.origin}/api/state`)).status, 401);
  assert.equal((await f.request('/api/state', { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = httpRequest(`${f.web.origin}/api/state`, { headers: { Host: 'attacker.invalid', Authorization: `Bearer ${f.token}` } }, response => { response.resume(); resolve(response.statusCode); });
    request.once('error', reject); request.end();
  });
  assert.equal(wrongHost, 403);
  const page = await f.request('/'); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await page.text()).includes(f.token), false);
  const logo = await fetch(`${f.web.origin}/personal-devspace-logo.png`); assert.equal(logo.status, 200); assert.match(logo.headers.get('content-type'), /^image\/png/);
  const favicon = await fetch(`${f.web.origin}/favicon.ico`); assert.equal(favicon.status, 200); assert.match(favicon.headers.get('content-type'), /^image\/x-icon/);
  assert.equal((await f.request('/api/action', { method: 'POST', body: '{}' })).status, 403);
  const post = body => f.request('/api/action', { method: 'POST', headers: { Origin: f.web.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ action: 'check', unexpected: true })).status, 400);
  assert.equal((await post({ action: 'project-root', projectRoot: 'x'.repeat(9000) })).status, 413);
  assert.equal((await post({ action: 'source-root', sourceRoot: 'x'.repeat(9000) })).status, 413);
  assert.equal((await post({ action: 'check' })).status, 200); assert.equal(f.events.length, 1);
  assert.equal((await post({ action: 'launch-qoder' })).status, 400);
});
test('busy preferred port falls back and preserves the other application', async t => {
  const f = await webFixture(t, { collide: true }); assert.notEqual(f.web.port, f.port);
  assert.equal(await (await fetch(`http://127.0.0.1:${f.port}`)).text(), 'other application');
  assert.equal((await f.request('/api/state')).status, 200);
  const credential = JSON.parse(await readFile(join(f.home, 'control-capability.json'), 'utf8')); assert.equal(credential.port, f.web.port);
});
test('control capability is the single durable endpoint owner', async t => {
  const f = await webFixture(t);
  const credential = JSON.parse(await readFile(join(f.home, 'control-capability.json'), 'utf8'));
  assert.equal(credential.port, f.web.port);
  await assert.rejects(access(join(f.home, 'control-endpoint.json')));
  assert.equal((await f.request('/api/state')).status, 200);
});
test('corrupted mandatory control credentials fail closed without invoking core operations', async t => {
  const home = await mkdtemp(join(tmpdir(), 'personal-corrupt-')); t.after(() => rm(home, { recursive: true, force: true }));
  await atomicJson(join(home, 'control-capability.json'), { schema: 1, token: 'bad' }); let called = false;
  await assert.rejects(startLocalControl({ dispatch: () => { called = true; }, snapshot: () => ({}) }, { home }), /凭据无效/); assert.equal(called, false);
});
