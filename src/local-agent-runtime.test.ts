import assert from "node:assert/strict";
import { Result, type Result as BetterResult } from "better-result";
import {
  AgentProviderExecutionError,
  AgentProviderUnavailableError,
  captureAgentProviderResult,
  type AgentProviderError,
} from "./local-agent-errors.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import {
  localAgentProviderSupportsWriteMode,
  localAgentProviderWriteModes,
} from "./local-agent-runtime.js";
import type {
  LocalAgentDriver,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";

assert.deepEqual(localAgentProviderWriteModes("agy"), ["allowed", "full_access"]);
assert.equal(localAgentProviderSupportsWriteMode("agy", "read_only"), false);
assert.deepEqual(localAgentProviderWriteModes("qoder"), ["allowed", "full_access"]);
assert.equal(localAgentProviderSupportsWriteMode("qoder", "read_only"), false);

const context: LocalAgentRuntimeContext = {
  agentId: "agt_test",
  provider: "codex",
  workspaceRoot: "/tmp/project",
};
const input: LocalAgentRunInput = { prompt: "inspect", workspaceRoot: "/tmp/project" };

for (const [code, retryable] of [["ENOENT", false], ["ECONNREFUSED", true], ["ENOTFOUND", true]] as const) {
  const classified = await captureAgentProviderResult({
    provider: "codex",
    operation: "connect",
    run: () => { throw Object.assign(new Error(code), { code }); },
  });
  assert.equal(classified.isErr(), true);
  if (classified.isErr()) {
    assert.equal(classified.error.code, "PROVIDER_UNAVAILABLE");
    assert.equal(classified.error.retryable, retryable);
  }
}

class FakeRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;
  alive = true;
  closeCount = 0;
  runCount = 0;
  readonly releasedSessions: string[] = [];
  private readonly pending: Array<() => void> = [];
  releaseBlocked = false;
  releaseStarted = false;
  releaseInFlight = false;
  private releaseResolve?: () => void;

  releaseWait(): void {
    for (const resolve of this.pending.splice(0)) resolve();
  }

  finishSessionRelease(): void {
    this.releaseResolve?.();
    this.releaseResolve = undefined;
  }

  async run(runInput: LocalAgentRunInput): Promise<BetterResult<LocalAgentRunResult, AgentProviderError>> {
    assert.equal(this.releaseInFlight, false, "a session turn must not overlap session release");
    this.runCount += 1;
    if (runInput.prompt === "wait") await new Promise<void>((resolve) => this.pending.push(resolve));
    return Result.ok({
      provider: this.provider,
      providerSessionId: "thread_1",
      finalResponse: `done:${runInput.prompt}`,
      items: [],
    });
  }

  async releaseSession(providerSessionId: string): Promise<void> {
    this.releaseInFlight = true;
    this.releaseStarted = true;
    this.releasedSessions.push(providerSessionId);
    if (this.releaseBlocked) {
      await new Promise<void>((resolve) => { this.releaseResolve = resolve; });
    }
    this.releaseInFlight = false;
  }

  isAlive(): boolean {
    return this.alive;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.alive = false;
    this.releaseWait();
  }
}

const runtime = new FakeRuntime();
let createCount = 0;
const driver: LocalAgentDriver = {
  provider: "codex",
  idleTimeoutMs: Number.POSITIVE_INFINITY,
  runtimeKey: () => "shared",
  createRuntime: async () => {
    createCount += 1;
    await Promise.resolve();
    return Result.ok(runtime);
  },
};

const pool = new LocalAgentRuntimePool();
const [first, second] = await Promise.all([
  pool.run(driver, context, input),
  pool.run(driver, { ...context, agentId: "agt_other" }, { ...input, prompt: "second" }),
]);
assert.equal(createCount, 1, "runtime creation is single-flight per runtime key");
assert.equal(unwrap(first).finalResponse, "done:inspect");
assert.equal(unwrap(second).finalResponse, "done:second");
assert.equal(runtime.runCount, 2);

{
  let closeCount = 0;
  let sessionId: string | undefined;
  let processId: number | undefined;
  const disposableRuntime: LocalAgentRuntime = {
    provider: "qoder",
    async run(_input, callbacks) {
      await callbacks?.onSessionId?.("qoder-session");
      await callbacks?.onProcessId?.(4242);
      return Result.ok({
        provider: "qoder",
        providerSessionId: "qoder-session",
        processId: 4242,
        finalResponse: "done",
        items: [],
      });
    },
    async releaseSession() {},
    async close() { closeCount += 1; },
    isAlive: () => true,
  };
  const disposableDriver: LocalAgentDriver = {
    provider: "qoder",
    reuseRuntime: false,
    runtimeKey: () => "qoder-disposable",
    createRuntime: async () => Result.ok(disposableRuntime),
  };
  const disposablePool = new LocalAgentRuntimePool();
  const result = await disposablePool.run(
    disposableDriver,
    { ...context, provider: "qoder" },
    input,
    {
      onSessionId: (value) => { sessionId = value; },
      onProcessId: (value) => { processId = value; },
    },
  );
  assert.equal(result.isOk(), true);
  assert.equal(sessionId, "qoder-session");
  assert.equal(processId, 4242);
  assert.equal(closeCount, 1, "disposable runtimes close immediately after one execution");
  assert.equal(disposablePool.size, 0, "disposable runtimes never enter the shared pool");
  await disposablePool.close();
}

{
  let closeCount = 0;
  let releaseRun!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseRun = resolve; });
  const disposableRuntime: LocalAgentRuntime = {
    provider: "qoder",
    async run() {
      await blocked;
      return Result.err(new AgentProviderExecutionError({
        code: "PROVIDER_EXECUTION_ERROR",
        provider: "qoder",
        operation: "run",
        retryable: true,
        message: "stopped by shutdown",
      }));
    },
    async releaseSession() {},
    async close() {
      closeCount += 1;
      releaseRun();
    },
    isAlive: () => true,
  };
  const disposableDriver: LocalAgentDriver = {
    provider: "qoder",
    reuseRuntime: false,
    runtimeKey: () => "qoder-disposable-shutdown",
    createRuntime: async () => Result.ok(disposableRuntime),
  };
  const disposablePool = new LocalAgentRuntimePool();
  const runningDisposable = disposablePool.run(
    disposableDriver,
    { ...context, provider: "qoder" },
    input,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disposablePool.size, 1);
  await disposablePool.close();
  const stopped = await runningDisposable;
  assert.equal(stopped.isErr(), true);
  assert.equal(closeCount, 1, "pool shutdown interrupts an active disposable runtime exactly once");
  assert.equal(disposablePool.size, 0);
}

const running = pool.run(driver, context, { ...input, prompt: "wait", providerSessionId: "thread_1" });
await new Promise<void>((resolve) => setImmediate(resolve));
await pool.evictIdle(Date.now() + 10_000_000);
assert.equal(runtime.closeCount, 0, "active runtimes are not evicted");
runtime.releaseWait();
await running;

await pool.close();
await pool.close();
assert.equal(runtime.closeCount, 1, "runtime close is idempotent");
assert.deepEqual(runtime.releasedSessions, [], "shutdown closes the runtime without racing session release");
assert.equal(pool.size, 0);

let clock = 0;
const sessionRuntime = new FakeRuntime();
const sessionPool = new LocalAgentRuntimePool({
  now: () => clock,
  sessionIdleTimeoutMs: 10,
});
const sessionDriver: LocalAgentDriver = {
  provider: "codex",
  idleTimeoutMs: Number.POSITIVE_INFINITY,
  runtimeKey: () => "session-runtime",
  createRuntime: async () => Result.ok(sessionRuntime),
};
await sessionPool.run(sessionDriver, context, input);
clock = 11;
sessionRuntime.releaseBlocked = true;
const releasing = sessionPool.evictIdle();
await waitFor(() => sessionRuntime.releaseStarted);
const reused = sessionPool.run(sessionDriver, context, { ...input, providerSessionId: "thread_1", prompt: "reuse" });
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(sessionRuntime.runCount, 1, "reuse waits for the in-flight session release");
sessionRuntime.finishSessionRelease();
await releasing;
await reused;
sessionRuntime.releaseBlocked = false;
assert.equal(sessionRuntime.releaseInFlight, false);
assert.deepEqual(sessionRuntime.releasedSessions, ["thread_1"]);
assert.equal(sessionPool.size, 1, "releasing an idle session does not close the runtime");
await sessionPool.close();

const shutdownReleaseRuntime = new FakeRuntime();
const shutdownReleasePool = new LocalAgentRuntimePool({
  now: () => clock,
  sessionIdleTimeoutMs: 10,
});
const shutdownReleaseDriver: LocalAgentDriver = {
  provider: "codex",
  idleTimeoutMs: Number.POSITIVE_INFINITY,
  runtimeKey: () => "shutdown-release-runtime",
  createRuntime: async () => Result.ok(shutdownReleaseRuntime),
};
await shutdownReleasePool.run(shutdownReleaseDriver, context, input);
shutdownReleaseRuntime.releaseBlocked = true;
const shutdownRelease = shutdownReleasePool.evictIdle(30);
await waitFor(() => shutdownReleaseRuntime.releaseStarted);
const shutdownReuse = shutdownReleasePool.run(
  shutdownReleaseDriver,
  context,
  { ...input, providerSessionId: "thread_1", prompt: "reuse during shutdown" },
);
await new Promise<void>((resolve) => setImmediate(resolve));
const shutdown = shutdownReleasePool.close();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(shutdownReleaseRuntime.closeCount, 0, "shutdown waits for an in-flight session release");
shutdownReleaseRuntime.finishSessionRelease();
await shutdownRelease;
const shutdownReuseResult = await shutdownReuse;
assert.equal(shutdownReuseResult.isErr(), true);
if (shutdownReuseResult.isErr()) {
  assert.equal(shutdownReuseResult.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(shutdownReuseResult.error.retryable, true);
}
await shutdown;
assert.equal(shutdownReleaseRuntime.closeCount, 1);

class CleanupFailureRuntime extends FakeRuntime {
  override async close(): Promise<void> {
    throw new Error("cleanup failed");
  }

  override async run(): Promise<BetterResult<LocalAgentRunResult, AgentProviderError>> {
    this.alive = false;
    return Result.err(new AgentProviderExecutionError({
      code: "PROVIDER_EXECUTION_ERROR",
      provider: this.provider,
      operation: "run",
      retryable: false,
      message: "provider failed",
    }));
  }
}

const cleanupPool = new LocalAgentRuntimePool();
const cleanupRuntime = new CleanupFailureRuntime();
const cleanupDriver: LocalAgentDriver = {
  provider: "codex",
  runtimeKey: () => "cleanup-runtime",
  createRuntime: async () => Result.ok(cleanupRuntime),
};
const cleanupFailure = await cleanupPool.run(cleanupDriver, context, input);
assert.equal(cleanupFailure.isErr(), true);
if (cleanupFailure.isErr()) assert.equal(cleanupFailure.error.message, "provider failed");

{
  const deadRuntime = new FakeRuntime();
  deadRuntime.alive = false;
  deadRuntime.close = async () => { throw new Error("dead runtime cleanup failed"); };
  const replacementRuntime = new FakeRuntime();
  let attempts = 0;
  const recoveryPool = new LocalAgentRuntimePool();
  const recoveryDriver: LocalAgentDriver = {
    provider: "codex",
    runtimeKey: () => "dead-runtime-recovery",
    createRuntime: async () => Result.ok(attempts++ === 0 ? deadRuntime : replacementRuntime),
  };

  const recovered = await recoveryPool.run(recoveryDriver, context, input);
  assert.equal(recovered.isOk(), true, "cleanup failure does not hide successful runtime recovery");
  assert.equal(attempts, 2);
  await recoveryPool.close();
}

{
  let closeDuringRun: Promise<void> | undefined;
  let completedTurnPool!: LocalAgentRuntimePool;
  class ClosingAfterTurnRuntime extends FakeRuntime {
    override async run(runInput: LocalAgentRunInput) {
      const result = await super.run(runInput);
      closeDuringRun = completedTurnPool.close();
      return result;
    }
  }
  const completedTurnRuntime = new ClosingAfterTurnRuntime();
  completedTurnPool = new LocalAgentRuntimePool();
  const completedTurnDriver: LocalAgentDriver = {
    provider: "codex",
    runtimeKey: () => "completed-turn-during-close",
    createRuntime: async () => Result.ok(completedTurnRuntime),
  };

  const completedTurn = await completedTurnPool.run(completedTurnDriver, context, input);
  assert.equal(completedTurn.isOk(), true, "shutdown does not discard an already completed provider turn");
  if (completedTurn.isOk()) assert.equal(completedTurn.value.finalResponse, "done:inspect");
  await closeDuringRun;
}

let resolveCreation!: (runtime: BetterResult<LocalAgentRuntime, AgentProviderError>) => void;
const creating = new Promise<BetterResult<LocalAgentRuntime, AgentProviderError>>((resolve) => { resolveCreation = resolve; });
const raceRuntime = new FakeRuntime();
const racePool = new LocalAgentRuntimePool();
const raceDriver: LocalAgentDriver = {
  provider: "codex",
  runtimeKey: () => "creation-race",
  createRuntime: () => creating,
};
const pendingRun = racePool.run(raceDriver, context, input);
await new Promise<void>((resolve) => setImmediate(resolve));
const pendingClose = racePool.close();
resolveCreation(Result.ok(raceRuntime));
await pendingClose;
const closedDuringCreation = await pendingRun;
assert.equal(closedDuringCreation.isErr(), true);
if (closedDuringCreation.isErr()) {
  assert.equal(closedDuringCreation.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(closedDuringCreation.error.retryable, true);
}
assert.equal(raceRuntime.closeCount, 1, "a runtime created during shutdown is closed");

const afterClose = await racePool.run(raceDriver, context, input);
assert.equal(afterClose.isErr(), true);
if (afterClose.isErr()) {
  assert.equal(afterClose.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(afterClose.error.retryable, true);
}

{
  const creationStarted = deferred<void>();
  const finishCreation = deferred<void>();
  let createAttempts = 0;
  const recoveryRuntime = new FakeRuntime();
  const creationPool = new LocalAgentRuntimePool();
  const creationDriver: LocalAgentDriver = {
    provider: "codex",
    runtimeKey: () => "creation-failure",
    async createRuntime() {
      createAttempts += 1;
      if (createAttempts === 1) {
        creationStarted.resolve();
        await finishCreation.promise;
        return Result.err(new AgentProviderUnavailableError({
          code: "PROVIDER_UNAVAILABLE",
          provider: "codex",
          operation: "create_runtime",
          retryable: true,
          message: "runtime creation failed",
        }));
      }
      return Result.ok(recoveryRuntime);
    },
  };

  const firstRun = creationPool.run(creationDriver, context, input);
  await creationStarted.promise;
  const secondRun = creationPool.run(creationDriver, context, input);
  const failedRuns = Promise.allSettled([firstRun, secondRun]);
  finishCreation.resolve();

  const results = await failedRuns;
  assert.equal(createAttempts, 1, "concurrent callers share one failing creation attempt");
  assert.equal(results.every((result) => result.status === "fulfilled" && result.value.isErr()), true);
  assert.equal(creationPool.size, 0, "a failed starting entry is removed from the pool");

  await creationPool.run(creationDriver, context, input);
  assert.equal(createAttempts, 2, "a later caller can retry after creation fails");
  await creationPool.close();
}

{
  class FlakyReleaseRuntime extends FakeRuntime {
    releaseAttempts = 0;

    override releaseSession(): Promise<void> {
      this.releaseAttempts += 1;
      if (this.releaseAttempts === 1) throw new Error("session release failed");
      return Promise.resolve();
    }
  }

  let releaseClock = 0;
  const releaseRuntime = new FlakyReleaseRuntime();
  const releasePool = new LocalAgentRuntimePool({
    now: () => releaseClock,
    sessionIdleTimeoutMs: 10,
  });
  const releaseDriver: LocalAgentDriver = {
    provider: "codex",
    idleTimeoutMs: Number.POSITIVE_INFINITY,
    runtimeKey: () => "release-failure",
    createRuntime: async () => Result.ok(releaseRuntime),
  };

  await releasePool.run(releaseDriver, context, input);
  releaseClock = 11;
  await releasePool.evictIdle();
  assert.equal(releaseRuntime.releaseAttempts, 1);

  await releasePool.run(releaseDriver, context, { ...input, providerSessionId: "thread_1" });
  releaseClock = 22;
  await releasePool.evictIdle();
  assert.equal(
    releaseRuntime.releaseAttempts,
    2,
    "a failed release returns the session to retained state so it can be reused and retried",
  );
  await releasePool.close();
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
