import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { peDetails } from '../build-native.mjs';
test('native launcher retains ownership-before-resume and optional-log failure isolation', async () => {
  const source = await readFile(new URL('../native/windows-launcher.c', import.meta.url), 'utf8');
  assert.match(source, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/); assert.match(source, /CREATE_SUSPENDED \| CREATE_NO_WINDOW/);
  assert.ok(source.indexOf('AssignProcessToJobObject(job, process.hProcess)') < source.indexOf('ResumeThread(process.hThread)'));
  assert.match(source, /stdout unavailable; using NUL/); assert.doesNotMatch(source, /team-devspace-tray|TDS\\/);
});
test('built Windows helpers use GUI subsystem, not console windows', { skip: process.platform !== 'win32' }, async () => {
  // Missing artifacts fail this native acceptance check; do not silently count it as passed.
  for (const file of ['personal-launcher.exe', 'personal-devspace-tray.exe']) {
    const pe = await peDetails(new URL(`../bin/${file}`, import.meta.url)); assert.equal(pe.machine, 0x8664); assert.equal(pe.subsystem, 2);
  }
});
