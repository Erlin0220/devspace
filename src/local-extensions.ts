import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BasicMemoryManager } from "./basic-memory.js";
import { parseBasicMemoryConfig } from "./basic-memory-config.js";
import { registerBasicMemoryTools } from "./basic-memory-tools.js";
import { CodeGraphManager } from "./codegraph.js";
import { registerCodeGraphTools } from "./codegraph-tools.js";
import type { ServerConfig } from "./config.js";
import type { Workspace, WorkspaceRegistry } from "./workspaces.js";

interface ExtensionToolLog {
  tool: string;
  workspaceId?: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface LocalExtensionRegistrationOptions {
  workspaces: WorkspaceRegistry;
  logToolCall(fields: ExtensionToolLog): void;
  toolMeta(): { _meta: Record<string, unknown> };
}

export interface LocalExtensions {
  instruction: string;
  registerTools(server: McpServer, options: LocalExtensionRegistrationOptions): void;
  workspaceBootstrapContext(workspace: Workspace): Promise<string | undefined>;
  close(): Promise<void>;
}

export interface CreateLocalExtensionsOptions {
  codegraph?: CodeGraphManager;
  basicMemory?: BasicMemoryManager;
}

export function createLocalExtensions(
  config: ServerConfig,
  options: CreateLocalExtensionsOptions = {},
): LocalExtensions {
  const codegraph = options.codegraph ?? new CodeGraphManager(config.codegraph);
  const basicMemory = options.basicMemory ?? new BasicMemoryManager(parseBasicMemoryConfig());
  const instruction = [
    config.codegraph.enabled
      ? "For source-code questions and before editing named symbols, call codegraph_explore first. If the workspace has no CodeGraph index yet, DevSpace initializes it once and retries automatically. Treat returned source as already read; use normal DevSpace tools for configuration, documentation, and generated files."
      : undefined,
    basicMemory.enabled
      ? "For workspaces configured with shared project memory, use project_memory_recall when prior decisions, confirmed root causes, rejected approaches, or handoff context could materially change the work. After a substantial task produces durable verified information, call project_memory_checkpoint once before the final response. Do not checkpoint raw transcripts, routine tool output, or unverified hypotheses."
      : undefined,
  ].filter(Boolean).join(" ");

  return {
    instruction: instruction ? ` ${instruction}` : "",
    registerTools(server, registration) {
      registerCodeGraphTools(server, {
        workspaces: registration.workspaces,
        codegraph,
        logToolCall: registration.logToolCall,
        toolMeta: registration.toolMeta,
      });
      registerBasicMemoryTools(server, {
        workspaces: registration.workspaces,
        memory: basicMemory,
        logToolCall: registration.logToolCall,
        toolMeta: registration.toolMeta,
      });
    },
    workspaceBootstrapContext: (workspace) => basicMemory.bootstrapContext(workspace),
    async close() {
      await Promise.all([codegraph.close(), basicMemory.close()]);
    },
  };
}
