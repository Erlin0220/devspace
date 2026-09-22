import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  AgyRuntime,
  agyCommandEnvironment,
  agyCommandArgs,
  extractAgyConversationId,
  parseAgyStreamLine,
} from "./local-agent-agy.js";

assert.deepEqual(
  agyCommandEnvironment({
    OPENAI_TUNNEL_HTTP_PROXY: "http://127.0.0.1:7897",
    NO_PROXY: "localhost,127.0.0.1",
  }),
  {
    OPENAI_TUNNEL_HTTP_PROXY: "http://127.0.0.1:7897",
    HTTP_PROXY: "http://127.0.0.1:7897",
    HTTPS_PROXY: "http://127.0.0.1:7897",
    ALL_PROXY: "http://127.0.0.1:7897",
    http_proxy: "http://127.0.0.1:7897",
    https_proxy: "http://127.0.0.1:7897",
    all_proxy: "http://127.0.0.1:7897",
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
  },
);

assert.equal(
  agyCommandEnvironment({
    AGY_HTTP_PROXY: "http://127.0.0.1:9000",
    HTTPS_PROXY: "http://explicit-proxy:8080",
  }).HTTPS_PROXY,
  "http://explicit-proxy:8080",
);

assert.deepEqual(
  agyCommandArgs({
    prompt: "review",
    workspaceRoot: "/workspace",
    model: "Gemini 3.7 Pro (High)",
    effort: "high",
    writeMode: "allowed",
  }),
  [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--disable-slash-commands",
    "--print-timeout", "15m",
    "--model", "Gemini 3.7 Pro (High)",
    "--effort", "high",
    "--mode", "accept-edits",
    "--sandbox",
  ],
);

assert.deepEqual(
  agyCommandArgs({
    prompt: "continue",
    workspaceRoot: "/workspace",
    providerSessionId: "conversation_1",
    writeMode: "full_access",
  }),
  [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--disable-slash-commands",
    "--print-timeout", "15m",
    "--conversation", "conversation_1",
    "--mode", "accept-edits",
    "--dangerously-skip-permissions",
  ],
);

assert.throws(
  () => agyCommandArgs({ prompt: "inspect", workspaceRoot: "/workspace", writeMode: "read_only" }),
  /hard read-only headless mode/,
);

assert.deepEqual(
  parseAgyStreamLine('{"event":"step_update","step_update":{"step_type":"agent_response"}}'),
  { event: "step_update", step_update: { step_type: "agent_response" } },
);
assert.equal(
  extractAgyConversationId({ event: "init", conversation_id: "conversation_2", init: {} }),
  "conversation_2",
);
assert.throws(() => parseAgyStreamLine("not-json"), /malformed stream-json output/);

{
  let written = "";
  let spawnOptions: import("node:child_process").SpawnOptionsWithoutStdio | undefined;
  const spawn = ((_command: string, _args: readonly string[], options: import("node:child_process").SpawnOptionsWithoutStdio) => {
    spawnOptions = options;
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      killed: boolean;
      pid?: number;
      kill: () => boolean;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      child.exitCode = 1;
      return true;
    };
    child.stdin.on("data", (chunk) => { written += chunk.toString("utf8"); });
    child.stdin.once("finish", () => {
      queueMicrotask(() => {
        child.stdout.write('{"event":"init","conversation_id":"conversation_3","init":{"cwd":"/workspace"}}\n');
        child.stdout.write('{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"OK"}}\n');
        child.stdout.end('{"event":"result","result":{"status":"SUCCESS","response":"Final AGY response"}}\n');
        child.stderr.end();
        child.exitCode = 0;
        child.emit("close", 0, null);
      });
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as unknown as typeof import("node:child_process").spawn;

  const runtime = new AgyRuntime("agy", {}, spawn, 1_000);
  let persistedSessionId: string | undefined;
  const result = await runtime.run({
    prompt: "Reply with OK",
    workspaceRoot: process.cwd(),
    writeMode: "allowed",
  }, {
    onSessionId: (sessionId) => { persistedSessionId = sessionId; },
  });
  assert.equal(result.isOk(), true);
  if (result.isErr()) throw result.error;
  assert.equal(result.value.providerSessionId, "conversation_3");
  assert.equal(result.value.finalResponse, "Final AGY response");
  assert.equal(persistedSessionId, "conversation_3");
  assert.deepEqual(JSON.parse(written.trim()), {
    event: "user",
    message: { content: "Reply with OK" },
  });
  assert.equal(spawnOptions?.shell, false);
  assert.equal(spawnOptions?.windowsHide, true);
  await runtime.close();
}
