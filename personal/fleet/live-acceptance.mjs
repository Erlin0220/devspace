// Read-only acceptance on the two real devices. Never stops a Runtime or tunnel;
// an operator controls the new network services between the explicit phases.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const { values: v } = parseArgs({ options: { phase: { type: 'string' }, state: { type: 'string' } } });
if (!['start', 'resume', 'offline', 'recovered'].includes(v.phase) || !v.state) throw Error('Supply --phase start|resume|offline|recovered and --state private-file');
const auth = JSON.parse(await readFile(join(homedir(), '.personal-fleet-network', 'client.json'), 'utf8'));
const client = new Client({ name: 'personal-fleet-live-acceptance', version: '0.1.0' }); client.onerror = () => {};
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(auth.endpoint), { requestInit: { headers: { Authorization: `Bearer ${auth.apiToken}` } } }));
  assert.equal((await client.listTools()).tools.length, 7);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const success = r => { assert.notEqual(r.isError, true, r.structuredContent?.error?.code ?? 'Device operation failed'); return r.structuredContent; };
  const devices = success(await call('list_devices')).devices;
  const byId = Object.fromEntries(devices.map(d => [d.id, d]));
  if (v.phase === 'offline') {
    assert.equal(byId.macmini.online, false); assert.equal(byId.lecoo.online, true);
    const state = JSON.parse(await readFile(v.state, 'utf8'));
    const offline = await call('read', { workspaceId: state.macmini.workspaceId, path: 'README.md' });
    assert.equal(offline.isError, true); assert.equal(offline.structuredContent.error.code, 'DEVICE_OFFLINE');
    const peer = success(await call('exec_command', { workspaceId: state.lecoo.workspaceId, cmd: 'node -p process.platform', waitTimeMs: 1000 }));
    assert.match(peer.result, /win32/);
    console.log('PASS: Mac tunnel offline; its workspace fails closed; Lecoo command succeeds');
  } else {
    assert.equal(byId.macmini.online, true); assert.equal(byId.lecoo.online, true);
    if (v.phase === 'start') {
      const unauthorized = await fetch(auth.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(unauthorized.status, 401); await unauthorized.body?.cancel();
      const paths = { macmini: '/Volumes/KIOXIA-500G/project/devspace', lecoo: 'C:\\project\\devspace' };
      const state = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([deviceId, path]) => {
        const opened = success(await call('open_workspace', { deviceId, path })); assert.equal(opened.deviceId, deviceId);
        const process = success(await call('exec_command', { workspaceId: opened.workspaceId, cmd: 'node -e "setTimeout(()=>console.log(\'FLEET_\'+process.platform),1200)"', waitTimeMs: 1 }));
        assert.match(process.sessionId, /^fp_/);
        return [deviceId, { workspaceId: opened.workspaceId, sessionId: process.sessionId }];
      })));
      assert.notEqual(state.macmini.sessionId, state.lecoo.sessionId);
      await writeFile(v.state, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.log('PASS: public auth, two native devices, concurrent commands; opaque routes saved for restart/reconnect check');
    } else {
      const state = JSON.parse(await readFile(v.state, 'utf8'));
      for (const [id, handles] of Object.entries(state)) {
        if (v.phase === 'resume') {
          let output = '', running = true;
          for (let i = 0; i < 20 && running; i++) {
            const r = success(await call('write_stdin', { ...handles, waitTimeMs: 1000 })); output += r.result; running = r.running === true;
          }
          assert.equal(running, false); assert.match(output, new RegExp(id === 'macmini' ? 'FLEET_darwin' : 'FLEET_win32'));
        }
        success(await call('read', { workspaceId: handles.workspaceId, path: 'README.md' }));
      }
      console.log(v.phase === 'resume' ? 'PASS: host reconnect and Gateway redeploy retain both device process routes and outputs' : 'PASS: both devices recovered; original workspace routes still work');
    }
  }
} finally { await client.close(); }
