import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertLinearOverlay, repositoryRoot } from './upgrade.mjs';
import { recordCandidate, sourceRevision, verifyCandidate } from './artifact.mjs';
import { runVerification } from './verification.mjs';

const exec = promisify(execFile);
async function git(cwd, args, timeout = 120_000) {
  return exec('git', args, { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
}

export async function materializeVerificationWorktree(root, revision) {
  const scratch = await mkdtemp(join(tmpdir(), 'personal-verify-'));
  const checkout = join(scratch, 'source');
  try {
    await git(root, ['worktree', 'add', '--detach', checkout, revision.candidateHead]);
    await git(checkout, ['read-tree', '--reset', '-u', revision.sourceTree]);
  } catch (error) {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    await git(root, ['worktree', 'prune']).catch(() => {});
    throw error;
  }
  return {
    root: checkout,
    cleanup: async () => {
      const removed = await git(root, ['worktree', 'remove', '--force', checkout]).then(() => true, () => false);
      if (!removed) {
        await rm(checkout, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
        await git(root, ['worktree', 'prune']).catch(() => {});
      }
      await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    },
  };
}

async function promoteVerificationOutputs(root, verifiedRoot, stages) {
  for (const relative of ['dist', join('personal', 'bin')]) {
    const destination = join(root, relative);
    await rm(destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await cp(join(verifiedRoot, relative), destination, { recursive: true, force: true });
  }
  const review = join(root, '.personal-review');
  await mkdir(review, { recursive: true });
  return Promise.all(stages.map(async stage => {
    const log = join(review, stage.name + '.log');
    await cp(stage.log, log, { force: true });
    return { ...stage, log };
  }));
}

export async function verifyCheckout(root = repositoryRoot, { onProgress = () => {}, signal } = {}) {
  const expected = await sourceRevision(root);
  const isolated = await materializeVerificationWorktree(root, expected);
  try {
    await assertLinearOverlay(isolated.root);
    const stages = await runVerification(isolated.root, onProgress, { signal });
    const current = await sourceRevision(root);
    if (current.candidateHead !== expected.candidateHead || current.sourceTree !== expected.sourceTree) {
      throw new Error('Repository changed during verification; rerun against one frozen source tree');
    }
    const promoted = await promoteVerificationOutputs(root, isolated.root, stages);
    return await recordCandidate(root, promoted, expected);
  } finally {
    await isolated.cleanup();
  }
}

export async function ensureInstallCandidate(root = repositoryRoot, options = {}) {
  try { return (await verifyCandidate(root)).manifest; }
  catch { return verifyCheckout(root, options); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = process.argv[2] ? resolve(process.argv[2]) : repositoryRoot;
    console.log(JSON.stringify(await verifyCheckout(root, { onProgress: stage => console.log(`VERIFY ${stage}`) }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
