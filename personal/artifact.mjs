import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const directories = ['dist', 'personal', 'scripts', 'skills', 'docs', 'examples'];
const rootFiles = ['package.json', 'package-lock.json', 'LICENSE', 'README.md'];
export async function payloadFiles(root) {
  const files = [];
  async function walk(relative) {
    const info = await lstat(join(root, relative));
    if (info.isSymbolicLink()) throw new Error(`Packaging refuses symbolic links: ${relative}`);
    if (info.isDirectory()) {
      for (const entry of (await readdir(join(root, relative))).sort()) {
        if (['node_modules', 'target', '.git', '.personal-review'].includes(entry)) continue;
        await walk(`${relative}/${entry}`);
      }
    } else files.push(relative);
  }
  for (const directory of directories) await walk(directory);
  for (const file of rootFiles) {
    try { await lstat(join(root, file)); files.push(file); }
    catch (error) { if (['package.json', 'package-lock.json'].includes(file) || error.code !== 'ENOENT') throw error; }
  }
  return files.sort();
}
export async function payloadDigest(root) {
  const files = await payloadFiles(root); const hash = createHash('sha256'); let bytes = 0;
  for (const path of files) { const content = await readFile(join(root, path)); hash.update(`${path}\0`); hash.update(content); bytes += content.length; }
  return { sha256: hash.digest('hex'), bytes, files };
}
export async function cleanRevision(root) {
  const options = { cwd: root, windowsHide: true, timeout: 30000 };
  const dirty = (await exec('git', ['status', '--porcelain'], options)).stdout.trim();
  if (dirty) throw new Error('Commit tracked and untracked changes before creating an installable artifact');
  return (await exec('git', ['rev-parse', 'HEAD'], options)).stdout.trim();
}
export async function recordInstallable(root, stages, expectedCommit) {
  const required = ['install', 'typecheck', 'upstream-tests', 'build', 'native', 'personal-tests'];
  if (required.some(name => !stages.some(stage => stage.name === name && stage.exitCode === 0))) throw new Error('Required verification stages have not passed');
  const commit = await cleanRevision(root);
  if (!/^[a-f0-9]{40}$/.test(expectedCommit ?? '') || commit !== expectedCommit) throw new Error('Repository changed during verification; rerun against one frozen commit');
  const payload = await payloadDigest(root);
  const receipt = { schema: 1, commit, platform: process.platform, arch: process.arch, node: process.version,
    sha256: payload.sha256, bytes: payload.bytes, verifiedAt: new Date().toISOString(), stages: required };
  await mkdir(join(root, '.personal-review'), { recursive: true });
  await writeFile(join(root, '.personal-review/installable.json'), `${JSON.stringify(receipt, null, 2)}\n`); return receipt;
}
export async function verifyInstallable(root) {
  const receipt = JSON.parse(await readFile(join(root, '.personal-review/installable.json'), 'utf8'));
  if (receipt.schema !== 1 || receipt.platform !== process.platform || receipt.arch !== process.arch || receipt.node !== process.version || receipt.commit !== await cleanRevision(root)) throw new Error('Candidate revision/platform/Node version differs from its verification receipt');
  const payload = await payloadDigest(root);
  if (payload.sha256 !== receipt.sha256) throw new Error('Candidate bytes changed after verification');
  return { receipt, payload };
}
