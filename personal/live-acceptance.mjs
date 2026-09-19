import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
async function run(action) {
  const result = await exec(process.execPath, ['personal/tests/desktop-live.mjs', action], {
    cwd: process.cwd(),
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

let failure;
try {
  for (const action of ['prepare', 'lifecycle', 'verify']) await run(action);
} catch (error) {
  failure = error;
} finally {
  try { await run('stop'); } catch (error) { failure ??= error; }
}
if (failure) {
  console.error(failure.stderr ?? failure.message);
  process.exitCode = 1;
}
