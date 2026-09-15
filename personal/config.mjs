import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { readJson, stateHome } from './state.mjs';

export async function readPersonalConfig(home = stateHome()) {
  const value = await readJson(join(home, 'personal.json'), { schema: 1 });
  if (value?.schema !== 1 || (value.runtimeConfigDir !== undefined && !isAbsolute(value.runtimeConfigDir))) throw new Error('Invalid Personal configuration');
  if (value.projectRoot !== undefined && (typeof value.projectRoot !== 'string' || !isAbsolute(value.projectRoot))) throw new Error('Invalid Personal project directory');
  if (value.sourceRoot !== undefined && (typeof value.sourceRoot !== 'string' || !isAbsolute(value.sourceRoot))) throw new Error('Invalid Personal source directory');
  const intent = await readJson(join(home, 'intent.json'), { paused: false });
  if (typeof intent?.paused !== 'boolean') throw new Error('Invalid Personal pause intent');
  return { ...value, runtimeConfigDir: value.runtimeConfigDir ?? join(homedir(), '.devspace'), paused: intent.paused };
}
export async function readPersonalAuth(home = stateHome(), env = process.env) {
  const auth = await readJson(join(home, 'auth.json'), {});
  const apiToken = (env.DEVSPACE_API_TOKEN === '' ? undefined : env.DEVSPACE_API_TOKEN) ?? auth.apiToken;
  if (apiToken !== undefined && (typeof apiToken !== 'string' || !/^[\x21-\x7e]{32,4096}$/.test(apiToken))) throw new Error('Invalid Personal API Token');
  return { apiToken };
}
export function runtimeEnvironment(config, env = process.env) {
  const runtimeEnv = config.runtimeEnv ?? {};
  if (typeof runtimeEnv !== 'object' || Array.isArray(runtimeEnv) || Object.entries(runtimeEnv).some(([key, value]) => !/^DEVSPACE_[A-Z0-9_]+$/.test(key) || typeof value !== 'string')) throw new Error('Invalid upstream environment overrides');
  const result = { DEVSPACE_TOOL_MODE: 'codex', DEVSPACE_WIDGETS: 'off', ...env, ...runtimeEnv, DEVSPACE_CONFIG_DIR: config.runtimeConfigDir };
  if (config.projectRoot) result.DEVSPACE_ALLOWED_ROOTS = config.projectRoot;
  return result;
}
export async function approvedProjectRoot(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error('Choose an absolute project directory');
  const root = await realpath(resolve(value));
  if (!(await stat(root)).isDirectory()) throw new Error('Choose a project directory');
  return root;
}
