import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveSubagentsConfig } from "../../src/local-agent-config.js";
import {
  PersonalSubagentConfig,
  applySubagentConfigPatch,
} from "../../src/personal/subagent-config.js";
import { loadDevspaceFiles } from "../../src/user-config.js";

test("subagent config patch preserves unrelated config and updates routing/provider settings", async () => {
  const home = await mkdtemp(join(tmpdir(), "devspace-subagent-config-"));
  const env = { DEVSPACE_CONFIG_DIR: home };
  const configPath = join(home, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({
      allowedRoots: ["C:\\project"],
      artifactsEnabled: true,
      subagents: {
        enabled: true,
        providers: [
          { id: "codex", enabled: true, model: "gpt-paid", effort: "high" },
          { id: "qoder", enabled: true, model: "Qwen-free", effort: "high" },
          { id: "agy", enabled: true, model: "gemini", effort: "high" },
        ],
      },
    }, null, 2));
    const resolveCurrent = () => resolveSubagentsConfig(
      loadDevspaceFiles(env).config.subagents,
      {},
    );
    const settings = new PersonalSubagentConfig(env, resolveCurrent);
    const snapshot = settings.update({
      providers: [
        { id: "qoder", effort: "medium" },
        { id: "agy", enabled: false },
      ],
      routing: {
        default: ["qoder", "codex", "agy"],
        readOnly: ["qoder", "codex"],
        writable: ["qoder", "codex", "agy"],
      },
    });
    assert.deepEqual(snapshot.config.routing?.default, ["qoder", "codex", "agy"]);
    assert.equal(snapshot.config.providers.find((provider) => provider.id === "qoder")?.effort, "medium");
    assert.equal(snapshot.config.providers.find((provider) => provider.id === "agy")?.enabled, false);
    assert.deepEqual(
      snapshot.capabilities.find((entry) => entry.provider === "agy")?.writeModes,
      ["allowed", "full_access"],
    );
    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(persisted.allowedRoots, ["C:\\project"]);
    assert.equal(persisted.artifactsEnabled, true);
    assert.deepEqual(persisted.subagents.routing.readOnly, ["qoder", "codex"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("subagent config patch removes overrides and rejects duplicate routing targets", () => {
  const current = resolveSubagentsConfig({
    enabled: true,
    providers: [
      { id: "qoder", enabled: true, model: "Qwen-free", effort: "high" },
      { id: "codex", enabled: true },
    ],
    routing: {
      default: ["qoder", "codex"],
      readOnly: ["qoder", "codex"],
    },
  }, {});
  const updated = applySubagentConfigPatch(current, {
    providers: [{ id: "qoder", model: null }],
    routing: { readOnly: null },
  });
  assert.equal(updated.providers.find((provider) => provider.id === "qoder")?.model, undefined);
  assert.deepEqual(updated.routing, { default: ["qoder", "codex"] });
  assert.throws(
    () => applySubagentConfigPatch(current, {
      routing: { default: ["qoder", "qoder"] },
    }),
    /Duplicate subagent routing target: qoder/,
  );
});
