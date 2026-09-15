#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, stateHome } from './state.mjs';
import { jobAction, openBrowser, registerDesktopEntries, registerJobs, installRecord } from './desktop/platform.mjs';

const home = stateHome(); const action = process.argv[2] ?? 'status';
try {
  if (action === 'runtime' || action === 'desktop') {
    const service = action === 'runtime' ? await (await import('./runtime.mjs')).startRuntime(home)
      : await (await import('./desktop/main.mjs')).startDesktop(home);
    if (service) for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void service.close().catch(error => { console.error(error.message); process.exitCode = 1; }));
  } else if (action === 'install') {
    console.log(JSON.stringify(await (await import('./install.mjs')).requestInstall(process.argv[3] ? resolve(process.argv[3]) : resolve(fileURLToPath(new URL('..', import.meta.url))), home)));
  } else if (action === 'installer') {
    await (await import('./install.mjs')).runInstaller(home);
  } else if (action === 'migrate') {
    console.log(JSON.stringify(await (await import('./legacy-import.mjs')).importLegacy(home), null, 2));
  } else if (action === 'repair') {
    const installed = await installRecord(home); await registerJobs(home, installed.packageRoot);
    let entryError; try { await registerDesktopEntries(home, installed.packageRoot); } catch (error) { entryError = error; }
    await jobAction(home, 'desktop', 'start'); if (entryError) throw entryError;
  } else if (action === 'start') {
    if (!(await (await import('./config.mjs')).readPersonalConfig(home)).paused) await jobAction(home, 'runtime', 'start');
    await jobAction(home, 'desktop', 'start');
  } else if (action === 'stop') {
    const results = await Promise.allSettled(['runtime', 'desktop'].map(component => jobAction(home, component, 'stop')));
    if (results.some(result => result.status === 'rejected')) throw new Error('Some Personal services could not be stopped');
  } else if (['pause', 'resume'].includes(action)) {
    const ops = (await import('./desktop/main.mjs')).operations(home); await ops[action === 'pause' ? 'suspend' : 'resume']();
  } else if (action === 'open') {
    await jobAction(home, 'desktop', 'start');
    const { setTimeout: sleep } = await import('node:timers/promises');
    let opened = false;
    for (let i = 0; i < 30; i++) {
      const credential = await readJson(join(home, 'control-capability.json'), null).catch(() => null);
      if (credential?.port && /^[A-Za-z0-9_-]{43}$/.test(credential.token ?? '')) {
        const origin = `http://127.0.0.1:${credential.port}`;
        const ready = await fetch(`${origin}/api/state`, { headers: { Authorization: `Bearer ${credential.token}` }, signal: AbortSignal.timeout(1000) }).then(response => response.ok, () => false);
        if (ready) { await openBrowser(`${origin}/#${credential.token}`); opened = true; break; }
      }
      await sleep(200);
    }
    if (!opened) throw new Error('Control Center is unavailable. Run personal status/diagnostics; the Runtime is independent.');
  } else if (['check', 'prepare'].includes(action)) {
    const upgrade = await import('./upgrade.mjs');
    console.log(JSON.stringify(action === 'check' ? await upgrade.discoverStable() : await upgrade.prepareStable({ onProgress: console.error }), null, 2));
  } else if (['status', 'diagnostics'].includes(action)) {
    const ops = (await import('./desktop/main.mjs')).operations(home); console.log(JSON.stringify(await ops[action](), null, 2));
  } else throw new Error('Usage: devspace-personal install [source] | migrate | start | stop | pause | resume | open | repair | status | diagnostics | check | prepare');
} catch (error) { console.error(error.message); process.exitCode = 1; }
