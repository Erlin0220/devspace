import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Result, type Result as BetterResult } from "better-result";
import {
  AgentConflictError,
  AgentScopeError,
  AgentStoreError,
  AgentTargetError,
  isLocalAgentError,
  isProgrammerDefect,
  type LocalAgentError,
} from "./local-agent-errors.js";
import {
  type LocalAgentProfile,
  type LocalAgentProvider,
  isLocalAgentProvider,
  localAgentProfileWriteMode,
} from "./local-agent-profiles.js";
import {
  type LocalAgentTarget,
  resolveLocalAgentTarget,
} from "./local-agent-targets.js";
import {
  type LocalAgentRecord,
  type LocalAgentGraderResult,
  type LocalAgentStore,
  type LocalAgentWorkspaceMode,
  type LocalAgentWorkspaceScope,
} from "./local-agent-store.js";
import {
  type LocalAgentDriver,
  type LocalAgentExecutionMode,
  type LocalAgentRunCallbacks,
  type LocalAgentRunInput,
  type LocalAgentRuntimeContext,
  type LocalAgentWriteMode,
  localAgentProviderSupportsWriteMode,
} from "./local-agent-runtime.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";
import { HeadTailBuffer } from "./process-sessions.js";
import { assertAllowedPath } from "./roots.js";
import { detectWorkspaceMode } from "./workspace-mode.js";
import {
  isSubagentProviderEnabled,
  type SubagentsConfig,
} from "./local-agent-config.js";

export interface StartLocalAgentInput {
  target: string;
  prompt: string;
  workspaceRoot: string;
  workspaceId?: string;
  model?: string;
  effort?: string;
  writeMode?: LocalAgentWriteMode;
  executionMode?: LocalAgentExecutionMode;
  goalTurns?: number;
  requireReview?: boolean;
  maxAttempts?: number;
  graderCommands?: string[];
}

export interface RunOverrides {
  model?: string;
  effort?: string;
  writeMode?: LocalAgentWriteMode;
}

export type AgentReviewAction = "approve" | "retry" | "reject";
export const DEFAULT_MAX_ACTIVE_SUBAGENTS_PER_WORKSPACE = 3;

export interface LocalAgentManagerLogger {
  (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void;
}

export interface LocalAgentManagerOptions {
  store: LocalAgentStore;
  drivers: readonly LocalAgentDriver[];
  pool: LocalAgentRuntimePool;
  loadProfiles: (workspaceRoot: string) => Promise<LocalAgentProfile[]>;
  agentDir?: string;
  allowedRoots?: readonly string[];
  logger?: LocalAgentManagerLogger;
  subagents: SubagentsConfig | (() => SubagentsConfig);
  maxActiveTurnsPerWorkspace?: number;
  executionOwner?: string;
  requireWorktreeForWritable?: boolean;
}

export type AgentStartError = AgentTargetError | AgentScopeError | AgentConflictError | AgentStoreError;
export type AgentContinueError = AgentStartError;
export type AgentLookupError = AgentTargetError | AgentScopeError | AgentStoreError;
export type AgentListError = AgentScopeError | AgentStoreError;

/**
 * Owns one durable DevSpace agent's turn lifecycle. Provider runtimes remain
 * below this seam; this class only translates records into provider inputs and
 * persists the result.
 */
export class LocalAgentManager {
  private readonly store: LocalAgentStore;
  private readonly drivers = new Map<LocalAgentProvider, LocalAgentDriver>();
  private readonly pool: LocalAgentRuntimePool;
  private readonly loadProfiles: (workspaceRoot: string) => Promise<LocalAgentProfile[]>;
  private readonly agentDir?: string;
  private readonly allowedRoots?: readonly string[];
  private readonly logger?: LocalAgentManagerLogger;
  private readonly resolveSubagents: () => SubagentsConfig;
  private readonly maxActiveTurnsPerWorkspace?: number;
  private readonly executionOwner: string;
  private readonly requireWorktreeForWritable: boolean;
  private readonly activeTurns = new Map<string, Promise<void>>();
  private readonly stopGraders = new Set<() => void>();
  private accepting = true;
  private closePromise?: Promise<void>;

  constructor(options: LocalAgentManagerOptions) {
    this.store = options.store;
    for (const driver of options.drivers) this.drivers.set(driver.provider, driver);
    this.pool = options.pool;
    this.loadProfiles = options.loadProfiles;
    this.agentDir = options.agentDir;
    this.allowedRoots = options.allowedRoots;
    this.logger = options.logger;
    this.maxActiveTurnsPerWorkspace = options.maxActiveTurnsPerWorkspace;
    this.executionOwner = options.executionOwner ?? "local";
    this.requireWorktreeForWritable = options.requireWorktreeForWritable ?? false;
    const subagents = options.subagents;
    this.resolveSubagents = typeof subagents === "function" ? subagents : () => subagents;
  }

  reconcileActiveRuns(message?: string): BetterResult<number, AgentStoreError> {
    const active = this.store.activeRunsResult(this.executionOwner);
    if (active.isErr()) return active;
    const cleaned = this.cleanupInterruptedRecords(active.value);
    if (cleaned.isErr()) return cleaned;
    return this.store.reconcileActiveRunsResult(this.executionOwner, message);
  }

  reconcileLegacyActiveRuns(
    message = "DevSpace upgraded while this legacy agent execution was running.",
  ): BetterResult<number, AgentStoreError> {
    const recoveryOwner = `legacy:${this.executionOwner}`;
    const claimed = this.store.claimActiveRunsResult("legacy", recoveryOwner);
    if (claimed.isErr()) return claimed;
    const pending = this.store.activeRunsResult(recoveryOwner);
    if (pending.isErr()) return pending;
    const cleaned = this.cleanupInterruptedRecords(pending.value, "legacy");
    if (cleaned.isErr()) return cleaned;
    for (const record of pending.value) {
      const updated = this.store.updateResult(record.id, {
        status: "error",
        processId: undefined,
        error: message,
        errorCode: "AGENT_EXECUTION_INTERRUPTED",
        errorRetryable: true,
      });
      if (updated.isErr()) return updated;
    }
    return Result.ok(pending.value.length);
  }

  async start(input: StartLocalAgentInput): Promise<BetterResult<LocalAgentRecord, AgentStartError>> {
    const manager = this;
    return Result.gen(async function* () {
      yield* manager.acceptingResult("start");
      const workspaceRoot = yield* manager.authorizeWorkspace(
        input.workspaceRoot,
        input.workspaceId,
        "start",
      );
      const profiles = yield* Result.await(manager.loadProfilesResult(workspaceRoot, input.target));
      const subagents = manager.resolveSubagents();
      const target = resolveLocalAgentTarget(
        input.target,
        profiles,
        input.model,
        input.effort,
        subagents.providers,
      );
      if (!target) {
        return Result.err(new AgentTargetError({
          code: "UNKNOWN_TARGET",
          target: input.target,
          retryable: false,
          message: `Unknown subagent profile or provider: ${input.target}.`,
        }));
      }
      if (target.kind === "profile" && target.profile.disabled) {
        return Result.err(new AgentTargetError({
          code: "PROVIDER_DISABLED",
          target: target.name,
          provider: target.provider,
          retryable: false,
          message: `Subagent profile is disabled: ${target.name}.`,
        }));
      }
      yield* manager.providerEnabledResult(target.provider, target.name, "start", subagents);
      yield* manager.driverResult(target.provider, "start");
      const executionMode = input.executionMode ?? (target.provider === "qoder" ? "goal" : "turn");
      if (target.provider === "qoder" && executionMode !== "goal") {
        return Result.err(new AgentTargetError({
          code: "PROVIDER_NOT_CONFIGURED",
          target: target.name,
          provider: target.provider,
          operation: "start",
          retryable: false,
          message: "Qoder uses only its native visible Goal TUI; mode=turn is not available.",
        }));
      }
      if (executionMode === "goal" && target.provider !== "qoder") {
        return Result.err(new AgentTargetError({
          code: "PROVIDER_NOT_CONFIGURED",
          target: target.name,
          provider: target.provider,
          operation: "start",
          retryable: false,
          message: "Goal execution is currently provided by Qoder's native Goal mode.",
        }));
      }
      const writeMode = yield* manager.startWriteModeResult(target, input.writeMode);
      const workspaceMode = detectWorkspaceMode(workspaceRoot);
      yield* manager.writableWorkspaceResult(
        writeMode,
        workspaceMode,
        target.name,
        "start",
      );
      if (writeMode === "read_only" && (input.graderCommands?.length ?? 0) > 0) {
        return Result.err(new AgentTargetError({
          code: "PROVIDER_NOT_CONFIGURED",
          target: target.name,
          provider: target.provider,
          operation: "configure_graders",
          retryable: false,
          message: "Read-only subagents cannot execute shell grader commands.",
        }));
      }
      const createInput = {
        workspaceId: input.workspaceId,
        workspaceRoot,
        profileName: target.name,
        provider: target.provider,
        executionOwner: manager.executionOwner,
        workspaceMode,
        writeMode,
        model: target.model,
        effort: target.effort,
        executionMode,
        goalTurns: input.goalTurns,
        requireReview: input.requireReview,
        maxAttempts: input.maxAttempts,
        graderCommands: input.graderCommands,
      };
      const record = manager.maxActiveTurnsPerWorkspace === undefined
        ? yield* manager.store.createResult(createInput)
        : yield* manager.store.createWithCapacityResult(createInput, manager.maxActiveTurnsPerWorkspace);
      if (!record) return Result.err(manager.workspaceCapacityConflict("start"));
      return manager.begin(record, input.prompt, {
        model: target.model,
        effort: target.effort,
        writeMode,
      }, input.workspaceId);
    });
  }

  async continue(
    agentId: string,
    prompt: string,
    overrides: RunOverrides = {},
    scope: LocalAgentWorkspaceScope,
    allowReviewRetry = false,
  ): Promise<BetterResult<LocalAgentRecord, AgentContinueError>> {
    const manager = this;
    return Result.gen(async function* () {
      yield* manager.acceptingResult("continue", agentId);
      const record = yield* manager.store.getByIdResult(agentId);
      if (!record) return Result.err(agentNotFound(agentId));
      yield* manager.agentWorkspaceResult(record, scope, "continue");
      if (record.status === "starting" || record.status === "running") {
        return Result.err(new AgentConflictError({
          code: "AGENT_CONFLICT",
          agentId,
          operation: "continue",
          retryable: true,
          message: `Agent ${agentId} already has a running execution.`,
        }));
      }
      if (record.status === "awaiting_review" && !allowReviewRetry) {
        return Result.err(new AgentConflictError({
          code: "AGENT_CONFLICT",
          agentId,
          operation: "continue",
          retryable: false,
          message: `Agent ${agentId} is awaiting supervisor review; use review_agent.`,
        }));
      }
      const profiles = yield* Result.await(manager.loadProfilesResult(record.workspaceRoot, record.profileName));
      const profile = yield* manager.profileForRecordResult(record, profiles);
      const writeMode = yield* manager.recordWriteModeResult(record, profile, overrides.writeMode);
      const workspaceMode = detectWorkspaceMode(record.workspaceRoot);
      yield* manager.writableWorkspaceResult(
        writeMode,
        workspaceMode,
        record.profileName,
        "continue",
      );
      if (writeMode === "read_only" && (record.graderCommands?.length ?? 0) > 0) {
        return Result.err(new AgentTargetError({
          code: "PROVIDER_NOT_CONFIGURED",
          target: record.profileName,
          provider: isLocalAgentProvider(record.provider) ? record.provider : undefined,
          operation: "configure_graders",
          retryable: false,
          message: "Read-only subagents cannot execute shell grader commands.",
        }));
      }
      yield* manager.providerEnabledResult(
        record.provider,
        record.profileName,
        "continue",
        manager.resolveSubagents(),
      );
      yield* manager.driverResult(record.provider, "continue", agentId);
      return manager.begin(
        record,
        prompt,
        { ...overrides, writeMode },
        scope.workspaceId,
        workspaceMode,
      );
    });
  }

  get(
    agentId: string,
    scope: LocalAgentWorkspaceScope,
  ): BetterResult<LocalAgentRecord, AgentLookupError> {
    const lookup = this.store.getByIdResult(agentId);
    if (lookup.isErr()) return lookup;
    const record = lookup.value;
    if (!record) return Result.err(agentNotFound(agentId));
    const scoped = this.agentWorkspaceResult(record, scope, "get");
    if (scoped.isErr()) return scoped;
    return Result.ok(record);
  }

  list(scope: LocalAgentWorkspaceScope): BetterResult<LocalAgentRecord[], AgentListError> {
    return this.authorizeWorkspace(scope.workspaceRoot, scope.workspaceId, "list").andThen((workspaceRoot) => (
      this.store.listResult({
        workspaceId: scope.workspaceId,
        workspaceRoot,
      })
    ));
  }

  async review(
    agentId: string,
    action: AgentReviewAction,
    note: string | undefined,
    scope: LocalAgentWorkspaceScope,
  ): Promise<BetterResult<LocalAgentRecord, AgentContinueError>> {
    const lookup = this.get(agentId, scope);
    if (lookup.isErr()) return lookup;
    const record = lookup.value;
    if (record.status !== "awaiting_review") {
      return Result.err(new AgentConflictError({
        code: "AGENT_CONFLICT",
        agentId,
        operation: "review",
        retryable: false,
        message: `Agent ${agentId} is not awaiting supervisor review.`,
      }));
    }

    if (action === "approve") {
      if (!gradersPassed(record.graderCommands ?? [], record.graderResults ?? [])) {
        return Result.err(new AgentConflictError({
          code: "AGENT_CONFLICT",
          agentId,
          operation: "review_approve",
          retryable: false,
          message: `Agent ${agentId} cannot be approved until every deterministic grader has a matching successful result.`,
        }));
      }
      const approved = this.store.updateIfStatusResult(agentId, "awaiting_review", {
        status: "idle",
        reviewStatus: "approved",
        reviewNote: note,
      });
      if (approved.isErr()) return approved;
      if (approved.value) return Result.ok(approved.value);
      return Result.err(reviewStateChanged(agentId, "review_approve"));
    }
    if (action === "reject") {
      const rejected = this.store.updateIfStatusResult(agentId, "awaiting_review", {
        status: "error",
        reviewStatus: "rejected",
        reviewNote: note,
        error: note?.trim() || "Supervisor rejected the agent result.",
        errorCode: "AGENT_REVIEW_REJECTED",
        errorRetryable: false,
      });
      if (rejected.isErr()) return rejected;
      if (rejected.value) return Result.ok(rejected.value);
      return Result.err(reviewStateChanged(agentId, "review_reject"));
    }

    if ((record.attempts ?? 0) >= (record.maxAttempts ?? 5)) {
      return Result.err(new AgentConflictError({
        code: "AGENT_CONFLICT",
        agentId,
        operation: "review_retry",
        retryable: false,
        message: `Agent ${agentId} reached its retry limit.`,
      }));
    }
    const evidence = [
      note?.trim(),
      ...(record.graderResults ?? [])
        .filter((grader) => grader.timedOut || grader.exitCode !== 0)
        .map((grader) => `Grader failed: ${grader.command}\n${grader.output}`),
    ].filter((value): value is string => Boolean(value));
    const prompt = [
      "Continue the same task and fix the remaining acceptance failures.",
      "Do not weaken or remove acceptance criteria.",
      ...evidence,
    ].join("\n\n");
    return this.continue(agentId, prompt, {}, scope, true);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.accepting = false;
    for (const stop of this.stopGraders) stop();
    const turns = Array.from(this.activeTurns.values());
    this.closePromise = (async () => {
      // Closing pooled runtimes is what interrupts provider turns. Waiting for
      // those turns first can strand a provider process indefinitely.
      await this.pool.close();
      const turnResults = await Promise.allSettled(turns);
      for (const result of turnResults) {
        if (result.status === "rejected") {
          this.log("warn", "local_agent_close_failed", { error: errorMessage(result.reason) });
        }
      }
      this.store.close();
    })();
    return this.closePromise;
  }

  get activeTurnCount(): number {
    return this.activeTurns.size;
  }

  get runtimeCount(): number {
    return this.pool.size;
  }

  async evictIdle(now?: number): Promise<void> {
    await this.pool.evictIdle(now);
  }

  private begin(
    record: LocalAgentRecord,
    prompt: string,
    overrides: RunOverrides,
    workspaceId?: string,
    workspaceMode = record.workspaceMode,
  ): BetterResult<LocalAgentRecord, AgentConflictError | AgentStoreError> {
    if (this.activeTurns.has(record.id)) {
      return Result.err(new AgentConflictError({
        code: "AGENT_CONFLICT",
        agentId: record.id,
        operation: "continue",
        retryable: true,
        message: `Agent ${record.id} already has a running turn.`,
      }));
    }

    const claimed = record.status === "starting" || this.maxActiveTurnsPerWorkspace === undefined
      ? this.store.claimRunResult(record.id, record.status, this.executionOwner).map((value) => value ? "claimed" as const : "state_changed" as const)
      : this.store.claimRunWithCapacityResult(
          record.id,
          record.status,
          this.executionOwner,
          this.maxActiveTurnsPerWorkspace,
        );
    if (claimed.isErr()) return claimed;
    if (claimed.value === "capacity") return Result.err(this.workspaceCapacityConflict("continue"));
    if (claimed.value !== "claimed") {
      return Result.err(new AgentConflictError({
        code: "AGENT_CONFLICT",
        agentId: record.id,
        operation: record.status === "starting" ? "start" : "continue",
        retryable: true,
        message: `Agent ${record.id} changed state before this turn could start.`,
      }));
    }

    const updated = this.store.updateResult(record.id, {
      status: "running",
      executionOwner: this.executionOwner,
      workspaceMode,
      model: overrides.model ?? record.model,
      effort: overrides.effort ?? record.effort,
      writeMode: overrides.writeMode ?? record.writeMode,
      attempts: (record.attempts ?? 0) + 1,
      reviewStatus: record.requireReview ? "pending" : (record.reviewStatus ?? "not_required"),
      reviewNote: undefined,
      graderResults: [],
      processId: undefined,
      latestResponse: undefined,
      error: undefined,
      errorCode: undefined,
      errorRetryable: undefined,
    });
    if (updated.isErr()) return updated;
    // Defer invocation until after the tracking entry is visible. This keeps
    // cleanup correct even if runTurn later gains a synchronous completion path.
    const turn = Promise.resolve().then(() => (
      this.runTurn(updated.value, prompt, overrides, workspaceId)
    ));
    this.activeTurns.set(record.id, turn);
    void turn.catch(() => undefined);
    return updated;
  }

  private cleanupInterruptedRecords(
    records: readonly LocalAgentRecord[],
    previousOwner?: string,
  ): BetterResult<void, AgentStoreError> {
    try {
      for (const record of records) {
        if (!record.processId) continue;
        const provider = isLocalAgentProvider(record.provider) ? record.provider : undefined;
        const driver = provider ? this.drivers.get(provider) : undefined;
        if (!driver?.cleanupInterruptedProcess) {
          throw new Error(`Cannot safely clean up interrupted ${record.provider} process ${record.processId}.`);
        }
        driver.cleanupInterruptedProcess({
          agentId: record.id,
          processId: record.processId,
          workspaceRoot: record.workspaceRoot,
          executionOwner: previousOwner ?? record.executionOwner,
          providerSessionId: record.providerSessionId,
        });
      }
      return Result.ok(undefined);
    } catch (cause) {
      return Result.err(new AgentStoreError("reconcile_active_runs_cleanup", cause));
    }
  }

  private async runTurn(
    record: LocalAgentRecord,
    prompt: string,
    overrides: RunOverrides,
    workspaceId?: string,
  ): Promise<void> {
    const startedAt = Date.now();
    this.log("info", "agent_run_started", {
      provider: record.provider,
      agentId: record.id,
      providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
    });
    try {
      const authorized = this.authorizeWorkspace(record.workspaceRoot, workspaceId, "run");
      if (authorized.isErr()) {
        this.persistRunError(record, authorized.error, startedAt);
        return;
      }
      const workspaceRoot = authorized.value;
      const authorizedRecord = workspaceRoot === record.workspaceRoot
        ? record
        : { ...record, workspaceRoot };
      const profiles = await this.loadProfilesResult(workspaceRoot, record.profileName);
      if (profiles.isErr()) {
        this.persistRunError(record, profiles.error, startedAt);
        return;
      }
      const profile = this.profileForRecordResult(record, profiles.value);
      if (profile.isErr()) {
        this.persistRunError(record, profile.error, startedAt);
        return;
      }
      const input = this.buildRunInputResult(authorizedRecord, profile.value, prompt, overrides);
      if (input.isErr()) {
        this.persistRunError(record, input.error, startedAt);
        return;
      }
      const workspaceAuthority = this.writableWorkspaceResult(
        input.value.writeMode ?? "allowed",
        detectWorkspaceMode(workspaceRoot),
        record.profileName,
        "run",
      );
      if (workspaceAuthority.isErr()) {
        this.persistRunError(record, workspaceAuthority.error, startedAt);
        return;
      }
      const driver = this.driverResult(record.provider, "run", record.id);
      if (driver.isErr()) {
        this.persistRunError(record, driver.error, startedAt);
        return;
      }
      const context: LocalAgentRuntimeContext = {
        agentId: record.id,
        provider: driver.value.provider,
        workspaceRoot,
        providerSessionId: record.providerSessionId,
        writeMode: input.value.writeMode,
        model: input.value.model,
        effort: input.value.effort,
        agentDir: this.agentDir,
      };
      const callbacks: LocalAgentRunCallbacks = {
        onSessionId: (providerSessionId) => {
          const current = this.store.getByIdResult(record.id);
          if (current.isErr()) throw current.error;
          if (!current.value || current.value.providerSessionId === providerSessionId) return;
          const updated = this.store.updateResult(record.id, { providerSessionId });
          if (updated.isErr()) throw updated.error;
        },
        onProcessId: (processId) => {
          const updated = this.store.updateResult(record.id, { processId });
          if (updated.isErr()) throw updated.error;
        },
        onProgress: (message) => {
          const updated = this.store.updateResult(record.id, { latestResponse: message });
          if (updated.isErr()) throw updated.error;
        },
      };
      const result = await this.pool.run(driver.value, context, input.value, callbacks);
      if (result.isErr()) {
        this.persistRunError(record, result.error, startedAt);
        return;
      }
      const runResult = result.value;
      const current = this.store.getByIdResult(record.id);
      if (current.isErr()) throw current.error;
      if (!current.value) return;
      const graderResults = await this.runGraders(
        workspaceRoot,
        current.value.graderCommands ?? [],
        input.value.writeMode ?? "allowed",
      );
      const needsReview = Boolean(current.value.requireReview)
        || !gradersPassed(current.value.graderCommands ?? [], graderResults);
      const updated = this.store.updateResult(record.id, {
        providerSessionId: runResult.providerSessionId ?? current.value.providerSessionId,
        processId: undefined,
        status: needsReview ? "awaiting_review" : "idle",
        reviewStatus: needsReview ? "pending" : "not_required",
        graderResults,
        latestResponse: runResult.finalResponse,
        error: undefined,
        errorCode: undefined,
        errorRetryable: undefined,
      });
      if (updated.isErr()) throw updated.error;
      this.log("info", "agent_run_completed", {
        provider: updated.value.provider,
        agentId: updated.value.id,
        providerSessionIdPrefix: updated.value.providerSessionId?.slice(0, 8),
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    } catch (error) {
      if (isLocalAgentError(error)) {
        this.persistRunError(record, error, startedAt);
        return;
      }
      const persisted = this.store.updateResult(record.id, {
        status: "error",
        error: "Unexpected internal subagent failure.",
        errorCode: "AGENT_INTERNAL_ERROR",
        errorRetryable: false,
      });
      this.log("error", "agent_run_failed", {
        provider: record.provider,
        agentId: record.id,
        providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
        durationMs: Math.max(0, Date.now() - startedAt),
        error: "Unexpected internal subagent failure.",
        errorType: error instanceof Error ? error.name : typeof error,
        persistenceFailed: persisted.isErr(),
      });
      throw error;
    } finally {
      this.activeTurns.delete(record.id);
    }
  }

  private async runGraders(
    workspaceRoot: string,
    commands: readonly string[],
    writeMode: LocalAgentWriteMode,
  ): Promise<LocalAgentGraderResult[]> {
    if (writeMode === "read_only" && commands.length > 0) {
      return commands.map((command) => ({
        command,
        timedOut: false,
        output: "Skipped: read-only subagents cannot execute shell grader commands.",
      }));
    }
    const results: LocalAgentGraderResult[] = [];
    for (const command of commands) {
      if (!this.accepting) {
        results.push({ command, timedOut: false, output: "DevSpace stopped before this grader could run." });
        break;
      }
      const result = await this.runGrader(workspaceRoot, command);
      results.push(result);
      if (result.timedOut || result.exitCode !== 0) break;
    }
    return results;
  }

  private async runGrader(
    workspaceRoot: string,
    command: string,
  ): Promise<LocalAgentGraderResult> {
    const shell = resolveShellCommand(command);
    const detached = process.platform !== "win32";
    // Let Node quote Windows commands without dropping POSIX login-shell arguments.
    const child = spawn(detached ? shell.executable : command, detached ? shell.args : [], {
      cwd: workspaceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached,
      ...(detached ? {} : { shell: shell.executable }),
    });
    const output = new HeadTailBuffer(12_000);
    const append = (chunk: Buffer) => output.append(chunk.toString("utf8"));
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    return new Promise((resolveResult) => {
      let settled = false;
      const finish = (exitCode?: number, timedOut = false, error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.stopGraders.delete(stop);
        if (error) output.append(`\n${error}`);
        resolveResult({ command, exitCode, timedOut, output: output.drain(12_000).output.trim() });
      };
      const stop = () => {
        terminateProcessTree(child, "SIGTERM", detached);
        finish(undefined, false, "DevSpace stopped while this grader was running.");
      };
      this.stopGraders.add(stop);
      child.once("error", (error) => finish(undefined, false, error.message));
      child.once("close", (code) => finish(code ?? undefined));
      const timer = setTimeout(() => {
        terminateProcessTree(child, "SIGTERM", detached);
        finish(undefined, true);
      }, 60 * 60_000);
      timer.unref();
    });
  }

  private persistRunError(
    record: LocalAgentRecord,
    error: LocalAgentError,
    startedAt: number,
  ): void {
    const persisted = this.store.updateResult(record.id, {
      status: "error",
      processId: undefined,
      error: error.message,
      errorCode: error.code,
      errorRetryable: error.retryable,
    });
    this.log("error", "agent_run_failed", {
      provider: record.provider,
      agentId: record.id,
      providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode: error.code,
      error: error.message,
      causeType: safeCauseType("cause" in error ? error.cause : undefined),
      persistenceFailed: persisted.isErr(),
    });
  }

  private buildRunInputResult(
    record: LocalAgentRecord,
    profile: LocalAgentProfile | undefined,
    prompt: string,
    overrides: RunOverrides,
  ): BetterResult<LocalAgentRunInput, AgentTargetError> {
    const isRawProvider = record.profileName === record.provider;
    if (!profile && !isRawProvider) {
      return Result.err(new AgentTargetError({
        code: "UNKNOWN_TARGET",
        target: record.profileName,
        provider: isLocalAgentProvider(record.provider) ? record.provider : undefined,
        retryable: false,
        message: `Subagent profile not found: ${record.profileName}.`,
      }));
    }
    const body = profile?.body.trim();
    const fullPrompt = body ? `${body}\n\nTask:\n${prompt}` : prompt;
    const writeModeResult = this.recordWriteModeResult(record, profile, overrides.writeMode);
    if (writeModeResult.isErr()) return writeModeResult;
    const writeMode = writeModeResult.value;
    return Result.ok({
      prompt: fullPrompt,
      workspaceRoot: record.workspaceRoot,
      providerSessionId: record.providerSessionId,
      executionMode: record.executionMode ?? "turn",
      goalTurns: record.goalTurns,
      writeMode,
      model: record.model ?? profile?.model,
      effort: record.effort ?? profile?.effort,
      modelOverrideRequested: overrides.model !== undefined,
      effortOverrideRequested: overrides.effort !== undefined,
    });
  }

  private startWriteModeResult(
    target: LocalAgentTarget,
    requested: LocalAgentWriteMode | undefined,
  ): BetterResult<LocalAgentWriteMode, AgentTargetError> {
    const base = target.kind === "profile"
      ? localAgentProfileWriteMode(target.profile)
      : defaultProviderWriteMode(target.provider);
    return this.authorizedWriteModeResult(target.name, target.provider, base, requested);
  }

  private recordWriteModeResult(
    record: LocalAgentRecord,
    profile: LocalAgentProfile | undefined,
    requested: LocalAgentWriteMode | undefined,
  ): BetterResult<LocalAgentWriteMode, AgentTargetError> {
    const provider = isLocalAgentProvider(record.provider) ? record.provider : undefined;
    if (!provider) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_NOT_CONFIGURED",
        target: record.profileName,
        retryable: false,
        message: `No local agent provider is configured for ${record.provider}.`,
      }));
    }
    const profileMode = profile ? localAgentProfileWriteMode(profile) : undefined;
    const persisted = record.writeMode ?? profileMode ?? defaultProviderWriteMode(provider);
    const base = profileMode ? narrowerWriteMode(persisted, profileMode) : persisted;
    return this.authorizedWriteModeResult(record.profileName, provider, base, requested);
  }

  private authorizedWriteModeResult(
    target: string,
    provider: LocalAgentProvider,
    base: LocalAgentWriteMode,
    requested: LocalAgentWriteMode | undefined,
  ): BetterResult<LocalAgentWriteMode, AgentTargetError> {
    const writeMode = requested ?? base;
    if (writeModeRank(writeMode) > writeModeRank(base)) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_NOT_CONFIGURED",
        target,
        provider,
        operation: "configure_permissions",
        retryable: false,
        message: `Subagent target ${target} cannot broaden write mode from ${base} to ${writeMode}.`,
      }));
    }
    if (!localAgentProviderSupportsWriteMode(provider, writeMode)) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_NOT_CONFIGURED",
        target,
        provider,
        operation: "configure_permissions",
        retryable: false,
        message: `${provider} does not support subagent write mode ${writeMode}.`,
      }));
    }
    return Result.ok(writeMode);
  }

  private writableWorkspaceResult(
    writeMode: LocalAgentWriteMode,
    workspaceMode: LocalAgentWorkspaceMode | undefined,
    target: string,
    operation: string,
  ): BetterResult<void, AgentTargetError> {
    if (!this.requireWorktreeForWritable || writeMode === "read_only" || workspaceMode === "worktree") {
      return Result.ok(undefined);
    }
    return Result.err(new AgentTargetError({
      code: "PROVIDER_NOT_CONFIGURED",
      target,
      operation,
      retryable: false,
      message: `Writable subagent target ${target} requires an isolated worktree workspace.`,
    }));
  }

  private profileForRecordResult(
    record: LocalAgentRecord,
    profiles: readonly LocalAgentProfile[],
  ): BetterResult<LocalAgentProfile | undefined, AgentTargetError> {
    if (record.profileName === record.provider) return Result.ok(undefined);
    const profile = profiles.find((candidate) => candidate.name === record.profileName);
    if (!profile) {
      return Result.err(new AgentTargetError({
        code: "UNKNOWN_TARGET",
        target: record.profileName,
        provider: isLocalAgentProvider(record.provider) ? record.provider : undefined,
        retryable: false,
        message: `Subagent profile not found: ${record.profileName}.`,
      }));
    }
    if (profile.disabled) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_DISABLED",
        target: profile.name,
        provider: profile.provider,
        retryable: false,
        message: `Subagent profile is disabled: ${profile.name}.`,
      }));
    }
    return Result.ok(profile);
  }

  private driverResult(
    provider: string,
    operation: string,
    agentId?: string,
  ): BetterResult<LocalAgentDriver, AgentTargetError> {
    if (!isLocalAgentProvider(provider)) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_NOT_CONFIGURED",
        target: provider,
        operation,
        retryable: false,
        message: `No local agent driver is configured for provider: ${provider}.`,
      }));
    }
    const driver = this.drivers.get(provider);
    if (!driver) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_NOT_CONFIGURED",
        target: agentId ?? provider,
        provider,
        operation,
        retryable: false,
        message: `No local agent driver is configured for provider: ${provider}.`,
      }));
    }
    return Result.ok(driver);
  }

  private providerEnabledResult(
    provider: string,
    target: string,
    operation: string,
    subagents: SubagentsConfig,
  ): BetterResult<void, AgentTargetError> {
    if (!isLocalAgentProvider(provider)) return Result.ok(undefined);
    if (isSubagentProviderEnabled(subagents, provider)) return Result.ok(undefined);
    return Result.err(new AgentTargetError({
      code: "PROVIDER_DISABLED",
      target,
      provider,
      operation,
      retryable: false,
      message: `Subagent provider is disabled: ${provider}.`,
    }));
  }

  private acceptingResult(
    operation: string,
    agentId?: string,
  ): BetterResult<void, AgentConflictError> {
    if (this.accepting) return Result.ok(undefined);
    return Result.err(new AgentConflictError({
      code: "AGENT_CONFLICT",
      agentId,
      operation,
      retryable: false,
      message: "Local agent manager is closed.",
    }));
  }

  private authorizeWorkspace(
    workspaceRoot: string,
    workspaceId: string | undefined,
    operation: string,
  ): BetterResult<string, AgentScopeError> {
    const normalized = resolve(workspaceRoot);
    if (!workspaceId || !this.allowedRoots) return Result.ok(normalized);
    try {
      return Result.ok(assertAllowedPath(normalized, [...this.allowedRoots]));
    } catch (cause) {
      return Result.err(new AgentScopeError({
        code: "WORKSPACE_NOT_ALLOWED",
        operation,
        retryable: false,
        cause,
        message: "Workspace root is outside configured allowed roots.",
      }));
    }
  }

  private workspaceCapacityConflict(operation: "start" | "continue"): AgentConflictError {
    return new AgentConflictError({
      code: "AGENT_CONFLICT",
      operation,
      retryable: true,
      message: `Workspace subagent capacity is full; the limit is ${this.maxActiveTurnsPerWorkspace}. Reuse or inspect an existing agent before starting another turn.`,
    });
  }

  private agentWorkspaceResult(
    record: LocalAgentRecord,
    scope: LocalAgentWorkspaceScope,
    operation: string,
  ): BetterResult<void, AgentScopeError> {
    const workspaceRoot = this.authorizeWorkspace(scope.workspaceRoot, scope.workspaceId, operation);
    if (workspaceRoot.isErr()) return workspaceRoot;
    const idMismatch = scope.workspaceId !== undefined && record.workspaceId !== scope.workspaceId;
    if (workspaceRoot.value !== record.workspaceRoot || idMismatch) {
      return Result.err(new AgentScopeError({
        code: "WORKSPACE_MISMATCH",
        agentId: record.id,
        workspaceId: scope.workspaceId,
        operation,
        retryable: false,
        message: `Subagent ${record.id} belongs to a different workspace.`,
      }));
    }
    return Result.ok(undefined);
  }

  private async loadProfilesResult(
    workspaceRoot: string,
    target: string,
  ): Promise<BetterResult<LocalAgentProfile[], AgentTargetError>> {
    try {
      return Result.ok(await this.loadProfiles(workspaceRoot));
    } catch (cause) {
      if (isProgrammerDefect(cause)) throw cause;
      return Result.err(new AgentTargetError({
        code: "TARGET_RESOLUTION_FAILED",
        target,
        retryable: false,
        cause,
        message: "Unable to load subagent profiles.",
      }));
    }
  }

  private log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>,
  ): void {
    this.logger?.(level, event, fields);
  }
}

export function createLocalAgentManager(options: LocalAgentManagerOptions): LocalAgentManager {
  return new LocalAgentManager(options);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gradersPassed(commands: readonly string[], results: readonly LocalAgentGraderResult[]): boolean {
  return commands.length === results.length && commands.every((command, index) => {
    const result = results[index];
    return result?.command === command && result.exitCode === 0 && !result.timedOut;
  });
}

function defaultProviderWriteMode(provider: LocalAgentProvider): LocalAgentWriteMode {
  return provider === "agy" ? "full_access" : "allowed";
}

function reviewStateChanged(agentId: string, operation: string): AgentConflictError {
  return new AgentConflictError({
    code: "AGENT_CONFLICT",
    agentId,
    operation,
    retryable: true,
    message: `Agent ${agentId} review state changed before this decision could be committed.`,
  });
}

function writeModeRank(writeMode: LocalAgentWriteMode): number {
  switch (writeMode) {
    case "read_only": return 0;
    case "allowed": return 1;
    case "full_access": return 2;
  }
}

function narrowerWriteMode(
  left: LocalAgentWriteMode,
  right: LocalAgentWriteMode,
): LocalAgentWriteMode {
  return writeModeRank(left) <= writeModeRank(right) ? left : right;
}

function safeCauseType(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.name;
  if (cause && typeof cause === "object" && "error" in cause) {
    const nested = (cause as { error?: unknown }).error;
    if (nested instanceof Error) return nested.name;
  }
  return cause === undefined ? undefined : typeof cause;
}

function agentNotFound(agentId: string): AgentTargetError {
  return new AgentTargetError({
    code: "AGENT_NOT_FOUND",
    target: agentId,
    retryable: false,
    message: `Unknown subagent id: ${agentId}.`,
  });
}
