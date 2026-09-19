import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, readFile, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { activateCandidate } from '../install.mjs';
import { importLegacy } from '../legacy-import.mjs';
import { collectGarbage } from '../gc.mjs';
import { atomicJson, secureStateDirectory } from '../state.mjs';

const exec = promisify(execFile);
async function windowsAcl(path) {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    "$ErrorActionPreference='Stop'",
    "$acl=Get-Acl -LiteralPath $env:PERSONAL_TEST_ACL_PATH",
    "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "function Has-FullControl([string]$ExpectedSid) { foreach($rule in $acl.Access) { try { $ruleSid=$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { continue }; if($ruleSid -eq $ExpectedSid -and -not $rule.IsInherited -and $rule.AccessControlType -eq 'Allow' -and (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)) { return $true } }; return $false }",
    "[PSCustomObject]@{sddl=$acl.Sddl;protected=$acl.AreAccessRulesProtected;user=(Has-FullControl $sid);system=(Has-FullControl 'S-1-5-18');inherited=@($acl.Access | Where-Object IsInherited).Count} | ConvertTo-Json -Compress",
  ].join('; ');
  const { stdout } = await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 10000,
    env: { ...process.env, PERSONAL_TEST_ACL_PATH: path },
  });
  return JSON.parse(stdout.trim());
}

test('installer never switches after a partial stop', async () => {
  const calls = [];
  await assert.rejects(activateCandidate({ stop: async () => { throw new Error('stop failed'); }, select: async () => calls.push('select'), paused: false }), /stop failed/);
  assert.deepEqual(calls, []);
});
test('candidate readiness failure restores the previous runtime and never starts its UI', async () => {
  const calls = [];
  await assert.rejects(activateCandidate({ paused: false, stop: async () => calls.push('stop'), select: async () => calls.push('select'),
    start: async () => calls.push('start'), ready: async () => { throw new Error('probe failed'); }, commit: async () => calls.push('commit'),
    restore: async () => calls.push('restore'), desktop: async () => calls.push('desktop') }), /previous runtime was restored/);
  assert.deepEqual(calls, ['stop', 'select', 'start', 'restore']);
});
test('active installation record commits only after candidate readiness', async () => {
  const calls = [];
  await activateCandidate({ paused: false, stop: async () => calls.push('stop'), select: async () => calls.push('select'),
    start: async () => calls.push('start'), ready: async () => calls.push('ready'), commit: async () => calls.push('commit'),
    restore: async () => calls.push('restore'), desktop: async () => calls.push('desktop') });
  assert.deepEqual(calls, ['stop', 'select', 'start', 'ready', 'commit', 'desktop']);
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
test('Windows fresh state root is secured before any child state exists', { skip: process.platform !== 'win32' }, async t => {
  const parent = await mkdtemp(join(tmpdir(), 'personal-acl-fresh-')); t.after(() => rm(parent, { recursive: true, force: true }));
  const home = join(parent, 'state');
  await secureStateDirectory(home);
  const root = await windowsAcl(home);
  assert.equal(root.protected, true); assert.equal(root.user, true); assert.equal(root.system, true); assert.equal(root.inherited, 0);
  const child = join(home, 'plain-child.txt'); await writeFile(child, 'inherited');
  assert.ok((await windowsAcl(child)).inherited >= 2);
  await rm(home, { recursive: true, force: true });
  await secureStateDirectory(home);
  assert.equal((await windowsAcl(home)).protected, true);
});
test('Windows state ACL hardening never propagates through populated bulk directories', { skip: process.platform !== 'win32' }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'personal-acl-')); t.after(() => rm(home, { recursive: true, force: true }));
  const appSentinel = join(home, 'apps/old/node_modules/package/file.js');
  const cacheSentinel = join(home, 'build-cache/win32-x64-old/native-build.json');
  await mkdir(join(home, 'apps/old/node_modules/package'), { recursive: true });
  await mkdir(join(home, 'build-cache/win32-x64-old'), { recursive: true });
  await writeFile(appSentinel, 'old app');
  await writeFile(cacheSentinel, '{}');
  const unrelatedJson = join(home, 'unrelated.json');
  await writeFile(unrelatedJson, '{}');
  await writeFile(join(home, 'auth.json'), '{"apiToken":"existing-private-state"}\n');
  const rootBefore = await windowsAcl(home);
  const appBefore = await windowsAcl(appSentinel);
  const cacheBefore = await windowsAcl(cacheSentinel);
  const unrelatedBefore = await windowsAcl(unrelatedJson);
  await secureStateDirectory(home);
  assert.equal((await windowsAcl(home)).sddl, rootBefore.sddl);
  assert.equal((await windowsAcl(appSentinel)).sddl, appBefore.sddl);
  assert.equal((await windowsAcl(cacheSentinel)).sddl, cacheBefore.sddl);
  assert.equal((await windowsAcl(unrelatedJson)).sddl, unrelatedBefore.sddl);
  const migrated = await windowsAcl(join(home, 'auth.json'));
  assert.equal(migrated.protected, true);
  assert.equal(migrated.user, true);
  assert.equal(migrated.system, true);
  assert.equal(migrated.inherited, 0);
  await atomicJson(join(home, 'intent.json'), { paused: false });
  const created = await windowsAcl(join(home, 'intent.json'));
  assert.equal(created.protected, true);
  assert.equal(created.user, true);
  assert.equal(created.system, true);
  assert.equal(created.inherited, 0);
  await secureStateDirectory(home);
  assert.equal((await windowsAcl(appSentinel)).sddl, appBefore.sddl);
  assert.equal((await windowsAcl(cacheSentinel)).sddl, cacheBefore.sddl);
  assert.equal((await windowsAcl(unrelatedJson)).sddl, unrelatedBefore.sddl);
});
test('one-time import separates token and extension settings and discards retired keys', async t => {
  const root = await mkdtemp(join(tmpdir(), 'personal-import-')); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'personal'), legacyDir = join(root, 'upstream');
  await atomicJson(join(legacyDir, 'config.json'), { port: 4100, allowedRoots: [root], codegraphEnabled: true, basicMemoryEnabled: true,
    futureUpstreamSetting: 'preserve-me', subagents: false });
  await atomicJson(join(legacyDir, 'auth.json'), { ownerToken: 'test-only-owner-token', basicMemoryToken: 'test-only-retired-token',
    futureUpstreamAuth: 'preserve-me' });
  const result = await importLegacy(home, { legacyDir, sourceRoot: root, desktop: { tasks: [], environment: { DEVSPACE_API_TOKEN: 'test-only-api-token-with-enough-characters', DEVSPACE_WIDGETS: 'off' } } });
  assert.equal(result.apiTokenPreserved, true);
  const personal = JSON.parse(await readFile(join(home, 'personal.json'), 'utf8'));
  assert.equal(personal.codegraph.enabled, true); assert.equal(personal.runtimeConfigDir, legacyDir);
  assert.equal(personal.runtimeEnv, undefined); assert.deepEqual(personal.codegraph, { enabled: true });
  assert.deepEqual(JSON.parse(await readFile(join(legacyDir, 'auth.json'), 'utf8')),
    { ownerToken: 'test-only-owner-token', futureUpstreamAuth: 'preserve-me' });
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(legacyDir, 'config.json'), 'utf8'))).sort(),
    ['allowedRoots', 'futureUpstreamSetting', 'port', 'subagents']);
  assert.equal((await importLegacy(home, { legacyDir })).unchanged, true);
});

test('historical import resumes forward from its durable backup journal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'personal-import-resume-')); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'personal'), legacyDir = join(root, 'upstream'), backup = join(home, 'legacy-backup');
  await atomicJson(join(backup, 'config.json'), { port: 4200, codegraphEnabled: false, basicMemoryEnabled: true });
  await atomicJson(join(backup, 'auth.json'), { ownerToken: 'resume-owner', retiredToken: 'retired' });
  await atomicJson(join(backup, 'desktop.json'), { tasks: [], environment: { DEVSPACE_API_TOKEN: 'resume-api-token-with-enough-characters' } });
  await atomicJson(join(home, 'legacy-import.json'), { schema: 1, complete: false, phase: 'personal-written', backup,
    legacyDir, sourceRoot: root, updatedAt: new Date().toISOString() });
  await atomicJson(join(home, 'personal.json'), { schema: 1, partial: true });
  await atomicJson(join(legacyDir, 'config.json'), { already: 'partially-rewritten' });
  await atomicJson(join(legacyDir, 'auth.json'), { ownerToken: 'resume-owner' });
  const result = await importLegacy(home, { legacyDir, sourceRoot: root });
  assert.equal(result.complete, true);
  assert.equal(JSON.parse(await readFile(join(home, 'legacy-import.json'), 'utf8')).complete, true);
  assert.equal(JSON.parse(await readFile(join(home, 'personal.json'), 'utf8')).runtimeConfigDir, legacyDir);
});

test('GC keeps current and previous installs while removing only owned stale state', async t => {
  const home = await mkdtemp(join(tmpdir(), 'personal-gc-')); t.after(() => rm(home, { recursive: true, force: true }));
  const apps = join(home, 'apps'), current = join(apps, 'current'), previous = join(apps, 'previous'), old = join(apps, 'old');
  for (const path of [current, previous, old]) {
    await atomicJson(join(path, '.personal-install.json'), { schema: 1, owner: 'personal-devspace' });
  }
  await atomicJson(join(home, 'install.json'), { schema: 1, owner: 'personal-devspace', packageRoot: current });
  await atomicJson(join(home, 'install-attempt.json'), { schema: 1, requestId: 'done', status: 'installed', previous });
  const digest = 'a'.repeat(64), oldDigest = 'b'.repeat(64);
  await atomicJson(join(current, 'personal/bin/native-build.json'), { sourceDigest: digest });
  const cachePrefix = process.platform + '-' + process.arch + '-';
  await mkdir(join(home, 'build-cache', cachePrefix + digest), { recursive: true });
  await mkdir(join(home, 'build-cache', cachePrefix + oldDigest), { recursive: true });
  await mkdir(join(apps, 'orphan.stage-dead'), { recursive: true });
  await writeFile(join(home, 'install-result.json'), '{}');
  await writeFile(join(home, 'control-endpoint.json'), '{}');
  await mkdir(join(home, 'startup'), { recursive: true }); await writeFile(join(home, 'startup/runtime.xml'), 'old');
  const log = join(home, 'logs/runtime.log'); await mkdir(join(home, 'logs'), { recursive: true }); await writeFile(log, 'old');
  const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60_000); await utimes(log, oldTime, oldTime);
  const result = await collectGarbage(home);
  assert.ok(result.actions.some(action => action.kind === 'old-install'));
  await access(current); await access(previous);
  await assert.rejects(access(old)); await assert.rejects(access(join(apps, 'orphan.stage-dead')));
  await access(join(home, 'build-cache', cachePrefix + digest));
  await assert.rejects(access(join(home, 'build-cache', cachePrefix + oldDigest)));
  await assert.rejects(access(join(home, 'install-result.json')));
  await assert.rejects(access(join(home, 'control-endpoint.json')));
  await assert.rejects(access(join(home, 'startup')));
  await assert.rejects(access(log));
});

test('GC removes only old Personal-owned review worktrees and keeps the current candidate', async t => {
  const root = await mkdtemp(join(tmpdir(), 'personal-review-gc-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), home = join(root, 'home');
  await mkdir(source, { recursive: true });
  const git = args => exec('git', ['-c', 'user.name=Personal Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: source, windowsHide: true });
  await git(['init', '--quiet']); await writeFile(join(source, 'README.md'), 'fixture\n'); await git(['add', '.']); await git(['commit', '-m', 'base']);
  const oldReview = join(root, 'DevSpace-review-old'), currentReview = join(root, 'DevSpace-review-current');
  await git(['worktree', 'add', '-b', 'personal/upgrade-old', oldReview]);
  await git(['worktree', 'add', '-b', 'personal/upgrade-current', currentReview]);
  await atomicJson(join(oldReview, '.personal-review/candidate.json'), { schema: 1, owner: 'personal-devspace', branch: 'personal/upgrade-old' });
  await atomicJson(join(currentReview, '.personal-review/candidate.json'), { schema: 1, owner: 'personal-devspace', branch: 'personal/upgrade-current' });
  await atomicJson(join(home, 'personal.json'), { schema: 1, sourceRoot: source });
  await atomicJson(join(home, 'upgrade-review.json'), { schema: 1, status: 'tested-awaiting-review', candidate: currentReview, candidateHead: 'a'.repeat(40) });
  const result = await collectGarbage(home);
  assert.ok(result.actions.some(action => action.kind === 'old-review-worktree' && resolve(action.path) === resolve(oldReview)));
  await assert.rejects(access(oldReview)); await access(currentReview);
});
