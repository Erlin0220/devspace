import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { randomInt } from 'node:crypto';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopController } from '../desktop/controller.mjs';
import { startLocalControl, bindPort } from '../desktop/local-control.mjs';
import { atomicJson } from '../state.mjs';
import { runtimeEnvironment, readPersonalConfig } from '../config.mjs';
import { taskXml, ownerId } from '../desktop/platform.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
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
  const config = { runtimeConfigDir: home, projectRoot: home, runtimeEnv: { DEVSPACE_SUBAGENTS: 'true' } };
  assert.equal(runtimeEnvironment(config, {}).DEVSPACE_SUBAGENTS, 'true'); assert.equal(runtimeEnvironment(config, {}).DEVSPACE_CONFIG_DIR, home);
  await atomicJson(join(home, 'intent.json'), { paused: 'invalid' }); await assert.rejects(readPersonalConfig(home), /pause intent/);
});
test('native task identity is independent of API tokens and uses current-user GUI launcher ownership', () => {
  const home = join(tmpdir(), 'personal-example'); const text = taskXml({ home, root: 'C:\\example', node: 'C:\\node.exe', component: 'runtime', sid: 'S-1-5-21-123-456-789-1001' });
  assert.ok(text.includes(`PersonalDevSpace:${ownerId(home)}:runtime`)); assert.match(text, /LeastPrivilege/); assert.match(text, /InteractiveToken/);
  assert.match(text, /personal-launcher\.exe/); assert.doesNotMatch(text, /TeamDevSpace|TDS|apiToken|ownerToken/);
  assert.match(text, /DEVSPACE_API_TOKEN=/, 'managed profiles clear inherited API credentials and use their own private file');
});
test('Control Center uses the Personal logo and keeps manual status checks out of transient banners', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('../desktop/control.html', import.meta.url), 'utf8'),
    readFile(new URL('../desktop/control.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /personal-devspace-logo\.png/); assert.match(html, /id="check-status"/);
  assert.match(script, /if \(name !== 'check'\) feedback\('正在处理…'\)/);
  assert.match(script, /requestAction === 'check'/);
});

async function webFixture(t, { collide = false, cacheFailure = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'personal-control-')); const port = randomInt(50000, 65000);
  let blocker;
  if (collide) { blocker = createServer((_req, res) => res.end('other application')); await bindPort(blocker, port); }
  if (cacheFailure) await mkdir(join(home, 'control-endpoint.json'));
  const events = [];
  const controller = { snapshot: () => ({ status: 'ready', running: true }), dispatch: async (action, value) => { events.push([action, value]); return action === 'choose-folder' ? 'C:\\project' : { ok: true }; } };
  const web = await startLocalControl(controller, { home, preferredPort: port, retryAttempts: 1, retryDelayMs: 1 });
  const token = web.url.split('#')[1];
  t.after(async () => { await web.close(); if (blocker) await new Promise(resolve => blocker.close(resolve)); await rm(home, { recursive: true, force: true }); });
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
  assert.equal((await post({ action: 'check' })).status, 200); assert.equal(f.events.length, 1);
});
test('busy preferred port falls back and preserves the other application', async t => {
  const f = await webFixture(t, { collide: true }); assert.notEqual(f.web.port, f.port);
  assert.equal(await (await fetch(`http://127.0.0.1:${f.port}`)).text(), 'other application');
  assert.equal((await f.request('/api/state')).status, 200);
  const credential = JSON.parse(await readFile(join(f.home, 'control-capability.json'), 'utf8')); assert.equal(credential.port, f.web.port);
});
test('unwritable endpoint cache cannot take down the Control Center', async t => {
  const f = await webFixture(t, { cacheFailure: true }); assert.equal(f.web.endpointPersisted, false); assert.equal((await f.request('/api/state')).status, 200);
});
test('corrupted mandatory control credentials fail closed without invoking core operations', async t => {
  const home = await mkdtemp(join(tmpdir(), 'personal-corrupt-')); t.after(() => rm(home, { recursive: true, force: true }));
  await atomicJson(join(home, 'control-capability.json'), { schema: 1, token: 'bad' }); let called = false;
  await assert.rejects(startLocalControl({ dispatch: () => { called = true; }, snapshot: () => ({}) }, { home }), /凭据无效/); assert.equal(called, false);
});
