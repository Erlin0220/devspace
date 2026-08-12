import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CodeGraphConfig } from "./config.js";
import type { Workspace } from "./workspaces.js";

const CODEGRAPH_INIT_TIMEOUT_MS = 10 * 60_000;
const MAX_PROCESS_OUTPUT = 8_000;

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

function appendBounded(current: string, chunk: unknown): string {
  const next = `${current}${String(chunk)}`;
  return next.length <= MAX_PROCESS_OUTPUT ? next : next.slice(-MAX_PROCESS_OUTPUT);
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

export function buildCodeGraphInitArgs(serverArgs: string[], projectRoot: string): string[] {
  const serveIndex = serverArgs.lastIndexOf("serve");
  if (serveIndex < 0) {
    throw new Error(
      "Unable to initialize CodeGraph because its configured server arguments do not contain the 'serve' command.",
    );
  }

  return [...serverArgs.slice(0, serveIndex), "init", projectRoot, "-i"];
}

export function needsCodeGraphInitialization(result: string): boolean {
  if (result.length > 4_000) return false;

  const normalized = result.toLowerCase();
  if (normalized.includes("codegraph not initialized")) return true;
  if (normalized.includes("no codegraph project is loaded")) return true;

  const mentionsInit = normalized.includes("codegraph init");
  const saysUnindexed = normalized.includes("isn't indexed") || normalized.includes("is not indexed");
  return mentionsInit && saysUnindexed;
}

async function hasCodeGraphIndex(projectRoot: string): Promise<boolean> {
  try {
    await access(join(projectRoot, ".codegraph", "codegraph.db"));
    return true;
  } catch {
    return false;
  }
}

async function runCodeGraphCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: processEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    child.stdout?.on("data", (chunk) => {
      output = appendBounded(output, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output = appendBounded(output, chunk);
    });
    child.once("error", (error) => {
      const detail = output.trim();
      finish(
        new Error(
          `Unable to initialize CodeGraph: ${error.message}${detail ? `\n${detail}` : ""}`,
        ),
      );
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }

      const detail = output.trim();
      finish(
        new Error(
          `CodeGraph initialization failed with exit code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}${detail ? `\n${detail}` : ""}`,
        ),
      );
    });

    timer = setTimeout(() => {
      child.kill();
      const detail = output.trim();
      finish(
        new Error(
          `CodeGraph initialization timed out after ${Math.round(timeoutMs / 1_000)} seconds${detail ? `\n${detail}` : ""}`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
  });
}

export class CodeGraphManager {
  private session?: Promise<CodeGraphSession>;
  private readonly initializations = new Map<string, Promise<void>>();

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

    await this.ensureProjectInitialized(workspace);
    const first = await this.callExplore(workspace, query, maxFiles);
    if (!needsCodeGraphInitialization(first.result)) return first;

    // CodeGraph can occasionally keep the pre-init project state for the first request.
    // Re-check the index and retry exactly once instead of leaking init guidance to the host.
    await this.ensureProjectInitialized(workspace);
    return this.callExplore(workspace, query, maxFiles);
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

  private async callExplore(
    workspace: Workspace,
    query: string,
    maxFiles?: number,
  ): Promise<CodeGraphToolResult> {
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

  private async ensureProjectInitialized(workspace: Workspace): Promise<void> {
    if (await hasCodeGraphIndex(workspace.root)) return;

    const current = this.initializations.get(workspace.root);
    if (current) {
      await current;
      return;
    }

    const pending = this.initializeProject(workspace).finally(() => {
      if (this.initializations.get(workspace.root) === pending) {
        this.initializations.delete(workspace.root);
      }
    });
    this.initializations.set(workspace.root, pending);
    await pending;
  }

  private async initializeProject(workspace: Workspace): Promise<void> {
    const args = buildCodeGraphInitArgs(this.config.args, workspace.root);
    await runCodeGraphCommand(
      this.config.command,
      args,
      workspace.root,
      Math.max(CODEGRAPH_INIT_TIMEOUT_MS, this.config.toolTimeoutMs),
    );

    if (!(await hasCodeGraphIndex(workspace.root))) {
      throw new Error(
        `CodeGraph initialization completed without creating an index for workspace: ${workspace.root}`,
      );
    }
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
      session.stderr = appendBounded(session.stderr, chunk);
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
