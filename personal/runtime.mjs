import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../dist/config.js';
import { createServer } from '../dist/server.js';
import { personalExtensions } from '../dist/personal/index.js';
import { readPersonalAuth, readPersonalConfig, runtimeEnvironment } from './config.mjs';
import { stateHome } from './state.mjs';
import { ownerId } from './desktop/platform.mjs';
import { readJson } from './state.mjs';

export async function runtimeSettings(home = stateHome()) {
  const personal = await readPersonalConfig(home);
  return { personal, config: loadConfig(runtimeEnvironment(personal)), auth: await readPersonalAuth(home) };
}
export async function startRuntime(home = stateHome()) {
  const { personal, config, auth } = await runtimeSettings(home);
  if (personal.paused) return null;
  const baseline = JSON.parse(await readFile(new URL('./upstream.json', import.meta.url), 'utf8'));
  const installed = await readJson(new URL('../.personal-install.json', import.meta.url), null);
  const running = createServer(config, personalExtensions(config, { ...auth, codegraph: personal.codegraph }));
  running.app.get('/personal-healthz', (_request, response) => response.json({ name: 'personal-devspace', owner: ownerId(home), version: baseline.version,
    overlayCommit: installed?.commit ?? 'development', runningProcesses: running.runningProcessCount() }));
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
