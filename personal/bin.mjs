#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, stateHome } from './state.mjs';
import { jobAction, openBrowser } from './desktop/platform.mjs';
import { operations } from './desktop/main.mjs';

const home = stateHome(); const action = process.argv[2] ?? 'status';
const ops = operations(home);
try {
  if (action === 'runtime' || action === 'desktop') {
    const service = action === 'runtime' ? await (await import('./runtime.mjs')).startRuntime(home)
      : await (await import('./desktop/main.mjs')).startDesktop(home);
    if (service) for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void service.close().catch(error => { console.error(error.message); process.exitCode = 1; }));
  } else if (action === 'install') {
    console.log(JSON.stringify(await (await import('./install.mjs')).requestInstallAndWait(
      process.argv[3] ? resolve(process.argv[3]) : resolve(fileURLToPath(new URL('..', import.meta.url))), home), null, 2));
  } else if (action === 'installer') {
    await (await import('./install.mjs')).runInstaller(home);
  } else if (action === 'migrate') {
    console.log(JSON.stringify(await (await import('./legacy-import.mjs')).importLegacy(home), null, 2));
  } else if (action === 'gc') {
    console.log(JSON.stringify(await (await import('./gc.mjs')).collectGarbage(home, { dryRun: process.argv.includes('--dry-run') }), null, 2));
  } else if (action === 'repair') {
    await ops.repair();
  } else if (action === 'start') {
    await ops.start();
  } else if (action === 'stop') {
    await ops.stop();
  } else if (['pause', 'resume'].includes(action)) {
    await ops[action === 'pause' ? 'suspend' : 'resume']();
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
    console.log(JSON.stringify(await ops[action](), null, 2));
  } else throw new Error('Usage: devspace-personal install [source] | migrate | gc [--dry-run] | start | stop | pause | resume | open | repair | status | diagnostics | check | prepare');
} catch (error) { console.error(error.message); process.exitCode = 1; }
