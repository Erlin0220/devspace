import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  QoderCliLocalAgentDriver,
  qoderInteractiveGoalArgs,
  parseQoderGoalStatus,
  qoderPrompt,
  qoderSessionListContains,
  resolvePowerShell7Command,
} from "./local-agent-qoder.js";

const context = {
  agentId: "agt_qoder",
  provider: "qoder" as const,
  workspaceRoot: "/tmp/project",
  writeMode: "allowed" as const,
  model: "Qwen3.8-Flash",
  effort: "max",
};

assert.equal(qoderPrompt({ prompt: "finish the project", goalTurns: 321 }),
  "/goal finish the project --turns 321");
assert.deepEqual(qoderInteractiveGoalArgs({
  ...context,
  prompt: "finish the project",
  goalTurns: 321,
}, "local-session", context.agentId), [
  "--session-id",
  "local-session",
  "--name",
  "DevSpace agt_qoder",
  "--permission-mode",
  "dont_ask",
  "--context-window",
  "1000000",
  "--model",
  "Qwen3.8-Flash",
  "--reasoning-effort",
  "max",
  "-i",
  "/goal finish the project --turns 321",
]);
assert.deepEqual(qoderInteractiveGoalArgs({
  ...context,
  providerSessionId: "existing-session",
  prompt: "fix the remaining failure",
  goalTurns: 50,
}, "ignored", context.agentId).slice(0, 4), [
  "--resume",
  "existing-session",
  "--permission-mode",
  "dont_ask",
]);
assert.deepEqual(qoderInteractiveGoalArgs({
  ...context,
  writeMode: "full_access",
  prompt: "finish the project",
}, "local-session", context.agentId).slice(4, 6), [
  "--permission-mode",
  "bypass_permissions",
]);
assert.equal(qoderInteractiveGoalArgs({
  ...context,
  providerSessionId: "existing-session",
  prompt: "fix the remaining failure",
  goalTurns: 50,
}, "ignored", context.agentId).at(-1), "/goal fix the remaining failure --turns 50");
assert.throws(
  () => qoderInteractiveGoalArgs({ ...context, writeMode: "read_only", prompt: "inspect" }, "local-session", context.agentId),
  /hard read-only mode/,
);
assert.throws(
  () => qoderInteractiveGoalArgs({
    ...context,
    providerSessionId: "qs_01m3er8cxxwm6aax8wydm8n72v",
    prompt: "resume",
  }, "ignored", context.agentId),
  /retired Remote Control session/,
);
assert.equal(parseQoderGoalStatus("**Status:** active\n**Turns:** 2 / 10"), "active");
assert.equal(parseQoderGoalStatus("**Status:** paused\n**Turns:** 10 / 10"), "paused");
assert.equal(parseQoderGoalStatus("**Status:** complete"), "complete");
assert.equal(parseQoderGoalStatus("There is no active goal."), "none");
assert.equal(parseQoderGoalStatus("temporarily unavailable"), "unknown");
assert.equal(qoderSessionListContains("1. DevSpace [session-one]", "session-one"), true);
assert.equal(qoderSessionListContains("1. DevSpace [session-two]", "session-one"), false);

const driver = new QoderCliLocalAgentDriver({}, () => "/usr/local/bin/qodercli");
assert.equal(driver.provider, "qoder");
assert.notEqual(
  driver.runtimeKey(context),
  driver.runtimeKey({ ...context, agentId: "agt_other" }),
  "Qoder CLI runtimes must remain agent-owned",
);
assert.match(driver.runtimeKey(context), /^qoder-native-cli:/);
assert.doesNotThrow(() => driver.cleanupInterruptedProcess({
  agentId: "agt_legacy",
  processId: process.pid,
  executionOwner: "legacy",
}), "legacy Qoder cleanup without persisted session evidence must never attempt PID termination");

const root = await mkdtemp(join(tmpdir(), "devspace-qoder-cli-test-"));
const workspaceRoot = join(root, "workspace");
try {
  await mkdir(workspaceRoot, { recursive: true });
  const fakePwsh = join(root, "pwsh.exe");
  await writeFile(fakePwsh, "");
  if (process.platform !== "win32") await chmod(fakePwsh, 0o700);
  assert.equal(resolvePowerShell7Command({ PATH: root, ProgramFiles: "", LOCALAPPDATA: "" }), resolve(fakePwsh));

  const created = await driver.createRuntime({
    ...context,
    workspaceRoot,
  });
  assert.equal(created.isOk(), true);
  if (created.isErr()) throw created.error;
  const runtime = created.value;

  const turnResult = await runtime.run({
    prompt: "ordinary hidden turn must not run",
    workspaceRoot,
    writeMode: "allowed",
    model: "Qwen3.8-Flash",
    effort: "max",
  });
  assert.equal(turnResult.isErr(), true);
  if (turnResult.isErr()) assert.match(turnResult.error.message, /native visible Goal TUI/);
  await runtime.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
