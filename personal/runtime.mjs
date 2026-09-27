import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from '../dist/config.js';
import { createServer } from '../dist/server.js';
import { personalExtensions } from '../dist/personal/index.js';
import { LocalAgentClient } from '../dist/local-agent-client.js';
import { readPersonalAuth, readPersonalConfig, runtimeEnvironment } from './config.mjs';
import { readJson, stateHome } from './state.mjs';
import { ownerId } from './ownership.mjs';
import { readUpstreamBaseline } from './upstream.mjs';

export async function runtimeConfig(home = stateHome()) {
  const personal = await readPersonalConfig(home);
  return { personal, config: loadConfig(runtimeEnvironment(personal)) };
}
async function runtimeSettings(home = stateHome()) {
  const current = await runtimeConfig(home);
  return { ...current, auth: await readPersonalAuth(home) };
}
async function runtimeHealthSnapshot(home, config, timeoutMs = 2_000) {
  const origin = `http://127.0.0.1:${config.port}`;
  const response = await fetch(`${origin}/personal-healthz`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' }).catch(() => null);
  const health = response?.ok ? await response.json().catch(() => null) : null;
  if (response && !response.ok) await response.body?.cancel().catch(() => {});
  const owned = Boolean(health?.name === 'personal-devspace' && health.owner === ownerId(home));
  return {
    origin,
    responding: response !== null,
    owned,
    running: owned,
    runningProcesses: owned ? health.runningProcesses ?? 0 : 0,
    overlayCommit: owned ? health.overlayCommit : undefined,
    payloadSha256: owned ? health.payloadSha256 : undefined,
    runtimeVersion: owned ? health.version : undefined,
    activeAgentTurns: owned ? health.activeAgentTurns ?? 0 : 0,
    agentRuntimeCount: owned ? health.agentRuntimeCount ?? 0 : 0,
  };
}
export async function runtimeSnapshot(home = stateHome(), known) {
  const current = known ?? await runtimeConfig(home);
  const runtime = await runtimeHealthSnapshot(home, current.config);
  return {
    ...current,
    ...runtime,
  };
}
export async function waitForRuntime(
  home,
  predicate,
  { attempts = 40, intervalMs = 100, known, errorMessage = 'Runtime state did not converge' } = {},
) {
  const current = known ?? await runtimeConfig(home);
  for (let i = 0; i < attempts; i++) {
    const snapshot = await runtimeSnapshot(home, current);
    if (predicate(snapshot)) return snapshot;
    await sleep(intervalMs);
  }
  throw new Error(errorMessage);
}
// Compatibility cleanup only: Personal web subagents run in-process, but the
// upstream CLI may still have an on-demand agent daemon using the same state DB.
export async function stopCliAgentDaemon(home = stateHome()) {
  const { config } = await runtimeConfig(home);
  const client = new LocalAgentClient({ stateDir: config.stateDir, requestTimeoutMs: 5_000 });
  const result = await client.stopForUpgrade();
  if (result.isErr() && result.error?.code === 'DAEMON_UNAVAILABLE') return { available: false };
  if (result.isErr()) throw new Error(`Unable to stop CLI agent daemon (${result.error?.code ?? result.error?.message ?? 'unknown'})`);
  const probe = new LocalAgentClient({ stateDir: config.stateDir, requestTimeoutMs: 250 });
  for (let i = 0; i < 48; i++) {
    await sleep(250);
    const current = await probe.status();
    if (current.isErr() && current.error?.code === 'DAEMON_UNAVAILABLE') return { available: true, stopped: true };
  }
  throw new Error('CLI agent daemon accepted stop but did not exit');
}
export async function startRuntime(home = stateHome()) {
  const { personal, config, auth } = await runtimeSettings(home);
  if (personal.paused) return null;
  const baseline = await readUpstreamBaseline();
  const installed = await readJson(new URL('../.personal-install.json', import.meta.url), null);
  const runtimeEnv = runtimeEnvironment(personal);
  const resolveSubagentsConfig = () => loadConfig(runtimeEnv).subagents;
  const extensions = personalExtensions(config, {
      ...auth,
      codegraph: personal.codegraph,
      runtimeEnv,
      resolveSubagentsConfig,
    });
  const running = createServer(config, {
    ...extensions,
    resolveSubagentsConfig,
  });
  running.app.get('/personal-healthz', (_request, response) => {
    const agents = extensions.agentStatus();
    response.json({ name: 'personal-devspace', owner: ownerId(home), version: baseline.version,
    overlayCommit: installed?.candidateHead ?? installed?.commit ?? 'development',
    payloadSha256: installed?.payload?.sha256, runningProcesses: running.runningProcessCount(),
    activeAgentTurns: agents.activeTurns, agentRuntimeCount: agents.runtimeCount });
  });
  let http;
  try {
    http = await new Promise((resolve, reject) => {
      const server = running.app.listen(config.port, config.host, () => resolve(server)); server.once('error', reject);
    });
  } catch (error) { await running.close(); throw error; }
  let closing;
  const close = () => closing ??= (async () => {
    await running.close();
    await new Promise(resolve => { http.close(resolve); http.closeAllConnections(); });
  })();
  console.log(`Personal DevSpace stable ${baseline.version}; listening on ${config.host}:${config.port}; optional extensions isolated`);
  return { close, running, http };
}
