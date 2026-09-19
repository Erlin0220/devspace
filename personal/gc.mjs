import { execFile } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { installerRunning } from './desktop/platform.mjs';
import { readJson, stateHome } from './state.mjs';

const LOG_RETENTION_MS = 30 * 24 * 60 * 60_000;
const exec = promisify(execFile);

async function entries(path) {
  return readdir(path, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}

export async function collectGarbage(home = stateHome(), { dryRun = false, now = Date.now() } = {}) {
  const actions = [];
  const remove = async (kind, path, options = { recursive: true, force: true }) => {
    actions.push({ kind, path });
    if (!dryRun) await rm(path, options);
  };
  if (await installerRunning(home)) return { skipped: 'installer-running', actions };

  const installation = await readJson(join(home, 'install.json'), null).catch(() => null);
  const attempt = await readJson(join(home, 'install-attempt.json'), null).catch(() => null);
  const keepApps = new Set([installation?.packageRoot, attempt?.previous].filter(Boolean).map(path => resolve(path)));
  const apps = join(home, 'apps');
  for (const entry of await entries(apps)) {
    if (!entry.isDirectory()) continue;
    const path = join(apps, entry.name);
    if (entry.name.includes('.stage-')) {
      await remove('stale-stage', path);
      continue;
    }
    if (keepApps.has(resolve(path))) continue;
    const receipt = await readJson(join(path, '.personal-install.json'), null).catch(() => null);
    if (receipt?.owner === 'personal-devspace') await remove('old-install', path);
  }

  let sourceDigest;
  if (installation?.packageRoot) {
    sourceDigest = await readJson(join(installation.packageRoot, 'personal', 'bin', 'native-build.json'), null)
      .then(value => value?.sourceDigest, () => undefined);
  }
  const cacheRoot = join(home, 'build-cache');
  const cachePrefix = process.platform + '-' + process.arch + '-';
  const keepCache = sourceDigest ? cachePrefix + sourceDigest : undefined;
  for (const entry of await entries(cacheRoot)) {
    if (!entry.isDirectory() || !entry.name.startsWith(cachePrefix) || entry.name === keepCache) continue;
    if (/^[A-Za-z0-9._-]+-[a-f0-9]{64}$/.test(entry.name)) await remove('old-native-cache', join(cacheRoot, entry.name));
  }

  const logs = join(home, 'logs');
  for (const entry of await entries(logs)) {
    if (!entry.isFile()) continue;
    const path = join(logs, entry.name);
    const info = await stat(path).catch(() => null);
    if (info && now - info.mtimeMs > LOG_RETENTION_MS) await remove('expired-log', path, { force: true });
  }

  const queue = join(home, 'install-queue.json');
  const queued = await readJson(queue, null).catch(() => null);
  if (queued) {
    const age = now - Date.parse(queued.createdAt ?? '');
    if (Number.isFinite(age) && age >= 5 * 60_000) await remove('stale-install-queue', queue, { force: true });
  }
  for (const name of ['install-request.json', 'install-result.json', 'control-endpoint.json']) {
    const path = join(home, name);
    if (await stat(path).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))) {
      await remove('retired-state', path, { force: true });
    }
  }
  const startup = join(home, 'startup');
  if (await stat(startup).then(info => info.isDirectory(), error => error.code === 'ENOENT' ? false : Promise.reject(error))) {
    await remove('retired-task-cache', startup);
  }

  const personal = await readJson(join(home, 'personal.json'), null).catch(() => null);
  const review = await readJson(join(home, 'upgrade-review.json'), null).catch(() => null);
  const sourceRoot = personal?.sourceRoot;
  if (typeof sourceRoot === 'string') {
    const listing = await exec('git', ['worktree', 'list', '--porcelain'], {
      cwd: sourceRoot, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
    }).then(result => result.stdout, () => '');
    const worktrees = listing.split(/\r?\n/).flatMap(line => line.startsWith('worktree ') ? [line.slice(9)] : []);
    for (const worktree of worktrees) {
      if (resolve(worktree) === resolve(sourceRoot) || resolve(worktree) === resolve(review?.candidate ?? sourceRoot)) continue;
      if (!basename(worktree).startsWith('DevSpace-review-')) continue;
      const manifest = await readJson(join(worktree, '.personal-review', 'candidate.json'), null).catch(() => null);
      if (manifest?.owner !== 'personal-devspace' || !/^personal\/upgrade-[A-Za-z0-9._-]+$/.test(manifest.branch ?? '')) continue;
      actions.push({ kind: 'old-review-worktree', path: worktree });
      if (!dryRun) {
        await exec('git', ['worktree', 'remove', '--force', worktree], { cwd: sourceRoot, windowsHide: true, timeout: 60_000 });
        await exec('git', ['branch', '-D', manifest.branch], { cwd: sourceRoot, windowsHide: true, timeout: 30_000 }).catch(() => {});
      }
    }
  }
  return { skipped: false, actions };
}
