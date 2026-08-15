import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CodeGraphManager } from "./codegraph.js";
import { registerCodeGraphTools } from "./codegraph-tools.js";
import type { ServerConfig } from "./config.js";
import type { JournalCommandRunner } from "./journal-mlflow.js";
import { registerJournalTools } from "./journal-tools.js";
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
  journalRunner?: JournalCommandRunner;
}

export function createLocalExtensions(
  config: ServerConfig,
  options: CreateLocalExtensionsOptions = {},
): LocalExtensions {
  const codegraph = options.codegraph ?? new CodeGraphManager(config.codegraph);
  const instruction = config.codegraph.enabled
    ? " For source-code questions and before editing named symbols, call codegraph_explore first. If the workspace has no CodeGraph index yet, DevSpace initializes it once and retries automatically. Treat returned source as already read; use normal DevSpace tools for configuration, documentation, and generated files."
    : "";

  return {
    instruction,
    registerTools(server, registration) {
      registerCodeGraphTools(server, {
        workspaces: registration.workspaces,
        codegraph,
        logToolCall: registration.logToolCall,
        toolMeta: registration.toolMeta,
      });
      registerJournalTools(server, {
        workspaces: registration.workspaces,
        logToolCall: registration.logToolCall,
        toolMeta: registration.toolMeta,
        ...(options.journalRunner ? { runner: options.journalRunner } : {}),
      });
    },
    close: () => codegraph.close(),
  };
}
