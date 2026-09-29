import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { atomicJson, readJson, stateHome, statePath } from './state.mjs';

const exec = promisify(execFile);

export async function readPersonalConfig(home = stateHome()) {
  const value = await readJson(statePath(home, 'personal'), { schema: 1 });
  if (value?.schema !== 1 || (value.runtimeConfigDir !== undefined && !isAbsolute(value.runtimeConfigDir))) throw new Error('Invalid Personal configuration');
  if (value.projectRoot !== undefined && (typeof value.projectRoot !== 'string' || !isAbsolute(value.projectRoot))) throw new Error('Invalid Personal project directory');
  if (value.sourceRoot !== undefined && (typeof value.sourceRoot !== 'string' || !isAbsolute(value.sourceRoot))) throw new Error('Invalid Personal source directory');
  if (value.codegraph !== undefined && (typeof value.codegraph !== 'object' || Array.isArray(value.codegraph)
      || (value.codegraph.enabled !== undefined && typeof value.codegraph.enabled !== 'boolean')
      || (value.codegraph.idleTimeoutMs !== undefined && (!Number.isInteger(value.codegraph.idleTimeoutMs)
        || value.codegraph.idleTimeoutMs < 0 || value.codegraph.idleTimeoutMs > 600_000)))) throw new Error('Invalid Personal CodeGraph configuration');
  const intent = await readJson(statePath(home, 'intent'), { paused: false });
  if (typeof intent?.paused !== 'boolean') throw new Error('Invalid Personal pause intent');
  return { ...value, codegraph: { enabled: value.codegraph?.enabled === true,
      ...(value.codegraph?.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: value.codegraph.idleTimeoutMs }) },
    runtimeConfigDir: value.runtimeConfigDir ?? join(homedir(), '.devspace'), paused: intent.paused };
}
export async function readPersonalAuth(home = stateHome(), env = process.env) {
  const auth = await readJson(statePath(home, 'auth'), {});
  const apiToken = (env.DEVSPACE_API_TOKEN === '' ? undefined : env.DEVSPACE_API_TOKEN) ?? auth.apiToken;
  if (apiToken !== undefined && (typeof apiToken !== 'string' || !/^[\x21-\x7e]{32,4096}$/.test(apiToken))) throw new Error('Invalid Personal API Token');
  return { apiToken };
}
export async function bindPersonalSourceRoot(home = stateHome(), sourceRoot) {
  sourceRoot = await approvedPersonalSourceRoot(sourceRoot);
  const value = await readJson(statePath(home, 'personal'), { schema: 1 });
  if (value?.schema !== 1) throw new Error('Invalid Personal configuration');
  const next = { ...value, schema: 1, sourceRoot };
  await atomicJson(statePath(home, 'personal'), next);
  return next.sourceRoot;
}
export function runtimeEnvironment(config, env = process.env) {
  const result = { ...env, DEVSPACE_TOOL_MODE: 'codex', DEVSPACE_WIDGETS: 'off', DEVSPACE_CONFIG_DIR: config.runtimeConfigDir };
  if (config.projectRoot) result.DEVSPACE_ALLOWED_ROOTS = config.projectRoot;
  return result;
}
export async function approvedProjectRoot(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error('Choose an absolute project directory');
  const root = await realpath(resolve(value));
  if (!(await stat(root)).isDirectory()) throw new Error('Choose a project directory');
  return root;
}
export async function approvedPersonalSourceRoot(value) {
  const root = await approvedProjectRoot(value);
  let gitRoot;
  try {
    gitRoot = (await exec('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      windowsHide: true,
      timeout: 15_000,
    })).stdout.trim();
  } catch {
    throw new Error('请选择 Personal DevSpace Git checkout');
  }
  if (await realpath(resolve(gitRoot)) !== root) throw new Error('请选择 Personal DevSpace Git checkout 的顶层目录');
  let pkg;
  try { pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); }
  catch { throw new Error('请选择 Personal DevSpace Git checkout'); }
  if (pkg?.name !== '@waishnav/devspace') throw new Error('请选择 Personal DevSpace Git checkout');
  try { await readFile(join(root, 'personal', 'upstream.json'), 'utf8'); }
  catch { throw new Error('所选目录缺少 personal/upstream.json；不是可升级的 Personal DevSpace 源码 checkout'); }
  return root;
}
