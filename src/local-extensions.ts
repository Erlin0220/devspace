import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BasicMemoryManager } from "./basic-memory.js";
import { registerBasicMemoryTools } from "./basic-memory-tools.js";
import { CodeGraphManager } from "./codegraph.js";
import { registerCodeGraphTools } from "./codegraph-tools.js";
import type { ServerConfig } from "./config.js";
import type { WorkspaceRegistry } from "./workspaces.js";

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
  const basicMemory = options.basicMemory ?? new BasicMemoryManager(config.basicMemory);
  const instruction = [
    config.codegraph.enabled
      ? "For source-code questions and before editing named symbols, call codegraph_explore first. If the workspace has no CodeGraph index yet, DevSpace initializes it once and retries automatically. Treat returned source as already read; use normal DevSpace tools for configuration, documentation, and generated files."
      : undefined,
    basicMemory.enabled
      ? "Project memory is resolved automatically from the workspace source project. Use project_memory_recall when prior decisions, confirmed root causes, rejected approaches, or handoff context could materially change the work. A missing memory project is created automatically only by project_memory_checkpoint, never by read-only recall. Call project_memory_checkpoint only when the task produced new durable engineering knowledge worth carrying forward: a confirmed non-obvious root cause, a future-relevant architecture/product decision, an important rejected approach, a cross-session open item, or a substantive correction to existing long-term memory. Do not checkpoint ordinary code changes, routine test results, raw transcripts, routine tool output, duplicate conclusions, or unverified hypotheses."
      : undefined,
    basicMemory.globalEnabled
      ? "Persistent global GPT/tooling memory is available through global_memory_recall without opening a workspace. For ChatGPT, plugins/apps, MCP, DevSpace, WindowsTerminalMCP, Playwright, OpenAI workspace configuration, or previously configured infrastructure, call global_memory_recall before deciding or acting when prior context could materially matter. Call global_memory_checkpoint only for new durable global tooling knowledge that will materially affect future sessions, such as a confirmed root cause, stable operating decision, rejected approach, or unresolved cross-session dependency. Do not store routine work, duplicate conclusions, or secrets."
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
    async close() {
      await Promise.all([codegraph.close(), basicMemory.close()]);
    },
  };
}
