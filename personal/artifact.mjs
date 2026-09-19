import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { access, lstat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { VERIFICATION_STAGES } from './verification.mjs';

const exec = promisify(execFile);
const requiredStages = VERIFICATION_STAGES.map(stage => stage.name);

async function npmPackMetadata(root) {
  const stdout = await new Promise((resolve, reject) => {
    const chunks = [];
    const child = process.platform === 'win32'
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm pack --json --dry-run --ignore-scripts'], {
        cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      : spawn('npm', ['pack', '--json', '--dry-run', '--ignore-scripts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 8192) stderr = stderr.slice(-8192); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(Buffer.concat(chunks).toString('utf8'))
      : reject(new Error('npm pack metadata failed (' + code + '): ' + stderr)));
  });
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0]?.files)) throw new Error('Invalid npm pack metadata');
  return parsed[0];
}

export async function payloadFiles(root) {
  const metadata = await npmPackMetadata(root);
  const files = metadata.files.map(file => file.path);
  if (await access(join(root, 'package-lock.json')).then(() => true, () => false)) files.push('package-lock.json');
  const unique = [...new Set(files)].sort();
  for (const path of unique) {
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error('Packaging refuses symbolic links: ' + path);
    if (!info.isFile()) throw new Error('Packaging expected a regular file: ' + path);
  }
  return unique;
}

export async function payloadDigest(root, frozenFiles) {
  const files = frozenFiles ?? await payloadFiles(root);
  const hash = createHash('sha256');
  let bytes = 0;
  for (const path of files) {
    const content = await readFile(join(root, path));
    hash.update(path + '\0');
    hash.update(content);
    bytes += content.length;
  }
  return { sha256: hash.digest('hex'), bytes, files };
}

export async function cleanRevision(root) {
  const options = { cwd: root, windowsHide: true, timeout: 30_000 };
  const dirty = (await exec('git', ['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).personal-review'], options)).stdout.trim();
  if (dirty) throw new Error('Commit tracked and untracked changes before creating an installable artifact');
  return (await exec('git', ['rev-parse', 'HEAD'], options)).stdout.trim();
}

async function upstreamIdentity(root) {
  const value = JSON.parse(await readFile(join(root, 'personal', 'upstream.json'), 'utf8'));
  if (typeof value?.version !== 'string' || !/^v?\d+\.\d+\.\d+$/.test(value.tag ?? '')
      || !/^[a-f0-9]{40}$/.test(value.commit ?? '')) throw new Error('Invalid Personal upstream baseline');
  return { version: value.version, tag: value.tag, commit: value.commit };
}

export async function recordCandidate(root, stages, expectedCommit, extra = {}) {
  if (requiredStages.some(name => !stages.some(stage => stage.name === name && stage.exitCode === 0))) {
    throw new Error('Required verification stages have not passed');
  }
  const candidateHead = await cleanRevision(root);
  if (!/^[a-f0-9]{40}$/.test(expectedCommit ?? '') || candidateHead !== expectedCommit) {
    throw new Error('Repository changed during verification; rerun against one frozen commit');
  }
  const payload = await payloadDigest(root);
  const manifest = {
    schema: 1,
    owner: 'personal-devspace',
    candidateHead,
    upstream: await upstreamIdentity(root),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    payload: { sha256: payload.sha256, bytes: payload.bytes, files: payload.files.length },
    verifiedAt: new Date().toISOString(),
    stages: stages.map(stage => ({ name: stage.name, exitCode: stage.exitCode, log: stage.log, durationMs: stage.durationMs })),
    ...extra,
  };
  await mkdir(join(root, '.personal-review'), { recursive: true });
  await writeFile(join(root, '.personal-review', 'candidate.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export async function inspectCandidate(root) {
  const manifest = JSON.parse(await readFile(join(root, '.personal-review', 'candidate.json'), 'utf8'));
  if (manifest?.schema !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch
      || manifest.node !== process.version || manifest.candidateHead !== await cleanRevision(root)) {
    throw new Error('Candidate revision/platform/Node version differs from its verification manifest');
  }
  const baseline = await upstreamIdentity(root);
  if (baseline.version !== manifest.upstream?.version || baseline.tag !== manifest.upstream?.tag || baseline.commit !== manifest.upstream?.commit) {
    throw new Error('Candidate upstream identity differs from its verification manifest');
  }
  return manifest;
}

export async function verifyCandidate(root) {
  const manifest = await inspectCandidate(root);
  const payload = await payloadDigest(root);
  if (payload.sha256 !== manifest.payload?.sha256 || payload.bytes !== manifest.payload?.bytes) {
    throw new Error('Candidate bytes changed after verification');
  }
  return { manifest, payload };
}
