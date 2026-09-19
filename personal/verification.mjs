import { execFile } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import crossSpawn from 'cross-spawn';

const exec = promisify(execFile);
export const VERIFICATION_STAGES = [
  { name: 'install', args: ['ci', '--no-audit', '--no-fund'], timeoutMs: 10 * 60_000 },
  { name: 'typecheck', args: ['run', 'typecheck'], timeoutMs: 5 * 60_000 },
  { name: 'upstream-tests', args: ['test'], timeoutMs: 15 * 60_000 },
  { name: 'build', args: ['run', 'build'], timeoutMs: 10 * 60_000 },
  { name: 'native', args: ['run', 'personal:native'], timeoutMs: 15 * 60_000 },
  { name: 'personal-tests', args: ['run', 'test:personal'], timeoutMs: 10 * 60_000 },
];

async function stopProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    await exec(taskkill, ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 10_000 }).catch(() => {});
    return;
  }
  child.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 1_000));
  if (child.exitCode === null) child.kill('SIGKILL');
}

export async function runNpmCommand(cwd, args, { timeoutMs = 10 * 60_000, signal, stdio = 'inherit' } = {}) {
  let timer;
  let abort;
  const child = crossSpawn('npm', args, { cwd, windowsHide: true, stdio });
  try {
    return await new Promise((resolveExit, reject) => {
      let settled = false;
      const settle = callback => value => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      const fail = settle(reject);
      const finish = settle(resolveExit);
      child.once('error', fail);
      child.once('exit', finish);
      const cancel = reason => {
        if (settled) return;
        settled = true;
        void stopProcessTree(child).finally(() => reject(reason));
      };
      timer = setTimeout(() => cancel(new Error('npm ' + args.join(' ') + ' timed out after ' + timeoutMs + 'ms')), timeoutMs);
      timer.unref?.();
      if (signal) {
        abort = () => cancel(Object.assign(new Error('npm command cancelled'), { name: 'AbortError' }));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }
    });
  } finally {
    clearTimeout(timer);
    if (signal && abort) signal.removeEventListener('abort', abort);
  }
}

async function runStage(cwd, stage, { signal } = {}) {
  const log = join(cwd, '.personal-review', stage.name + '.log');
  await mkdir(join(cwd, '.personal-review'), { recursive: true });
  const handle = await open(log, 'w');
  const started = performance.now();
  try {
    const code = await runNpmCommand(cwd, stage.args, {
      timeoutMs: stage.timeoutMs,
      signal,
      stdio: ['ignore', handle.fd, handle.fd],
    });
    if (code !== 0) throw new Error(stage.name + ' failed; inspect ' + log);
    return { name: stage.name, exitCode: code, log, durationMs: Math.round(performance.now() - started) };
  } finally {
    await handle.close();
  }
}

export async function runVerification(cwd, onProgress = () => {}, options = {}) {
  const results = [];
  for (const stage of VERIFICATION_STAGES) {
    onProgress(stage.name);
    results.push(await runStage(cwd, stage, options));
  }
  return results;
}
