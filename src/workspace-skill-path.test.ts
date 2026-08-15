import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { WorkspaceRegistry } from "./workspaces.js";

test("advertised home-relative skill paths resolve outside the workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-home-skill-test-"));
  const agentDir = join(root, ".agent");
  await mkdir(agentDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const registry = new WorkspaceRegistry(config);
  const opened = await registry.openWorkspace(root);
  const templateSkill = opened.workspace.skills[0];
  assert.ok(templateSkill);

  const skillBaseDir = join(homedir(), ".agents", "skills", "__devspace-test-skill__");
  const skillFilePath = join(skillBaseDir, "SKILL.md");
  opened.workspace.skills.push({
    ...templateSkill,
    name: "__devspace-test-skill__",
    description: "test skill",
    filePath: skillFilePath,
    baseDir: skillBaseDir,
  });

  const resolved = registry.resolveReadPath(
    opened.workspace,
    "~/.agents/skills/__devspace-test-skill__/SKILL.md",
  );

  assert.equal(resolved.absolutePath, skillFilePath);
  assert.equal(resolved.skillRead?.isSkillFile, true);
});
