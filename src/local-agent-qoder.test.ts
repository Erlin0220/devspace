import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  QoderCliLocalAgentDriver,
  qoderCliArgs,
  qoderInteractiveGoalArgs,
  parseQoderGoalStatus,
  qoderPrompt,
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

assert.deepEqual(qoderCliArgs(context, "local-session", context.agentId), [
  "-p",
  "--output-format",
  "text",
  "--session-id",
  "local-session",
  "--name",
  "DevSpace agt_qoder",
  "--permission-mode",
  "auto",
  "--context-window",
  "1000000",
  "--model",
  "Qwen3.8-Flash",
  "--reasoning-effort",
  "max",
]);

assert.deepEqual(qoderCliArgs({
  ...context,
  providerSessionId: "existing-session",
}, "ignored", context.agentId), [
  "-p",
  "--output-format",
  "text",
  "--resume",
  "existing-session",
  "--permission-mode",
  "auto",
  "--context-window",
  "1000000",
  "--model",
  "Qwen3.8-Flash",
  "--reasoning-effort",
  "max",
]);

assert.deepEqual(qoderCliArgs({
  ...context,
  writeMode: "full_access",
}, "local-session", context.agentId).slice(-2), [
  "--reasoning-effort",
  "max",
]);
assert.ok(qoderCliArgs({
  ...context,
  writeMode: "full_access",
}, "local-session", context.agentId).includes("bypass_permissions"));

assert.throws(
  () => qoderCliArgs({ ...context, writeMode: "read_only" }, "local-session", context.agentId),
  /hard read-only mode/,
);
assert.throws(
  () => qoderCliArgs({
    ...context,
    providerSessionId: "qs_01m3er8cxxwm6aax8wydm8n72v",
  }, "ignored", context.agentId),
  /retired Remote Control session/,
);
assert.equal(qoderPrompt({ prompt: "finish the project", executionMode: "goal", goalTurns: 321 }),
  "/goal finish the project --turns 321");
assert.equal(qoderPrompt({ prompt: "normal turn", executionMode: "turn" }), "normal turn");
assert.deepEqual(qoderInteractiveGoalArgs({
  ...context,
  prompt: "finish the project",
  executionMode: "goal",
  goalTurns: 321,
}, "local-session", context.agentId), [
  "--session-id",
  "local-session",
  "--name",
  "DevSpace agt_qoder",
  "--permission-mode",
  "auto",
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
  executionMode: "goal",
  goalTurns: 50,
}, "ignored", context.agentId).slice(0, 4), [
  "--resume",
  "existing-session",
  "--permission-mode",
  "auto",
]);
assert.equal(qoderInteractiveGoalArgs({
  ...context,
  providerSessionId: "existing-session",
  prompt: "fix the remaining failure",
  executionMode: "goal",
  goalTurns: 50,
}, "ignored", context.agentId).at(-1), "/goal fix the remaining failure --turns 50");
assert.equal(parseQoderGoalStatus("**Status:** active\n**Turns:** 2 / 10"), "active");
assert.equal(parseQoderGoalStatus("**Status:** paused\n**Turns:** 10 / 10"), "paused");
assert.equal(parseQoderGoalStatus("**Status:** complete"), "complete");
assert.equal(parseQoderGoalStatus("There is no active goal."), "none");
assert.equal(parseQoderGoalStatus("temporarily unavailable"), "unknown");

const driver = new QoderCliLocalAgentDriver({}, () => "/usr/local/bin/qodercli");
assert.equal(driver.provider, "qoder");
assert.notEqual(
  driver.runtimeKey(context),
  driver.runtimeKey({ ...context, agentId: "agt_other" }),
  "Qoder CLI runtimes must remain agent-owned",
);
assert.match(driver.runtimeKey(context), /^qoder-native-cli:/);

const root = await mkdtemp(join(tmpdir(), "devspace-qoder-cli-test-"));
const workspaceRoot = join(root, "workspace");
const marker = join(root, "args.jsonl");
const recorder = join(root, "record-args.cjs");
const command = join(root, process.platform === "win32" ? "qodercli.cmd" : "qodercli");
try {
  await mkdir(workspaceRoot, { recursive: true });
  const fakePwsh = join(root, "pwsh.exe");
  await writeFile(fakePwsh, "");
  if (process.platform !== "win32") await chmod(fakePwsh, 0o700);
  assert.equal(resolvePowerShell7Command({ PATH: root, ProgramFiles: "", LOCALAPPDATA: "" }), resolve(fakePwsh));

  await writeFile(
    recorder,
    [
      'const fs = require("node:fs");',
      'fs.appendFileSync(process.env.QODER_TEST_MARKER, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'console.log("FAKE QODER OK");',
      "",
    ].join("\n"),
  );
  if (process.platform === "win32") {
    await writeFile(command, '@echo off\r\n"' + process.execPath + '" "' + recorder + '" %*\r\n');
  } else {
    await writeFile(command, '#!/bin/sh\nexec "' + process.execPath + '" "' + recorder + '" "$@"\n', { mode: 0o700 });
    await chmod(command, 0o700);
  }

  const runtimeDriver = new QoderCliLocalAgentDriver(
    { ...process.env, QODER_TEST_MARKER: marker, DEVSPACE_QODER_VISIBLE_TERMINAL: "0" },
    () => command,
  );
  const created = await runtimeDriver.createRuntime({
    ...context,
    workspaceRoot,
  });
  assert.equal(created.isOk(), true);
  if (created.isErr()) throw created.error;
  const runtime = created.value;

  let sessionId: string | undefined;
  const prompt = 'literal & prompt | with "quotes" and spaces';
  const firstResult = await runtime.run({
    prompt,
    workspaceRoot,
    writeMode: "allowed",
    model: "Qwen3.8-Flash",
    effort: "max",
  }, {
    onSessionId: (value) => { sessionId = value; },
  });
  assert.equal(firstResult.isOk(), true);
  if (firstResult.isErr()) throw firstResult.error;
  assert.equal(firstResult.value.finalResponse, "FAKE QODER OK");
  assert.equal(firstResult.value.providerSessionId, sessionId);

  const secondResult = await runtime.run({
    prompt: "/goal resume",
    workspaceRoot,
    providerSessionId: sessionId,
    writeMode: "allowed",
  });
  assert.equal(secondResult.isOk(), true);
  if (secondResult.isErr()) throw secondResult.error;

  const calls = (await readFile(marker, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.at(-1), prompt);
  assert.ok(calls[0]?.includes("--session-id"));
  assert.ok(calls[1]?.includes("--resume"));
  assert.equal(calls[1]?.at(-1), "/goal resume");
  await runtime.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
