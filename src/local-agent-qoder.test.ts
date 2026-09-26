import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  QoderCliLocalAgentDriver,
  qoderCliArgs,
} from "./local-agent-qoder.js";

const context = {
  agentId: "agt_qoder",
  provider: "qoder" as const,
  workspaceRoot: "/tmp/project",
  writeMode: "allowed" as const,
  model: "Qwen3.8-Flash",
  effort: "high",
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
  "--model",
  "Qwen3.8-Flash",
  "--reasoning-effort",
  "high",
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
  "--model",
  "Qwen3.8-Flash",
  "--reasoning-effort",
  "high",
]);

assert.deepEqual(qoderCliArgs({
  ...context,
  writeMode: "full_access",
}, "local-session", context.agentId).slice(-2), [
  "--reasoning-effort",
  "high",
]);
assert.ok(qoderCliArgs({
  ...context,
  writeMode: "full_access",
}, "local-session", context.agentId).includes("bypass_permissions"));

assert.throws(
  () => qoderCliArgs({ ...context, writeMode: "read_only" }, "local-session", context.agentId),
  /hard read-only headless mode/,
);
assert.throws(
  () => qoderCliArgs({
    ...context,
    providerSessionId: "qs_01m3er8cxxwm6aax8wydm8n72v",
  }, "ignored", context.agentId),
  /retired Remote Control session/,
);

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
    { ...process.env, QODER_TEST_MARKER: marker },
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
    effort: "high",
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
