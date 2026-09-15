import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Run this same behavior probe against the pristine stable worktree and the overlay.
const root = resolve(process.argv[2] ?? '.');
const source = (name: string) => import(pathToFileURL(join(root, 'src', `${name}.ts`)).href);
const [{ loadConfig }, { WorkspaceRegistry }, { ProcessSessionManager }, { createMcpServer }, { createReviewCheckpointManager }] =
  await Promise.all(['config', 'workspaces', 'process-sessions', 'server', 'review-checkpoints'].map(source));
const temporary = await mkdtemp(join(tmpdir(), 'personal-baseline-probe-'));
const agentDir = join(temporary, 'agents'); await mkdir(agentDir);
const config = loadConfig({ DEVSPACE_CONFIG_DIR: join(temporary, 'config'), DEVSPACE_ALLOWED_ROOTS: temporary,
  DEVSPACE_STATE_DIR: join(temporary, 'state'), DEVSPACE_WORKTREE_ROOT: join(temporary, 'worktrees'),
  DEVSPACE_AGENT_DIR: agentDir, DEVSPACE_SUBAGENTS: '1', DEVSPACE_TOOL_MODE: 'codex', DEVSPACE_WIDGETS: 'off',
  DEVSPACE_OAUTH_OWNER_TOKEN: 'test-owner-token-that-is-long-enough', PORT: '1' });
const registry = new WorkspaceRegistry(config); const processes = new ProcessSessionManager();
const server = createMcpServer(config, registry, createReviewCheckpointManager(), processes, () => [], []);
const client = new Client({ name: 'stable-regression-probe', version: '1.0.0' });
const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
try {
  const opened = await registry.openWorkspace(temporary);
  const baseDir = join(homedir(), '.agents', 'skills', '__personal_probe__');
  opened.workspace.skills.push({ name: '__personal_probe__', description: 'probe', filePath: join(baseDir, 'SKILL.md'), baseDir, source: 'user' });
  let skillPath = false;
  try { skillPath = registry.resolveReadPath(opened.workspace, '~/.agents/skills/__personal_probe__/SKILL.md').absolutePath === join(baseDir, 'SKILL.md'); } catch {}
  const tools = await client.listTools();
  const execute = tools.tools.find(tool => tool.name === 'exec_command');
  assert.ok(execute);
  const properties = execute.inputSchema.properties ?? {};
  const started = await processes.start({ workspaceId: opened.workspace.id, workspaceRoot: temporary, cwd: temporary, command: 'echo PERSONAL_PROCESS_OK', yieldTimeMs: 1000 });
  console.log(JSON.stringify({ root, homeRelativeAdvertisedSkill: skillPath, processWaitArgument: Object.keys(properties).filter(key => /TimeMs$/.test(key)), processExitCode: started.exitCode, processOutput: started.output ?? started.result ?? started }, null, 2));
} finally { processes.shutdown(); await client.close(); await server.close(); await rm(temporary, { recursive: true, force: true }); }
