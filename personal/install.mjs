import { randomUUID } from 'node:crypto';
import { mkdir, copyFile, rename, access, rm } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson, secureStateDirectory, stateHome, statePath } from './state.mjs';
import { inspectCandidate, payloadDigest, verifyCandidate } from './artifact.mjs';
import { readPersonalAuth, readPersonalConfig } from './config.mjs';
import { installerRunning, jobAction, registerDesktopEntries, registerJobs } from './desktop/platform.mjs';
import { stopCliAgentDaemon, waitForRuntime } from './runtime.mjs';
import { runNpmCommand } from './verification.mjs';
import { legacyTasksAction } from './legacy-import.mjs';

const installerRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const terminalInstallStates = new Set(['installed', 'failed']);
const attemptPath = home => statePath(home, 'installAttempt');
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
async function ready(home, version, commit, payloadSha256) {
  await waitForRuntime(home, snapshot => (
    snapshot.owned && snapshot.runtimeVersion === version && snapshot.overlayCommit === commit
      && snapshot.payloadSha256 === payloadSha256
  ), {
    attempts: 80,
    intervalMs: 250,
    errorMessage: 'Candidate did not become healthy within the readiness window',
  });
}
async function installPersonal(source, home = stateHome(), { requestId, expectedCandidateHead, expectedPayloadSha256 } = {}) {
  await secureStateDirectory(home);
  const { manifest, payload } = await verifyCandidate(source);
  if (expectedCandidateHead && manifest.candidateHead !== expectedCandidateHead) {
    throw new Error('Candidate revision changed after the installation request was approved');
  }
  if (expectedPayloadSha256 && manifest.payload.sha256 !== expectedPayloadSha256) {
    throw new Error('Candidate payload changed after the installation request was approved');
  }
  const stable = manifest.upstream;
  const previous = await readJson(statePath(home, 'install'), null);
  const config = await readPersonalConfig(home);
  if (!(await readPersonalAuth(home, {})).apiToken) throw new Error('Migrate or configure the private Personal API Token before installing');
  if (requestId) await report(home, requestId, { status: 'staging', source, version: stable.version });
  const destination = await copyCandidate(source, home, manifest, payload);
  if (requestId) await report(home, requestId, { status: 'switching', version: stable.version, previous: previous?.packageRoot });
  const result = await activateCandidate({ paused: config.paused,
    stop: async () => {
      try {
        await stopCliAgentDaemon(home);
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
    ready: () => ready(home, stable.version, manifest.candidateHead, manifest.payload.sha256),
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
    candidateHead: manifest.candidateHead, payloadSha256: manifest.payload.sha256, previous: previous?.packageRoot, ...result });
  return result;
}

// The OS starts this outside the invoking MCP process tree. It may safely replace
// the Runtime/desktop without killing itself or unrelated Team/Tunnel processes.
async function requestInstall(source, home = stateHome(), { expectedCandidateHead, expectedPayloadSha256 } = {}) {
  const manifest = await inspectCandidate(source);
  if (expectedCandidateHead && manifest.candidateHead !== expectedCandidateHead) {
    throw new Error('Candidate revision changed after review; prepare and approve it again');
  }
  if (expectedPayloadSha256 && manifest.payload.sha256 !== expectedPayloadSha256) {
    throw new Error('Candidate payload changed after review; prepare and approve it again');
  }
  await secureStateDirectory(home);
  const requestId = randomUUID();
  const path = attemptPath(home);
  if (await installerRunning(home)) throw new Error('An installer is already running');
  const existing = await readJson(path, null).catch(() => null);
  let recoveredFrom;
  if (existing) {
    if (!terminalInstallStates.has(existing.status)) {
      recoveredFrom = { requestId: existing.requestId, status: existing.status,
        error: 'stale attempt recovered because no installer was running' };
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
    payloadSha256: manifest.payload.sha256,
    status: 'queued',
    queuedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(recoveredFrom ? { recoveredFrom } : {}),
  };
  if (!await atomicJson(path, attempt, { createOnly: true })) {
    throw new Error('Another installation request won the queue race');
  }
  try {
    if (await installerRunning(home)) throw new Error('An installer is already running');
    // The OS-owned installer always runs the already executing/trusted Personal
    // implementation. Candidate code is data until verifyCandidate() succeeds.
    await registerJobs(home, installerRoot, ['installer'], { record: false });
    await jobAction(home, 'installer', 'start');
    return { accepted: true, requestId, status: 'queued', candidateHead: manifest.candidateHead, payloadSha256: manifest.payload.sha256 };
  } catch (error) {
    await report(home, requestId, { status: 'failed', error: error.message });
    if (!await installerRunning(home).catch(() => true)) await jobAction(home, 'installer', 'remove').catch(() => {});
    throw error;
  }
}
export async function runInstaller(home = stateHome()) {
  const request = await readJson(attemptPath(home));
  if (request?.schema !== 1 || typeof request.requestId !== 'string' || request.home !== home || !isAbsolute(request.source)
      || !/^[a-f0-9]{40}$/.test(request.candidateHead ?? '') || !/^[a-f0-9]{64}$/.test(request.payloadSha256 ?? '')
      || request.status !== 'queued') throw new Error('Invalid installation attempt');
  try { return await installPersonal(request.source, home, { requestId: request.requestId, expectedCandidateHead: request.candidateHead,
    expectedPayloadSha256: request.payloadSha256 }); }
  catch (error) { await report(home, request.requestId, { status: 'failed', error: error.message }); throw error; }
}

async function reconcileStoppedAttempt(home, attempt) {
  const installation = await readJson(statePath(home, 'install'), null).catch(() => null);
  const installed = installation?.packageRoot
    ? await readJson(join(installation.packageRoot, '.personal-install.json'), null).catch(() => null)
    : null;
  const value = installed?.candidateHead === attempt.candidateHead && installed?.payload?.sha256 === attempt.payloadSha256
    ? { ...attempt, status: 'installed', packageRoot: installation.packageRoot, reconciled: true,
      updatedAt: new Date().toISOString() }
    : { ...attempt, status: 'failed', error: 'Installer exited without committing the requested candidate',
      reconciled: true, updatedAt: new Date().toISOString() };
  return value;
}

export async function reconcileInstallAttempt(home, attempt, { isInstallerRunning = installerRunning } = {}) {
  if (!attempt || terminalInstallStates.has(attempt.status)) return attempt;
  const queuedFor = Date.now() - Date.parse(attempt.queuedAt ?? attempt.updatedAt ?? '');
  if (!Number.isFinite(queuedFor) || queuedFor < 5_000) return attempt;
  let running;
  try { running = await isInstallerRunning(home); }
  catch { return attempt; }
  return running ? attempt : reconcileStoppedAttempt(home, attempt);
}

async function waitForInstall(home, requestId, { timeoutMs = 35 * 60_000, cleanup = true } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let attempt = await readJson(attemptPath(home), null).catch(() => null);
    if (!attempt || attempt.requestId !== requestId) throw new Error('Installation attempt is no longer available');
    attempt = await reconcileInstallAttempt(home, attempt);
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

export async function requestInstallAndWait(source, home = stateHome(), { expectedCandidateHead, expectedPayloadSha256, ...waitOptions } = {}) {
  const queued = await requestInstall(source, home, { expectedCandidateHead, expectedPayloadSha256 });
  return waitForInstall(home, queued.requestId, waitOptions);
}
