import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanRevision, recordInstallable } from '../artifact.mjs';
import { selectStable, stableVersion, discoverStable } from '../upgrade.mjs';
const release = (version, extra = {}) => ({ tag_name: `v${version}`, draft: false, prerelease: false, published_at: '2026-09-01', body: 'notes', ...extra });
const registry = version => ({ 'dist-tags': { latest: version, beta: '99.0.0-beta.9' }, versions: { '1.0.7': {}, [version]: {}, '99.0.0-beta.9': {} } });
test('stable selection excludes all prereleases, misleading tags and drafts', () => {
  for (const invalid of ['main', '1.0.9-beta', '2.0.0-alpha.1', '2.0.0-rc.9', '1.0.8+build', '01.0.8']) assert.equal(Boolean(stableVersion(invalid)), false);
  const selected = selectStable([release('99.0.0-beta.9'), release('3.0.0', { draft: true }), release('2.0.0', { prerelease: true }), release('1.0.8'), release('1.0.7')], registry('1.0.8'));
  assert.equal(selected.version, '1.0.8');
});
test('disagreement between npm and official releases fails closed', () => {
  assert.throws(() => selectStable([release('1.0.8')], registry('1.0.9')), /disagree/);
  const latest = registry('1.0.8'); latest['dist-tags'].latest = '99.0.0-beta.9';
  assert.throws(() => selectStable([release('1.0.8')], latest), /disagree/);
  assert.throws(() => selectStable([], registry('1.0.8')), /No official stable/);
});
test('discovery uses canonical official endpoints and never treats a network error as current', async () => {
  const urls = [];
  const found = await discoverStable({ fetchImpl: async url => { urls.push(url); return new Response(JSON.stringify(url.includes('api.github.com') ? [release('1.0.8')] : registry('1.0.8'))); } });
  assert.equal(found.version, '1.0.8'); assert.equal(urls.length, 2);
  await assert.rejects(discoverStable({ fetchImpl: async () => new Response('rate limited', { status: 403 }) }), /403/);
});
test('package and baseline retain official identity; no private version masquerades as upstream', async () => {
  const baseline = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, baseline.version); assert.equal(baseline.channel, 'stable'); assert.ok(stableVersion(pkg.version));
  assert.equal(baseline.repository, 'Waishnav/devspace'); assert.match(baseline.commit, /^[a-f0-9]{40}$/);
});

test('artifact receipt rejects a commit changed while verification was running', async t => {
  const root = await mkdtemp(join(tmpdir(), 'personal-frozen-revision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exec = promisify(execFile);
  const git = args => exec('git', ['-c', 'user.name=Personal Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, windowsHide: true });
  await git(['init', '--quiet']); await git(['commit', '--allow-empty', '-m', 'before']);
  const before = await cleanRevision(root);
  await git(['commit', '--allow-empty', '-m', 'changed-during-tests']);
  const stages = ['install', 'typecheck', 'upstream-tests', 'build', 'native', 'personal-tests'].map(name => ({ name, exitCode: 0 }));
  await assert.rejects(recordInstallable(root, stages, before), /changed during verification/);
});
