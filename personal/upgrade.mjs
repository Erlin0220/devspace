import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import semver from 'semver';
import { recordInstallable } from './artifact.mjs';

const exec = promisify(execFile);
export const UPSTREAM = 'https://github.com/Waishnav/devspace.git';
export const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const stableVersion = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) && semver.valid(value) === value;

export function selectStable(releases, registry) {
  const official = releases.filter(r => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name ?? '') && stableVersion(r.tag_name.slice(1)))
    .sort((a, b) => semver.rcompare(a.tag_name.slice(1), b.tag_name.slice(1)))[0];
  if (!official) throw new Error('No official stable release was found');
  const version = official.tag_name.slice(1);
  const published = Object.keys(registry.versions ?? {}).filter(stableVersion).sort(semver.rcompare)[0];
  // A publish in progress, retagged beta, or disagreement requires review, never fallback to main.
  if (published !== version || registry['dist-tags']?.latest !== version || registry.versions[version]?.deprecated) {
    throw new Error('GitHub stable and npm latest disagree; refusing an automatic baseline selection');
  }
  return { version, tag: official.tag_name, publishedAt: official.published_at, notes: official.body ?? '',
    url: `https://github.com/Waishnav/devspace/releases/tag/${official.tag_name}` };
}

async function json(url, { signal, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    headers: { Accept: 'application/json', 'User-Agent': 'Personal-DevSpace-stable-review' } });
  if (!response.ok) throw new Error(`Stable discovery failed (${response.status})`);
  return response.json();
}

export async function discoverStable(options = {}) {
  const releases = [];
  for (let page = 1; ; page++) {
    if (page > 20) throw new Error('Release history exceeds bounded discovery; review upstream manually');
    const batch = await json(`https://api.github.com/repos/Waishnav/devspace/releases?per_page=100&page=${page}`, options);
    if (!Array.isArray(batch)) throw new Error('Invalid official release metadata');
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  const registry = await json('https://registry.npmjs.org/@waishnav%2fdevspace', options);
  return selectStable(releases, registry);
}

async function git(cwd, args, timeout = 120000) {
  try { return (await exec('git', args, { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout.trim(); }
  catch (error) { throw new Error(`git ${args[0]} failed: ${String(error.stderr ?? error.message).slice(-5000)}`); }
}
export async function runVerification(cwd, onProgress = () => {}) {
  const stages = [ ['install', ['ci', '--no-audit', '--no-fund']], ['typecheck', ['run', 'typecheck']],
    ['upstream-tests', ['test']], ['build', ['run', 'build']], ['native', ['run', 'personal:native']], ['personal-tests', ['run', 'test:personal']] ];
  const { spawn } = await import('node:child_process');
  const results = [];
  for (const [name, args] of stages) {
    onProgress(name);
    const log = join(cwd, '.personal-review', `${name}.log`);
    await mkdir(dirname(log), { recursive: true });
    const { open } = await import('node:fs/promises');
    const handle = await open(log, 'w');
    try {
      const code = await new Promise((resolveExit, reject) => {
        // npm.cmd must go through cmd.exe; all arguments here are fixed, never user input.
        const child = process.platform === 'win32'
          ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], { cwd, windowsHide: true, stdio: ['ignore', handle.fd, handle.fd] })
          : spawn('npm', args, { cwd, stdio: ['ignore', handle.fd, handle.fd] });
        child.once('error', reject);
        child.once('exit', resolveExit);
      });
      results.push({ name, exitCode: code, log });
      if (code !== 0) throw new Error(`${name} failed; inspect ${log}`);
    } finally { await handle.close(); }
  }
  return results;
}

// Native Git does the replay. This never switches/restarts the installed application.
export async function prepareStable({ root = repositoryRoot, onProgress = () => {}, replayCurrent = false } = {}) {
  if (await git(root, ['status', '--porcelain'])) throw new Error('Commit or preserve current changes before preparing an upgrade');
  const baseline = JSON.parse(await readFile(join(root, 'personal', 'upstream.json'), 'utf8'));
  if (!stableVersion(baseline.version) || !/^[a-f0-9]{40}$/.test(baseline.commit)) throw new Error('Invalid recorded stable baseline');
  onProgress('Checking official stable releases');
  const release = await discoverStable();
  if (semver.lt(release.version, baseline.version)) throw new Error('Stable discovery would downgrade the baseline');
  const ref = `refs/remotes/upstream-stable/${release.tag}`;
  await git(root, ['fetch', '--no-tags', UPSTREAM, `${`refs/tags/${release.tag}`}:${ref}`]);
  const commit = await git(root, ['rev-parse', `${ref}^{commit}`]);
  const pkg = JSON.parse(await git(root, ['show', `${commit}:package.json`]));
  if (pkg.name !== '@waishnav/devspace' || pkg.version !== release.version) throw new Error('Official tag/package identity mismatch');
  if (release.version === baseline.version && commit !== baseline.commit) throw new Error('Official stable tag moved; explicit integrity review is required');
  if (commit === baseline.commit && !replayCurrent) return { unchanged: true, version: release.version, commit };
  await git(root, ['merge-base', '--is-ancestor', baseline.commit, 'HEAD']);
  if (await git(root, ['rev-list', '--merges', `${baseline.commit}..HEAD`])) throw new Error('Personal overlay is not linear');
  const head = await git(root, ['rev-parse', 'HEAD']);
  const suffix = `${release.version}-${Date.now()}`;
  const branch = `personal/upgrade-${suffix}`;
  const candidate = join(dirname(root), `DevSpace-review-${suffix}`);
  await git(root, ['config', 'rerere.enabled', 'true']);
  // Reuse rerere resolutions, but leave every conflict resolution unstaged for review.
  await git(root, ['config', 'rerere.autoupdate', 'false']);
  await git(root, ['worktree', 'add', '-b', branch, candidate, head]);
  onProgress(`Replaying overlay in ${candidate}`);
  try {
    await git(candidate, ['rebase', ...(replayCurrent ? ['--force-rebase'] : []), '--onto', commit, baseline.commit]);
    await writeFile(join(candidate, 'personal', 'upstream.json'), `${JSON.stringify({ ...baseline, version: release.version, tag: release.tag, commit }, null, 2)}\n`);
    await git(candidate, ['add', 'personal/upstream.json']);
    if (await git(candidate, ['diff', '--cached', '--name-only'])) await git(candidate, ['commit', '-m', `chore: record official stable ${release.version} baseline`]);
    const candidateHead = await git(candidate, ['rev-parse', 'HEAD']);
    const tests = await runVerification(candidate, onProgress);
    await recordInstallable(candidate, tests, candidateHead);
    const rangeDiff = await git(root, ['range-diff', `${baseline.commit}..${head}`, `${commit}..${candidateHead}`]);
    const modifyingDelta = await git(candidate, ['diff', '--stat', '--diff-filter=M', commit, 'HEAD']);
    const result = { schema: 1, status: 'tested-awaiting-review', version: release.version, commit, branch, candidate, candidateHead, tests,
      note: 'Review range-diff, removed/absorbed patches and behavior regressions before installing. No running version was changed.' };
    await mkdir(join(candidate, '.personal-review'), { recursive: true });
    await writeFile(join(candidate, '.personal-review', 'range-diff.txt'), `${rangeDiff}\n`);
    await writeFile(join(candidate, '.personal-review', 'modifying-delta.txt'), `${modifyingDelta}\n`);
    await writeFile(join(candidate, '.personal-review', 'result.json'), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    throw new Error(`${error.message}\nCandidate retained at ${candidate}; current checkout/runtime are unchanged. Resolve or abort with native git rebase.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const action = process.argv[2] ?? 'check';
    if (!['check', 'prepare', 'replay'].includes(action)) throw new Error('Usage: node personal/upgrade.mjs check|prepare|replay');
    console.log(JSON.stringify(action === 'check' ? await discoverStable() : await prepareStable({ onProgress: console.error, replayCurrent: action === 'replay' }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
