// Snapshot of Team DevSpace 15ce088 client/state.mjs storage primitives.
// Only local private-file operations are retained; no enterprise state/schema.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod, rm, link, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const securedStateDirectories = new Set();
export const PERSONAL_STATE_FILES = Object.freeze({
  personal: 'personal.json',
  auth: 'auth.json',
  intent: 'intent.json',
  install: 'install.json',
  installAttempt: 'install-attempt.json',
  installQueue: 'install-queue.json',
  legacyImport: 'legacy-import.json',
  controlCapability: 'control-capability.json',
  upgradeReview: 'upgrade-review.json',
  desktopStatus: 'desktop-status.json',
});
const privateStateFiles = Object.values(PERSONAL_STATE_FILES);
const privateBackupFiles = ['config.json', 'auth.json', 'desktop.json'];
let windowsSidPromise;

export function stateHome(env = process.env) {
  return resolve(env.PERSONAL_DEVSPACE_HOME ?? join(homedir(), '.devspace-personal'));
}
export function statePath(home, record) {
  const file = PERSONAL_STATE_FILES[record];
  if (!file) throw new Error(`Unknown Personal state record: ${record}`);
  return join(home, file);
}
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(path, 0o700);
}
async function currentWindowsSid() {
  if (!windowsSidPromise) {
    const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    windowsSidPromise = exec(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
      windowsHide: true,
      timeout: 10000,
    }).then(({ stdout }) => {
      const sid = /S-1-5-[0-9-]+/.exec(stdout)?.[0];
      if (!sid) throw new Error('Unable to resolve current Windows user SID');
      return sid;
    }).catch(error => {
      windowsSidPromise = undefined;
      throw error;
    });
  }
  return windowsSidPromise;
}
async function secureWindowsPath(path, sid, { directory = false } = {}) {
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const rights = directory ? '(OI)(CI)F' : 'F';
  await exec(join(system, 'icacls.exe'), [
    path,
    '/inheritance:r',
    '/grant:r',
    '*' + sid + ':' + rights,
    '*S-1-5-18:' + rights,
  ], {
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
}
async function secureExistingStateFiles(directory, names, sid) {
  await Promise.all(names.map(async name => {
    const path = join(directory, name);
    const entry = await lstat(path).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (entry?.isFile()) await secureWindowsPath(path, sid);
  }));
}
export async function secureStateDirectory(home = stateHome()) {
  if (process.platform === 'win32') {
    const resolved = resolve(home);
    let created = false;
    try {
      await mkdir(resolved, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        await mkdir(resolved, { recursive: true, mode: 0o700 });
        created = true;
      } else if (error.code !== 'EEXIST') throw error;
    }
    const sid = await currentWindowsSid();
    // A directory created by this call is still empty, so setting inheritable ACLs
    // is safe and preserves the original security boundary for fresh installs.
    if (created) await secureWindowsPath(resolved, sid, { directory: true });
    if (securedStateDirectories.has(resolved)) return;
    // Never rewrite inheritable ACLs on the populated state root. Existing private
    // metadata is hardened file-by-file; bulk apps/build-cache/logs are untouched.
    await secureExistingStateFiles(resolved, privateStateFiles, sid);
    await secureExistingStateFiles(join(resolved, 'legacy-backup'), privateBackupFiles, sid);
    securedStateDirectories.add(resolved);
  } else await privateDirectory(home);
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
  const nonce = randomUUID();
  const stage = process.platform === 'win32' ? join(dirname(path), '.personal-private-' + nonce) : undefined;
  const temporary = stage ? join(stage, 'value.tmp') : path + '.' + nonce + '.tmp';
  let sid;
  try {
    if (stage) {
      sid = await currentWindowsSid();
      await mkdir(stage, { mode: 0o700 });
      await secureWindowsPath(stage, sid, { directory: true });
    }
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    if (createOnly) {
      try { await link(temporary, path); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (sid) await secureWindowsPath(path, sid);
        return false;
      }
    } else {
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, path); break; }
        catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code) || attempt >= 9) throw error;
          await sleep(10 * (attempt + 1));
        }
      }
    }
    if (sid) await secureWindowsPath(path, sid);
    else await chmod(path, 0o600);
    return true;
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
    else await rm(temporary, { force: true }).catch(() => {});
  }
}
export async function atomicJson(path, value, options) { return atomicText(path, `${JSON.stringify(value, null, 2)}\n`, options); }
export function randomSecret() { return randomBytes(32).toString('base64url'); }
