import { randomUUID } from 'node:crypto';
import { mkdir, copyFile, rename, access, rm } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson, secureStateDirectory, stateHome, statePath } from './state.mjs';
import { inspectCandidate, payloadDigest, verifyCandidate } from './artifact.mjs';
import { readPersonalAuth, readPersonalConfig } from './config.mjs';
import { installerRunning, jobRunning, jobAction, registerDesktopEntries, registerJobs } from './desktop/platform.mjs';
import { runtimeSnapshot, stopIdleAgentDaemon, waitForRuntime } from './runtime.mjs';
import { runNpmCommand } from './verification.mjs';
import { legacyTasksAction } from './legacy-import.mjs';

const installerRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const terminalInstallStates = new Set(['installed', 'failed']);
const attemptPath = home => statePath(home, 'installAttempt');
const queuePath = home => statePath(home, 'installQueue');
async function report(home, requestId, value) {
  // Progress is optional; its failure must not roll back a healthy installed runtime.
  try {
    const current = await readJson(attemptPath(home), null);
    if (!current || current.requestId !== requestId) return false;
    await atomicJson(attemptPath(home), { ...current, ...value, schema: 1, requestId, updatedAt: new Date().toISOString() });
    return true;
  } catch { return false; }
}

// One transaction, shared by first install and update. Presentation is explicitly
// outside the core commit/rollback boundary (same fault isolation as the snapshot).
export async function activateCandidate({ stop, select, start, ready, commit, restore, desktop, paused }) {
  await stop(); // A partial stop must never authorize the candidate.
  try {
    await select();
    if (!paused) { await start(); await ready(); }
    await commit?.();
  }
  catch (failure) {
    try { await restore(); }
    catch (rollback) { throw new AggregateError([failure, rollback], `Installation failed and rollback needs attention: ${failure.message}; ${rollback.message}`); }
    throw new Error(`Installation failed; previous runtime was restored: ${failure.message}`);
  }
  let warning;
  try { await desktop(); } catch (error) { warning = `Runtime is installed; desktop entry needs repair: ${error.message}`; }
  return { installed: true, warning };
}

async function copyCandidate(source, home, manifest, payload) {
  const apps = join(home, 'apps'); await mkdir(apps, { recursive: true });
  const destination = join(apps, `${manifest.candidateHead.slice(0, 12)}-${manifest.payload.sha256.slice(0, 12)}`);
  const existing = await readJson(join(destination, '.personal-install.json'), null);
  if (existing) {
    if (existing.payload?.sha256 !== manifest.payload.sha256 || (await payloadDigest(destination, payload.files)).sha256 !== manifest.payload.sha256) {
      throw new Error('Existing immutable candidate was modified; refusing reuse');
    }
    return destination;
  }
  if (await access(destination).then(() => true, () => false)) throw new Error('Candidate directory exists without Personal ownership');
  const stage = `${destination}.stage-${randomUUID()}`;
  await mkdir(stage);
  try {
    for (const file of payload.files) { const to = join(stage, file); await mkdir(dirname(to), { recursive: true }); await copyFile(join(source, file), to); }
    if ((await payloadDigest(stage, payload.files)).sha256 !== manifest.payload.sha256) throw new Error('Candidate bytes changed during staging');
    // Use the same lockfile and upstream postinstall, but never execute an alternate installer.
    const installCode = await runNpmCommand(stage, ['ci', '--omit=dev', '--no-audit', '--no-fund'], { timeoutMs: 10 * 60_000 });
    if (installCode !== 0) throw new Error(`Dependency installation failed (${installCode})`);
    if ((await payloadDigest(stage, payload.files)).sha256 !== manifest.payload.sha256) throw new Error('Packaging modified verified application bytes');
    await atomicJson(join(stage, '.personal-install.json'), {
      schema: 1,
      owner: 'personal-devspace',
      candidateHead: manifest.candidateHead,
      upstream: manifest.upstream,
      platform: manifest.platform,
      arch: manifest.arch,
      node: manifest.node,
      payload: manifest.payload,
    });
    await rename(stage, destination); return destination;
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}

async function stopOwn(home) {
  const results = await Promise.allSettled(['runtime', 'desktop'].map(component => jobAction(home, component, 'stop')));
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, 'One or more Personal process owners did not stop');
  await waitForRuntime(home, snapshot => !snapshot.responding, {
    attempts: 40,
    intervalMs: 100,
    errorMessage: 'Personal process owners stopped but the Runtime health endpoint is still responding',
  });
}
async function ready(home, version, commit) {
  await waitForRuntime(home, snapshot => (
    snapshot.owned && snapshot.runtimeVersion === version && snapshot.overlayCommit === commit
  ), {
    attempts: 80,
    intervalMs: 250,
    errorMessage: 'Candidate did not become healthy within the readiness window',
  });
}
export async function installPersonal(source, home = stateHome(), { requestId, expectedCandidateHead } = {}) {
  await secureStateDirectory(home);
  const { manifest, payload } = await verifyCandidate(source);
  if (expectedCandidateHead && manifest.candidateHead !== expectedCandidateHead) {
    throw new Error('Candidate revision changed after the installation request was approved');
  }
  const stable = manifest.upstream;
  const previous = await readJson(statePath(home, 'install'), null);
  const config = await readPersonalConfig(home);
  if (!(await readPersonalAuth(home, {})).apiToken) throw new Error('Migrate or configure the private Personal API Token before installing');
  // Recheck after staging as well: testing/download time may overlap a new command.
  const idle = async () => {
    const snapshot = await runtimeSnapshot(home);
    if (snapshot.owned && snapshot.runningProcesses > 0) throw new Error('Runtime has active commands; installation was not started');
    if (snapshot.activeAgentTurns > 0) throw new Error('Runtime has active subagent turns; installation was not started');
    if (snapshot.activeAgentTurns === null) throw new Error('Subagent activity could not be verified; installation was not started');
    if (previous && !snapshot.owned && await jobRunning(home, 'runtime')) throw new Error('Running runtime did not provide a trustworthy idle status; refusing an installation switch');
  };
  await idle();
  if (requestId) await report(home, requestId, { status: 'staging', source, version: stable.version });
  const destination = await copyCandidate(source, home, manifest, payload);
  await idle();
  if (requestId) await report(home, requestId, { status: 'switching', version: stable.version, previous: previous?.packageRoot });
  const result = await activateCandidate({ paused: config.paused,
    stop: async () => {
      try {
        await stopIdleAgentDaemon(home);
        if (previous) await stopOwn(home); else await legacyTasksAction(home, 'stop');
      }
      catch (error) {
        // Restore independently stopped siblings, but do not switch to a candidate after a partial stop.
        if (previous) { if (!config.paused) await jobAction(home, 'runtime', 'start').catch(() => {}); await jobAction(home, 'desktop', 'start').catch(() => {}); }
        else await legacyTasksAction(home, 'restore').catch(() => {});
        throw error;
      }
    },
    select: () => registerJobs(home, destination, undefined, { record: false }),
    start: () => jobAction(home, 'runtime', 'start'),
    ready: () => ready(home, stable.version, manifest.candidateHead),
    commit: () => atomicJson(statePath(home, 'install'), { schema: 1, owner: 'personal-devspace', packageRoot: destination }),
    restore: async () => {
      await stopOwn(home);
      if (previous) { await registerJobs(home, previous.packageRoot); if (!config.paused) await jobAction(home, 'runtime', 'start'); await jobAction(home, 'desktop', 'start'); }
      else {
        for (const component of ['runtime', 'desktop']) await jobAction(home, component, 'remove');
        await rm(statePath(home, 'install'), { force: true }); await legacyTasksAction(home, 'restore');
      }
    },
    desktop: async () => {
      let entryError; try { await registerDesktopEntries(home, destination); } catch (error) { entryError = error; }
      await jobAction(home, 'desktop', 'start');
      if (entryError) throw entryError;
    },
  });
  // Reuse npm's existing shim/link management. Otherwise the legacy global CLI
  // would still expose removed commands, and later upgrades could leave it stale.
  // This is an optional entrypoint repair after core commit, never a core rollback.
  try {
    const code = await runNpmCommand(destination, ['install', '--global', '--ignore-scripts', destination], { timeoutMs: 120_000 });
    if (code !== 0) throw new Error(`CLI registration exited ${code}`);
  } catch (error) {
    result.warning = `${result.warning ?? ''} Runtime is healthy; global CLI registration needs attention: ${error.message}`.trim();
  }
  if (!previous) await legacyTasksAction(home, 'disable').catch(error => { result.warning = `${result.warning ?? ''} Legacy logon tasks need cleanup: ${error.message}`.trim(); });
  if (requestId) await report(home, requestId, { status: 'installed', version: stable.version, packageRoot: destination,
    candidateHead: manifest.candidateHead, previous: previous?.packageRoot, ...result });
  return result;
}

// The OS starts this outside the invoking MCP process tree. It may safely replace
// the Runtime/desktop without killing itself or unrelated Team/Tunnel processes.
export async function requestInstall(source, home = stateHome(), { expectedCandidateHead } = {}) {
  const manifest = await inspectCandidate(source);
  if (expectedCandidateHead && manifest.candidateHead !== expectedCandidateHead) {
    throw new Error('Candidate revision changed after review; prepare and approve it again');
  }
  await secureStateDirectory(home);
  const requestId = randomUUID();
  const lock = queuePath(home);
  const previousLock = await readJson(lock, null).catch(() => null);
  if (previousLock) {
    const age = Date.now() - Date.parse(previousLock.createdAt ?? '');
    if (await installerRunning(home)) throw new Error('Another installation request is being queued');
    let ownerAlive = false;
    if (Number.isInteger(previousLock.pid) && previousLock.pid > 0) {
      try { process.kill(previousLock.pid, 0); ownerAlive = true; }
      catch (error) { if (error.code !== 'ESRCH') ownerAlive = true; }
    }
    if (ownerAlive && (!Number.isFinite(age) || age < 5 * 60_000)) throw new Error('Another installation request is being queued');
    await rm(lock, { force: true });
  }
  if (!await atomicJson(lock, { schema: 1, requestId, pid: process.pid, createdAt: new Date().toISOString() }, { createOnly: true })) {
    throw new Error('Another installation request won the queue race');
  }
  try {
    if (await installerRunning(home)) throw new Error('An installer is already running');
    const path = attemptPath(home);
    const existing = await readJson(path, null).catch(() => null);
    let recoveredFrom;
    if (existing) {
      if (!terminalInstallStates.has(existing.status)) {
        recoveredFrom = { requestId: existing.requestId, status: existing.status, error: 'stale attempt recovered because no installer was running' };
      }
      await rm(path, { force: true });
    }
    const sourcePath = resolve(source);
    const attempt = {
      schema: 1,
      requestId,
      source: sourcePath,
      home,
      candidateHead: manifest.candidateHead,
      status: 'queued',
      queuedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(recoveredFrom ? { recoveredFrom } : {}),
    };
    if (!await atomicJson(path, attempt, { createOnly: true })) throw new Error('Another installation request won the queue race');
    // The OS-owned installer always runs the already executing/trusted Personal
    // implementation. Candidate code is data until verifyCandidate() succeeds.
    await registerJobs(home, installerRoot, ['installer'], { record: false });
    await jobAction(home, 'installer', 'start');
    return { accepted: true, requestId, status: 'queued', candidateHead: manifest.candidateHead };
  } catch (error) {
    await report(home, requestId, { status: 'failed', error: error.message });
    if (!await installerRunning(home).catch(() => true)) await jobAction(home, 'installer', 'remove').catch(() => {});
    throw error;
  } finally {
    await rm(lock, { force: true }).catch(() => {});
  }
}
export async function runInstaller(home = stateHome()) {
  const request = await readJson(attemptPath(home));
  if (request?.schema !== 1 || typeof request.requestId !== 'string' || request.home !== home || !isAbsolute(request.source)
      || request.status !== 'queued') throw new Error('Invalid installation attempt');
  try { return await installPersonal(request.source, home, { requestId: request.requestId, expectedCandidateHead: request.candidateHead }); }
  catch (error) { await report(home, request.requestId, { status: 'failed', error: error.message }); throw error; }
}

async function reconcileStoppedAttempt(home, attempt) {
  const installation = await readJson(statePath(home, 'install'), null).catch(() => null);
  const installed = installation?.packageRoot
    ? await readJson(join(installation.packageRoot, '.personal-install.json'), null).catch(() => null)
    : null;
  const value = installed?.candidateHead === attempt.candidateHead
    ? { ...attempt, status: 'installed', packageRoot: installation.packageRoot, reconciled: true,
      updatedAt: new Date().toISOString() }
    : { ...attempt, status: 'failed', error: 'Installer exited without committing the requested candidate',
      reconciled: true, updatedAt: new Date().toISOString() };
  await atomicJson(attemptPath(home), value).catch(() => {});
  return value;
}

export async function waitForInstall(home, requestId, { timeoutMs = 35 * 60_000, cleanup = true } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let attempt = await readJson(attemptPath(home), null).catch(() => null);
    if (!attempt || attempt.requestId !== requestId) throw new Error('Installation attempt is no longer available');
    if (!terminalInstallStates.has(attempt.status)) {
      const queuedFor = Date.now() - Date.parse(attempt.queuedAt ?? attempt.updatedAt ?? '');
      if (Number.isFinite(queuedFor) && queuedFor >= 5_000 && !await installerRunning(home)) {
        attempt = await reconcileStoppedAttempt(home, attempt);
      }
    }
    if (terminalInstallStates.has(attempt.status)) {
      if (cleanup) {
        for (let i = 0; i < 40 && await installerRunning(home); i++) await sleep(250);
        if (!await installerRunning(home)) await jobAction(home, 'installer', 'remove').catch(() => {});
      }
      if (attempt.status === 'failed') throw Object.assign(new Error(attempt.error ?? 'Installation failed'), { attempt });
      const garbage = await (await import('./gc.mjs')).collectGarbage(home).catch(error => ({ error: error.message }));
      return { ...attempt, garbage };
    }
    await sleep(250);
  }
  throw new Error('Timed out waiting for installation to finish');
}

export async function requestInstallAndWait(source, home = stateHome(), { expectedCandidateHead, ...waitOptions } = {}) {
  const queued = await requestInstall(source, home, { expectedCandidateHead });
  return waitForInstall(home, queued.requestId, waitOptions);
}
