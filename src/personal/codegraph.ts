import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { WorkspaceRegistry } from "../workspaces.js";

export interface CodeGraphOptions {
  enabled?: boolean;
  command?: string;
  args?: string[];
  initCommand?: string;
  initArgs?: string[];
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
}

function commandOptions(options: CodeGraphOptions) {
  const installed = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "codegraph", "current");
  const windows = process.platform === "win32";
  const command = options.command ?? (windows ? join(installed, "node.exe") : "codegraph");
  const args = options.args ?? (windows
    ? [join(installed, "lib", "dist", "bin", "codegraph.js"), "serve", "--mcp"] : ["serve", "--mcp"]);
  if (typeof command !== "string" || !command || !Array.isArray(args) || args.some(arg => typeof arg !== "string")) {
    throw new Error("Invalid Personal CodeGraph command/args");
  }
  const timeout = (value: number | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < 1 || value > 120_000) throw new Error("CodeGraph timeout must be 1..120000 ms");
    return value;
  };
  return { command, args, startupTimeoutMs: timeout(options.startupTimeoutMs, 10_000), toolTimeoutMs: timeout(options.toolTimeoutMs, 60_000) };
}

function initializationOptions(options: CodeGraphOptions, root: string) {
  const config = commandOptions(options);
  const installed = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "codegraph", "current");
  const windows = process.platform === "win32";
  let args = options.initArgs;
  if (!args) {
    if (options.args !== undefined) {
      throw new Error("Custom Personal CodeGraph args require initArgs for automatic workspace initialization");
    }
    args = windows
      ? [join(installed, "lib", "dist", "bin", "codegraph.js"), "init"]
      : ["init"];
  }
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) {
    throw new Error("Invalid Personal CodeGraph initArgs");
  }
  return { command: options.initCommand ?? config.command, args: [...args, root], toolTimeoutMs: config.toolTimeoutMs };
}

// Optional per-runtime client. Workspace initialization is separate; query transport stays thin.
export class PersonalCodeGraph {
  private session?: Promise<{ client: Client; transport: StdioClientTransport }>;
  private initializations = new Map<string, Promise<void>>();
  private closed = false;
  constructor(private options: CodeGraphOptions) {}

  async ensureInitialized(root: string): Promise<void> {
    if (this.options.enabled !== true) return;
    const marker = join(root, ".codegraph");
    if (await access(marker).then(() => true, () => false)) return;
    const key = process.platform === "win32" ? root.toLowerCase() : root;
    if (!this.initializations.has(key)) {
      const operation = (async () => {
        const config = initializationOptions(this.options, root);
        await promisify(execFile)(config.command, config.args, {
          cwd: root, windowsHide: true, timeout: config.toolTimeoutMs, maxBuffer: 64 * 1024,
          env: this.environment(),
        });
        await access(marker);
      })().finally(() => this.initializations.delete(key));
      this.initializations.set(key, operation);
    }
    await this.initializations.get(key);
  }

  private environment(): Record<string, string> {
    return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined && !/^(DEVSPACE_|PERSONAL_DEVSPACE_)/i.test(entry[0])));
  }

  private connect() {
    if (this.closed) throw new Error("CodeGraph runtime is closed");
    if (!this.session) {
      const pending = (async () => {
        const config = commandOptions(this.options);
        const transport = new StdioClientTransport({ command: config.command, args: config.args, env: this.environment(), stderr: "pipe" });
        const client = new Client({ name: "personal-devspace-codegraph", version: "1.0.0" });
        // Drain output without forwarding local paths or credentials into runtime logs.
        transport.stderr?.on("data", () => {});
        try {
          await client.connect(transport, { timeout: config.startupTimeoutMs });
          client.onclose = () => { if (this.session === pending) this.session = undefined; };
          return { client, transport };
        } catch (error) { await transport.close().catch(() => {}); throw error; }
      })().catch(error => { if (this.session === pending) this.session = undefined; throw error; });
      this.session = pending;
    }
    return this.session;
  }

  async explore(root: string, query: string, maxFiles?: number) {
    await this.ensureInitialized(root);
    const { client } = await this.connect();
    const result = await client.callTool({ name: "codegraph_explore", arguments: { projectPath: root, query, maxFiles } },
      undefined, { timeout: commandOptions(this.options).toolTimeoutMs });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.flatMap(item => item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n");
    return { content: [{ type: "text" as const, text }], structuredContent: { result: text }, isError: result.isError === true };
  }

  register(server: McpServer, workspaces: WorkspaceRegistry) {
    if (this.options.enabled !== true) return;
    server.registerTool("codegraph_explore", {
      title: "Explore code graph",
      description: "Explore current source and call relationships before editing. Uses the opened workspace. Optional extension failures do not affect core tools.",
      inputSchema: { workspaceId: z.string(), query: z.string().min(1), maxFiles: z.number().int().min(1).max(50).optional() },
      outputSchema: { result: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspaceId, query, maxFiles }) => {
      try { return await this.explore(workspaces.getWorkspace(workspaceId).root, query, maxFiles); }
      catch { const text = "CodeGraph is unavailable. Check personal.json and the local CodeGraph installation; core file/command tools remain available.";
        return { content: [{ type: "text" as const, text }], structuredContent: { result: text }, isError: true }; }
    });
  }

  async close() {
    this.closed = true;
    const session = await this.session?.catch(() => undefined);
    this.session = undefined;
    if (session) await session.client.close().catch(() => {});
  }
}
