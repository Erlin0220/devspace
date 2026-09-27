import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Result as BetterResult } from "better-result";
import * as z from "zod/v4";
import {
  toAgentErrorPayload,
  type LocalAgentError,
} from "../local-agent-errors.js";
import type { AgentReviewAction } from "../local-agent-manager.js";
import {
  formatAgentObservation,
  formatAgentReceipt,
  formatAgentSummary,
  presentAgentObservation,
  presentAgentReceipt,
  presentAgentSummary,
} from "../local-agent-presentation.js";
import type {
  LocalAgentRecord,
  LocalAgentWorkspaceScope,
} from "../local-agent-store.js";
import type { WorkspaceRegistry } from "../workspaces.js";

export interface PersonalSubagentClient {
  start: (input: import("../local-agent-manager.js").StartLocalAgentInput) => Promise<BetterResult<LocalAgentRecord, LocalAgentError>>;
  get: (agentId: string, scope: LocalAgentWorkspaceScope) => Promise<BetterResult<LocalAgentRecord, LocalAgentError>>;
  continue: (
    agentId: string,
    prompt: string,
    overrides: import("../local-agent-manager.js").RunOverrides,
    scope: LocalAgentWorkspaceScope,
  ) => Promise<BetterResult<LocalAgentRecord, LocalAgentError>>;
  list: (scope: LocalAgentWorkspaceScope) => Promise<BetterResult<LocalAgentRecord[], LocalAgentError>>;
  review?: (
    agentId: string,
    action: AgentReviewAction,
    note: string | undefined,
    scope: LocalAgentWorkspaceScope,
  ) => Promise<BetterResult<LocalAgentRecord, LocalAgentError>>;
}

const agentStatusSchema = z.enum(["running", "awaiting_review", "completed", "failed", "stopped"]);
const agentFailureSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});
const agentReceiptOutputSchema = {
  id: z.string(),
  status: agentStatusSchema,
  mode: z.enum(["turn", "goal"]).optional(),
};
const graderResultSchema = z.object({
  command: z.string(),
  exitCode: z.number().int().optional(),
  timedOut: z.boolean(),
  output: z.string(),
});
const agentObservationOutputSchema = {
  ...agentReceiptOutputSchema,
  response: z.string().optional(),
  error: agentFailureSchema.optional(),
  attempts: z.number().int().optional(),
  maxAttempts: z.number().int().optional(),
  graderResults: z.array(graderResultSchema).optional(),
};
const agentSummarySchema = z.object({
  ...agentReceiptOutputSchema,
  target: z.string(),
});
const agentListOutputSchema = {
  agents: z.array(agentSummarySchema),
};

export class PersonalSubagents {
  constructor(
    private readonly client: PersonalSubagentClient,
  ) {
  }

  register(server: McpServer, workspaces: WorkspaceRegistry): void {
    server.registerTool(
      "run_agent",
      {
        title: "Run DevSpace subagent",
        description:
          "Start a durable DevSpace subagent execution in the current workspace using an advertised profile or enabled provider. Use mode=goal for Qoder native Goal work. The execution runs independently; inspect it with get_agent, use review_agent for supervisor decisions, and continue_agent for ordinary follow-up turns.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          target: z.string().min(1).describe(
            "Subagent profile name advertised by open_workspace.agents, or an enabled provider name when no profile fits.",
          ),
          prompt: z.string().min(1).describe(
            "Self-contained task brief. Include the objective, relevant constraints/context, and expected result. For command-recovery delegation, describe the legitimate high-level objective instead of copying or disguising a rejected command, and do not include credentials.",
          ),
          mode: z.enum(["turn", "goal"]).optional().describe(
            "Use goal for a durable Qoder native Goal execution. Defaults to a normal bounded turn.",
          ),
          goalTurns: z.number().int().min(1).max(5_000).optional(),
          graderCommands: z.array(z.string().min(1).max(8_000)).max(20).optional(),
          requireReview: z.boolean().optional().describe(
            "Keep successful work awaiting independent supervisor review. Defaults to true for goal mode.",
          ),
          maxAttempts: z.number().int().min(1).max(5).optional(),
        },
        outputSchema: agentReceiptOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ workspaceId, target, prompt, mode, goalTurns, graderCommands, requireReview, maxAttempts }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const input = {
          target,
          prompt,
          workspaceId,
          workspaceRoot: workspace.root,
          executionMode: mode,
          goalTurns,
          graderCommands,
          requireReview,
          maxAttempts,
        };
        const result = await this.client.start(input);
        return result.isErr()
          ? agentErrorResponse(result.error)
          : agentReceiptResponse(result.value);
      },
    );

    server.registerTool(
      "review_agent",
      {
        title: "Review DevSpace subagent",
        description:
          "Apply an independent supervisor decision to an agent awaiting review. Retry continues the same provider session with the supplied evidence; approve accepts the result; reject marks it failed.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier used to start the subagent."),
          agentId: z.string().min(1).describe("Agent identifier returned by run_agent."),
          action: z.enum(["approve", "retry", "reject"]),
          note: z.string().max(8_000).optional(),
        },
        outputSchema: agentReceiptOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ workspaceId, agentId, action, note }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        if (!this.client.review) {
          return {
            content: [{ type: "text" as const, text: "AGENT_REVIEW_UNAVAILABLE: Supervisor review is not available." }],
            isError: true,
          };
        }
        const result = await this.client.review(
          agentId,
          action,
          note,
          workspaceScope(workspaceId, workspace.root),
        );
        return result.isErr()
          ? agentErrorResponse(result.error)
          : agentReceiptResponse(result.value);
      },
    );

    server.registerTool(
      "get_agent",
      {
        title: "Get DevSpace subagent",
        description:
          "Get a DevSpace subagent's current persisted state and latest result. This mirrors DevSpace agent.get; if the agent is still running, call get_agent again later.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier used to start the subagent."),
          agentId: z.string().min(1).describe("Agent identifier returned by run_agent or continue_agent."),
        },
        outputSchema: agentObservationOutputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ workspaceId, agentId }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const result = await this.client.get(
          agentId,
          workspaceScope(workspaceId, workspace.root),
        );
        return result.isErr()
          ? agentErrorResponse(result.error)
          : agentObservationResponse(result.value);
      },
    );

    server.registerTool(
      "continue_agent",
      {
        title: "Continue DevSpace subagent",
        description:
          "Give an existing DevSpace subagent another turn while preserving its provider session and context. Use get_agent with the returned agent id to inspect the follow-up turn's current state or result.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier used to start the subagent."),
          agentId: z.string().min(1).describe("Existing DevSpace subagent identifier."),
          prompt: z.string().min(1).describe("Self-contained follow-up brief for the existing subagent."),
        },
        outputSchema: agentReceiptOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ workspaceId, agentId, prompt }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const result = await this.client.continue(
          agentId,
          prompt,
          {},
          workspaceScope(workspaceId, workspace.root),
        );
        return result.isErr()
          ? agentErrorResponse(result.error)
          : agentReceiptResponse(result.value);
      },
    );

    server.registerTool(
      "list_agents",
      {
        title: "List DevSpace subagents",
        description:
          "List durable DevSpace subagent sessions for the current workspace. Use this to inspect or recover existing agent ids after reconnecting or losing earlier conversation context.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace whose DevSpace subagent sessions should be listed."),
        },
        outputSchema: agentListOutputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ workspaceId }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const result = await this.client.list(
          workspaceScope(workspaceId, workspace.root),
        );
        return result.isErr()
          ? agentErrorResponse(result.error)
          : agentListResponse(result.value);
      },
    );
  }
}

function workspaceScope(workspaceId: string, workspaceRoot: string): LocalAgentWorkspaceScope {
  return { workspaceId, workspaceRoot };
}

function agentReceiptResponse(record: LocalAgentRecord) {
  const receipt = presentAgentReceipt(record);
  return {
    content: [{ type: "text" as const, text: formatAgentReceipt(receipt) }],
    structuredContent: { ...receipt },
  };
}

function agentObservationResponse(record: LocalAgentRecord) {
  const observation = presentAgentObservation(record);
  return {
    content: [{ type: "text" as const, text: formatAgentObservation(observation) }],
    structuredContent: { ...observation },
  };
}

function agentListResponse(records: LocalAgentRecord[]) {
  const agents = records.map(presentAgentSummary);
  const text = agents.length === 0
    ? "No subagent sessions found for this workspace."
    : agents.map(formatAgentSummary).join("\n");
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { agents },
  };
}

function agentErrorResponse(error: LocalAgentError) {
  const payload = toAgentErrorPayload(error);
  const retryable = payload.retryable ? " [retryable]" : "";
  return {
    content: [{
      type: "text" as const,
      text: `${payload.code}: ${payload.message}${retryable}`,
    }],
    isError: true,
  };
}
