import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { SerenaConfig } from "./config.js";
import type { Workspace } from "./workspaces.js";

const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1_000;

interface SerenaSession {
  workspaceId: string;
  root: string;
  client: Client;
  transport: StdioClientTransport;
  lastUsedAt: number;
  activeCalls: number;
  queue: Promise<void>;
  stderr: string;
}

export interface SerenaToolResult {
  result: string;
  isError: boolean;
}

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function appendStderr(current: string, chunk: unknown): string {
  const next = `${current}${String(chunk)}`;
  return next.length <= 8_000 ? next : next.slice(-8_000);
}

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content ?? null, null, 2);

  return content
    .map((item) => {
      if (!item || typeof item !== "object") return String(item);
      if ("text" in item && typeof item.text === "string") return item.text;
      return JSON.stringify(item, null, 2);
    })
    .join("\n");
}

export class SerenaManager {
  private readonly sessions = new Map<string, Promise<SerenaSession>>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(private readonly config: SerenaConfig) {
    this.sweepTimer = setInterval(() => {
      void this.closeIdleSessions();
    }, SESSION_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  async callTool(
    workspace: Workspace,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<SerenaToolResult> {
    if (!this.config.enabled) {
      throw new Error("Serena integration is disabled. Set DEVSPACE_SERENA=1 or enable it in ~/.devspace/config.json.");
    }

    const session = await this.ensureSession(workspace);
    return this.enqueue(session, async () => {
      session.lastUsedAt = Date.now();
      session.activeCalls += 1;
      try {
        const response = await session.client.callTool(
          { name: toolName, arguments: args },
          undefined,
          { timeout: this.config.toolTimeoutMs },
        );
        return {
          result: resultText(response.content),
          isError: response.isError === true,
        };
      } finally {
        session.activeCalls -= 1;
        session.lastUsedAt = Date.now();
      }
    });
  }

  async close(): Promise<void> {
    clearInterval(this.sweepTimer);
    const sessions = await Promise.allSettled(this.sessions.values());
    this.sessions.clear();
    await Promise.allSettled(
      sessions
        .filter((result): result is PromiseFulfilledResult<SerenaSession> => result.status === "fulfilled")
        .map((result) => this.closeSession(result.value)),
    );
  }

  private async ensureSession(workspace: Workspace): Promise<SerenaSession> {
    const existing = this.sessions.get(workspace.id);
    if (existing) {
      const session = await existing;
      if (session.root === workspace.root) return session;
      await this.closeSession(session);
      this.sessions.delete(workspace.id);
    }

    const pending = this.createSession(workspace).catch((error) => {
      if (this.sessions.get(workspace.id) === pending) {
        this.sessions.delete(workspace.id);
      }
      throw error;
    });
    this.sessions.set(workspace.id, pending);
    return pending;
  }

  private async createSession(workspace: Workspace): Promise<SerenaSession> {
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: [
        "start-mcp-server",
        "--context",
        this.config.context,
        "--project",
        workspace.root,
        "--enable-web-dashboard",
        "false",
        "--open-web-dashboard",
        "false",
        "--enable-gui-log-window",
        "false",
        "--log-level",
        "WARNING",
        "--tool-timeout",
        String(Math.ceil(this.config.toolTimeoutMs / 1_000)),
      ],
      cwd: workspace.root,
      env: processEnvironment(),
      stderr: "pipe",
    });
    const client = new Client({ name: "devspace-serena", version: "1.0.0" });
    const session: SerenaSession = {
      workspaceId: workspace.id,
      root: workspace.root,
      client,
      transport,
      lastUsedAt: Date.now(),
      activeCalls: 0,
      queue: Promise.resolve(),
      stderr: "",
    };

    transport.stderr?.on("data", (chunk) => {
      session.stderr = appendStderr(session.stderr, chunk);
    });
    transport.onclose = () => {
      const current = this.sessions.get(workspace.id);
      if (current) {
        void current.then((resolved) => {
          if (resolved === session) this.sessions.delete(workspace.id);
        }).catch(() => undefined);
      }
    };

    try {
      await client.connect(transport, { timeout: this.config.startupTimeoutMs });
      return session;
    } catch (error) {
      await transport.close().catch(() => undefined);
      const reason = error instanceof Error ? error.message : String(error);
      const stderr = session.stderr.trim();
      throw new Error(
        `Unable to start Serena for ${workspace.root}: ${reason}${stderr ? `\n${stderr}` : ""}`,
      );
    }
  }

  private async enqueue<T>(session: SerenaSession, operation: () => Promise<T>): Promise<T> {
    const result = session.queue.then(operation, operation);
    session.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async closeIdleSessions(): Promise<void> {
    const now = Date.now();
    for (const [workspaceId, pending] of this.sessions) {
      const session = await pending.catch(() => undefined);
      if (!session || session.activeCalls > 0) continue;
      if (now - session.lastUsedAt < this.config.idleTimeoutMs) continue;

      this.sessions.delete(workspaceId);
      await this.closeSession(session);
    }
  }

  private async closeSession(session: SerenaSession): Promise<void> {
    await session.queue.catch(() => undefined);
    await session.client.close().catch(() => undefined);
    await session.transport.close().catch(() => undefined);
  }
}
