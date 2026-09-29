import assert from "node:assert/strict";
import { Panic, Result, type Result as BetterResult } from "better-result";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalAgentManager } from "./local-agent-manager.js";
import {
  AgentProviderExecutionError,
  type AgentProviderError,
} from "./local-agent-errors.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";
import type {
  LocalAgentDriver,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { LocalAgentStore } from "./local-agent-store.js";
import type { SubagentsConfig } from "./local-agent-config.js";

const root = await mkdtemp(join(tmpdir(), "devspace-agent-manager-test-"));
const directRoot = await mkdtemp(join(tmpdir(), "devspace-direct-agent-manager-test-"));
const stateDir = join(root, "state");
const scope = { workspaceId: "ws_test", workspaceRoot: root };
const profile: LocalAgentProfile = {
  name: "reviewer",
  description: "Test reviewer",
  provider: "codex",
  writeMode: "read_only",
  filePath: join(root, "reviewer.md"),
  body: "Review only.",
  disabled: false,
};
const disabledProfile: LocalAgentProfile = {
  ...profile,
  name: "disabled-reviewer",
  filePath: join(root, "disabled-reviewer.md"),
  disabled: true,
};
const agyProfile: LocalAgentProfile = {
  name: "agy-worker",
  description: "Sandboxed AGY worker",
  provider: "agy",
  filePath: join(root, "agy-worker.md"),
  body: "Work inside the workspace.",
  disabled: false,
};
const subagents: SubagentsConfig = {
  enabled: true,
  providers: [
    { id: "codex", enabled: true, model: "gpt-default", effort: "medium" },
    { id: "claude", enabled: true },
    { id: "agy", enabled: true, model: "gemini-3.7-flash-high", effort: "high" },
    { id: "qoder", enabled: true, model: "Qwen3.8-Flash", effort: "high" },
  ],
};
let currentSubagents = subagents;

class FakeRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;
  readonly inputs: LocalAgentRunInput[] = [];
  closed = false;
  private releaseHold: (() => void) | undefined;

  async run(
    input: LocalAgentRunInput,
    callbacks?: { onSessionId?: (id: string) => void | Promise<void> },
  ): Promise<BetterResult<LocalAgentRunResult, AgentProviderError>> {
    this.inputs.push(input);
    if (input.prompt.includes("early-fail")) {
      await callbacks?.onSessionId?.("thread_early");
      return Result.err(providerFailure("provider failed after session creation"));
    }
    if (input.prompt.includes("defect")) throw new TypeError("internal defect");
    if (input.prompt.includes("fail")) return Result.err(providerFailure("provider failed"));
    if (input.prompt.includes("hold")) {
      await new Promise<void>((resolve) => { this.releaseHold = resolve; });
    }
    return Result.ok({
      provider: this.provider,
      providerSessionId: "thread_test",
      finalResponse: `response:${input.prompt}`,
      items: [],
    });
  }

  release(): void {
    this.releaseHold?.();
    this.releaseHold = undefined;
  }

  releaseSession(): Promise<void> {
    return Promise.resolve();
  }

  isAlive(): boolean {
    return !this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.release();
  }
}

const runtimes = new Map<string, FakeRuntime>();
const driver: LocalAgentDriver = {
  provider: "codex",
  runtimeKey: (context: LocalAgentRuntimeContext) => context.agentId,
  createRuntime: async (context) => {
    const runtime = new FakeRuntime();
    runtimes.set(context.agentId, runtime);
    return Result.ok(runtime);
  },
};

class FakeAgyRuntime implements LocalAgentRuntime {
  readonly provider = "agy" as const;
  readonly inputs: LocalAgentRunInput[] = [];

  async run(input: LocalAgentRunInput): Promise<BetterResult<LocalAgentRunResult, AgentProviderError>> {
    this.inputs.push(input);
    return Result.ok({
      provider: this.provider,
      providerSessionId: "agy_thread_test",
      finalResponse: "agy response",
      items: [],
    });
  }

  releaseSession(): Promise<void> {
    return Promise.resolve();
  }

  isAlive(): boolean {
    return true;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const agyRuntimes = new Map<string, FakeAgyRuntime>();
const agyDriver: LocalAgentDriver = {
  provider: "agy",
  runtimeKey: (context: LocalAgentRuntimeContext) => context.agentId,
  createRuntime: async (context) => {
    const runtime = new FakeAgyRuntime();
    agyRuntimes.set(context.agentId, runtime);
    return Result.ok(runtime);
  },
};

class FakeQoderRuntime implements LocalAgentRuntime {
  readonly provider = "qoder" as const;
  readonly inputs: LocalAgentRunInput[] = [];

  async run(
    input: LocalAgentRunInput,
    callbacks?: {
      onSessionId?: (id: string) => void | Promise<void>;
      onProcessId?: (id: number) => void | Promise<void>;
    },
  ): Promise<BetterResult<LocalAgentRunResult, AgentProviderError>> {
    this.inputs.push(input);
    const sessionId = input.providerSessionId ?? "qoder_session_test";
    await callbacks?.onSessionId?.(sessionId);
    await callbacks?.onProcessId?.(4242);
    return Result.ok({
      provider: this.provider,
      providerSessionId: sessionId,
      finalResponse: "qoder goal complete",
      items: [],
      processId: 4242,
    });
  }

  releaseSession(): Promise<void> {
    return Promise.resolve();
  }

  isAlive(): boolean {
    return true;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const qoderRuntimes = new Map<string, FakeQoderRuntime>();
const qoderDriver: LocalAgentDriver = {
  provider: "qoder",
  reuseRuntime: false,
  runtimeKey: (context: LocalAgentRuntimeContext) => context.agentId,
  createRuntime: async (context) => {
    const runtime = new FakeQoderRuntime();
    qoderRuntimes.set(context.agentId, runtime);
    return Result.ok(runtime);
  },
};

function providerFailure(message: string): AgentProviderExecutionError {
  return new AgentProviderExecutionError({
    code: "PROVIDER_EXECUTION_ERROR",
    provider: "codex",
    operation: "run",
    retryable: false,
    message,
  });
}

const store = new LocalAgentStore(stateDir);
const stale = store.create({
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
  profileName: "reviewer",
  provider: "codex",
});
store.update(stale.id, { status: "running", latestResponse: "previous response" });

const manager = new LocalAgentManager({
  store,
  drivers: [driver, agyDriver, qoderDriver],
  pool: new LocalAgentRuntimePool(),
  loadProfiles: async () => [profile, disabledProfile, agyProfile],
  allowedRoots: [root],
  subagents: () => currentSubagents,
});

const defectStore = new LocalAgentStore(join(root, "defect-state"));
const defectManager = new LocalAgentManager({
  store: defectStore,
  drivers: [driver],
  pool: new LocalAgentRuntimePool(),
  loadProfiles: async () => {
    throw new TypeError("profile loader defect");
  },
  allowedRoots: [root],
  subagents,
});
await assert.rejects(
  defectManager.start({
    target: "reviewer",
    prompt: "inspect",
    workspaceId: scope.workspaceId,
    workspaceRoot: root,
  }),
  (error: unknown) => Panic.is(error) && error.cause instanceof TypeError,
);
await defectManager.close();

const capacityStore = new LocalAgentStore(join(root, "capacity-state"));
const capacityManager = new LocalAgentManager({
  store: capacityStore,
  drivers: [driver],
  pool: new LocalAgentRuntimePool(),
  loadProfiles: async () => [profile],
  allowedRoots: [root],
  subagents,
  maxActiveTurnsPerWorkspace: 1,
});
const capacityIdle = unwrap(await capacityManager.start({
  target: "reviewer",
  prompt: "capacity idle",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => capacityStore.getById(capacityIdle.id)?.status === "idle");
const capacityFirst = unwrap(await capacityManager.start({
  target: "reviewer",
  prompt: "hold capacity",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => runtimes.get(capacityFirst.id)?.inputs.length === 1);
const capacityBlocked = await capacityManager.start({
  target: "reviewer",
  prompt: "second active agent",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
});
assert.equal(capacityBlocked.isErr(), true);
if (capacityBlocked.isErr()) {
  assert.equal(capacityBlocked.error.code, "AGENT_CONFLICT");
  assert.match(capacityBlocked.error.message, /limit is 1/);
}
const capacityContinueBlocked = await capacityManager.continue(
  capacityIdle.id,
  "resume while capacity is full",
  {},
  scope,
);
assert.equal(capacityContinueBlocked.isErr(), true);
if (capacityContinueBlocked.isErr()) {
  assert.equal(capacityContinueBlocked.error.code, "AGENT_CONFLICT");
  assert.match(capacityContinueBlocked.error.message, /limit is 1/);
}
runtimes.get(capacityFirst.id)!.release();
await waitFor(() => capacityManager.activeTurnCount === 0);
await capacityManager.close();

const outside = await manager.start({
  target: "reviewer",
  prompt: "outside",
  workspaceId: scope.workspaceId,
  workspaceRoot: join(tmpdir(), "outside"),
});
assert.equal(outside.isErr(), true);
if (outside.isErr()) assert.equal(outside.error.code, "WORKSPACE_NOT_ALLOWED");

const unknown = await manager.start({
  target: "missing",
  prompt: "inspect",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
});
assert.equal(unknown.isErr(), true);
if (unknown.isErr()) assert.equal(unknown.error.code, "UNKNOWN_TARGET");

const disabled = await manager.start({
  target: "disabled-reviewer",
  prompt: "inspect",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
});
assert.equal(disabled.isErr(), true);
if (disabled.isErr()) assert.equal(disabled.error.code, "PROVIDER_DISABLED");

const unconfigured = await manager.start({
  target: "claude",
  prompt: "inspect",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
});
assert.equal(unconfigured.isErr(), true);
if (unconfigured.isErr()) assert.equal(unconfigured.error.code, "PROVIDER_NOT_CONFIGURED");

const disabledProvider = await manager.start({
  target: "pi",
  prompt: "inspect",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
});
assert.equal(disabledProvider.isErr(), true);
if (disabledProvider.isErr()) assert.equal(disabledProvider.error.code, "PROVIDER_DISABLED");

const previouslyCreatedDisabled = store.create({
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
  profileName: disabledProfile.name,
  provider: "codex",
});
store.update(previouslyCreatedDisabled.id, { status: "idle" });
const disabledContinuation = await manager.continue(previouslyCreatedDisabled.id, "inspect", {}, scope);
assert.equal(disabledContinuation.isErr(), true);
if (disabledContinuation.isErr()) assert.equal(disabledContinuation.error.code, "PROVIDER_DISABLED");

assert.equal(getRecord(stale.id).status, "running");

const mismatchedGet = manager.get(stale.id, { workspaceId: "ws_current", workspaceRoot: root });
assert.equal(mismatchedGet.isErr(), true);
if (mismatchedGet.isErr()) assert.equal(mismatchedGet.error.code, "WORKSPACE_MISMATCH");

unwrap(manager.reconcileActiveRuns());
assert.equal(getRecord(stale.id).status, "error");
assert.equal(getRecord(stale.id).latestResponse, "previous response");
assert.equal(getRecord(stale.id).error, "DevSpace restarted while this agent execution was running.");
assert.equal(getRecord(stale.id).errorCode, "AGENT_EXECUTION_INTERRUPTED");
assert.equal(getRecord(stale.id).errorRetryable, true);

const first = unwrap(await manager.start({
  target: "reviewer",
  prompt: "hold",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
assert.equal(first.status, "running");
assert.equal(first.model, "gpt-default");
assert.equal(first.effort, "medium");
await waitFor(() => runtimes.get(first.id)?.inputs.length === 1);
assert.equal(runtimes.get(first.id)?.inputs.at(-1)?.writeMode, "read_only");
const conflict = await manager.continue(first.id, "another prompt", {}, scope);
assert.equal(conflict.isErr(), true);
if (conflict.isErr()) {
  assert.equal(conflict.error.code, "AGENT_CONFLICT");
  assert.equal("agentId" in conflict.error ? conflict.error.agentId : undefined, first.id);
}

runtimes.get(first.id)!.release();
await waitFor(() => getRecord(first.id).status === "idle");
assert.equal(getRecord(first.id).providerSessionId, "thread_test");
assert.match(getRecord(first.id).latestResponse ?? "", /Task:\nhold/);

const agyDefault = unwrap(await manager.start({
  target: "agy",
  prompt: "default agy permissions",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => getRecord(agyDefault.id).status === "idle");
assert.equal(agyRuntimes.get(agyDefault.id)?.inputs.at(-1)?.writeMode, "full_access");

const agyProfileDefault = unwrap(await manager.start({
  target: "agy-worker",
  prompt: "profile defaults stay workspace-scoped",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => getRecord(agyProfileDefault.id).status === "idle");
assert.equal(agyRuntimes.get(agyProfileDefault.id)?.inputs.at(-1)?.writeMode, "allowed");

const agyExplicitAllowed = unwrap(await manager.start({
  target: "agy",
  prompt: "explicit agy permissions",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
  writeMode: "allowed",
}));
await waitFor(() => getRecord(agyExplicitAllowed.id).status === "idle");
assert.equal(agyRuntimes.get(agyExplicitAllowed.id)?.inputs.at(-1)?.writeMode, "allowed");

const qoderDefault = unwrap(await manager.start({
  target: "qoder",
  prompt: "default qoder execution mode",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
  requireReview: false,
}));
await waitFor(() => getRecord(qoderDefault.id).status === "idle");
assert.equal(getRecord(qoderDefault.id).executionMode, "goal");
assert.equal(qoderRuntimes.get(qoderDefault.id)?.inputs.at(-1)?.executionMode, "goal");

const rejectedQoderTurn = await manager.start({
  target: "qoder",
  prompt: "hidden qoder turn must not exist",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
  executionMode: "turn",
});
assert.equal(rejectedQoderTurn.isErr(), true);
if (rejectedQoderTurn.isErr()) {
  assert.equal(rejectedQoderTurn.error.code, "PROVIDER_NOT_CONFIGURED");
  assert.match(rejectedQoderTurn.error.message, /native visible Goal TUI/);
}

const goal = unwrap(await manager.start({
  target: "qoder",
  prompt: "finish the remaining work",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
  executionMode: "goal",
  goalTurns: 321,
  requireReview: true,
  maxAttempts: 3,
}));
await waitFor(() => getRecord(goal.id).status === "awaiting_review");
const goalRecord = getRecord(goal.id);
assert.equal(goalRecord.executionMode, "goal");
assert.equal(goalRecord.goalTurns, 321);
assert.equal(goalRecord.providerSessionId, "qoder_session_test");
assert.equal(goalRecord.attempts, 1);
assert.equal(goalRecord.maxAttempts, 3);
assert.equal(goalRecord.processId, undefined);
assert.equal(goalRecord.reviewStatus, "pending");
assert.equal(qoderRuntimes.get(goal.id)?.inputs.at(-1)?.executionMode, "goal");
const goalContinueWhileAwaitingReview = await manager.continue(
  goal.id,
  "bypass review",
  {},
  scope,
);
assert.equal(goalContinueWhileAwaitingReview.isErr(), true);
if (goalContinueWhileAwaitingReview.isErr()) {
  assert.equal(goalContinueWhileAwaitingReview.error.code, "AGENT_CONFLICT");
  assert.match(goalContinueWhileAwaitingReview.error.message, /review_agent/);
}

const goalRetry = unwrap(await manager.review(
  goal.id,
  "retry",
  "The supervisor needs one more verification pass.",
  scope,
));
assert.equal(goalRetry.status, "running");
await waitFor(() => getRecord(goal.id).status === "awaiting_review");
assert.equal(getRecord(goal.id).attempts, 2);
assert.equal(qoderRuntimes.get(goal.id)?.inputs.at(-1)?.providerSessionId, "qoder_session_test");
assert.match(qoderRuntimes.get(goal.id)?.inputs.at(-1)?.prompt ?? "", /one more verification pass/);

const goalApproved = unwrap(await manager.review(goal.id, "approve", "Evidence accepted.", scope));
assert.equal(goalApproved.status, "idle");
assert.equal(goalApproved.reviewStatus, "approved");

const graderFailure = unwrap(await manager.start({
  target: "qoder",
  prompt: "produce a result that still fails the deterministic grader",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
  executionMode: "goal",
  requireReview: false,
  graderCommands: [
    `"${process.execPath}" -e "process.exit(1)"`,
  ],
}));
assert.equal(graderFailure.requireReview, false);
assert.equal(graderFailure.reviewStatus, "not_required");
await waitFor(() => getRecord(graderFailure.id).status === "awaiting_review");
assert.equal(getRecord(graderFailure.id).graderResults?.at(0)?.exitCode, 1);
const invalidApproval = await manager.review(
  graderFailure.id,
  "approve",
  "ignore the failing grader",
  scope,
);
assert.equal(invalidApproval.isErr(), true);
if (invalidApproval.isErr()) {
  assert.equal(invalidApproval.error.code, "AGENT_CONFLICT");
  assert.match(invalidApproval.error.message, /every deterministic grader has a matching successful result/);
}

const expectedGraders = ["first acceptance command", "second acceptance command"];
const successfulGraders = expectedGraders.map((command) => ({ command, exitCode: 0, timedOut: false, output: "ok" }));
for (const incomplete of [
  [],
  successfulGraders.slice(0, 1),
  [...successfulGraders].reverse(),
  [...successfulGraders, successfulGraders[0]!],
  successfulGraders.map((result) => ({ ...result, timedOut: true })),
]) {
  store.update(graderFailure.id, { graderCommands: expectedGraders, graderResults: incomplete });
  const approval = await manager.review(graderFailure.id, "approve", "Incomplete evidence must not pass.", scope);
  assert.equal(approval.isErr(), true);
  assert.equal(getRecord(graderFailure.id).status, "awaiting_review");
}
store.update(graderFailure.id, { graderResults: successfulGraders });
assert.equal(unwrap(await manager.review(graderFailure.id, "approve", "All evidence matches.", scope)).status, "idle");

const graderSuccess = unwrap(await manager.start({
  target: "qoder",
  prompt: "produce verifiable acceptance results",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
  requireReview: false,
  graderCommands: [
    `"${process.execPath}" -e "console.log('GRADER_HEAD'); console.log('x'.repeat(15000)); console.log('GRADER_TAIL')"`,
    `"${process.execPath}" -e "console.log('SECOND_GRADER_OK')"`,
  ],
}));
await waitFor(() => getRecord(graderSuccess.id).status !== "running");
const passedGrading = getRecord(graderSuccess.id);
assert.equal(passedGrading.status, "idle", JSON.stringify(passedGrading.graderResults));
assert.deepEqual(passedGrading.graderResults?.map(result => result.exitCode), [0, 0]);
assert.match(passedGrading.graderResults?.[0]?.output ?? "", /GRADER_HEAD/);
assert.match(passedGrading.graderResults?.[0]?.output ?? "", /GRADER_TAIL/);
assert.ok((passedGrading.graderResults?.[0]?.output.length ?? 0) <= 12_000);
assert.equal(passedGrading.graderResults?.[1]?.output, "SECOND_GRADER_OK");

currentSubagents = { ...subagents, enabled: false };
const disabledAfterReload = await manager.start({
  target: "reviewer",
  prompt: "disabled after config reload",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
});
assert.equal(disabledAfterReload.isErr(), true);
if (disabledAfterReload.isErr()) assert.equal(disabledAfterReload.error.code, "PROVIDER_DISABLED");

currentSubagents = {
  enabled: true,
  providers: [
    { id: "codex", enabled: true, model: "gpt-reloaded", effort: "high" },
    { id: "claude", enabled: true },
  ],
};
const reloaded = unwrap(await manager.start({
  target: "reviewer",
  prompt: "after config reload",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
assert.equal(reloaded.model, "gpt-reloaded");
assert.equal(reloaded.effort, "high");
await waitFor(() => getRecord(reloaded.id).status === "idle");

const preserved = unwrap(await manager.continue(first.id, "preserve existing model", {}, scope));
assert.equal(preserved.model, "gpt-default");
assert.equal(preserved.effort, "medium");
await waitFor(() => getRecord(first.id).status === "idle");
assert.equal(runtimes.get(first.id)?.inputs.at(-1)?.model, "gpt-default");
assert.equal(runtimes.get(first.id)?.inputs.at(-1)?.effort, "medium");

const continued = unwrap(await manager.continue(first.id, "continue", {
  model: "gpt-run",
  effort: "high",
}, scope));
assert.equal(continued.status, "running");
await waitFor(() => getRecord(first.id).status === "idle");
assert.equal(getRecord(first.id).model, "gpt-run");
assert.equal(getRecord(first.id).effort, "high");

const second = unwrap(await manager.start({
  target: "reviewer",
  prompt: "second agent",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => getRecord(second.id).status === "idle");
assert.notEqual(first.id, second.id);
assert.ok(runtimes.has(first.id) && runtimes.has(reloaded.id) && runtimes.has(second.id),
  "different agents receive independent logical runtimes");

const failed = unwrap(await manager.start({
  target: "reviewer",
  prompt: "fail",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => getRecord(failed.id).status === "error");
assert.equal(getRecord(failed.id).error, "provider failed");
assert.equal(getRecord(failed.id).errorCode, "PROVIDER_EXECUTION_ERROR");
assert.equal(getRecord(failed.id).errorRetryable, false);
const recovered = unwrap(await manager.continue(failed.id, "recovered", {}, scope));
assert.equal(recovered.status, "running", "provider Err releases active-turn ownership");
await waitFor(() => getRecord(failed.id).status === "idle");

const earlyFailure = unwrap(await manager.start({
  target: "reviewer",
  prompt: "early-fail",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => getRecord(earlyFailure.id).status === "error");
assert.equal(getRecord(earlyFailure.id).providerSessionId, "thread_early");

const wrongWorkspace = await manager.continue(
  first.id,
  "wrong workspace",
  {},
  { workspaceId: scope.workspaceId, workspaceRoot: join(root, "other") },
);
assert.equal(wrongWorkspace.isErr(), true);
if (wrongWorkspace.isErr()) assert.equal(wrongWorkspace.error.code, "WORKSPACE_MISMATCH");

const wrongWorkspaceId = await manager.continue(
  first.id,
  "wrong workspace id",
  {},
  { workspaceId: "ws_other", workspaceRoot: root },
);
assert.equal(wrongWorkspaceId.isErr(), true);
if (wrongWorkspaceId.isErr()) assert.equal(wrongWorkspaceId.error.code, "WORKSPACE_MISMATCH");

const directOutside = unwrap(await manager.start({
  target: "reviewer",
  prompt: "direct outside allowed roots",
  workspaceRoot: directRoot,
}));
await waitFor(() => unwrap(manager.get(directOutside.id, { workspaceRoot: directRoot })).status === "idle");
assert.equal(directOutside.workspaceId, undefined);
assert.deepEqual(unwrap(manager.list({ workspaceRoot: directRoot })).map((record) => record.id), [
  directOutside.id,
]);

const direct = unwrap(await manager.start({
  target: "reviewer",
  prompt: "direct harness",
  workspaceRoot: root,
}));
await waitFor(() => unwrap(manager.get(direct.id, { workspaceRoot: root })).status === "idle");
assert.equal(direct.workspaceId, undefined);
assert.equal(unwrap(manager.get(first.id, { workspaceRoot: root })).id, first.id);
const directWrongId = manager.get(direct.id, { workspaceId: "ws_other", workspaceRoot: root });
assert.equal(directWrongId.isErr(), true);
if (directWrongId.isErr()) assert.equal(directWrongId.error.code, "WORKSPACE_MISMATCH");

const defect = unwrap(await manager.start({
  target: "reviewer",
  prompt: "defect",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => getRecord(defect.id).status === "error");
assert.equal(getRecord(defect.id).errorCode, "AGENT_INTERNAL_ERROR");
assert.notEqual(getRecord(defect.id).errorCode, "PROVIDER_EXECUTION_ERROR");

const gradingAtShutdown = unwrap(await manager.start({
  target: "reviewer",
  prompt: "run acceptance commands",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
  graderCommands: [
    `"${process.execPath}" -e "require('node:fs').writeFileSync('grader-started', String(process.pid)); setTimeout(() => {}, 10000)"`,
    `"${process.execPath}" -e "require('node:fs').writeFileSync('grader-must-not-run', 'unexpected')"`,
  ],
}));
await waitFor(() => existsSync(join(root, "grader-started")) || getRecord(gradingAtShutdown.id).status !== "running");
assert.ok(existsSync(join(root, "grader-started")), JSON.stringify(getRecord(gradingAtShutdown.id)));
const graderPid = Number(await readFile(join(root, "grader-started"), "utf8"));

const shuttingDown = unwrap(await manager.start({
  target: "reviewer",
  prompt: "hold during shutdown",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => runtimes.get(shuttingDown.id)?.inputs.length === 1);
const closing = manager.close();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(runtimes.get(shuttingDown.id)?.closed, true);
await waitFor(() => manager.activeTurnCount === 0);
await closing;
await waitFor(() => {
  try { process.kill(graderPid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
});
assert.equal(existsSync(join(root, "grader-must-not-run")), false);
const closedStore = new LocalAgentStore(stateDir);
const interruptedGrader = closedStore.getById(gradingAtShutdown.id);
assert.ok(interruptedGrader);
assert.equal(interruptedGrader?.status, "awaiting_review");
assert.equal(interruptedGrader.graderResults?.[0]?.exitCode, undefined);
assert.match(interruptedGrader.graderResults?.[0]?.output ?? "", /stopped/);
closedStore.close();

await manager.close();
await rm(root, { recursive: true, force: true });
await rm(directRoot, { recursive: true, force: true });

function getRecord(id: string) {
  return unwrap(manager.get(id, scope));
}

function unwrap<T, E>(result: BetterResult<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(check(), true, "condition did not become true before timeout");
}
