import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from '../dist/config.js';
import { createServer } from '../dist/server.js';
import { personalExtensions } from '../dist/personal/index.js';
import { LocalAgentClient } from '../dist/local-agent-client.js';
import { readPersonalAuth, readPersonalConfig, runtimeEnvironment } from './config.mjs';
import { stateHome } from './state.mjs';
import { ownerId } from './desktop/platform.mjs';
import { readJson } from './state.mjs';

export async function runtimeSettings(home = stateHome()) {
  const personal = await readPersonalConfig(home);
  return { personal, config: loadConfig(runtimeEnvironment(personal)), auth: await readPersonalAuth(home) };
}
async function agentDaemonSnapshot(config, requestTimeoutMs = 750) {
  const result = await new LocalAgentClient({ stateDir: config.stateDir, requestTimeoutMs }).status();
  if (result.isErr()) {
    if (result.error?.code === 'DAEMON_UNAVAILABLE') return { available: false, activeTurns: 0, runtimeCount: 0 };
    return { available: false, activeTurns: null, runtimeCount: null, error: result.error?.code ?? result.error?.message ?? 'unknown' };
  }
  return { available: true, activeTurns: result.value.activeTurns, runtimeCount: result.value.runtimeCount,
    state: result.value.state, pid: result.value.pid };
}
export async function agentDaemonStatus(home = stateHome(), knownConfig) {
  const config = knownConfig ?? (await runtimeSettings(home)).config;
  return agentDaemonSnapshot(config);
}
export async function stopIdleAgentDaemon(home = stateHome()) {
  const { config } = await runtimeSettings(home);
  const snapshot = await agentDaemonSnapshot(config, 1_000);
  if (snapshot.error) throw new Error(`Local agent daemon state is not trustworthy (${snapshot.error})`);
  if (snapshot.activeTurns > 0) throw new Error('Local agent daemon has active turns; installation was not started');
  if (!snapshot.available) return snapshot;
  const result = await new LocalAgentClient({ stateDir: config.stateDir, requestTimeoutMs: 5_000 }).stop();
  if (result.isErr()) throw new Error(`Unable to stop local agent daemon (${result.error?.code ?? result.error?.message ?? 'unknown'})`);
  const probe = new LocalAgentClient({ stateDir: config.stateDir, requestTimeoutMs: 250 });
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    const current = await probe.status();
    if (current.isErr() && current.error?.code === 'DAEMON_UNAVAILABLE') return { ...snapshot, stopped: true };
  }
  throw new Error('Local agent daemon accepted stop but did not exit');
}
export async function startRuntime(home = stateHome()) {
  const { personal, config, auth } = await runtimeSettings(home);
  if (personal.paused) return null;
  const baseline = JSON.parse(await readFile(new URL('./upstream.json', import.meta.url), 'utf8'));
  const installed = await readJson(new URL('../.personal-install.json', import.meta.url), null);
  const running = createServer(config, personalExtensions(config, { ...auth, codegraph: personal.codegraph }));
  running.app.get('/personal-healthz', (_request, response) => response.json({ name: 'personal-devspace', owner: ownerId(home), version: baseline.version,
    overlayCommit: installed?.candidateHead ?? installed?.commit ?? 'development', runningProcesses: running.runningProcessCount() }));
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
