import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { loadWorkspaceSkills } from "./skills.js";

const root = await mkdtemp(join(tmpdir(), "devspace-cangjie-distill-test-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

try {
  process.env.HOME = root;
  process.env.USERPROFILE = root;

  const projectRoot = join(root, "project");
  const agentDir = join(root, ".codex");
  await mkdir(projectRoot, { recursive: true });

  const baseEnv = {
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  };

  const config = loadConfig(baseEnv);
  const loaded = loadWorkspaceSkills(config, projectRoot);
  assert.equal(loaded.skills.filter((skill) => skill.name === "cangjie-distill").length, 1);

  const installedSkill = join(root, ".devspace", "skills", "cangjie-distill", "SKILL.md");
  const firstContent = await readFile(installedSkill, "utf8");
  assert.match(firstContent, /name: cangjie-distill/);
  assert.match(firstContent, /蒸馏资料/);

  await writeFile(installedSkill, `${firstContent}\n<!-- CUSTOM_MARKER -->\n`);
  loadWorkspaceSkills(config, projectRoot);
  const secondContent = await readFile(installedSkill, "utf8");
  assert.match(secondContent, /CUSTOM_MARKER/);

  const subagentConfig = loadConfig({ ...baseEnv, DEVSPACE_SUBAGENTS: "1" });
  const withSubagents = loadWorkspaceSkills(subagentConfig, projectRoot);
  assert.equal(withSubagents.skills.filter((skill) => skill.name === "cangjie-distill").length, 1);
  assert.equal(withSubagents.skills.filter((skill) => skill.name === "subagent-delegation").length, 1);
  assert.equal(
    withSubagents.diagnostics.some(
      (diagnostic) => diagnostic.collision?.name === "cangjie-distill",
    ),
    false,
  );
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  await rm(root, { recursive: true, force: true });
}
