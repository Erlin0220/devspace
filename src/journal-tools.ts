import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  MlflowJournalRunner,
  type JournalAction,
  type JournalCommandRunner,
} from "./journal-mlflow.js";
import type { WorkspaceRegistry } from "./workspaces.js";

interface JournalToolLog {
  tool: string;
  workspaceId?: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

interface JournalToolRegistrationOptions {
  workspaces: WorkspaceRegistry;
  logToolCall(fields: JournalToolLog): void;
  toolMeta(): { _meta: Record<string, unknown> };
  runner?: JournalCommandRunner;
}

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const eventTypeSchema = z.enum([
  "work",
  "test",
  "e2e",
  "commit",
  "evidence",
  "decision",
  "other",
]);

export function registerJournalTools(
  server: McpServer,
  options: JournalToolRegistrationOptions,
): void {
  const runner = options.runner ?? new MlflowJournalRunner();

  registerAppTool(
    server,
    "journal_start_round",
    {
      title: "Start journal round",
      description:
        "Start a durable MLflow-backed work round for the current workspace. Use this for workflows that need an auditable round history; it does not replace workspace locking or heartbeat state.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        project: z.string().min(1).describe("Stable journal project name, for example saas-agent."),
        direction: z.string().min(1).describe("The concrete direction or goal for this round."),
        baseHead: z.string().min(1).optional().describe("Optional Git HEAD at round start."),
        roundId: z.string().min(1).optional().describe("Optional caller-provided stable round identifier."),
      },
      outputSchema: {
        result: z.string(),
        traceId: z.string(),
        roundId: z.string(),
      },
      ...options.toolMeta(),
      annotations: writeAnnotations,
    },
    async ({ workspaceId, ...input }) => runTool(
      options,
      runner,
      "journal_start_round",
      "start_round",
      workspaceId,
      input,
    ),
  );

  registerAppTool(
    server,
    "journal_record_event",
    {
      title: "Record journal event",
      description:
        "Append one verified work event to a running journal round, such as a work unit, test, E2E check, commit, or evidence item.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        traceId: z.string().min(1).describe("Trace ID returned by journal_start_round."),
        eventType: eventTypeSchema,
        summary: z.string().min(1).describe("Short factual summary of what happened."),
        details: z.record(z.string(), z.unknown()).optional().describe("Optional structured evidence or result details."),
      },
      outputSchema: {
        result: z.string(),
        traceId: z.string(),
        eventSpanId: z.string(),
      },
      ...options.toolMeta(),
      annotations: writeAnnotations,
    },
    async ({ workspaceId, ...input }) => runTool(
      options,
      runner,
      "journal_record_event",
      "record_event",
      workspaceId,
      input,
    ),
  );

  registerAppTool(
    server,
    "journal_complete_round",
    {
      title: "Complete journal round",
      description:
        "Complete a running journal round after its facts are verified. Stores the final summary, result, and next candidates in MLflow.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        traceId: z.string().min(1).describe("Trace ID returned by journal_start_round."),
        summary: z.string().min(1).describe("Final factual round summary."),
        result: z.string().min(1).describe("Final round result, for example completed, partial, or blocked."),
        nextCandidates: z.array(z.string().min(1)).max(10).optional().describe("Evidence-backed candidates for a later round."),
      },
      outputSchema: {
        result: z.string(),
        traceId: z.string(),
        round: z.record(z.string(), z.unknown()),
      },
      ...options.toolMeta(),
      annotations: writeAnnotations,
    },
    async ({ workspaceId, ...input }) => runTool(
      options,
      runner,
      "journal_complete_round",
      "complete_round",
      workspaceId,
      input,
    ),
  );

  registerAppTool(
    server,
    "journal_get_latest_round",
    {
      title: "Get latest journal round",
      description:
        "Read the latest completed main round or supervisor review from the MLflow-backed journal for a project.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        project: z.string().min(1).describe("Stable journal project name, for example saas-agent."),
        role: z.enum(["main", "supervisor"]).optional().describe("Defaults to main."),
      },
      outputSchema: {
        result: z.string(),
        round: z.record(z.string(), z.unknown()).nullable(),
      },
      ...options.toolMeta(),
      annotations: readAnnotations,
    },
    async ({ workspaceId, ...input }) => runTool(
      options,
      runner,
      "journal_get_latest_round",
      "get_latest_round",
      workspaceId,
      input,
    ),
  );

  registerAppTool(
    server,
    "journal_record_review",
    {
      title: "Record journal review",
      description:
        "Persist a supervisor review of a completed main round as a separate MLflow trace linked to the reviewed trace.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        project: z.string().min(1).describe("Stable journal project name, for example saas-agent."),
        reviewedTraceId: z.string().min(1).describe("Completed main-round trace being reviewed."),
        decision: z.enum(["CONTINUE", "COOLDOWN", "STOP"]),
        summary: z.string().min(1).describe("Evidence-based supervisor conclusion."),
        top3: z.array(z.string().min(1)).max(3).optional(),
        avoid: z.array(z.string().min(1)).max(10).optional(),
        unknowns: z.array(z.string().min(1)).max(10).optional(),
        reviewId: z.string().min(1).optional(),
      },
      outputSchema: {
        result: z.string(),
        traceId: z.string(),
        round: z.record(z.string(), z.unknown()),
      },
      ...options.toolMeta(),
      annotations: writeAnnotations,
    },
    async ({ workspaceId, ...input }) => runTool(
      options,
      runner,
      "journal_record_review",
      "record_review",
      workspaceId,
      input,
    ),
  );
}

async function runTool(
  options: JournalToolRegistrationOptions,
  runner: JournalCommandRunner,
  tool: string,
  action: JournalAction,
  workspaceId: string,
  input: Record<string, unknown>,
) {
  const startedAt = performance.now();
  try {
    const workspace = options.workspaces.getWorkspace(workspaceId);
    const payload = { ...input, workspaceRoot: workspace.root };
    const data = await runner.run(action, payload);
    const result = JSON.stringify(data, null, 2);
    const structuredContent: Record<string, unknown> = { result };
    if (typeof data.traceId === "string") structuredContent.traceId = data.traceId;
    if (typeof data.roundId === "string") structuredContent.roundId = data.roundId;
    if (typeof data.eventSpanId === "string") structuredContent.eventSpanId = data.eventSpanId;
    if ("round" in data) structuredContent.round = data.round;
    if (action === "complete_round" || action === "record_review") structuredContent.round = data;

    options.logToolCall({
      tool,
      workspaceId,
      success: true,
      durationMs: Math.round(performance.now() - startedAt),
    });

    return {
      content: [{ type: "text" as const, text: result }],
      structuredContent,
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
