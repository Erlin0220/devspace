import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { atomicJson, readJson, stateHome } from '../state.mjs';
import { approvedProjectRoot, readPersonalConfig } from '../config.mjs';
import { agentDaemonStatus, runtimeSettings } from '../runtime.mjs';
import { discoverStable, prepareStable } from '../upgrade.mjs';
import { createDesktopController } from './controller.mjs';
import { startLocalControl } from './local-control.mjs';
import { chooseFolder, installRecord, jobAction, jobStatus, openBrowser, openLogs, ownerId, registerDesktopEntries, registerJobs, serviceComponents } from './platform.mjs';
import semver from 'semver';
import { setTimeout as sleep } from 'node:timers/promises';

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const baseline = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));
async function candidateStatus(home) {
  const review = await readJson(join(home, 'upgrade-review.json'), null).catch(() => null);
  if (!review?.candidate || !review.candidateHead) return review;
  const manifest = await readJson(join(review.candidate, '.personal-review', 'candidate.json'), null).catch(() => null);
  const attempt = await readJson(join(home, 'install-attempt.json'), null).catch(() => null);
  const applied = attempt?.status === 'installed' && attempt.candidateHead === review.candidateHead;
  return { ...review,
    status: applied ? 'applied' : review.status,
    version: manifest?.upstream?.version,
    branch: manifest?.branch,
    verifiedAt: manifest?.verifiedAt,
    tests: manifest?.stages };
}
export async function status(home = stateHome()) {
  const { config, personal, auth } = await runtimeSettings(home);
  const origin = `http://127.0.0.1:${config.port}`;
  const probe = await fetch(`${origin}/personal-healthz`, { signal: AbortSignal.timeout(2000) }).then(async response => response.ok ? response.json() : null).catch(() => null);
  const agentd = await agentDaemonStatus(home, config).catch(error => ({ activeTurns: null, runtimeCount: null, error: error.message }));
  return { running: probe?.name === 'personal-devspace' && probe.owner === ownerId(home), paused: personal.paused,
    version: baseline.version, projectRoot: personal.projectRoot ?? (config.allowedRoots.length === 1 ? config.allowedRoots[0] : undefined),
    allowedRoots: config.allowedRoots, endpoint: `${origin}/mcp`,
    apiTokenConfigured: Boolean(auth.apiToken), codegraphEnabled: personal.codegraph?.enabled === true,
    runningProcesses: probe?.owner === ownerId(home) ? probe.runningProcesses ?? 0 : 0,
    activeAgentTurns: agentd.activeTurns, agentRuntimeCount: agentd.runtimeCount, agentStatusError: agentd.error,
    overlayCommit: probe?.owner === ownerId(home) ? probe.overlayCommit : undefined,
    candidate: await candidateStatus(home),
    installation: await readJson(join(home, 'install-attempt.json'), null).catch(() => null) };
}
async function requireIdle(home) {
  const snapshot = await status(home);
  if (snapshot.runningProcesses > 0) throw new Error('仍有命令正在执行，请结束任务后再操作');
  if (snapshot.activeAgentTurns > 0) throw new Error('仍有子代理任务正在执行，请结束任务后再操作');
  if (snapshot.activeAgentTurns === null) throw new Error('无法确认子代理是否空闲，请检查诊断后再操作');
}
async function startReady(home) {
  await jobAction(home, 'runtime', 'start');
  for (let i = 0; i < 60; i++) { if ((await status(home)).running) return; await sleep(250); }
  throw new Error('Runtime 未能启动，请查看诊断日志');
}
async function stopReady(home) {
  await jobAction(home, 'runtime', 'stop');
  for (let i = 0; i < 40; i++) { if (!(await status(home)).running) return; await sleep(100); }
  throw new Error('Runtime owner stopped but the health endpoint is still responding');
}
export function operations(home = stateHome()) {
  return {
    status: () => status(home),
    start: async () => {
      if (!(await readPersonalConfig(home)).paused) await startReady(home);
      await jobAction(home, 'desktop', 'start');
    },
    stop: async () => {
      await requireIdle(home);
      const results = await Promise.allSettled([stopReady(home), jobAction(home, 'desktop', 'stop')]);
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'Some Personal services could not be stopped');
    },
    suspend: async () => { await requireIdle(home); await atomicJson(join(home, 'intent.json'), { paused: true }); await stopReady(home); },
    resume: async () => {
      await atomicJson(join(home, 'intent.json'), { paused: false });
      try { await startReady(home); }
      catch (error) { await atomicJson(join(home, 'intent.json'), { paused: true }); throw error; }
    },
    restart: async () => { await requireIdle(home); await stopReady(home); if (!(await readPersonalConfig(home)).paused) await startReady(home); },
    repair: async () => {
      const installed = await installRecord(home);
      // Re-register definitions only; a healthy Runtime is not restarted.
      await registerJobs(home, installed.packageRoot, serviceComponents);
      let entryError; try { await registerDesktopEntries(home, installed.packageRoot); } catch (error) { entryError = error; }
      await jobAction(home, 'desktop', 'start');
      if (entryError) throw entryError;
    },
    'project-root': async ({ projectRoot }) => {
      const root = await approvedProjectRoot(projectRoot);
      const before = await readJson(join(home, 'personal.json'), { schema: 1 });
      if (before.projectRoot === root) return;
      const paused = (await readPersonalConfig(home)).paused;
      await requireIdle(home);
      await stopReady(home);
      try { await atomicJson(join(home, 'personal.json'), { ...before, projectRoot: root }); if (!paused) await startReady(home); }
      catch (error) { await stopReady(home).catch(() => {}); await atomicJson(join(home, 'personal.json'), before); if (!paused) await startReady(home); throw error; }
    },
    'choose-folder': async input => chooseFolder({ ...input, projectRoot: (await status(home)).projectRoot }),
    logs: () => openLogs(home),
    diagnostics: async () => {
      const safe = async operation => operation().catch(error => ({ error: error.message }));
      return { schema: 1, platform: process.platform, architecture: process.arch, node: process.version,
        upstream: baseline,
        runtime: await safe(() => status(home)),
        jobs: Object.fromEntries(await Promise.all(['runtime', 'desktop', 'installer'].map(async component => [component, await safe(() => jobStatus(home, component))]))),
        install: await readJson(join(home, 'install.json'), null).catch(error => ({ error: error.message })),
        attempt: await readJson(join(home, 'install-attempt.json'), null).catch(error => ({ error: error.message })),
        desktop: await readJson(join(home, 'desktop-status.json'), null).catch(error => ({ error: error.message })) };
    },
    'update-check': async ({ signal }) => { const release = await discoverStable({ signal }); return { ...release, available: semver.gt(release.version, baseline.version) }; },
    'update-prepare': async ({ onProgress }) => {
      const personal = await readPersonalConfig(home);
      const result = await prepareStable({ root: personal.sourceRoot ?? packageRoot, onProgress });
      const review = { schema: 1, status: 'tested-awaiting-review', candidate: result.candidate, candidateHead: result.candidateHead,
        preparedAt: new Date().toISOString() };
      await atomicJson(join(home, 'upgrade-review.json'), review);
      return { ...review, version: result.version, branch: result.branch, tests: result.tests };
    },
    'update-apply': async () => {
      await requireIdle(home);
      const candidate = await readJson(join(home, 'upgrade-review.json'));
      if (candidate?.status !== 'tested-awaiting-review' || !candidate.candidate) throw new Error('没有经过完整验证的升级候选');
      const approved = { ...candidate, approvedCandidateHead: candidate.candidateHead, approvedAt: new Date().toISOString() };
      await atomicJson(join(home, 'upgrade-review.json'), approved);
      try {
        const result = await (await import('../install.mjs')).requestInstallAndWait(candidate.candidate, home,
          { expectedCandidateHead: candidate.candidateHead });
        await atomicJson(join(home, 'upgrade-review.json'), { ...approved, status: 'applied', appliedAt: new Date().toISOString(),
          requestId: result.requestId });
        return result;
      } catch (error) {
        await atomicJson(join(home, 'upgrade-review.json'), { ...approved, lastInstallError: error.message, lastInstallAt: new Date().toISOString() }).catch(() => {});
        throw error;
      }
    },
    exit: async () => {
      await requireIdle(home);
      await atomicJson(join(home, 'intent.json'), { paused: true });
      // Let the desktop owner exit itself after the core stop has settled.
      await stopReady(home);
    },
  };
}
export function trayState(snapshot) {
  const ready = snapshot.running && !snapshot.paused;
  const item = (id, text, action, enabled = !snapshot.busy) => ({ id, text, action, enabled });
  return { status: snapshot.status, iconStatus: snapshot.status, tooltip: `Personal DevSpace · ${snapshot.activity ?? (snapshot.paused ? '已暂停' : ready ? '运行中' : '需要检查')}`,
    menu: [item('state', ready ? 'Runtime 正常运行' : snapshot.paused ? '服务已暂停' : 'Runtime 未就绪', '', false),
      item('settings', '打开控制中心', 'open', true), item('toggle', ready ? '暂停服务' : '恢复服务', ready ? 'suspend' : 'resume'),
      item('restart', '重启 Runtime', 'restart'), item('updates', '检查官方稳定版', 'update-check'),
      item('logs', '打开日志', 'logs', true), item('exit', '停止服务并退出', 'exit')] };
}
export async function startDesktop(home = stateHome(), { nativePath, onEvidence = console.log } = {}) {
  const desktopOperations = operations(home);
  const controller = createDesktopController(desktopOperations);
  const warnings = {};
  let control, tray, unsubscribe, retry, closing = false, attempts = 0;
  const report = () => atomicJson(join(home, 'desktop-status.json'), { schema: 1, pid: process.pid,
    control: Boolean(control), tray: Boolean(tray), warnings, updatedAt: new Date().toISOString() }).catch(() => {});
  const open = async () => {
    if (!control) control = await startLocalControl(controller, { home, openBrowser });
    await control.open();
  };
  const stop = async () => {
    if (closing) return;
    closing = true; clearTimeout(retry); unsubscribe?.();
    await controller.dispose(); tray?.stdin.end();
    await control?.close(); await report();
  };
  const launchTray = () => {
    if (closing) return;
    const executable = nativePath ?? join(packageRoot, 'personal', 'bin', process.platform === 'win32' ? 'personal-devspace-tray.exe' : 'personal-devspace-tray');
    if (!['win32', 'darwin'].includes(process.platform)) { warnings.tray = 'Native tray is available on Windows/macOS; Control Center remains available'; void report(); return; }
    const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PERSONAL_DEVSPACE_TRAY_INSTANCE_ID: createHash('sha256').update(process.platform === 'win32' ? resolve(home).toLowerCase() : resolve(home)).digest('hex') } });
    tray = child;
    child.stdin.on('error', () => {});
    child.stderr.on('data', chunk => process.stderr.write(`[personal-tray] ${String(chunk).slice(0, 4096)}`));
    const lines = createInterface({ input: child.stdout });
    const send = state => { if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(trayState(state))}\n`); };
    unsubscribe = controller.subscribe(send);
    lines.on('line', line => {
      if (line.length > 65536) return;
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.event === 'tray-visible') { delete warnings.tray; onEvidence('Personal tray visible'); void report(); }
      if (event.event !== 'menu' || typeof event.action !== 'string') return;
      const operation = event.action === 'open' ? open() : controller.dispatch(event.action);
      void operation.then(async () => { if (event.action === 'exit') await stop(); }, error => { warnings.action = error.message; void report(); });
    });
    let finished = false;
    const failed = error => {
      if (finished) return; finished = true; lines.close(); unsubscribe?.(); tray = undefined;
      if (!closing) { warnings.tray = error?.code ?? 'Native tray exited; Control Center and Runtime are independent';
        if (++attempts <= 3) retry = setTimeout(launchTray, 1000 * attempts); }
      void report();
    };
    child.once('error', failed); child.once('exit', () => failed());
  };
  const repairEntry = desktopOperations.repair;
  desktopOperations.repair = async () => {
    await repairEntry();
    if (!control) { control = await startLocalControl(controller, { home, openBrowser }); delete warnings.control; }
    if (!tray) { clearTimeout(retry); attempts = 0; launchTray(); }
    await report();
  };
  // Each optional frontend is started independently, with observable partial failure.
  controller.start();
  try { control = await startLocalControl(controller, { home, openBrowser }); }
  catch (error) { warnings.control = error.message; }
  launchTray(); await report();
  return { controller, open, close: stop };
}
