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
test('Personal branding is packaged for WebUI, native trays and Windows shortcuts', async () => {
  const [logo, ico, rgba, rust, swift, platform] = await Promise.all([
    readFile(new URL('../assets/personal-devspace-logo.png', import.meta.url)),
    readFile(new URL('../assets/personal-devspace.ico', import.meta.url)),
    readFile(new URL('../native/tray/assets/personal-devspace-32.rgba', import.meta.url)),
    readFile(new URL('../native/tray/src/main.rs', import.meta.url), 'utf8'),
    readFile(new URL('../native/PersonalDevSpaceTray.swift', import.meta.url), 'utf8'),
    readFile(new URL('../desktop/platform.mjs', import.meta.url), 'utf8'),
  ]);
  assert.equal(logo.toString('ascii', 1, 4), 'PNG'); assert.equal(logo.readUInt32BE(16), 500); assert.equal(logo.readUInt32BE(20), 500);
  assert.equal(ico.readUInt16LE(0), 0); assert.equal(ico.readUInt16LE(2), 1); assert.ok(ico.readUInt16LE(4) >= 7); assert.equal(rgba.length, 32 * 32 * 4);
  assert.match(rust, /personal-devspace-32\.rgba/); assert.match(swift, /assets\/personal-devspace-logo\.png/);
  assert.match(platform, /GetFolderPath\('Desktop'\)/); assert.match(platform, /GetFolderPath\('Programs'\)/); assert.match(platform, /IconLocation=\$env:PERSONAL_ICON/);
});
test('built Windows helpers use GUI subsystem, not console windows', { skip: process.platform !== 'win32' }, async () => {
  // Missing artifacts fail this native acceptance check; do not silently count it as passed.
  for (const file of ['personal-launcher.exe', 'personal-devspace-tray.exe']) {
    const pe = await peDetails(new URL(`../bin/${file}`, import.meta.url)); assert.equal(pe.machine, 0x8664); assert.equal(pe.subsystem, 2);
  }
});
