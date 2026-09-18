import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { activateCandidate } from '../install.mjs';
import { importLegacy } from '../legacy-import.mjs';
import { atomicJson, secureStateDirectory } from '../state.mjs';

test('installer never switches after a partial stop', async () => {
  const calls = [];
  await assert.rejects(activateCandidate({ stop: async () => { throw new Error('stop failed'); }, select: async () => calls.push('select'), paused: false }), /stop failed/);
  assert.deepEqual(calls, []);
});
test('candidate readiness failure restores the previous runtime and never starts its UI', async () => {
  const calls = [];
  await assert.rejects(activateCandidate({ paused: false, stop: async () => calls.push('stop'), select: async () => calls.push('select'),
    start: async () => calls.push('start'), ready: async () => { throw new Error('probe failed'); }, restore: async () => calls.push('restore'), desktop: async () => calls.push('desktop') }), /previous runtime was restored/);
  assert.deepEqual(calls, ['stop', 'select', 'start', 'restore']);
});
test('desktop startup failure cannot roll back a healthy installed core', async () => {
  const calls = [];
  const result = await activateCandidate({ paused: false, stop: async () => {}, select: async () => {}, start: async () => {}, ready: async () => {},
    restore: async () => calls.push('restore'), desktop: async () => { throw new Error('tray missing'); } });
  assert.equal(result.installed, true); assert.match(result.warning, /needs repair/); assert.deepEqual(calls, []);
});
test('install preserves pause intent without briefly starting the runtime', async () => {
  let started = false;
  const result = await activateCandidate({ paused: true, stop: async () => {}, select: async () => {}, start: async () => { started = true; },
    ready: async () => assert.fail('paused runtime was probed'), restore: async () => {}, desktop: async () => {} });
  assert.equal(result.installed, true); assert.equal(started, false);
});
test('rollback failures are explicit rather than claiming successful recovery', async () => {
  await assert.rejects(activateCandidate({ paused: false, stop: async () => {}, select: async () => { throw new Error('select'); },
    restore: async () => { throw new Error('rollback'); } }), /rollback needs attention/);
});
test('Windows state ACL hardening completes without waiting for icacls process handles and is idempotent', { skip: process.platform !== 'win32' }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'personal-acl-')); t.after(() => rm(home, { recursive: true, force: true }));
  await secureStateDirectory(home);
  await secureStateDirectory(home);
});
test('one-time import separates token and extension settings and discards retired keys', async t => {
  const root = await mkdtemp(join(tmpdir(), 'personal-import-')); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'personal'), legacyDir = join(root, 'upstream');
  await atomicJson(join(legacyDir, 'config.json'), { port: 4100, allowedRoots: [root], codegraphEnabled: true, retiredIntegrationEnabled: true, subagents: false });
  await atomicJson(join(legacyDir, 'auth.json'), { ownerToken: 'test-only-owner-token', retiredToken: 'test-only-retired-token' });
  const result = await importLegacy(home, { legacyDir, sourceRoot: root, desktop: { tasks: [], environment: { DEVSPACE_API_TOKEN: 'test-only-api-token-with-enough-characters', DEVSPACE_WIDGETS: 'off' } } });
  assert.equal(result.apiTokenPreserved, true);
  const personal = JSON.parse(await readFile(join(home, 'personal.json'), 'utf8'));
  assert.equal(personal.codegraph.enabled, true); assert.equal(personal.runtimeConfigDir, legacyDir);
  assert.deepEqual(JSON.parse(await readFile(join(legacyDir, 'auth.json'), 'utf8')), { ownerToken: 'test-only-owner-token' });
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(legacyDir, 'config.json'), 'utf8'))).sort(), ['allowedRoots', 'port', 'subagents']);
  assert.equal((await importLegacy(home, { legacyDir })).unchanged, true);
});
