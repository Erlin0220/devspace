import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CodeGraphConfig } from "./config.js";
import type { Workspace } from "./workspaces.js";

interface CodeGraphSession {
  client: Client;
  transport: StdioClientTransport;
  stderr: string;
}

export interface CodeGraphToolResult {
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

export class CodeGraphManager {
  private session?: Promise<CodeGraphSession>;

  constructor(private readonly config: CodeGraphConfig) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  async explore(
    workspace: Workspace,
    query: string,
    maxFiles?: number,
  ): Promise<CodeGraphToolResult> {
    if (!this.config.enabled) {
      throw new Error(
        "CodeGraph integration is disabled. Set DEVSPACE_CODEGRAPH=1 or enable it in ~/.devspace/config.json.",
      );
    }

    const session = await this.ensureSession();
    const response = await session.client.callTool(
      {
        name: "codegraph_explore",
        arguments: {
          query,
          projectPath: workspace.root,
          ...(maxFiles === undefined ? {} : { maxFiles }),
        },
      },
      undefined,
      { timeout: this.config.toolTimeoutMs },
    );

    return {
      result: resultText(response.content),
      isError: response.isError === true,
    };
  }

  async close(): Promise<void> {
    const pending = this.session;
    this.session = undefined;
    if (!pending) return;

    const session = await pending.catch(() => undefined);
    if (!session) return;
    await session.client.close().catch(() => undefined);
    await session.transport.close().catch(() => undefined);
  }

  private async ensureSession(): Promise<CodeGraphSession> {
    if (this.session) return this.session;

    const pending = this.createSession().catch((error) => {
      if (this.session === pending) this.session = undefined;
      throw error;
    });
    this.session = pending;
    return pending;
  }

  private async createSession(): Promise<CodeGraphSession> {
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: processEnvironment(),
      stderr: "pipe",
    });
    const client = new Client({ name: "devspace-codegraph", version: "1.0.0" });
    const session: CodeGraphSession = {
      client,
      transport,
      stderr: "",
    };

    transport.stderr?.on("data", (chunk) => {
      session.stderr = appendStderr(session.stderr, chunk);
    });
    transport.onclose = () => {
      const current = this.session;
      if (!current) return;
      void current
        .then((resolved) => {
          if (resolved === session) this.session = undefined;
        })
        .catch(() => undefined);
    };

    try {
      await client.connect(transport, { timeout: this.config.startupTimeoutMs });
      return session;
    } catch (error) {
      await transport.close().catch(() => undefined);
      const reason = error instanceof Error ? error.message : String(error);
      const stderr = session.stderr.trim();
      throw new Error(
        `Unable to start CodeGraph: ${reason}${stderr ? `\n${stderr}` : ""}`,
      );
    }
  }
}
