import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  AgentProviderExecutionError,
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
  captureAgentProviderResult,
} from "./local-agent-errors.js";
import { terminateProcessTree } from "./process-platform.js";
import type {
  LocalAgentDriver,
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
  LocalAgentWriteMode,
} from "./local-agent-runtime.js";

const require = createRequire(import.meta.url);
const spawn = require("cross-spawn") as typeof import("node:child_process").spawn;

const QODER_TURN_TIMEOUT_MS = 4 * 60 * 60_000;
const QODER_STDOUT_TAIL_CHARS = 4 * 1024 * 1024;
const QODER_STDERR_TAIL_CHARS = 64 * 1024;
const LEGACY_REMOTE_SESSION = /^qs_[A-Za-z0-9]+$/;

export function qoderCliArgs(
  input: Pick<
    LocalAgentRunInput,
    "providerSessionId" | "writeMode" | "model" | "effort"
  >,
  sessionId: string,
  agentId: string,
): string[] {
  if (input.providerSessionId && LEGACY_REMOTE_SESSION.test(input.providerSessionId)) {
    throw new AgentProviderProtocolError({
      code: "PROVIDER_PROTOCOL_ERROR",
      provider: "qoder",
      agentId,
      operation: "resume_session",
      retryable: false,
      message:
        "This Qoder agent uses a retired Remote Control session. Start a new Qoder agent to continue with the native CLI.",
    });
  }

  const sessionArgs = input.providerSessionId
    ? ["--resume", input.providerSessionId]
    : ["--session-id", sessionId, "--name", ("DevSpace " + agentId).slice(0, 80)];
  return [
    "-p",
    "--output-format",
    "text",
    ...sessionArgs,
    ...qoderAuthorityArgs({ ...input, agentId }),
  ];
}

export class QoderCliRuntime implements LocalAgentRuntime {
  readonly provider = "qoder" as const;
  private closed = false;
  private activeChild?: ChildProcessWithoutNullStreams;

  constructor(
    private readonly command: string,
    private readonly agentId: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks) {
    return captureAgentProviderResult({
      provider: this.provider,
      operation: "run",
      run: async (): Promise<LocalAgentRunResult> => {
        if (this.closed) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            agentId: this.agentId,
            operation: "run",
            retryable: true,
            message: "Qoder CLI runtime is closed.",
          });
        }
        if (this.activeChild) {
          throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: this.provider,
            agentId: this.agentId,
            operation: "run",
            retryable: false,
            message: "Qoder CLI runtime already has an active turn.",
          });
        }

        const sessionId = input.providerSessionId ?? randomUUID();
        const args = qoderCliArgs(input, sessionId, this.agentId);
        await callbacks?.onSessionId?.(sessionId);

        const child = spawn(this.command, [...args, input.prompt], {
          cwd: resolve(input.workspaceRoot),
          env: this.env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
        }) as ChildProcessWithoutNullStreams;
        this.activeChild = child;
        child.stdin.end();

        try {
          const completed = await collectQoderTurn(child, QODER_TURN_TIMEOUT_MS);
          if (completed.exitCode !== 0) {
            throw new AgentProviderExecutionError({
              code: "PROVIDER_EXECUTION_ERROR",
              provider: this.provider,
              agentId: this.agentId,
              operation: "run",
              retryable: true,
              cause: {
                exitCode: completed.exitCode,
                stderr: completed.stderr || undefined,
              },
              message:
                completed.stderr ||
                "Qoder CLI exited with code " + (completed.exitCode ?? "unknown") + ".",
            });
          }

          const finalResponse = completed.stdout.trim();
          if (!finalResponse) {
            throw new AgentProviderProtocolError({
              code: "PROVIDER_PROTOCOL_ERROR",
              provider: this.provider,
              agentId: this.agentId,
              operation: "read_result",
              retryable: false,
              message: "Qoder CLI completed without a final response.",
            });
          }

          return {
            provider: this.provider,
            providerSessionId: sessionId,
            finalResponse,
            items: [{
              type: "qoder_cli",
              sessionId,
              exitCode: completed.exitCode,
            }],
          };
        } finally {
          if (this.activeChild === child) this.activeChild = undefined;
        }
      },
    });
  }

  async releaseSession(_providerSessionId: string): Promise<void> {
    // Qoder owns durable session persistence on disk. Releasing the DevSpace
    // runtime does not delete or mutate the provider session.
  }

  isAlive(): boolean {
    return !this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.activeChild;
    this.activeChild = undefined;
    if (!child || child.exitCode !== null) return;
    const detached = process.platform !== "win32";
    terminateProcessTree(child, "SIGTERM", detached);
    if (!await waitForChildExit(child, 1_000)) {
      terminateProcessTree(child, "SIGKILL", detached);
    }
  }
}

export class QoderCliLocalAgentDriver implements LocalAgentDriver {
  readonly provider = "qoder" as const;
  private commandResolved = false;
  private resolvedCommand?: string;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly commandResolver: (env: NodeJS.ProcessEnv) => string | undefined = resolveQoderCommand,
  ) {}

  runtimeKey(context: LocalAgentRuntimeContext): string {
    const command = this.resolveCommand() ?? this.env.QODER_COMMAND ?? "qodercli";
    return [
      "qoder-native-cli",
      command,
      context.agentId,
      context.writeMode ?? "allowed",
      context.model ?? "",
      context.effort ?? "",
      resolve(context.workspaceRoot),
    ].join(":");
  }

  async createRuntime(context: LocalAgentRuntimeContext) {
    return captureAgentProviderResult({
      provider: this.provider,
      agentId: context.agentId,
      operation: "create_runtime",
      run: async (): Promise<LocalAgentRuntime> => {
        const command = this.resolveCommand();
        if (!command) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            agentId: context.agentId,
            operation: "create_runtime",
            retryable: false,
            message: "Qoder CLI executable was not found.",
          });
        }
        return new QoderCliRuntime(command, context.agentId, this.env);
      },
    });
  }

  private resolveCommand(): string | undefined {
    if (!this.commandResolved) {
      this.resolvedCommand = this.commandResolver(this.env);
      this.commandResolved = true;
    }
    return this.resolvedCommand;
  }
}

export function resolveQoderCommand(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.QODER_COMMAND?.trim();
  if (configured) return executableExists(configured) ? configured : undefined;

  if (process.platform === "win32") {
    const native = join(homedir(), ".qoder", "bin", "qodercli", "qodercli.exe");
    if (executableExists(native)) return native;
  }

  const path = env.PATH;
  if (!path) return undefined;
  const extensions = process.platform === "win32"
    ? [".exe", ".EXE", "", ".cmd", ".CMD", ".bat", ".BAT"]
    : [""];
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = resolve(directory, "qodercli" + extension);
      if (executableExists(candidate)) return candidate;
    }
  }
  return undefined;
}

function qoderAuthorityArgs(input: {
  writeMode?: LocalAgentWriteMode;
  model?: string;
  effort?: string;
  agentId?: string;
}): string[] {
  const writeMode = input.writeMode ?? "allowed";
  if (writeMode === "read_only") {
    throw new AgentProviderProtocolError({
      code: "PROVIDER_PROTOCOL_ERROR",
      provider: "qoder",
      agentId: input.agentId,
      operation: "configure_permissions",
      retryable: false,
      message:
        "Qoder CLI does not expose a hard read-only headless mode; DevSpace will not weaken read_only to an advisory prompt.",
    });
  }
  const args = [
    "--permission-mode",
    writeMode === "full_access" ? "bypass_permissions" : "auto",
  ];
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--reasoning-effort", input.effort);
  return args;
}

async function collectQoderTurn(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout = appendTail(stdout, chunk, QODER_STDOUT_TAIL_CHARS);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = appendTail(stderr, chunk, QODER_STDERR_TAIL_CHARS);
  });

  return new Promise((resolveTurn, rejectTurn) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      operation();
    };
    const onError = (cause: Error) => finish(() => {
      rejectTurn(new AgentProviderUnavailableError({
        code: "PROVIDER_UNAVAILABLE",
        provider: "qoder",
        operation: "spawn",
        retryable: true,
        cause,
        message: "Unable to start Qoder CLI.",
      }));
    });
    const onClose = (code: number | null) => finish(() => {
      resolveTurn({ exitCode: code, stdout, stderr: stderr.trim() });
    });
    timer = setTimeout(() => finish(() => {
      const detached = process.platform !== "win32";
      terminateProcessTree(child, "SIGTERM", detached);
      rejectTurn(new AgentProviderExecutionError({
        code: "PROVIDER_EXECUTION_ERROR",
        provider: "qoder",
        operation: "run",
        retryable: true,
        cause: { stderr: stderr.trim() || undefined },
        message: "Qoder CLI turn exceeded the provider timeout.",
      }));
    }), timeoutMs);
    timer.unref();
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function executableExists(path: string): boolean {
  const mode = process.platform === "win32" ? constants.F_OK : constants.X_OK;
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

function appendTail(current: string, chunk: string, maxCharacters: number): string {
  const next = current + chunk;
  return next.length <= maxCharacters ? next : next.slice(next.length - maxCharacters);
}

async function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    timer.unref();
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once("exit", onExit);
  });
}
