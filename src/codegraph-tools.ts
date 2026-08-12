import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import type { CodeGraphManager } from "./codegraph.js";
import type { ServerConfig } from "./config.js";
import type { WorkspaceRegistry } from "./workspaces.js";

interface CodeGraphToolLog {
  tool: string;
  workspaceId?: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

interface CodeGraphToolRegistrationOptions {
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  codegraph: CodeGraphManager;
  logToolCall(fields: CodeGraphToolLog): void;
  toolMeta(): { _meta: Record<string, unknown> };
}

export function registerCodeGraphTools(
  server: McpServer,
  options: CodeGraphToolRegistrationOptions,
): void {
  if (!options.config.codegraph.enabled) return;

  registerAppTool(
    server,
    "codegraph_explore",
    {
      title: "Explore code graph",
      description:
        "Explore the current workspace through its CodeGraph index. DevSpace automatically initializes a missing workspace index on first use. Use this first for architecture, call flow, impact analysis, bug tracing, or before editing related symbols. Returns relevant verbatim source and relationships in one call. The workspace root is supplied automatically from workspaceId.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        query: z
          .string()
          .min(1)
          .describe(
            "Natural-language question, symbol names, file names, or short code terms to explore.",
          ),
        maxFiles: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("Maximum number of files to include. CodeGraph defaults to 12."),
      },
      outputSchema: { result: z.string() },
      ...options.toolMeta(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, query, maxFiles }) => {
      const startedAt = performance.now();
      const workspace = options.workspaces.getWorkspace(workspaceId);

      try {
        const response = await options.codegraph.explore(workspace, query, maxFiles);
        options.logToolCall({
          tool: "codegraph_explore",
          workspaceId,
          success: !response.isError,
          durationMs: Math.round(performance.now() - startedAt),
          error: response.isError ? response.result : undefined,
        });

        return {
          content: [{ type: "text" as const, text: response.result }],
          isError: response.isError || undefined,
          _meta: {
            tool: "grep",
            card: {
              workspaceId,
              path: workspace.root,
              payload: {
                content: [{ type: "text" as const, text: response.result }],
              },
            },
          },
          structuredContent: { result: response.result },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logToolCall({
          tool: "codegraph_explore",
          workspaceId,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });

        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
          structuredContent: { result: message },
        };
      }
    },
  );
}
