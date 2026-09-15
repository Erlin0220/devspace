import { spawn } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { randomUUID } from 'node:crypto';
import { mkdir, copyFile, rename, access, rm } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicJson, readJson, secureStateDirectory, stateHome } from './state.mjs';
import { payloadDigest, verifyInstallable } from './artifact.mjs';
import { readPersonalAuth, readPersonalConfig } from './config.mjs';
import { discoverStable } from './upgrade.mjs';
import { installerRunning, jobRunning, jobAction, registerJobs, runWindowsDesktop, ownerId } from './desktop/platform.mjs';

async function report(home, value) {
  // Progress is optional; its failure must not roll back a healthy installed runtime.
  return atomicJson(join(home, 'install-result.json'), { schema: 1, ...value, updatedAt: new Date().toISOString() }).then(() => true, () => false);
}

// One transaction, shared by first install and update. Presentation is explicitly
// outside the core commit/rollback boundary (same fault isolation as the snapshot).
export async function activateCandidate({ stop, select, start, ready, restore, desktop, paused }) {
  await stop(); // A partial stop must never authorize the candidate.
  try { await select(); if (!paused) { await start(); await ready(); } }
  catch (failure) {
    try { await restore(); }
    catch (rollback) { throw new AggregateError([failure, rollback], `Installation failed and rollback needs attention: ${failure.message}; ${rollback.message}`); }
    throw new Error(`Installation failed; previous runtime was restored: ${failure.message}`);
  }
  let warning;
  try { await desktop(); } catch (error) { warning = `Runtime is installed; desktop entry needs repair: ${error.message}`; }
  return { installed: true, warning };
}

async function copyCandidate(source, home, receipt, payload) {
  const apps = join(home, 'apps'); await mkdir(apps, { recursive: true });
  const destination = join(apps, `${receipt.commit.slice(0, 12)}-${receipt.sha256.slice(0, 12)}`);
  const existing = await readJson(join(destination, '.personal-install.json'), null);
  if (existing) {
    if (existing.sha256 !== receipt.sha256 || (await payloadDigest(destination)).sha256 !== receipt.sha256) throw new Error('Existing immutable candidate was modified; refusing reuse');
    return destination;
  }
  if (await access(destination).then(() => true, () => false)) throw new Error('Candidate directory exists without Personal ownership');
  const stage = `${destination}.stage-${randomUUID()}`;
  await mkdir(stage);
  try {
    for (const file of payload.files) { const to = join(stage, file); await mkdir(dirname(to), { recursive: true }); await copyFile(join(source, file), to); }
    if ((await payloadDigest(stage)).sha256 !== receipt.sha256) throw new Error('Candidate bytes changed during staging');
    // Use the same lockfile and upstream postinstall, but never execute an alternate installer.
    await new Promise((resolveExit, reject) => {
      const child = process.platform === 'win32'
        ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm ci --omit=dev --no-audit --no-fund'], { cwd: stage, windowsHide: true, stdio: 'inherit' })
        : spawn('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });
      child.once('error', reject); child.once('exit', code => code === 0 ? resolveExit() : reject(new Error(`Dependency installation failed (${code})`)));
    });
    if ((await payloadDigest(stage)).sha256 !== receipt.sha256) throw new Error('Packaging modified verified application bytes');
    await atomicJson(join(stage, '.personal-install.json'), { schema: 1, owner: 'personal-devspace', ...receipt });
    await rename(stage, destination); return destination;
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}

async function legacyAction(home, action) {
  const legacy = await readJson(join(home, 'legacy-import.json'), null);
  if (!legacy?.complete || !legacy.tasks?.length || process.platform !== 'win32') return;
  for (const task of legacy.tasks) {
    if (!/^com\.devspace\.[a-f0-9]{16}\.(runtime|tray)$/.test(task.name) || !isAbsolute(task.executable)) throw new Error('Invalid historical task ownership');
    const script = `
$ErrorActionPreference='Stop'
$task=Get-ScheduledTask -TaskName $env:PERSONAL_OLD_TASK -ErrorAction SilentlyContinue
if(!$task){throw 'Historical task disappeared; refusing a partial migration'}
if(@($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ne $env:PERSONAL_OLD_LAUNCHER){throw 'Historical task ownership changed'}
if($env:PERSONAL_OLD_ACTION -eq 'stop') {
  if($task.State -in @('Running','Queued')){Stop-ScheduledTask -TaskName $task.TaskName}
  for($i=0;$i -lt 60;$i++){if((Get-ScheduledTask -TaskName $task.TaskName).State -notin @('Running','Queued')){break};Start-Sleep -Milliseconds 100}
  if((Get-ScheduledTask -TaskName $task.TaskName).State -in @('Running','Queued')){throw 'Historical process owner did not stop'}
} elseif($env:PERSONAL_OLD_ACTION -eq 'disable') { Disable-ScheduledTask -TaskName $task.TaskName | Out-Null }
elseif($env:PERSONAL_OLD_ACTION -eq 'restore') { Enable-ScheduledTask -TaskName $task.TaskName | Out-Null; if($env:PERSONAL_OLD_RUNNING -eq 'true'){Start-ScheduledTask -TaskName $task.TaskName} }
`;
    await runWindowsDesktop(script, { env: { PERSONAL_OLD_TASK: task.name, PERSONAL_OLD_LAUNCHER: task.executable,
      PERSONAL_OLD_ACTION: action, PERSONAL_OLD_RUNNING: String(task.running) } });
  }
}
async function stopOwn(home) {
  const results = await Promise.allSettled(['runtime', 'desktop'].map(component => jobAction(home, component, 'stop')));
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, 'One or more Personal process owners did not stop');
}
async function runtimeProbe(home) {
  const { runtimeSettings } = await import('./runtime.mjs'); const { config } = await runtimeSettings(home);
  return fetch(`http://127.0.0.1:${config.port}/personal-healthz`, { signal: AbortSignal.timeout(1000) })
    .then(response => response.ok ? response.json() : null).catch(() => null);
}
async function ready(home, version, commit) {
  for (let i = 0; i < 80; i++) {
    const health = await runtimeProbe(home);
    if (health?.owner === ownerId(home) && health.version === version && health.overlayCommit === commit) return;
    await sleep(250);
  }
  throw new Error('Candidate did not become healthy within the readiness window');
}
export async function installPersonal(source, home = stateHome()) {
  await secureStateDirectory(home);
  const { receipt, payload } = await verifyInstallable(source);
  const baseline = await readJson(join(source, 'personal/upstream.json'));
  const stable = await discoverStable();
  if (baseline.version !== stable.version) throw new Error('Candidate is no longer the latest official stable; prepare a fresh review candidate');
  const previous = await readJson(join(home, 'install.json'), null);
  const config = await readPersonalConfig(home);
  if (!(await readPersonalAuth(home, {})).apiToken) throw new Error('Migrate or configure the private Personal API Token before installing');
  // Recheck after staging as well: testing/download time may overlap a new command.
  const idle = async () => {
    const probe = await runtimeProbe(home);
    if (probe?.owner === ownerId(home) && probe.runningProcesses > 0) throw new Error('Runtime has active commands; installation was not started');
    if (previous && probe?.owner !== ownerId(home) && await jobRunning(home, 'runtime')) throw new Error('Running runtime did not provide a trustworthy idle status; refusing an installation switch');
  };
  await idle();
  await report(home, { status: 'staging', source, version: stable.version });
  const destination = await copyCandidate(source, home, receipt, payload);
  await idle();
  await report(home, { status: 'switching', version: stable.version, previous: previous?.packageRoot });
  const result = await activateCandidate({ paused: config.paused,
    stop: async () => {
      try { if (previous) await stopOwn(home); else await legacyAction(home, 'stop'); }
      catch (error) {
        // Restore independently stopped siblings, but do not switch to a candidate after a partial stop.
        if (previous) { if (!config.paused) await jobAction(home, 'runtime', 'start').catch(() => {}); await jobAction(home, 'desktop', 'start').catch(() => {}); }
        else await legacyAction(home, 'restore').catch(() => {});
        throw error;
      }
    },
    select: () => registerJobs(home, destination),
    start: () => jobAction(home, 'runtime', 'start'),
    ready: () => ready(home, stable.version, receipt.commit),
    restore: async () => {
      await stopOwn(home);
      if (previous) { await registerJobs(home, previous.packageRoot); if (!config.paused) await jobAction(home, 'runtime', 'start'); await jobAction(home, 'desktop', 'start'); }
      else {
        for (const component of ['runtime', 'desktop']) await jobAction(home, component, 'remove');
        await rm(join(home, 'install.json'), { force: true }); await legacyAction(home, 'restore');
      }
    },
    desktop: () => jobAction(home, 'desktop', 'start'),
  });
  // Reuse npm's existing shim/link management. Otherwise the legacy global CLI
  // would still expose removed commands, and later upgrades could leave it stale.
  // This is an optional entrypoint repair after core commit, never a core rollback.
  try {
    await new Promise((resolveExit, reject) => {
      const child = crossSpawn('npm', ['install', '--global', '--ignore-scripts', destination], {
        cwd: destination, windowsHide: true, stdio: 'inherit', timeout: 120000,
      });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolveExit() : reject(new Error(`CLI registration exited ${code}`)));
    });
  } catch (error) {
    result.warning = `${result.warning ?? ''} Runtime is healthy; global CLI registration needs attention: ${error.message}`.trim();
  }
  if (!previous) await legacyAction(home, 'disable').catch(error => { result.warning = `${result.warning ?? ''} Legacy logon tasks need cleanup: ${error.message}`.trim(); });
  await report(home, { status: 'installed', version: stable.version, packageRoot: destination, previous: previous?.packageRoot, ...result });
  return result;
}

// The OS starts this outside the invoking MCP process tree. It may safely replace
// the Runtime/desktop without killing itself or unrelated Team/Tunnel processes.
export async function requestInstall(source, home = stateHome()) {
  await verifyInstallable(source);
  await secureStateDirectory(home);
  const requestPath = join(home, 'install-request.json');
  if (await installerRunning(home)) throw new Error('An installer is already running');
  if (!await atomicJson(requestPath, { schema: 1, source: resolve(source), home }, { createOnly: true })) throw new Error('An installation request already exists; inspect diagnostics before retrying');
  try {
    await registerJobs(home, resolve(source), ['installer'], { record: false });
    await report(home, { status: 'queued', source: resolve(source) });
    await jobAction(home, 'installer', 'start');
  } catch (error) { await rm(requestPath, { force: true }); await report(home, { status: 'failed', error: error.message }); throw error; }
  return { accepted: true, status: 'queued' };
}
export async function runInstaller(home = stateHome()) {
  const requestPath = join(home, 'install-request.json');
  const request = await readJson(requestPath);
  if (request?.schema !== 1 || request.home !== home || !isAbsolute(request.source)) throw new Error('Invalid installation request');
  try { return await installPersonal(request.source, home); }
  catch (error) { await report(home, { status: 'failed', error: error.message }); throw error; }
  finally { await rm(requestPath, { force: true }); }
}
