// Snapshot of Team DevSpace 15ce088 client/state.mjs storage primitives.
// Only local private-file operations are retained; no enterprise state/schema.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod, rm, link } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

export function stateHome(env = process.env) {
  return resolve(env.PERSONAL_DEVSPACE_HOME ?? join(homedir(), '.devspace-personal'));
}
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(path, 0o700);
}
async function waitForAclResult(path, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = (await readFile(path, 'utf8')).trim();
      if (/^\d+$/.test(result)) return Number(result);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await sleep(25);
  }
  throw new Error('Timed out securing Personal state directory');
}
export async function secureStateDirectory(home = stateHome()) {
  await privateDirectory(home);
  if (process.platform === 'win32') {
    const exec = promisify(execFile);
    const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const { stdout } = await exec(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 10000 });
    const sid = /S-1-5-[0-9-]+/.exec(stdout)?.[0];
    if (!sid) throw new Error('Unable to resolve current Windows user SID');
    const nonce = randomUUID();
    const script = join(tmpdir(), `.secure-state-${nonce}.cmd`);
    const result = join(tmpdir(), `.secure-state-${nonce}.result`);
    await writeFile(script, '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%SystemRoot%\\System32\\icacls.exe" "%PERSONAL_ACL_HOME%" /inheritance:r /grant:r "*%PERSONAL_ACL_SID%:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" >nul 2>&1\r\n> "%PERSONAL_ACL_RESULT%" echo %ERRORLEVEL%\r\nendlocal\r\n', { flag: 'wx', mode: 0o600 });
    try {
      const child = spawn(join(system, 'cmd.exe'), ['/d', '/c', script], {
        windowsHide: true, stdio: 'ignore',
        env: { ...process.env, PERSONAL_ACL_HOME: home, PERSONAL_ACL_SID: sid, PERSONAL_ACL_RESULT: result },
      });
      await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
      child.unref();
      const code = await waitForAclResult(result);
      if (code !== 0) throw new Error(`Unable to secure Personal state directory (icacls exit ${code})`);
    } finally {
      await Promise.all([rm(script, { force: true }), rm(result, { force: true })]);
    }
  }
}
export async function readJson(path, fallback) {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error.code === 'ENOENT' && arguments.length > 1) return fallback;
    throw new Error(`Cannot read ${path}: ${error.code ?? 'invalid JSON'}`);
  }
}
export async function atomicText(path, content, { createOnly = false } = {}) {
  await privateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    if (createOnly) {
      try { await link(temporary, path); }
      catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    } else {
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, path); break; }
        catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code) || attempt >= 9) throw error;
          await sleep(10 * (attempt + 1));
        }
      }
    }
    if (process.platform !== 'win32') await chmod(path, 0o600);
    return true;
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
export async function atomicJson(path, value, options) { return atomicText(path, `${JSON.stringify(value, null, 2)}\n`, options); }
export function randomSecret() { return randomBytes(32).toString('base64url'); }
