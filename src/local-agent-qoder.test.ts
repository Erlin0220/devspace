import assert from "node:assert/strict";
import {
  QoderRemoteControlLocalAgentDriver,
  extractQoderRemoteSessionId,
  isQoderRemoteSessionId,
  normalizeQoderTerminalText,
  parseQoderRemoteWorkerLine,
  qoderBootstrapArgs,
  qoderPromptInputChunks,
  qoderRemoteControllerArgs,
  qoderRemoteInputText,
  qoderTopLevelUserTurnKey,
  qoderRemoteSessionUrl,
  qoderRemoteWorkerArgs,
} from "./local-agent-qoder.js";

const context = {
  agentId: "agt_qoder",
  provider: "qoder" as const,
  workspaceRoot: "/tmp/project",
  writeMode: "allowed" as const,
  model: "Qwen3.8-Flash",
  effort: "high",
};

assert.equal(isQoderRemoteSessionId("qs_01m3er8cxxwm6aax8wydm8n72v"), true);
assert.equal(isQoderRemoteSessionId("session-local"), false);
assert.equal(
  qoderRemoteSessionUrl("qs_01m3er8cxxwm6aax8wydm8n72v"),
  "https://qoder.com/agents/session/qs_01m3er8cxxwm6aax8wydm8n72v",
);

assert.deepEqual(qoderRemoteWorkerArgs(context, "qs_remote"), [
  "--remote-control", "qs_remote",
  "--permission-mode", "auto",
  "--model", "Qwen3.8-Flash",
  "--reasoning-effort", "high",
]);
assert.deepEqual(qoderRemoteWorkerArgs(context, "qs_remote", { toolsIsolated: true }), [
  "--remote-control", "qs_remote",
  "--tools", "",
  "--strict-mcp-config",
  "--mcp-config", '{"mcpServers":{}}',
  "--disallowed-tools", "mcp__qw-builtin__present_files",
  "--permission-mode", "auto",
  "--model", "Qwen3.8-Flash",
  "--reasoning-effort", "high",
]);
assert.deepEqual(qoderRemoteControllerArgs(context, "qs_remote"), [
  "--remote-session", "qs_remote",
  "--permission-mode", "auto",
  "--model", "Qwen3.8-Flash",
  "--reasoning-effort", "high",
]);
assert.deepEqual(qoderBootstrapArgs(context, "local-session"), [
  "--session-id", "local-session",
  "--name", "DevSpace agt_qoder",
  "--tools", "",
  "--strict-mcp-config",
  "--mcp-config", '{"mcpServers":{}}',
  "--disallowed-tools", "mcp__qw-builtin__present_files",
  "--permission-mode", "auto",
  "--model", "Qwen3.8-Flash",
  "--reasoning-effort", "high",
]);
assert.deepEqual(qoderBootstrapArgs({
  ...context,
  providerSessionId: "legacy-qoder-session",
}, "ignored"), [
  "--resume", "legacy-qoder-session",
  "--name", "DevSpace agt_qoder",
  "--tools", "",
  "--strict-mcp-config",
  "--mcp-config", '{"mcpServers":{}}',
  "--disallowed-tools", "mcp__qw-builtin__present_files",
  "--permission-mode", "auto",
  "--model", "Qwen3.8-Flash",
  "--reasoning-effort", "high",
]);
assert.throws(
  () => qoderRemoteWorkerArgs({ ...context, writeMode: "read_only" }, "qs_remote"),
  /hard read-only mode/,
);
assert.deepEqual(qoderRemoteWorkerArgs({ ...context, writeMode: "full_access" }, "qs_remote"), [
  "--remote-control", "qs_remote",
  "--permission-mode", "bypass_permissions",
  "--model", "Qwen3.8-Flash",
  "--reasoning-effort", "high",
]);

assert.equal(
  extractQoderRemoteSessionId(
    "Open in browser: https://qoder.com/agents/session/qs_01m3er8cxxwm6aax8wydm8n72v",
  ),
  "qs_01m3er8cxxwm6aax8wydm8n72v",
);
assert.equal(
  extractQoderRemoteSessionId("Status: connected\nSession ID: qs_01abc123"),
  "qs_01abc123",
);

const remoteInput = parseQoderRemoteWorkerLine(JSON.stringify({
  type: "user",
  subtype: "remote_input",
  uuid: "controller-user:turn-1",
  message: {
    role: "user",
    content: [
      { type: "text", text: "first" },
      { type: "text", text: " second" },
    ],
  },
}));
assert.equal(qoderRemoteInputText(remoteInput), "first second");
assert.equal(qoderTopLevelUserTurnKey(remoteInput), "controller-user:turn-1");
assert.equal(qoderTopLevelUserTurnKey({
  type: "user",
  uuid: "background-turn",
  message: { role: "user", content: "<local-command-caveat>meta</local-command-caveat>" },
}), "background-turn");
assert.equal(qoderTopLevelUserTurnKey({
  type: "user",
  uuid: "tool-result",
  message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
}), undefined);
assert.equal(qoderRemoteInputText({ type: "user", message: { content: [] } }), undefined);
assert.throws(() => parseQoderRemoteWorkerLine("not-json"), /malformed JSONL output/);

assert.deepEqual(
  qoderPromptInputChunks("line 1\r\nline 2\u001b[31m\u0000"),
  ["line 1", "\n", "line 2[31m", "\r"],
);

assert.equal(
  normalizeQoderTerminalText("● Remote\u001b[1Cworker\u001b[1Cstate:\u001b[1Cconnected\u001b[K\r\n"),
  "● Remote worker state: connected\n",
);

const driver = new QoderRemoteControlLocalAgentDriver({}, () => "/usr/local/bin/qodercli");
assert.equal(driver.provider, "qoder");
assert.notEqual(
  driver.runtimeKey(context),
  driver.runtimeKey({ ...context, agentId: "agt_other" }),
  "Qoder Remote Control runtimes must remain agent-owned",
);
