import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Result } from "better-result";
import type { ServerConfig } from "../../src/config.js";
import type { SubagentsConfig } from "../../src/local-agent-config.js";
import type { StartLocalAgentInput } from "../../src/local-agent-manager.js";
import type { LocalAgentRecord, LocalAgentWorkspaceScope } from "../../src/local-agent-store.js";
import { PersonalLongruns } from "../../src/personal/longrun.js";

function config(): ServerConfig {
  return {
    subagents: {
      enabled: true,
      providers: [
        { id: "codex", enabled: true },
        { id: "qoder", enabled: true },
        { id: "agy", enabled: true },
      ],
      routing: {
        default: ["qoder", "codex", "agy"],
        readOnly: ["qoder", "codex"],
        writable: ["qoder", "codex", "agy"],
      },
    },
  } as ServerConfig;
}

class FakeAgentClient {
  readonly starts: StartLocalAgentInput[] = [];
  readonly continuations: Array<{ agentId: string; prompt: string }> = [];
  readonly records = new Map<string, LocalAgentRecord>();
  private nextId = 1;

  async start(input: StartLocalAgentInput) {
    this.starts.push(input);
    const now = new Date().toISOString();
    const record: LocalAgentRecord = {
      id: `agt_test_${this.nextId++}`,
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      profileName: input.target,
      provider: input.target,
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    return Result.ok(record);
  }

  async continue(
    agentId: string,
    prompt: string,
    _overrides: unknown,
    _scope: LocalAgentWorkspaceScope,
  ) {
    this.continuations.push({ agentId, prompt });
    const current = this.records.get(agentId);
    assert(current);
    current.status = "running";
    current.updatedAt = new Date().toISOString();
    return Result.ok({ ...current });
  }

  async get(agentId: string, _scope: LocalAgentWorkspaceScope) {
    const current = this.records.get(agentId);
    assert(current);
    current.status = "idle";
    current.latestResponse = "worker finished";
    current.updatedAt = new Date().toISOString();
    return Result.ok({ ...current });
  }
}

class FakeProcesses {
  readonly commands: string[] = [];
  readonly exits: number[];

  constructor(
    exits: number[] = [],
    private readonly onStart?: (command: string) => void,
  ) {
    this.exits = [...exits];
  }

  async start(input: { command: string }) {
    this.commands.push(input.command);
    this.onStart?.(input.command);
    const exitCode = this.exits.length > 0 ? this.exits.shift()! : 0;
    return {
      output: exitCode === 0 ? "grader ok" : "grader failed",
      outputTruncated: false,
      running: false,
      exitCode,
      wallTimeMs: 1,
    };
  }

  async write() {
    throw new Error("write should not be called for immediate fake grader commands");
  }

  terminate() {}
}

async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for long-run state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function fixture(
  exits: number[] = [],
  options: {
    config?: ServerConfig;
    resolveSubagentsConfig?: () => SubagentsConfig;
    onGraderStart?: (command: string) => void;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "devspace-longrun-"));
  const agents = new FakeAgentClient();
  const baseConfig = options.config ?? config();
  const processes = new FakeProcesses(exits, options.onGraderStart);
  const longruns = new PersonalLongruns(
    baseConfig,
    processes as never,
    home,
    agents as never,
    options.resolveSubagentsConfig ?? (() => baseConfig.subagents),
  );
  return {
    home,
    agents,
    processes,
    longruns,
    cleanup: async () => {
      await longruns.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("long-run dispatcher continuously drains tasks across different allowed workers", async () => {
  const f = await fixture();
  try {
    const job = await f.longruns.createJob({
      workspaceId: "ws_test",
      workspaceRoot: "C:\\project\\fixture",
      title: "multi worker",
      defaultTargets: ["codex"],
      tasks: [
        {
          id: "qwen-task",
          prompt: "run first bounded check",
          targets: ["qoder"],
          graderCommands: ["check-first"],
        },
        {
          id: "gemini-task",
          prompt: "run second bounded check",
          targets: ["agy"],
          dependsOn: ["qwen-task"],
          writeMode: "allowed",
          graderCommands: ["check-second"],
        },
      ],
    });

    const completed = await eventually(
      () => f.longruns.getJob(job.id),
      (value) => value.status === "completed",
    );

    assert.deepEqual(f.agents.starts.map((input) => input.target), ["qoder", "agy"]);
    assert.deepEqual(f.processes.commands, ["check-first", "check-second"]);
    assert.deepEqual(completed.tasks.map((task) => task.status), ["passed", "passed"]);
  } finally {
    await f.cleanup();
  }
});

test("runtime routing config prefers qoder before other enabled providers", async () => {
  const f = await fixture();
  try {
    const job = await f.longruns.createJob({
      workspaceId: "ws_test",
      workspaceRoot: "C:\project\fixture",
      title: "runtime routing",
      tasks: [{
        id: "default-worker",
        prompt: "run a bounded read-only check",
        graderCommands: ["verify-default"],
      }],
    });
    const completed = await eventually(
      () => f.longruns.getJob(job.id),
      (value) => value.status === "completed",
    );
    assert.equal(f.agents.starts[0]?.target, "qoder");
    assert.equal(completed.tasks[0]?.target, "qoder");
  } finally {
    await f.cleanup();
  }
});

test("long-run resolves fresh runtime routing before each newly-dispatched task", async () => {
  const baseConfig = config();
  let current = baseConfig.subagents;
  const f = await fixture([], {
    config: baseConfig,
    resolveSubagentsConfig: () => current,
    onGraderStart: (command) => {
      if (command !== "check-first") return;
      current = {
        ...current,
        routing: {
          ...current.routing,
          writable: ["codex", "qoder", "agy"],
        },
      };
    },
  });
  try {
    const job = await f.longruns.createJob({
      workspaceId: "ws_test",
      workspaceRoot: "C:\project\fixture",
      title: "dynamic routing",
      tasks: [
        {
          id: "first",
          prompt: "first writable task",
          writeMode: "allowed",
          graderCommands: ["check-first"],
        },
        {
          id: "second",
          prompt: "second writable task",
          writeMode: "allowed",
          dependsOn: ["first"],
          graderCommands: ["check-second"],
        },
      ],
    });
    const completed = await eventually(
      () => f.longruns.getJob(job.id),
      (value) => value.status === "completed",
    );
    assert.deepEqual(f.agents.starts.map((input) => input.target), ["qoder", "codex"]);
    assert.equal(completed.defaultTargets, undefined);
  } finally {
    await f.cleanup();
  }
});

test("read-only tasks skip providers that do not support that write mode", async () => {
  const f = await fixture();
  try {
    const job = await f.longruns.createJob({
      workspaceId: "ws_test",
      workspaceRoot: "C:\project\fixture",
      title: "read only compatibility",
      defaultTargets: ["agy", "qoder", "codex"],
      tasks: [{
        id: "read-only",
        prompt: "inspect without writes",
        writeMode: "read_only",
        graderCommands: ["verify-read-only"],
      }],
    });
    const completed = await eventually(
      () => f.longruns.getJob(job.id),
      (value) => value.status === "completed",
    );
    assert.equal(f.agents.starts[0]?.target, "qoder");
    assert.equal(completed.tasks[0]?.target, "qoder");
  } finally {
    await f.cleanup();
  }
});

test("worker cannot self-certify a task without an independent grader", async () => {
  const f = await fixture();
  try {
    const job = await f.longruns.createJob({
      workspaceId: "ws_test",
      workspaceRoot: "C:\\project\\fixture",
      title: "no self certification",
      defaultTargets: ["codex"],
      tasks: [{ id: "subjective", prompt: "inspect something subjective" }],
    });

    const review = await eventually(
      () => f.longruns.getJob(job.id),
      (value) => value.status === "needs_review",
    );
    assert.equal(review.tasks[0]?.status, "needs_review");
    assert.match(review.tasks[0]?.error ?? "", /self-certification is not accepted/);
  } finally {
    await f.cleanup();
  }
});

test("failed deterministic grader continues the same worker session before passing", async () => {
  const f = await fixture([1, 0]);
  try {
    const job = await f.longruns.createJob({
      workspaceId: "ws_test",
      workspaceRoot: "C:\\project\\fixture",
      title: "grader retry",
      defaultTargets: ["codex", "qoder"],
      tasks: [
        {
          id: "repair",
          prompt: "make the bounded repair",
          graderCommands: ["verify-repair"],
          maxAttempts: 2,
          writeMode: "allowed",
        },
      ],
    });

    const completed = await eventually(
      () => f.longruns.getJob(job.id),
      (value) => value.status === "completed",
    );
    assert.equal(f.agents.starts.length, 1);
    assert.equal(f.agents.continuations.length, 1);
    assert.equal(f.agents.continuations[0]?.agentId, f.agents.starts[0] ? "agt_test_1" : "");
    assert.deepEqual(f.processes.commands, ["verify-repair", "verify-repair"]);
    assert.equal(completed.tasks[0]?.attempts, 2);
    assert.equal(completed.tasks[0]?.status, "passed");
  } finally {
    await f.cleanup();
  }
});
