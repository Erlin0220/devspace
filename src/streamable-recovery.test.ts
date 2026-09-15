import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

function dropAfterFirstSseEvent(response: Response): Response {
  if (!response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }

      buffered += decoder.decode(value, { stream: true });
      const eventEnd = buffered.indexOf("\n\n");
      if (eventEnd < 0) return;

      controller.enqueue(encoder.encode(buffered.slice(0, eventEnd + 2)));
      await reader.cancel("POC injected response loss after resumability priming event");
      controller.error(new Error("POC injected Tool Call response loss"));
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function createDroppingFetch(counter: { remaining: number }): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (
      counter.remaining > 0 &&
      method === "POST" &&
      response.headers.get("content-type")?.includes("text/event-stream")
    ) {
      counter.remaining -= 1;
      return dropAfterFirstSseEvent(response);
    }
    return response;
  };
}

async function connectClient(
  t: TestContext,
  endpoint: URL,
  apiToken: string,
  drops: { remaining: number },
  name: string,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: {
        authorization: `Bearer ${apiToken}`,
      },
    },
    fetch: createDroppingFetch(drops),
    reconnectionOptions: {
      initialReconnectionDelay: 25,
      maxReconnectionDelay: 500,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 4,
    },
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close().catch(() => undefined);
  });
  return client;
}

test("a dropped tool response resumes the same call without re-executing the command", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-response-recovery-poc-"));
  const project = join(root, "project");
  const stateDir = join(root, ".state");
  const apiToken = "r".repeat(32);
  await mkdir(project, { recursive: true });

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: join(root, "agent"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_API_TOKEN: apiToken,
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_TOOL_MODE: "codex",
    DEVSPACE_SUBAGENTS: "0",
    HOST: "127.0.0.1",
    PORT: "1",
    DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:1",
  });
  const running = createServer(config, {
    incomingArtifactAdapters: [],
    extensions: {
      instruction: "",
      registerTools() {},
      async close() {},
    },
  });
  const httpServer = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });

  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  let dropNextToolResponse = false;
  const injectedFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (
      dropNextToolResponse &&
      (init?.method ?? (input instanceof Request ? input.method : "GET")) === "POST" &&
      response.headers.get("content-type")?.includes("text/event-stream")
    ) {
      dropNextToolResponse = false;
      return dropAfterFirstSseEvent(response);
    }
    return response;
  };

  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: {
        authorization: `Bearer ${apiToken}`,
      },
    },
    fetch: injectedFetch,
    reconnectionOptions: {
      initialReconnectionDelay: 25,
      maxReconnectionDelay: 250,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 4,
    },
  });
  const client = new Client({ name: "devspace-response-recovery-poc", version: "1.0.0" });

  t.after(async () => {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await running.close();
    await rm(root, { recursive: true, force: true });
  });

  await client.connect(transport);
  const opened = await client.callTool({
    name: "open_workspace",
    arguments: { path: project },
    _meta: { "openai/session": "poc-chat-session" },
  });
  assert.ok(opened.structuredContent);
  const workspaceId = (opened.structuredContent as { workspaceId: string }).workspaceId;

  for (const [label, delayMs] of [["fast", 0], ["slow", 250]] as const) {
    const marker = join(project, `${label}-execution-count.txt`);
    const escapedMarker = marker.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
    const script = [
      "const fs=require('fs')",
      `fs.appendFileSync('${escapedMarker}','x')`,
      delayMs > 0
        ? `setTimeout(()=>console.log('${label}-done'),${delayMs})`
        : `console.log('${label}-done')`,
    ].join(";");
    const node = process.platform === "win32" ? `"${process.execPath}"` : JSON.stringify(process.execPath);

    dropNextToolResponse = true;
    const result = await client.callTool(
      {
        name: "exec_command",
        arguments: {
          workspaceId,
          cmd: `${node} -e "${script}"`,
          waitTimeMs: 2_000,
        },
      },
      undefined,
      { timeout: 10_000 },
    );

    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.running, false, `${label} command should complete in the original call`);
    assert.equal(structured.exitCode, 0, `${label} command should exit successfully`);
    assert.match(String(structured.result), new RegExp(`${label}-done`));
    assert.equal(await readFile(marker, "utf8"), "x", `${label} command must execute exactly once`);
  }
});

test("concurrent dropped tool responses recover independently within one MCP session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-response-recovery-concurrent-"));
  const project = join(root, "project");
  const stateDir = join(root, ".state");
  const apiToken = "s".repeat(32);
  await mkdir(project, { recursive: true });

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: join(root, "agent"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_API_TOKEN: apiToken,
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_TOOL_MODE: "codex",
    DEVSPACE_SUBAGENTS: "0",
    HOST: "127.0.0.1",
    PORT: "1",
    DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:1",
  });
  const running = createServer(config, {
    incomingArtifactAdapters: [],
    extensions: {
      instruction: "",
      registerTools() {},
      async close() {},
    },
  });
  const httpServer = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });
  t.after(async () => {
    await running.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const drops = { remaining: 0 };
  const client = await connectClient(t, endpoint, apiToken, drops, "devspace-concurrent-session");
  const opened = await client.callTool({
    name: "open_workspace",
    arguments: { path: project },
    _meta: { "openai/session": "poc-concurrent-chat" },
  });
  assert.ok(opened.structuredContent);
  const workspaceId = (opened.structuredContent as { workspaceId: string }).workspaceId;
  drops.remaining = 2;

  const markers = ["one", "two"].map((label) => ({
    label,
    path: join(project, `${label}-count.txt`),
  }));
  const calls = markers.map(({ label, path }, index) => {
    const escaped = path.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
    const delay = 150 + index * 100;
    const node = process.platform === "win32" ? `"${process.execPath}"` : JSON.stringify(process.execPath);
    const script = [
      "const fs=require('fs')",
      `fs.appendFileSync('${escaped}','x')`,
      `setTimeout(()=>console.log('${label}-done'),${delay})`,
    ].join(";");
    return client.callTool(
      {
        name: "exec_command",
        arguments: {
          workspaceId,
          cmd: `${node} -e "${script}"`,
          waitTimeMs: 2_000,
        },
      },
      undefined,
      { timeout: 10_000 },
    );
  });

  const results = await Promise.all(calls);
  assert.equal(drops.remaining, 0);
  for (const [index, result] of results.entries()) {
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.exitCode, 0);
    assert.match(String(structured.result), new RegExp(`${markers[index].label}-done`));
    assert.equal(await readFile(markers[index].path, "utf8"), "x");
  }
});

test("dropped tool responses stay isolated across independent MCP sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-response-recovery-sessions-"));
  const project = join(root, "project");
  const stateDir = join(root, ".state");
  const apiToken = "t".repeat(32);
  await mkdir(project, { recursive: true });

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: join(root, "agent"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_API_TOKEN: apiToken,
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_TOOL_MODE: "codex",
    DEVSPACE_SUBAGENTS: "0",
    HOST: "127.0.0.1",
    PORT: "1",
    DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:1",
  });
  const running = createServer(config, {
    incomingArtifactAdapters: [],
    extensions: {
      instruction: "",
      registerTools() {},
      async close() {},
    },
  });
  const httpServer = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });
  t.after(async () => {
    await running.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const firstDrops = { remaining: 0 };
  const secondDrops = { remaining: 0 };
  const firstClient = await connectClient(t, endpoint, apiToken, firstDrops, "devspace-session-a");
  const secondClient = await connectClient(t, endpoint, apiToken, secondDrops, "devspace-session-b");
  const [firstOpen, secondOpen] = await Promise.all([
    firstClient.callTool({
      name: "open_workspace",
      arguments: { path: project },
      _meta: { "openai/session": "poc-chat-a" },
    }),
    secondClient.callTool({
      name: "open_workspace",
      arguments: { path: project },
      _meta: { "openai/session": "poc-chat-b" },
    }),
  ]);
  const firstWorkspaceId = (firstOpen.structuredContent as { workspaceId: string }).workspaceId;
  const secondWorkspaceId = (secondOpen.structuredContent as { workspaceId: string }).workspaceId;
  firstDrops.remaining = 1;
  secondDrops.remaining = 1;
  const firstMarker = join(project, "session-a-count.txt");
  const secondMarker = join(project, "session-b-count.txt");
  const node = process.platform === "win32" ? `"${process.execPath}"` : JSON.stringify(process.execPath);
  const makeCommand = (marker: string, label: string) => {
    const escaped = marker.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
    return `${node} -e "const fs=require('fs');fs.appendFileSync('${escaped}','x');setTimeout(()=>console.log('${label}-done'),200)"`;
  };

  const [firstResult, secondResult] = await Promise.all([
    firstClient.callTool(
      {
        name: "exec_command",
        arguments: {
          workspaceId: firstWorkspaceId,
          cmd: makeCommand(firstMarker, "session-a"),
          waitTimeMs: 2_000,
        },
      },
      undefined,
      { timeout: 10_000 },
    ),
    secondClient.callTool(
      {
        name: "exec_command",
        arguments: {
          workspaceId: secondWorkspaceId,
          cmd: makeCommand(secondMarker, "session-b"),
          waitTimeMs: 2_000,
        },
      },
      undefined,
      { timeout: 10_000 },
    ),
  ]);

  assert.match(String((firstResult.structuredContent as Record<string, unknown>).result), /session-a-done/);
  assert.match(String((secondResult.structuredContent as Record<string, unknown>).result), /session-b-done/);
  assert.equal(await readFile(firstMarker, "utf8"), "x");
  assert.equal(await readFile(secondMarker, "utf8"), "x");
  assert.equal(firstDrops.remaining, 0);
  assert.equal(secondDrops.remaining, 0);
});
