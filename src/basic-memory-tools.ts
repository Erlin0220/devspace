import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { BasicMemoryManager } from "./basic-memory.js";
import type { WorkspaceRegistry } from "./workspaces.js";

interface MemoryToolLog {
  tool: string;
  workspaceId?: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

interface BasicMemoryToolRegistrationOptions {
  workspaces: WorkspaceRegistry;
  memory: BasicMemoryManager;
  logToolCall(fields: MemoryToolLog): void;
  toolMeta(): { _meta: Record<string, unknown> };
}

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export function registerBasicMemoryTools(
  server: McpServer,
  options: BasicMemoryToolRegistrationOptions,
): void {
  if (!options.memory.enabled) return;

  if (options.memory.globalEnabled) {
    registerAppTool(
      server,
      "global_memory_recall",
      {
        title: "Recall global GPT memory",
        description:
          "Search durable global memory for ChatGPT, plugins/apps, MCP, DevSpace, WindowsTerminalMCP, Playwright, OpenAI workspace configuration, and previously configured infrastructure. This tool does not require a workspaceId. Call it before deciding or acting when prior setup, decisions, failures, or operational context could materially affect the task.",
        inputSchema: {
          query: z.string().min(1).describe("Concise high-signal terms describing the global GPT/tooling context to recall."),
        },
        outputSchema: { result: z.string() },
        ...options.toolMeta(),
        annotations: readAnnotations,
      },
      async ({ query }) => runMemoryTool(
        options,
        "global_memory_recall",
        undefined,
        () => options.memory.recallGlobal(query),
      ),
    );

    registerAppTool(
      server,
      "global_memory_checkpoint",
      {
        title: "Checkpoint global GPT memory",
        description:
          "Persist one concise verified global handoff for ChatGPT/MCP/tooling configuration and operational knowledge. Use only after substantial work produces durable information worth carrying to future web ChatGPT sessions. Do not store secrets, raw transcripts, routine logs, or unverified hypotheses.",
        inputSchema: {
          goal: z.string().min(1).describe("The concrete global tooling or ChatGPT task addressed."),
          rootCause: z.string().min(1).describe("The confirmed root cause or confirmed current state."),
          decision: z.string().min(1).describe("The final implementation or operational decision and why it was chosen."),
          verification: z.string().min(1).describe("Concrete evidence that verified the result."),
          rejectedApproaches: z.array(z.string().min(1)).max(8).optional().describe("Only rejected approaches whose failure reason remains useful."),
          openItems: z.array(z.string().min(1)).max(10).optional().describe("Remaining work or unresolved constraints worth carrying forward."),
        },
        outputSchema: { result: z.string() },
        ...options.toolMeta(),
        annotations: writeAnnotations,
      },
      async (input) => runMemoryTool(
        options,
        "global_memory_checkpoint",
        undefined,
        () => options.memory.checkpointGlobal(input),
      ),
    );
  }

  registerAppTool(
    server,
    "project_memory_recall",
    {
      title: "Recall project memory",
      description:
        "Search shared long-term engineering memory for the current workspace. DevSpace resolves the Basic Memory project automatically from the workspace source project; read-only recall never creates projects. Use this for prior decisions, confirmed root causes, rejected approaches, checkpoints, and cross-agent handoff context. Current code, Git, tests, and AGENTS.md remain authoritative.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace to use. Reuse the current project's workspaceId."),
        query: z.string().min(1).describe("High-signal technical terms or a concise description of the prior work to recall."),
      },
      outputSchema: { result: z.string() },
      ...options.toolMeta(),
      annotations: readAnnotations,
    },
    async ({ workspaceId, query }) => runMemoryTool(
      options,
      "project_memory_recall",
      workspaceId,
      () => options.memory.recall(options.workspaces.getWorkspace(workspaceId), query),
    ),
  );

  registerAppTool(
    server,
    "project_memory_checkpoint",
    {
      title: "Checkpoint project memory",
      description:
        "Persist one concise verified engineering handoff for the current workspace. DevSpace resolves the Basic Memory project automatically and creates it on the first checkpoint when needed. Use only after substantial work has produced durable information worth carrying to another agent or session. Do not store raw transcripts, routine tool logs, or unverified hypotheses.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace to use. Reuse the current project's workspaceId."),
        goal: z.string().min(1).describe("The concrete task or problem addressed."),
        rootCause: z.string().min(1).describe("The confirmed root cause or, when none exists, the confirmed current state."),
        decision: z.string().min(1).describe("The final implementation or architecture decision and why it was chosen."),
        verification: z.string().min(1).describe("Concrete evidence that verified the result, such as tests, logs, or real E2E behavior."),
        rejectedApproaches: z.array(z.string().min(1)).max(8).optional().describe("Only rejected approaches whose failure reason is useful in future work."),
        openItems: z.array(z.string().min(1)).max(10).optional().describe("Remaining work or unresolved constraints that matter to the next agent."),
      },
      outputSchema: { result: z.string() },
      ...options.toolMeta(),
      annotations: writeAnnotations,
    },
    async ({ workspaceId, ...input }) => runMemoryTool(
      options,
      "project_memory_checkpoint",
      workspaceId,
      () => options.memory.checkpoint(options.workspaces.getWorkspace(workspaceId), input),
    ),
  );
}

async function runMemoryTool(
  options: BasicMemoryToolRegistrationOptions,
  tool: string,
  workspaceId: string | undefined,
  run: () => Promise<{ result: string; isError: boolean }>,
) {
  const startedAt = performance.now();
  try {
    const response = await run();
    options.logToolCall({
      tool,
      workspaceId,
      success: !response.isError,
      durationMs: Math.round(performance.now() - startedAt),
      error: response.isError ? response.result : undefined,
    });
    return {
      content: [{ type: "text" as const, text: response.result }],
      isError: response.isError || undefined,
      structuredContent: { result: response.result },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.logToolCall({
      tool,
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
}
