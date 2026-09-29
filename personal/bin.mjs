#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, stateHome, statePath } from './state.mjs';

const home = stateHome(); const action = process.argv[2] ?? 'status';
const desktopOperations = async () => (await import('./desktop/main.mjs')).operations(home);
try {
  if (action === 'runtime' || action === 'desktop') {
    const service = action === 'runtime' ? await (await import('./runtime.mjs')).startRuntime(home)
      : await (await import('./desktop/main.mjs')).startDesktop(home);
    if (service) for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void service.close().catch(error => { console.error(error.message); process.exitCode = 1; }));
  } else if (action === 'install') {
    const explicitSource = process.argv[3] ? resolve(process.argv[3]) : undefined;
    const source = explicitSource ?? resolve(fileURLToPath(new URL('..', import.meta.url)));
    const manifest = await (await import('./verify.mjs')).ensureInstallCandidate(source, {
      onProgress: stage => console.error(`VERIFY ${stage}`),
    });
    if (explicitSource) await (await import('./config.mjs')).bindPersonalSourceRoot(home, explicitSource);
    console.log(JSON.stringify(await (await import('./install.mjs')).requestInstallAndWait(source, home, {
      expectedCandidateHead: manifest.candidateHead,
      expectedPayloadSha256: manifest.payload.sha256,
    }), null, 2));
  } else if (action === 'installer') {
    await (await import('./install.mjs')).runInstaller(home);
  } else if (action === 'migrate') {
    console.log(JSON.stringify(await (await import('./legacy-import.mjs')).importLegacy(home), null, 2));
  } else if (action === 'gc') {
    console.log(JSON.stringify(await (await import('./gc.mjs')).collectGarbage(home, { dryRun: process.argv.includes('--dry-run') }), null, 2));
  } else if (action === 'repair') {
    const ops = await desktopOperations();
    await ops.repair();
  } else if (action === 'start') {
    const ops = await desktopOperations();
    await ops.start();
  } else if (action === 'stop') {
    const ops = await desktopOperations();
    await ops.stop();
  } else if (['pause', 'resume'].includes(action)) {
    const ops = await desktopOperations();
    await ops[action === 'pause' ? 'suspend' : 'resume']();
  } else if (action === 'open') {
    const { jobAction, openBrowser } = await import('./desktop/platform.mjs');
    await jobAction(home, 'desktop', 'start');
    const { setTimeout: sleep } = await import('node:timers/promises');
    let opened = false;
    for (let i = 0; i < 30; i++) {
      const credential = await readJson(statePath(home, 'controlCapability'), null).catch(() => null);
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
    const ops = await desktopOperations();
    console.log(JSON.stringify(await ops[action](), null, 2));
  } else throw new Error('Usage: devspace-personal install [source] | migrate | gc [--dry-run] | start | stop | pause | resume | open | repair | status | diagnostics | check | prepare');
} catch (error) { console.error(error.message); process.exitCode = 1; }
