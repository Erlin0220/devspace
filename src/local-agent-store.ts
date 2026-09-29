import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Result, type Result as BetterResult } from "better-result";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { AgentStoreError, isProgrammerDefect } from "./local-agent-errors.js";
import type { LocalAgentExecutionMode, LocalAgentWriteMode } from "./local-agent-runtime.js";

export type LocalAgentStatus = "starting" | "running" | "awaiting_review" | "idle" | "error" | "stopped";
export type LocalAgentReviewStatus = "not_required" | "pending" | "approved" | "rejected";
export type LocalAgentWorkspaceMode = "checkout" | "worktree";
export type LocalAgentRunClaimResult = "claimed" | "capacity" | "state_changed";

export interface LocalAgentGraderResult {
  command: string;
  exitCode?: number;
  timedOut: boolean;
  output: string;
}

export interface LocalAgentRecord {
  id: string;
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  effort?: string;
  providerSessionId?: string;
  executionOwner?: string;
  workspaceMode?: LocalAgentWorkspaceMode;
  writeMode?: LocalAgentWriteMode;
  executionMode?: LocalAgentExecutionMode;
  goalTurns?: number;
  requireReview?: boolean;
  reviewStatus?: LocalAgentReviewStatus;
  reviewNote?: string;
  attempts?: number;
  maxAttempts?: number;
  graderCommands?: string[];
  graderResults?: LocalAgentGraderResult[];
  processId?: number;
  status: LocalAgentStatus;
  latestResponse?: string;
  error?: string;
  errorCode?: string;
  errorRetryable?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLocalAgentRecordInput {
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  executionOwner?: string;
  workspaceMode?: LocalAgentWorkspaceMode;
  writeMode?: LocalAgentWriteMode;
  model?: string;
  effort?: string;
  executionMode?: LocalAgentExecutionMode;
  goalTurns?: number;
  requireReview?: boolean;
  maxAttempts?: number;
  graderCommands?: string[];
}

export interface LocalAgentWorkspaceScope {
  workspaceId?: string;
  workspaceRoot: string;
}

export interface LocalAgentListScope {
  workspaceId?: string;
  workspaceRoot?: string;
}

interface LocalAgentRow {
  id: string;
  workspace_id: string | null;
  workspace_root: string;
  profile_name: string;
  provider: string;
  model: string | null;
  effort: string | null;
  provider_session_id: string | null;
  execution_owner: string | null;
  workspace_mode: string | null;
  write_mode: string | null;
  execution_mode: string | null;
  goal_turns: number | null;
  require_review: string | null;
  review_status: string | null;
  review_note: string | null;
  attempts: number | null;
  max_attempts: number | null;
  grader_commands: string | null;
  grader_results: string | null;
  process_id: number | null;
  status: string;
  latest_response: string | null;
  error: string | null;
  error_code: string | null;
  error_retryable: string | null;
  created_at: string;
  updated_at: string;
}

export class LocalAgentStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  list(scope: LocalAgentListScope = {}): LocalAgentRecord[] {
    let rows: LocalAgentRow[];
    if (scope.workspaceId && scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_id = ? and workspace_root = ?
           order by updated_at desc`,
        )
        .all(scope.workspaceId, resolve(scope.workspaceRoot)) as LocalAgentRow[];
    } else if (scope.workspaceId) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_id = ?
           order by updated_at desc`,
        )
        .all(scope.workspaceId) as LocalAgentRow[];
    } else if (scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_root = ?
           order by updated_at desc`,
        )
        .all(resolve(scope.workspaceRoot)) as LocalAgentRow[];
    } else {
      rows = this.database.sqlite
        .prepare("select * from local_agent_sessions order by updated_at desc")
        .all() as LocalAgentRow[];
    }

    return rows.map(rowToLocalAgentRecord);
  }

  listResult(scope: LocalAgentListScope = {}): BetterResult<LocalAgentRecord[], AgentStoreError> {
    return storeResult("list", () => this.list(scope));
  }

  create(input: CreateLocalAgentRecordInput): LocalAgentRecord {
    const now = new Date().toISOString();
    const requireReview = input.requireReview ?? input.executionMode === "goal";
    const record: LocalAgentRecord = {
      id: `agt_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      workspaceId: input.workspaceId,
      workspaceRoot: resolve(input.workspaceRoot),
      profileName: input.profileName,
      provider: input.provider,
      model: input.model,
      effort: input.effort,
      executionOwner: input.executionOwner ?? "local",
      workspaceMode: input.workspaceMode ?? "checkout",
      writeMode: input.writeMode,
      executionMode: input.executionMode ?? "turn",
      goalTurns: input.goalTurns,
      requireReview,
      reviewStatus: requireReview ? "pending" : "not_required",
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 5,
      graderCommands: input.graderCommands ?? [],
      graderResults: [],
      status: "starting",
      createdAt: now,
      updatedAt: now,
    };

    this.database.sqlite
      .prepare(
        `insert into local_agent_sessions (
          id,
          workspace_id,
          workspace_root,
          profile_name,
          provider,
          model,
          effort,
          execution_owner,
          workspace_mode,
          write_mode,
          execution_mode,
          goal_turns,
          require_review,
          review_status,
          attempts,
          max_attempts,
          grader_commands,
          grader_results,
          status,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId ?? null,
        record.workspaceRoot,
        record.profileName,
        record.provider,
        record.model ?? null,
        record.effort ?? null,
        record.executionOwner ?? "local",
        record.workspaceMode ?? "checkout",
        record.writeMode ?? null,
        record.executionMode,
        record.goalTurns ?? null,
        String(record.requireReview),
        record.reviewStatus,
        record.attempts,
        record.maxAttempts,
        JSON.stringify(record.graderCommands),
        JSON.stringify(record.graderResults),
        record.status,
        record.createdAt,
        record.updatedAt,
      );

    return record;
  }

  createResult(input: CreateLocalAgentRecordInput): BetterResult<LocalAgentRecord, AgentStoreError> {
    return storeResult("create", () => this.create(input));
  }

  createWithCapacity(
    input: CreateLocalAgentRecordInput,
    maxActive: number,
  ): LocalAgentRecord | undefined {
    const create = this.database.sqlite.transaction(() => {
      if (this.activeCount({ workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot }) >= maxActive) {
        return undefined;
      }
      return this.create(input);
    });
    return create.immediate();
  }

  createWithCapacityResult(
    input: CreateLocalAgentRecordInput,
    maxActive: number,
  ): BetterResult<LocalAgentRecord | undefined, AgentStoreError> {
    return storeResult("create_with_capacity", () => this.createWithCapacity(input, maxActive));
  }

  getById(id: string): LocalAgentRecord | undefined {
    const exact = this.database.sqlite
      .prepare(
        `select * from local_agent_sessions
         where id = ?
         limit 1`,
      )
      .get(id) as LocalAgentRow | undefined;
    return exact ? rowToLocalAgentRecord(exact) : undefined;
  }

  getByIdResult(id: string): BetterResult<LocalAgentRecord | undefined, AgentStoreError> {
    return storeResult("get", () => this.getById(id));
  }

  /**
   * Compatibility alias for callers that already use the store directly.
   * Identity lookup is exact and never falls back to provider session IDs.
   */
  get(id: string): LocalAgentRecord | undefined {
    return this.getById(id);
  }

  update(id: string, patch: Partial<Omit<LocalAgentRecord, "id" | "createdAt">>): LocalAgentRecord {
    const current = this.getById(id);
    if (!current) throw new Error(`Unknown subagent id: ${id}`);

    const updated: LocalAgentRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    this.database.sqlite
      .prepare(
        `update local_agent_sessions set
          workspace_id = ?,
          workspace_root = ?,
          profile_name = ?,
          provider = ?,
          model = ?,
          effort = ?,
          provider_session_id = ?,
          execution_owner = ?,
          workspace_mode = ?,
          write_mode = ?,
          execution_mode = ?,
          goal_turns = ?,
          require_review = ?,
          review_status = ?,
          review_note = ?,
          attempts = ?,
          max_attempts = ?,
          grader_commands = ?,
          grader_results = ?,
          process_id = ?,
          status = ?,
          latest_response = ?,
          error = ?,
          error_code = ?,
          error_retryable = ?,
          updated_at = ?
         where id = ?`,
      )
      .run(
        updated.workspaceId ?? null,
        resolve(updated.workspaceRoot),
        updated.profileName,
        updated.provider,
        updated.model ?? null,
        updated.effort ?? null,
        updated.providerSessionId ?? null,
        updated.executionOwner ?? "local",
        updated.workspaceMode ?? "checkout",
        updated.writeMode ?? null,
        updated.executionMode,
        updated.goalTurns ?? null,
        String(updated.requireReview),
        updated.reviewStatus,
        updated.reviewNote ?? null,
        updated.attempts,
        updated.maxAttempts,
        JSON.stringify(updated.graderCommands),
        JSON.stringify(updated.graderResults),
        updated.processId ?? null,
        updated.status,
        updated.latestResponse ?? null,
        updated.error ?? null,
        updated.errorCode ?? null,
        updated.errorRetryable === undefined ? null : String(updated.errorRetryable),
        updated.updatedAt,
        updated.id,
      );

    return updated;
  }

  updateResult(
    id: string,
    patch: Partial<Omit<LocalAgentRecord, "id" | "createdAt">>,
  ): BetterResult<LocalAgentRecord, AgentStoreError> {
    return storeResult("update", () => this.update(id, patch));
  }

  activeRuns(executionOwner: string): LocalAgentRecord[] {
    const rows = this.database.sqlite
      .prepare(
        `select * from local_agent_sessions
         where execution_owner = ? and status in ('starting', 'running')
         order by updated_at desc`,
      )
      .all(executionOwner) as LocalAgentRow[];
    return rows.map(rowToLocalAgentRecord);
  }

  activeRunsResult(executionOwner: string): BetterResult<LocalAgentRecord[], AgentStoreError> {
    return storeResult("list_active_runs", () => this.activeRuns(executionOwner));
  }

  claimActiveRuns(fromOwner: string, toOwner: string): LocalAgentRecord[] {
    const claim = this.database.sqlite.transaction(() => {
      const rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where execution_owner = ? and status in ('starting', 'running')
           order by updated_at desc`,
        )
        .all(fromOwner) as LocalAgentRow[];
      if (rows.length === 0) return [];
      const now = new Date().toISOString();
      const update = this.database.sqlite.prepare(
        `update local_agent_sessions
         set execution_owner = ?, updated_at = ?
         where id = ? and execution_owner = ? and status in ('starting', 'running')`,
      );
      const claimed: LocalAgentRecord[] = [];
      for (const row of rows) {
        const result = update.run(toOwner, now, row.id, fromOwner);
        if (Number(result.changes) === 1) {
          claimed.push({ ...rowToLocalAgentRecord(row), executionOwner: toOwner, updatedAt: now });
        }
      }
      return claimed;
    });
    return claim.immediate();
  }

  claimActiveRunsResult(
    fromOwner: string,
    toOwner: string,
  ): BetterResult<LocalAgentRecord[], AgentStoreError> {
    return storeResult("claim_active_runs", () => this.claimActiveRuns(fromOwner, toOwner));
  }

  claimRun(id: string, expectedStatus: LocalAgentStatus, executionOwner: string): boolean {
    const now = new Date().toISOString();
    const result = this.database.sqlite
      .prepare(
        `update local_agent_sessions
         set status = 'running', execution_owner = ?, updated_at = ?
         where id = ? and status = ?`,
      )
      .run(executionOwner, now, id, expectedStatus);
    return Number(result.changes) === 1;
  }

  claimRunResult(
    id: string,
    expectedStatus: LocalAgentStatus,
    executionOwner: string,
  ): BetterResult<boolean, AgentStoreError> {
    return storeResult("claim_run", () => this.claimRun(id, expectedStatus, executionOwner));
  }

  claimRunWithCapacity(
    id: string,
    expectedStatus: LocalAgentStatus,
    executionOwner: string,
    maxActive: number,
  ): LocalAgentRunClaimResult {
    const claim = this.database.sqlite.transaction(() => {
      const current = this.getById(id);
      if (!current || current.status !== expectedStatus) return "state_changed" as const;
      if (this.activeCount({ workspaceId: current.workspaceId, workspaceRoot: current.workspaceRoot }) >= maxActive) {
        return "capacity" as const;
      }
      return this.claimRun(id, expectedStatus, executionOwner) ? "claimed" as const : "state_changed" as const;
    });
    return claim.immediate();
  }

  claimRunWithCapacityResult(
    id: string,
    expectedStatus: LocalAgentStatus,
    executionOwner: string,
    maxActive: number,
  ): BetterResult<LocalAgentRunClaimResult, AgentStoreError> {
    return storeResult(
      "claim_run_with_capacity",
      () => this.claimRunWithCapacity(id, expectedStatus, executionOwner, maxActive),
    );
  }

  updateIfStatus(
    id: string,
    expectedStatus: LocalAgentStatus,
    patch: Partial<Omit<LocalAgentRecord, "id" | "createdAt">>,
  ): LocalAgentRecord | undefined {
    const transition = this.database.sqlite.transaction(() => {
      const current = this.getById(id);
      if (!current || current.status !== expectedStatus) return undefined;
      return this.update(id, patch);
    });
    return transition.immediate();
  }

  updateIfStatusResult(
    id: string,
    expectedStatus: LocalAgentStatus,
    patch: Partial<Omit<LocalAgentRecord, "id" | "createdAt">>,
  ): BetterResult<LocalAgentRecord | undefined, AgentStoreError> {
    return storeResult("update_if_status", () => this.updateIfStatus(id, expectedStatus, patch));
  }

  reconcileActiveRuns(
    executionOwner: string,
    message = "DevSpace restarted while this agent execution was running.",
  ): number {
    const now = new Date().toISOString();
    const result = this.database.sqlite
      .prepare(
        `update local_agent_sessions
         set status = 'error', error = ?, error_code = 'AGENT_EXECUTION_INTERRUPTED', error_retryable = 'true',
             process_id = null, updated_at = ?
         where execution_owner = ? and status in ('starting', 'running')`,
      )
      .run(message, now, executionOwner);
    return Number(result.changes);
  }

  reconcileActiveRunsResult(
    executionOwner: string,
    message = "DevSpace restarted while this agent execution was running.",
  ): BetterResult<number, AgentStoreError> {
    return storeResult("reconcile_active_runs", () => this.reconcileActiveRuns(executionOwner, message));
  }

  close(): void {
    this.database.close();
  }

  private activeCount(scope: LocalAgentListScope): number {
    return this.list(scope).filter(
      (record) => record.status === "starting" || record.status === "running",
    ).length;
  }

}

export function createLocalAgentStore(stateDir: string): LocalAgentStore {
  return new LocalAgentStore(stateDir);
}

function rowToLocalAgentRecord(row: LocalAgentRow): LocalAgentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? undefined,
    workspaceRoot: row.workspace_root,
    profileName: row.profile_name,
    provider: row.provider,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    providerSessionId: row.provider_session_id ?? undefined,
    executionOwner: row.execution_owner ?? undefined,
    workspaceMode: readWorkspaceMode(row.workspace_mode),
    writeMode: readWriteMode(row.write_mode),
    executionMode: readExecutionMode(row.execution_mode),
    goalTurns: row.goal_turns ?? undefined,
    requireReview: readOptionalBoolean(row.require_review) ?? false,
    reviewStatus: readReviewStatus(row.review_status),
    reviewNote: row.review_note ?? undefined,
    attempts: row.attempts ?? 0,
    maxAttempts: row.max_attempts ?? 5,
    graderCommands: readJsonArray(row.grader_commands),
    graderResults: readGraderResults(row.grader_results),
    processId: row.process_id ?? undefined,
    status: readStatus(row.status),
    latestResponse: row.latest_response ?? undefined,
    error: row.error ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorRetryable: readOptionalBoolean(row.error_retryable),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readOptionalBoolean(value: string | null): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function readExecutionMode(value: string | null): LocalAgentExecutionMode {
  return value === "goal" ? "goal" : "turn";
}

function readWorkspaceMode(value: string | null): LocalAgentWorkspaceMode {
  return value === "worktree" ? "worktree" : "checkout";
}

function readWriteMode(value: string | null): LocalAgentWriteMode | undefined {
  if (value === "read_only" || value === "allowed" || value === "full_access") return value;
  return undefined;
}

function readReviewStatus(value: string | null): LocalAgentReviewStatus {
  if (value === "pending" || value === "approved" || value === "rejected") return value;
  return "not_required";
}

function readJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function readGraderResults(value: string | null): LocalAgentGraderResult[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): LocalAgentGraderResult[] => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      if (
        typeof record.command !== "string"
        || typeof record.timedOut !== "boolean"
        || typeof record.output !== "string"
      ) return [];
      return [{
        command: record.command,
        timedOut: record.timedOut,
        output: record.output,
        ...(typeof record.exitCode === "number" ? { exitCode: record.exitCode } : {}),
      }];
    });
  } catch {
    return [];
  }
}

function storeResult<T>(operation: string, run: () => T): BetterResult<T, AgentStoreError> {
  try {
    return Result.ok(run());
  } catch (cause) {
    if (isProgrammerDefect(cause)) throw cause;
    return Result.err(new AgentStoreError(operation, cause));
  }
}

function readStatus(status: string): LocalAgentStatus {
  if (
    status === "starting" ||
    status === "running" ||
    status === "awaiting_review" ||
    status === "idle" ||
    status === "error" ||
    status === "stopped"
  ) {
    return status;
  }
  return "error";
}
