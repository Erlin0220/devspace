import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "../config.js";
import {
  createLocalAgentClient,
  type LocalAgentClient,
} from "../local-agent-client.js";
import {
  toAgentErrorPayload,
  type LocalAgentError,
} from "../local-agent-errors.js";
import {
  localAgentProviderSupportsWriteMode,
  type LocalAgentWriteMode,
} from "../local-agent-runtime.js";
import {
  subagentRoutingTargets,
  type SubagentsConfig,
} from "../local-agent-config.js";
import { isLocalAgentProvider } from "../local-agent-profiles.js";
import { resolveQoderCommand } from "../local-agent-qoder.js";
import type {
  LocalAgentRecord,
  LocalAgentWorkspaceScope,
} from "../local-agent-store.js";
import type { ProcessSessionManager, ProcessSnapshot } from "../process-sessions.js";
import type { WorkspaceRegistry } from "../workspaces.js";

type LongrunAgentClient = Pick<LocalAgentClient, "start" | "get" | "continue">;
type LongrunProcessManager = Pick<ProcessSessionManager, "start" | "write" | "terminate">;

type LongrunJobStatus =
  | "running"
  | "pausing"
  | "paused"
  | "completed"
  | "awaiting_review"
  | "needs_review"
  | "canceling"
  | "cancelled";
type LongrunTaskStatus =
  | "pending"
  | "running"
  | "grading"
  | "passed"
  | "awaiting_review"
  | "needs_review"
  | "failed";
type LongrunExecutionMode = "agent_turn" | "qoder_goal";

export interface LongrunTaskInput {
  id: string;
  prompt: string;
  targets?: string[];
  dependsOn?: string[];
  writeMode?: LocalAgentWriteMode;
  executionMode?: LongrunExecutionMode;
  goalTurns?: number;
  requireSupervisorReview?: boolean;
  graderCommands?: string[];
  maxAttempts?: number;
  workerTimeoutMinutes?: number;
  graderTimeoutMinutes?: number;
}

interface GraderResult {
  command: string;
  exitCode?: number;
  timedOut: boolean;
  output: string;
  outputTruncated: boolean;
}

interface LongrunTaskState extends LongrunTaskInput {
  status: LongrunTaskStatus;
  attempts: number;
  target?: string;
  agentId?: string;
  qoderSessionId?: string;
  workerResponse?: string;
  error?: string;
  reviewNote?: string;
  graderResults: GraderResult[];
  startedAt?: string;
  completedAt?: string;
}

interface LongrunJob {
  id: string;
  title: string;
  workspaceId: string;
  workspaceRoot: string;
  status: LongrunJobStatus;
  defaultTargets?: string[];
  tasks: LongrunTaskState[];
  activeTaskId?: string;
  pauseRequested: boolean;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
}

interface LongrunState {
  schema: 1;
  jobs: LongrunJob[];
}

const resultOutputSchema = { result: z.string() };
const jobIdSchema = z.string().min(1);
const taskIdSchema = z.string().min(1);
const writeModeSchema = z.enum(["read_only", "allowed", "full_access"]);
const executionModeSchema = z.enum(["agent_turn", "qoder_goal"]);
const taskSchema = z.object({
  id: z.string().min(1).max(120),
  prompt: z.string().min(1).max(40_000),
  targets: z.array(z.string().min(1)).min(1).max(10).optional(),
  dependsOn: z.array(z.string().min(1)).max(50).optional(),
  writeMode: writeModeSchema.optional(),
  executionMode: executionModeSchema.optional(),
  goalTurns: z.number().int().min(1).max(5_000).optional(),
  requireSupervisorReview: z.boolean().optional(),
  graderCommands: z.array(z.string().min(1).max(8_000)).max(20).optional(),
  maxAttempts: z.number().int().min(1).max(5).optional(),
  workerTimeoutMinutes: z.number().int().min(1).max(1_440).optional(),
  graderTimeoutMinutes: z.number().int().min(1).max(60).optional(),
});

const TERMINAL_JOB_STATUSES = new Set<LongrunJobStatus>(["completed", "cancelled"]);
const SAFE_START_FALLBACK_CODES = new Set([
  "UNKNOWN_TARGET",
  "PROVIDER_DISABLED",
  "PROVIDER_UNAVAILABLE",
]);
const POLL_INTERVAL_MS = 1_000;
const DEFAULT_WORKER_TIMEOUT_MINUTES = 50;
const DEFAULT_GRADER_TIMEOUT_MINUTES = 10;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_QODER_GOAL_TURNS = 200;
const MAX_GRADER_OUTPUT = 12_000;
const LONGRUN_SUPERVISION = {
  mode: "scheduled_supervisor",
  inlinePolling: false,
} as const;

export class PersonalLongruns {
  private readonly client: LongrunAgentClient;
  private readonly statePath: string;
  private readonly dispatching = new Map<string, Promise<void>>();
  private state: LongrunState = { schema: 1, jobs: [] };
  private loaded = false;
  private loadPromise?: Promise<void>;
  private persistPromise = Promise.resolve();
  private resumed = false;

  constructor(
    private readonly config: ServerConfig,
    private readonly processes: LongrunProcessManager,
    stateHome: string,
    client: LongrunAgentClient = createLocalAgentClient(config),
    private readonly resolveSubagentsConfig: () => SubagentsConfig = () => config.subagents,
    private readonly resolveQoderCliCommand: () => string | undefined = () => resolveQoderCommand(),
  ) {
    this.client = client;
    this.statePath = join(stateHome, "longrun-jobs.json");
  }

  register(server: McpServer, workspaces: WorkspaceRegistry): void {
    if (!this.resumed) {
      this.resumed = true;
      void this.resumePersistedJobs();
    }

    server.registerTool(
      "start_longrun_job",
      {
        title: "Start durable DevSpace job",
        description:
          "Create a durable queue of bounded tasks, start it in the DevSpace runtime, and return immediately. This is a fire-and-forget handoff from the current MCP host turn: after success, do not keep this turn alive by polling get_longrun_job/list_longrun_jobs. If the host supports scheduled or conditional tasks, hand the returned job id to a scheduled supervisor and end the current turn; otherwise return the job id and inspect it only from a later turn. agent_turn uses the configured subagent runtime; qoder_goal runs the native Qoder CLI /goal loop in the workspace and keeps its session id for supervisor retries. Deterministic graders run outside the worker, and requireSupervisorReview keeps a self-completed task in awaiting_review until an independent supervisor approves it.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          title: z.string().min(1).max(200),
          defaultTargets: z.array(z.string().min(1)).min(1).max(10).optional().describe(
            "Optional job-level ordered target override. If omitted, each new task resolves current runtime routing.",
          ),
          tasks: z.array(taskSchema).min(1).max(100),
        },
        outputSchema: resultOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ workspaceId, title, defaultTargets, tasks }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const job = await this.createJob({
          workspaceId,
          workspaceRoot: workspace.root,
          title,
          defaultTargets,
          tasks,
        });
        return resultResponse(jobSummary(job));
      },
    );

    server.registerTool(
      "get_longrun_job",
      {
        title: "Get durable DevSpace job",
        description:
          "Read one durable job from a later or scheduled supervisor turn, including task states, deterministic grader evidence, review state, acceptanceReady, and current progress. Do not use this to busy-poll from the turn that created the job.",
        inputSchema: { jobId: jobIdSchema },
        outputSchema: resultOutputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ jobId }) => resultResponse(await this.getJob(jobId)),
    );

    server.registerTool(
      "list_longrun_jobs",
      {
        title: "List durable DevSpace jobs",
        description:
          "List persisted long-running jobs and compact progress counts with an acceptanceReady signal. This is intended for a scheduled supervisor or a later user turn, not for keeping the job-creation turn alive with polling.",
        inputSchema: {},
        outputSchema: resultOutputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => resultResponse(await this.listJobs()),
    );

    server.registerTool(
      "control_longrun_job",
      {
        title: "Control durable DevSpace job",
        description:
          "Pause, resume, or cancel queue draining. Pause/cancel never kills an already-running provider turn; it takes effect before the next task so active work is not orphaned.",
        inputSchema: {
          jobId: jobIdSchema,
          action: z.enum(["pause", "resume", "cancel"]),
        },
        outputSchema: resultOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ jobId, action }) => resultResponse(await this.controlJob(jobId, action)),
    );

    server.registerTool(
      "review_longrun_task",
      {
        title: "Review durable DevSpace task",
        description:
          "Apply the independent supervisor decision to a task that needs review. Approve marks the task passed, retry gives its existing worker session one more bounded turn when possible, and reject marks it failed. Queue draining then resumes for newly-unblocked tasks.",
        inputSchema: {
          jobId: jobIdSchema,
          taskId: taskIdSchema,
          action: z.enum(["approve", "retry", "reject"]),
          note: z.string().max(8_000).optional(),
        },
        outputSchema: resultOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ jobId, taskId, action, note }) =>
        resultResponse(await this.reviewTask(jobId, taskId, action, note)),
    );
  }

  async createJob(input: {
    workspaceId: string;
    workspaceRoot: string;
    title: string;
    defaultTargets?: string[];
    tasks: LongrunTaskInput[];
  }): Promise<LongrunJob> {
    await this.ensureLoaded();
    this.validateTasks(input.tasks);
    const existing = this.state.jobs.find(
      (job) => job.workspaceRoot === input.workspaceRoot && !TERMINAL_JOB_STATUSES.has(job.status),
    );
    if (existing) {
      throw new Error(
        `Workspace already has an active long-run job: ${existing.id} (${existing.status}).`,
      );
    }

    const defaultTargets = input.defaultTargets
      ? uniqueNonEmpty(input.defaultTargets)
      : undefined;

    const now = new Date().toISOString();
    const job: LongrunJob = {
      id: `lr_${randomUUID().replaceAll("-", "").slice(0, 10)}`,
      title: input.title,
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      status: "running",
      ...(defaultTargets ? { defaultTargets } : {}),
      tasks: input.tasks.map((task) => {
        const targets = task.targets ? uniqueNonEmpty(task.targets) : undefined;
        const executionMode = task.executionMode ?? "agent_turn";
        const effectiveTargets = targets ?? defaultTargets;
        if (executionMode === "qoder_goal" && effectiveTargets?.[0] !== "qoder") {
          throw new Error(
            `Task ${task.id} uses qoder_goal and must pin qoder as its first target.`,
          );
        }
        const writeMode =
          task.writeMode ?? defaultWriteModeForTargets(effectiveTargets);
        if (executionMode === "qoder_goal" && writeMode === "read_only") {
          throw new Error(`Task ${task.id} uses qoder_goal and requires writable mode.`);
        }
        return {
          ...task,
          targets,
          dependsOn: task.dependsOn ? uniqueNonEmpty(task.dependsOn) : undefined,
          writeMode,
          executionMode,
          goalTurns: task.goalTurns ?? DEFAULT_QODER_GOAL_TURNS,
          requireSupervisorReview:
            task.requireSupervisorReview ?? executionMode === "qoder_goal",
          graderCommands: task.graderCommands ?? [],
          maxAttempts: task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
          workerTimeoutMinutes: task.workerTimeoutMinutes ?? DEFAULT_WORKER_TIMEOUT_MINUTES,
          graderTimeoutMinutes: task.graderTimeoutMinutes ?? DEFAULT_GRADER_TIMEOUT_MINUTES,
          status: "pending",
          attempts: 0,
          graderResults: [],
        };
      }),
      pauseRequested: false,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    };
    this.state.jobs.push(job);
    await this.persist();
    this.dispatch(job.id);
    return cloneJob(job);
  }

  async getJob(jobId: string): Promise<LongrunJob> {
    await this.ensureLoaded();
    return jobView(this.requireJob(jobId));
  }

  async listJobs(): Promise<ReturnType<typeof jobSummary>[]> {
    await this.ensureLoaded();
    return this.state.jobs
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(jobSummary);
  }

  async controlJob(
    jobId: string,
    action: "pause" | "resume" | "cancel",
  ): Promise<ReturnType<typeof jobSummary>> {
    await this.ensureLoaded();
    const job = this.requireJob(jobId);
    if (TERMINAL_JOB_STATUSES.has(job.status)) return jobSummary(job);

    if (action === "pause") {
      job.pauseRequested = true;
      job.status = job.activeTaskId ? "pausing" : "paused";
    } else if (action === "cancel") {
      job.cancelRequested = true;
      job.status = job.activeTaskId ? "canceling" : "cancelled";
    } else {
      job.pauseRequested = false;
      job.cancelRequested = false;
      job.status = "running";
      this.dispatch(job.id);
    }
    this.touch(job);
    await this.persist();
    return jobSummary(job);
  }

  async reviewTask(
    jobId: string,
    taskId: string,
    action: "approve" | "retry" | "reject",
    note?: string,
  ): Promise<LongrunJob> {
    await this.ensureLoaded();
    const job = this.requireJob(jobId);
    const task = this.requireTask(job, taskId);
    if (!["awaiting_review", "needs_review", "failed"].includes(task.status)) {
      throw new Error(`Task ${taskId} is not waiting for supervisor review.`);
    }

    task.reviewNote = note;
    if (action === "approve") {
      task.status = "passed";
      task.completedAt = new Date().toISOString();
    } else if (action === "reject") {
      task.status = "failed";
      task.completedAt = new Date().toISOString();
    } else {
      task.status = "pending";
      task.error = undefined;
      task.completedAt = undefined;
      task.reviewNote = note ?? "Supervisor requested one additional bounded attempt.";
      task.maxAttempts = Math.max(task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, task.attempts + 1);
    }
    job.status = "running";
    this.touch(job);
    await this.persist();
    this.dispatch(job.id);
    return cloneJob(job);
  }

  async close(): Promise<void> {
    await this.persistPromise;
  }

  private dispatch(jobId: string): void {
    if (this.dispatching.has(jobId)) return;
    const promise = this.drain(jobId)
      .catch(async (error) => {
        await this.ensureLoaded();
        const job = this.state.jobs.find((candidate) => candidate.id === jobId);
        if (job && !TERMINAL_JOB_STATUSES.has(job.status)) {
          job.status = "needs_review";
          const task = job.activeTaskId
            ? job.tasks.find((candidate) => candidate.id === job.activeTaskId)
            : undefined;
          if (task) {
            task.status = "needs_review";
            task.error = errorMessage(error);
          }
          job.activeTaskId = undefined;
          this.touch(job);
          await this.persist();
        }
      })
      .finally(() => this.dispatching.delete(jobId));
    this.dispatching.set(jobId, promise);
  }

  private async drain(jobId: string): Promise<void> {
    await this.ensureLoaded();
    const job = this.requireJob(jobId);

    while (!TERMINAL_JOB_STATUSES.has(job.status)) {
      const activeTask = job.activeTaskId
        ? job.tasks.find(
            (candidate) =>
              candidate.id === job.activeTaskId &&
              ["running", "grading"].includes(candidate.status),
          )
        : undefined;
      if (!activeTask && job.cancelRequested) {
        job.status = "cancelled";
        job.activeTaskId = undefined;
        this.touch(job);
        await this.persist();
        return;
      }
      if (!activeTask && job.pauseRequested) {
        job.status = "paused";
        job.activeTaskId = undefined;
        this.touch(job);
        await this.persist();
        return;
      }

      const task = activeTask ?? this.nextRunnableTask(job);
      if (!task) {
        job.activeTaskId = undefined;
        job.status = job.tasks.every((candidate) => candidate.status === "passed")
          ? "completed"
          : job.tasks.some((candidate) => candidate.status === "awaiting_review")
            ? "awaiting_review"
            : "needs_review";
        this.touch(job);
        await this.persist();
        return;
      }

      if (!activeTask) {
        job.status = "running";
        job.activeTaskId = task.id;
        task.status = "running";
        task.startedAt ??= new Date().toISOString();
        this.touch(job);
        await this.persist();
      }

      await this.executeTask(job, task);

      job.activeTaskId = undefined;
      this.touch(job);
      await this.persist();
    }
  }

  private async executeTask(job: LongrunJob, task: LongrunTaskState): Promise<void> {
    if (task.executionMode === "qoder_goal") {
      await this.executeQoderGoalTask(job, task);
      return;
    }

    if (
      task.status === "running" &&
      task.agentId &&
      task.attempts > 0 &&
      !task.reviewNote
    ) {
      const terminal = await this.waitForAgent(job, task, task.agentId);
      if (!terminal) return;
      const decision = await this.evaluateWorkerResult(job, task, terminal);
      if (decision !== "retry") return;
    } else if (task.status === "grading" && task.attempts > 0) {
      const decision = await this.gradeTask(job, task);
      if (decision !== "retry") return;
    }

    while (task.attempts < (task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
      const retryEvidence = task.reviewNote;
      task.reviewNote = undefined;
      task.attempts += 1;
      task.error = undefined;
      task.graderResults = [];
      this.touch(job);
      await this.persist();

      let record: LocalAgentRecord;
      if (task.agentId && task.attempts > 1) {
        const continued = await this.client.continue(
          task.agentId,
          this.retryPrompt(
            task,
            retryEvidence ?? "Supervisor requested one additional bounded attempt.",
          ),
          { writeMode: task.writeMode },
          jobScope(job),
        );
        if (continued.isErr()) {
          const failure = formatAgentError(continued.error);
          const payload = toAgentErrorPayload(continued.error);
          if (payload.retryable && task.attempts < (task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
            task.status = "running";
            task.error = failure;
            task.reviewNote = failure;
            await sleep(POLL_INTERVAL_MS);
            continue;
          }
          task.status = "needs_review";
          task.error = failure;
          task.completedAt = new Date().toISOString();
          return;
        }
        record = continued.value;
      } else {
        const started = await this.startWithFallback(job, task);
        if (started === "retry") {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        if (!started) return;
        record = started;
      }

      task.agentId = record.id;
      task.workerResponse = undefined;
      task.status = "running";
      this.touch(job);
      await this.persist();

      const terminal = await this.waitForAgent(job, task, record.id);
      if (!terminal) return;
      const decision = await this.evaluateWorkerResult(job, task, terminal);
      if (decision !== "retry") return;
    }
  }

  private async executeQoderGoalTask(
    job: LongrunJob,
    task: LongrunTaskState,
  ): Promise<void> {
    const maximumAttempts = task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (
      task.status === "running" &&
      task.qoderSessionId &&
      task.attempts > 0 &&
      !task.reviewNote
    ) {
      const recovered = await this.resumeQoderGoal(job, task);
      task.workerResponse = appendBounded(
        task.workerResponse ?? "",
        recovered.output,
        50_000,
      );
      if (recovered.completed) {
        task.error = undefined;
        await this.gradeTask(job, task);
        return;
      }
      task.status = "needs_review";
      task.error =
        recovered.failure ?? "Unable to safely resume the persisted Qoder Goal.";
      task.completedAt = new Date().toISOString();
      return;
    }

    while (task.attempts < maximumAttempts) {
      const retryEvidence = task.reviewNote;
      task.reviewNote = undefined;
      task.attempts += 1;
      task.error = undefined;
      task.graderResults = [];
      task.target = "qoder";
      const existingSession = Boolean(task.qoderSessionId);
      task.qoderSessionId ??= randomUUID();
      task.status = "running";
      this.touch(job);
      await this.persist();

      const goal = qoderGoalObjective(task, retryEvidence);
      const result = await this.runQoderGoal(job, task, goal, existingSession);
      task.workerResponse = result.output;
      if (!result.completed) {
        const failure = result.failure ?? "Qoder Goal did not reach a completed state.";
        task.error = failure;
        if (task.attempts >= maximumAttempts) {
          task.status = "needs_review";
          task.completedAt = new Date().toISOString();
          return;
        }
        task.reviewNote = failure;
        this.touch(job);
        await this.persist();
        continue;
      }

      task.error = undefined;
      const decision = await this.gradeTask(job, task);
      if (decision !== "retry") return;
    }
  }

  private async resumeQoderGoal(
    job: LongrunJob,
    task: LongrunTaskState,
  ): Promise<{ completed: boolean; output: string; failure?: string }> {
    const qoderCommand = this.resolveQoderCliCommand();
    const sessionId = task.qoderSessionId;
    if (!qoderCommand || !sessionId) {
      return {
        completed: false,
        output: "",
        failure: !qoderCommand
          ? "Qoder CLI executable was not found."
          : "Persisted Qoder Goal session id is missing.",
      };
    }
    const command = qoderResumeCommand(qoderCommand, sessionId);
    const before = await this.runManagedCommand(
      job,
      command,
      Math.min(2, task.workerTimeoutMinutes ?? DEFAULT_WORKER_TIMEOUT_MINUTES),
      "/goal status\n",
      8_000,
    );
    if (!before.timedOut && before.exitCode === 0 && /\bNo active goal\b/i.test(before.output)) {
      return { completed: true, output: before.output };
    }
    const beforeState = qoderGoalState(before.output);
    if (beforeState === "complete") {
      return { completed: true, output: before.output };
    }
    if (!["active", "paused"].includes(beforeState ?? "")) {
      return {
        completed: false,
        output: before.output,
        failure: "Unable to determine a resumable persisted Qoder Goal state.",
      };
    }

    const resumed = await this.runManagedCommand(
      job,
      command,
      task.workerTimeoutMinutes ?? DEFAULT_WORKER_TIMEOUT_MINUTES,
      "/goal resume\n",
      50_000,
    );
    const after = await this.runManagedCommand(
      job,
      command,
      Math.min(2, task.workerTimeoutMinutes ?? DEFAULT_WORKER_TIMEOUT_MINUTES),
      "/goal status\n",
      8_000,
    );
    const output = appendBounded(
      before.output,
      appendBounded(resumed.output, after.output, 50_000),
      50_000,
    );
    if (
      !after.timedOut &&
      after.exitCode === 0 &&
      (/\bNo active goal\b/i.test(after.output) || qoderGoalState(after.output) === "complete")
    ) {
      return { completed: true, output };
    }
    return {
      completed: false,
      output,
      failure: resumed.timedOut || resumed.exitCode !== 0
        ? "Persisted Qoder Goal could not be resumed to completion."
        : `Persisted Qoder Goal remains ${qoderGoalState(after.output) ?? "unproven"}.`,
    };
  }

  private async runQoderGoal(
    job: LongrunJob,
    task: LongrunTaskState,
    objective: string,
    existingSession: boolean,
  ): Promise<{ completed: boolean; output: string; failure?: string }> {
    const qoderCommand = this.resolveQoderCliCommand();
    if (!qoderCommand) {
      return {
        completed: false,
        output: "",
        failure: "Qoder CLI executable was not found.",
      };
    }
    const sessionId = task.qoderSessionId;
    if (!sessionId) {
      return {
        completed: false,
        output: "",
        failure: "Qoder Goal session id was not initialized.",
      };
    }

    const sessionArgument = existingSession
      ? `--resume ${sessionId}`
      : `--session-id ${sessionId}`;
    const command = [
      shellCommandArg(qoderCommand),
      "-p",
      "--permission-mode auto",
      "--output-format text",
      sessionArgument,
    ].join(" ");
    const goalCommand =
      `/goal ${singleLine(objective)} --turns ${task.goalTurns ?? DEFAULT_QODER_GOAL_TURNS}\n`;
    const run = await this.runManagedCommand(
      job,
      command,
      task.workerTimeoutMinutes ?? DEFAULT_WORKER_TIMEOUT_MINUTES,
      goalCommand,
      50_000,
    );
    if (run.timedOut || run.exitCode !== 0) {
      return {
        completed: false,
        output: run.output,
        failure: [
          "Qoder Goal process did not complete successfully.",
          `exitCode: ${run.exitCode ?? "unknown"}`,
          `timedOut: ${run.timedOut}`,
          run.output || "(no output)",
        ].join("\n"),
      };
    }
    if (/\bGoal closed\b/i.test(run.output)) {
      return { completed: true, output: run.output };
    }

    const statusCommand = qoderResumeCommand(qoderCommand, sessionId);
    const status = await this.runManagedCommand(
      job,
      statusCommand,
      Math.min(2, task.workerTimeoutMinutes ?? DEFAULT_WORKER_TIMEOUT_MINUTES),
      "/goal status\n",
      8_000,
    );
    const combined = appendBounded(run.output, status.output, 50_000);
    if (
      !status.timedOut &&
      status.exitCode === 0 &&
      /\bNo active goal\b/i.test(status.output)
    ) {
      return { completed: true, output: combined };
    }
    const state = qoderGoalState(status.output);
    return {
      completed: state === "complete",
      output: combined,
      failure:
        state
          ? `Qoder Goal remains ${state} after the worker process returned.`
          : "Unable to prove that the Qoder Goal completed; supervisor-safe fallback is retry/review.",
    };
  }

  private async evaluateWorkerResult(
    job: LongrunJob,
    task: LongrunTaskState,
    terminal: LocalAgentRecord,
  ): Promise<"done" | "retry"> {
    task.workerResponse = terminal.latestResponse;
    if (terminal.status !== "idle") {
      const failure = formatAgentRecordError(terminal);
      if (
        terminal.errorRetryable === true &&
        task.attempts < (task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
      ) {
        task.status = "running";
        task.error = failure;
        task.reviewNote = failure;
        task.completedAt = undefined;
        return "retry";
      }
      task.status = "needs_review";
      task.error = failure;
      task.completedAt = new Date().toISOString();
      return "done";
    }
    return this.gradeTask(job, task);
  }

  private async gradeTask(
    job: LongrunJob,
    task: LongrunTaskState,
  ): Promise<"done" | "retry"> {
    const graders = task.graderCommands ?? [];
    if (graders.length === 0) {
      task.status = "awaiting_review";
      task.error = undefined;
      task.reviewNote =
        "No deterministic grader was supplied. Supervisor review is required; worker self-certification is not accepted.";
      task.completedAt = new Date().toISOString();
      return "done";
    }

    task.status = "grading";
    this.touch(job);
    await this.persist();
    task.graderResults = await this.runGraders(job, task);
    if (task.graderResults.every((result) => result.exitCode === 0 && !result.timedOut)) {
      if (task.requireSupervisorReview) {
        task.status = "awaiting_review";
        task.completedAt = new Date().toISOString();
        task.error = undefined;
        task.reviewNote =
          "Worker self-verification and deterministic graders completed. Independent supervisor approval is still required.";
        return "done";
      }
      task.status = "passed";
      task.completedAt = new Date().toISOString();
      task.error = undefined;
      return "done";
    }

    const failure = graderFailureSummary(task.graderResults);
    if (task.attempts >= (task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
      task.status = "needs_review";
      task.error = failure;
      task.completedAt = new Date().toISOString();
      return "done";
    }

    task.status = "running";
    task.reviewNote = failure;
    task.error = failure;
    this.touch(job);
    await this.persist();
    return "retry";
  }

  private async startWithFallback(
    job: LongrunJob,
    task: LongrunTaskState,
  ): Promise<LocalAgentRecord | "retry" | undefined> {
    const runtimeTargets = subagentRoutingTargets(
      this.resolveSubagentsConfig(),
      task.writeMode,
    );
    const configuredTargets = uniqueNonEmpty(
      task.targets ?? job.defaultTargets ?? runtimeTargets,
    );
    const targets = configuredTargets.filter(
      (target) =>
        !isLocalAgentProvider(target) ||
        localAgentProviderSupportsWriteMode(target, task.writeMode),
    );
    if (targets.length === 0) {
      task.status = "needs_review";
      task.error = configuredTargets.length === 0
        ? "No enabled worker target is available in the current runtime routing configuration."
        : `No configured worker target supports write mode ${task.writeMode ?? "allowed"}. Configured targets: ${configuredTargets.join(", ")}.`;
      return undefined;
    }
    const failures: string[] = [];
    let retryableFailure = false;
    for (const target of targets) {
      let result = await this.client.start({
        target,
        prompt: workerPrompt(task),
        workspaceRoot: job.workspaceRoot,
        workspaceId: job.workspaceId,
        writeMode: task.writeMode,
      });
      if (result.isErr() && toAgentErrorPayload(result.error).code === "DAEMON_STARTUP_FAILURE") {
        result = await this.client.start({
          target,
          prompt: workerPrompt(task),
          workspaceRoot: job.workspaceRoot,
          workspaceId: job.workspaceId,
          writeMode: task.writeMode,
        });
      }
      if (!result.isErr()) {
        task.target = target;
        return result.value;
      }

      const payload = toAgentErrorPayload(result.error);
      failures.push(`${target}: ${payload.code}: ${payload.message}`);
      retryableFailure ||= payload.retryable === true;
      if (!SAFE_START_FALLBACK_CODES.has(payload.code)) {
        task.status = "needs_review";
        task.error = failures.join("\n");
        task.completedAt = new Date().toISOString();
        return undefined;
      }
    }
    const failure = `No allowed worker target could start.\n${failures.join("\n")}`;
    if (retryableFailure && task.attempts < (task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
      task.status = "running";
      task.error = failure;
      task.reviewNote = failure;
      return "retry";
    }
    task.status = "needs_review";
    task.error = failure;
    task.completedAt = new Date().toISOString();
    return undefined;
  }

  private async waitForAgent(
    job: LongrunJob,
    task: LongrunTaskState,
    agentId: string,
  ): Promise<LocalAgentRecord | undefined> {
    const deadline =
      Date.now() + (task.workerTimeoutMinutes ?? DEFAULT_WORKER_TIMEOUT_MINUTES) * 60_000;
    while (Date.now() < deadline) {
      const result = await this.client.get(agentId, jobScope(job));
      if (result.isErr()) {
        const payload = toAgentErrorPayload(result.error);
        if (payload.retryable) {
          task.error = formatAgentError(result.error);
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        task.status = "needs_review";
        task.error = formatAgentError(result.error);
        task.completedAt = new Date().toISOString();
        return undefined;
      }
      if (["idle", "error", "stopped"].includes(result.value.status)) return result.value;
      await sleep(POLL_INTERVAL_MS);
    }
    task.status = "needs_review";
    task.error =
      `Worker exceeded ${task.workerTimeoutMinutes ?? DEFAULT_WORKER_TIMEOUT_MINUTES} minutes. The dispatcher stopped scheduling new tasks because the active provider turn cannot be safely orphaned.`;
    job.pauseRequested = true;
    return undefined;
  }

  private async runGraders(
    job: LongrunJob,
    task: LongrunTaskState,
  ): Promise<GraderResult[]> {
    const results: GraderResult[] = [];
    for (const command of task.graderCommands ?? []) {
      results.push(await this.runGraderCommand(job, task, command));
      if (results.at(-1)?.exitCode !== 0 || results.at(-1)?.timedOut) break;
    }
    return results;
  }

  private async runGraderCommand(
    job: LongrunJob,
    task: LongrunTaskState,
    command: string,
  ): Promise<GraderResult> {
    return this.runManagedCommand(
      job,
      command,
      task.graderTimeoutMinutes ?? DEFAULT_GRADER_TIMEOUT_MINUTES,
      undefined,
      MAX_GRADER_OUTPUT,
    );
  }

  private async runManagedCommand(
    job: LongrunJob,
    command: string,
    timeoutMinutes: number,
    initialStdin: string | undefined,
    maximumOutput: number,
  ): Promise<GraderResult> {
    const timeoutMs = timeoutMinutes * 60_000;
    const deadline = Date.now() + timeoutMs;
    let snapshot = await this.processes.start({
      workspaceId: job.workspaceId,
      command,
      cwd: job.workspaceRoot,
      workspaceRoot: job.workspaceRoot,
      initialStdin,
      yieldTimeMs: 30_000,
      maxOutputTokens: 8_000,
    });
    let output = snapshot.output;
    let truncated = snapshot.outputTruncated;
    while (snapshot.running && snapshot.sessionId !== undefined && Date.now() < deadline) {
      snapshot = await this.processes.write({
        workspaceId: job.workspaceId,
        sessionId: snapshot.sessionId,
        yieldTimeMs: 30_000,
        maxOutputTokens: 8_000,
      });
      output = appendBounded(output, snapshot.output, maximumOutput);
      truncated = truncated || snapshot.outputTruncated;
    }

    let timedOut = false;
    if (snapshot.running && snapshot.sessionId !== undefined) {
      timedOut = true;
      this.processes.terminate(job.workspaceId, snapshot.sessionId);
      await sleep(250);
      const final = await this.processes.write({
        workspaceId: job.workspaceId,
        sessionId: snapshot.sessionId,
        yieldTimeMs: 1_000,
        maxOutputTokens: 2_000,
      }).catch((): ProcessSnapshot => snapshot);
      snapshot = final;
      output = appendBounded(output, final.output, maximumOutput);
      truncated = truncated || final.outputTruncated;
    }

    return {
      command,
      exitCode: snapshot.exitCode,
      timedOut,
      output,
      outputTruncated: truncated,
    };
  }

  private nextRunnableTask(job: LongrunJob): LongrunTaskState | undefined {
    const passed = new Set(
      job.tasks.filter((task) => task.status === "passed").map((task) => task.id),
    );
    return job.tasks.find(
      (task) =>
        task.status === "pending" &&
        (task.dependsOn ?? []).every((dependency) => passed.has(dependency)),
    );
  }

  private retryPrompt(task: LongrunTaskState, evidence: string): string {
    return [
      "Continue the same bounded task. You are the worker, not the final judge.",
      "Do not change or weaken acceptance/grader commands.",
      "Repair only what is necessary for this task and stay inside the original scope.",
      "",
      "Independent grader/supervisor evidence:",
      evidence || "(no additional note)",
      "",
      "Original task:",
      task.prompt,
    ].join("\n");
  }

  private validateTasks(tasks: LongrunTaskInput[]): void {
    const ids = new Set<string>();
    for (const task of tasks) {
      if (ids.has(task.id)) throw new Error(`Duplicate long-run task id: ${task.id}`);
      ids.add(task.id);
    }
    for (const task of tasks) {
      for (const dependency of task.dependsOn ?? []) {
        if (dependency === task.id) throw new Error(`Task ${task.id} cannot depend on itself.`);
        if (!ids.has(dependency)) {
          throw new Error(`Task ${task.id} depends on unknown task ${dependency}.`);
        }
      }
    }
    assertAcyclic(tasks);
  }

  private requireJob(jobId: string): LongrunJob {
    const job = this.state.jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error(`Unknown long-run job: ${jobId}`);
    return job;
  }

  private requireTask(job: LongrunJob, taskId: string): LongrunTaskState {
    const task = job.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Unknown long-run task ${taskId} in job ${job.id}.`);
    return task;
  }

  private async resumePersistedJobs(): Promise<void> {
    await this.ensureLoaded();
    for (const job of this.state.jobs) {
      if (["running", "pausing", "canceling"].includes(job.status)) this.dispatch(job.id);
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const parsed = JSON.parse((await readFile(this.statePath, "utf8")).replace(/^\uFEFF/, ""));
          if (parsed?.schema !== 1 || !Array.isArray(parsed.jobs)) {
            throw new Error("Unsupported long-run state schema.");
          }
          this.state = parsed as LongrunState;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        this.loaded = true;
      })();
    }
    await this.loadPromise;
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2) + "\n";
    this.persistPromise = this.persistPromise.then(() => atomicWrite(this.statePath, snapshot));
    return this.persistPromise;
  }

  private touch(job: LongrunJob): void {
    job.updatedAt = new Date().toISOString();
  }
}

function workerPrompt(task: LongrunTaskState): string {
  const graders = task.graderCommands ?? [];
  return [
    "You are a bounded execution worker. Do the task; do not self-certify the final acceptance result.",
    "The DevSpace dispatcher will independently run deterministic graders after your turn.",
    "Do not alter, skip, weaken, or replace grader commands. Do not expand task scope.",
    "",
    "Task:",
    task.prompt,
    "",
    "Independent grader commands (for awareness only; the dispatcher owns them):",
    ...(graders.length > 0 ? graders.map((command) => `- ${command}`) : ["- none; supervisor review will be required"]),
    "",
    "Return a concise execution summary and evidence locations. Never claim overall PASS without the dispatcher.",
  ].join("\n");
}

function qoderGoalObjective(task: LongrunTaskState, reviewEvidence?: string): string {
  return [
    "Complete this acceptance task end-to-end as the implementation worker.",
    "Validate the real current state, fix every local actionable defect you find, rerun the smallest relevant checks, and keep iterating until your own completion audit finds no remaining local actionable work.",
    "Do not commit, push, deploy, edit the formal acceptance ledger/status documents, or mark task checkboxes as passed; DevSpace and the web supervisor own final acceptance and authoritative acceptance records.",
    "Return concrete evidence paths, commands, outputs, screenshots, and remaining blockers so the independent supervisor can verify your candidate without guessing.",
    "If a genuine external dependency prevents final acceptance, finish every locally possible part and return EXTERNAL_BLOCKER with concrete evidence instead of fabricating a pass.",
    "",
    "Acceptance task:",
    task.prompt,
    ...(reviewEvidence
      ? [
          "",
          "Independent supervisor feedback from the previous candidate:",
          reviewEvidence,
          "Address that evidence before declaring this candidate complete.",
        ]
      : []),
  ].join("\n");
}

function jobScope(job: LongrunJob): LocalAgentWorkspaceScope {
  return { workspaceId: job.workspaceId, workspaceRoot: job.workspaceRoot };
}

function jobSummary(job: LongrunJob) {
  const counts = {
    pending: 0,
    running: 0,
    grading: 0,
    passed: 0,
    awaiting_review: 0,
    needs_review: 0,
    failed: 0,
  };
  for (const task of job.tasks) counts[task.status] += 1;
  return {
    id: job.id,
    title: job.title,
    workspaceId: job.workspaceId,
    workspaceRoot: job.workspaceRoot,
    status: job.status,
    activeTaskId: job.activeTaskId,
    counts,
    acceptanceReady: acceptanceReady(job),
    supervision: LONGRUN_SUPERVISION,
    updatedAt: job.updatedAt,
  };
}

function resultResponse(value: unknown) {
  const result = JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text" as const, text: result }],
    structuredContent: { result },
  };
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function shellCommandArg(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Unsafe command argument.");
  if (process.platform === "win32") {
    if (value.includes('"')) throw new Error("Qoder executable path cannot contain a quote.");
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function qoderResumeCommand(qoderCommand: string, sessionId: string): string {
  return [
    shellCommandArg(qoderCommand),
    "-p",
    "--permission-mode auto",
    "--output-format text",
    `--resume ${sessionId}`,
  ].join(" ");
}

function qoderGoalState(output: string): "active" | "paused" | "complete" | undefined {
  const value = output.match(/\*\*Status:\*\*\s*(active|paused|complete)/i)?.[1];
  return value?.toLowerCase() as "active" | "paused" | "complete" | undefined;
}

function defaultWriteModeForTargets(
  targets: readonly string[] | undefined,
): LocalAgentWriteMode {
  const firstTarget = targets?.[0];
  if (
    firstTarget &&
    isLocalAgentProvider(firstTarget) &&
    !localAgentProviderSupportsWriteMode(firstTarget, "read_only") &&
    localAgentProviderSupportsWriteMode(firstTarget, "allowed")
  ) {
    return "allowed";
  }
  return "read_only";
}

function cloneJob(job: LongrunJob): LongrunJob {
  return structuredClone(job);
}

function jobView(
  job: LongrunJob,
): LongrunJob & { acceptanceReady: boolean; supervision: typeof LONGRUN_SUPERVISION } {
  return {
    ...cloneJob(job),
    acceptanceReady: acceptanceReady(job),
    supervision: LONGRUN_SUPERVISION,
  };
}

function acceptanceReady(job: LongrunJob): boolean {
  return job.status === "completed" ||
    job.tasks.some((task) => task.status === "awaiting_review");
}

function formatAgentError(error: LocalAgentError): string {
  const payload = toAgentErrorPayload(error);
  return `${payload.code}: ${payload.message}${payload.retryable ? " [retryable]" : ""}`;
}

function formatAgentRecordError(record: LocalAgentRecord): string {
  const code = record.errorCode ? `${record.errorCode}: ` : "";
  const message = record.error ?? `Worker ended with status ${record.status}.`;
  return `${code}${message}${record.errorRetryable ? " [retryable]" : ""}`;
}

function graderFailureSummary(results: GraderResult[]): string {
  const failed = results.find((result) => result.timedOut || result.exitCode !== 0);
  if (!failed) return "Independent grader did not produce a passing result.";
  return [
    `Grader command: ${failed.command}`,
    `exitCode: ${failed.exitCode ?? "unknown"}`,
    `timedOut: ${failed.timedOut}`,
    "output:",
    failed.output || "(no output)",
  ].join("\n");
}

function appendBounded(current: string, next: string, maximum: number): string {
  if (!next) return current;
  const combined = current ? `${current}\n${next}` : next;
  if (combined.length <= maximum) return combined;
  const half = Math.floor((maximum - 32) / 2);
  return `${combined.slice(0, half)}\n... output truncated ...\n${combined.slice(-half)}`;
}

function assertAcyclic(tasks: LongrunTaskInput[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Long-run task dependency cycle includes ${id}.`);
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, path);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(code ?? "") || attempt >= 9) {
          throw error;
        }
        await sleep(10 * (attempt + 1));
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
