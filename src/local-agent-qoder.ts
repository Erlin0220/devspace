import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
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
const exec = promisify(execFile);

const QODER_TURN_TIMEOUT_MS = 4 * 60 * 60_000;
const QODER_STDOUT_TAIL_CHARS = 4 * 1024 * 1024;
const QODER_STDERR_TAIL_CHARS = 64 * 1024;
const QODER_GOAL_STATUS_POLL_MS = 5_000;
const QODER_GOAL_START_GRACE_MS = 20_000;
const QODER_CONTEXT_WINDOW = "1000000";
const LEGACY_REMOTE_SESSION = /^qs_[A-Za-z0-9]+$/;

export function qoderCliArgs(
  input: Pick<
    LocalAgentRunInput,
    "providerSessionId" | "writeMode" | "model" | "effort"
  >,
  sessionId: string,
  agentId: string,
): string[] {
  return [
    "-p",
    "--output-format",
    "text",
    ...qoderSessionArgs(input.providerSessionId, sessionId, agentId),
    ...qoderAuthorityArgs({ ...input, agentId }),
  ];
}

export function qoderInteractiveGoalArgs(
  input: Pick<
    LocalAgentRunInput,
    "providerSessionId" | "writeMode" | "model" | "effort" | "prompt" | "executionMode" | "goalTurns"
  >,
  sessionId: string,
  agentId: string,
): string[] {
  return [
    ...qoderSessionArgs(input.providerSessionId, sessionId, agentId),
    ...qoderAuthorityArgs({ ...input, agentId }),
    "-i",
    qoderPrompt(input),
  ];
}

function qoderSessionArgs(
  providerSessionId: string | undefined,
  sessionId: string,
  agentId: string,
): string[] {
  if (providerSessionId && LEGACY_REMOTE_SESSION.test(providerSessionId)) {
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
  return providerSessionId
    ? ["--resume", providerSessionId]
    : ["--session-id", sessionId, "--name", ("DevSpace " + agentId).slice(0, 80)];
}

export function qoderPrompt(
  input: Pick<LocalAgentRunInput, "prompt" | "executionMode" | "goalTurns">,
): string {
  if (input.executionMode !== "goal") return input.prompt;
  const objective = input.prompt.trim().replace(/\s+/g, " ");
  return `/goal ${objective} --turns ${input.goalTurns ?? 200}`;
}

export class QoderCliRuntime implements LocalAgentRuntime {
  readonly provider = "qoder" as const;
  private closed = false;
  private activeChild?: ChildProcessWithoutNullStreams;
  private activeProcessId?: number;

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
        await callbacks?.onSessionId?.(sessionId);

        try {
          const interactiveGoal =
            input.executionMode === "goal" &&
            process.platform === "win32" &&
            this.env.DEVSPACE_QODER_VISIBLE_TERMINAL !== "0";
          const completed = interactiveGoal
            ? await runInteractiveQoderGoal({
              command: this.command,
              args: qoderInteractiveGoalArgs(input, sessionId, this.agentId),
              cwd: resolve(input.workspaceRoot),
              env: this.env,
              agentId: this.agentId,
              sessionId,
              timeoutMs: QODER_TURN_TIMEOUT_MS,
              onProcessId: async (processId) => {
                this.activeProcessId = processId;
                await callbacks?.onProcessId?.(processId);
              },
              onProgress: callbacks?.onProgress,
            })
            : await this.runHidden(
              [...qoderCliArgs(input, sessionId, this.agentId), qoderPrompt(input)],
              input,
              callbacks,
            );
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
            processId: completed.processId,
            items: [{
              type: interactiveGoal ? "qoder_cli_tui_goal" : "qoder_cli",
              sessionId,
              exitCode: completed.exitCode,
              processId: completed.processId,
            }],
          };
        } finally {
          this.activeProcessId = undefined;
        }
      },
    });
  }

  private async runHidden(
    args: string[],
    input: LocalAgentRunInput,
    callbacks?: LocalAgentRunCallbacks,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string; processId?: number }> {
    const child = spawn(this.command, args, {
      cwd: resolve(input.workspaceRoot),
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.activeChild = child;
    if (child.pid) await callbacks?.onProcessId?.(child.pid);
    child.stdin.end();
    try {
      return { ...(await collectQoderTurn(child, QODER_TURN_TIMEOUT_MS)), processId: child.pid };
    } finally {
      if (this.activeChild === child) this.activeChild = undefined;
    }
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
    if (this.activeProcessId) {
      await terminateWindowsProcessTree(this.activeProcessId).catch(() => {});
      this.activeProcessId = undefined;
    }
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
  readonly reuseRuntime = false;
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
        "Qoder CLI does not expose a hard read-only mode; DevSpace will not weaken read_only to an advisory prompt.",
    });
  }
  const args = [
    "--permission-mode",
    writeMode === "full_access" ? "bypass_permissions" : "auto",
    "--context-window",
    QODER_CONTEXT_WINDOW,
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

interface InteractiveQoderGoalOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  agentId: string;
  sessionId: string;
  timeoutMs: number;
  onProcessId(processId: number): Promise<void>;
  onProgress?: (message: string) => void | Promise<void>;
}

type QoderGoalStatus = "active" | "paused" | "complete" | "none" | "unknown";

export function parseQoderGoalStatus(output: string): QoderGoalStatus {
  const status = /\*\*Status:\*\*\s*(active|paused|complete)\b/i.exec(output)?.[1]?.toLowerCase();
  if (status === "active" || status === "paused" || status === "complete") return status;
  if (/no active goal|no goal (?:is )?active|there is no active goal/i.test(output)) return "none";
  return "unknown";
}

async function runInteractiveQoderGoal(
  options: InteractiveQoderGoalOptions,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; processId: number }> {
  const runDir = await mkdtemp(join(tmpdir(), "devspace-qoder-"));
  const configPath = join(runDir, "run.json");
  const scriptPath = join(runDir, "run.ps1");
  await writeFile(configPath, JSON.stringify({
    command: options.command,
    args: options.args,
  }, null, 2) + "\n", { mode: 0o600 });
  await writeFile(scriptPath, [
    "$ErrorActionPreference = 'Stop'",
    "$config = Get-Content -Raw -LiteralPath $env:DEVSPACE_QODER_CONFIG | ConvertFrom-Json",
    "$arguments = @($config.args | ForEach-Object { [string]$_ })",
    "& ([string]$config.command) @arguments",
    "exit $LASTEXITCODE",
    "",
  ].join("\r\n"), { mode: 0o600 });

  let processId: number | undefined;
  try {
    processId = await launchInteractiveQoderTerminal({
      ...options,
      configPath,
      scriptPath,
    });
    await options.onProcessId(processId);
    const deadline = Date.now() + options.timeoutMs;
    const startupDeadline = Date.now() + QODER_GOAL_START_GRACE_MS;
    let sawGoal = false;

    while (Date.now() < deadline) {
      const status = await readNativeQoderGoalStatus(options);
      if (status.status !== "unknown" && status.text) await options.onProgress?.(status.text);
      if (status.status === "active") {
        sawGoal = true;
      } else if (status.status === "paused" || status.status === "complete") {
        sawGoal = true;
        return { exitCode: 0, stdout: status.text, stderr: "", processId };
      } else if (status.status === "none" && sawGoal) {
        return {
          exitCode: 0,
          stdout: status.text || "Qoder Goal completed.",
          stderr: "",
          processId,
        };
      }

      if (!isProcessAlive(processId)) {
        throw new AgentProviderExecutionError({
          code: "PROVIDER_EXECUTION_ERROR",
          provider: "qoder",
          agentId: options.agentId,
          operation: "run",
          retryable: true,
          message: sawGoal
            ? "The interactive Qoder terminal closed before the Goal reached a reviewable state."
            : "The interactive Qoder terminal closed before the Goal started.",
        });
      }
      if (!sawGoal && Date.now() >= startupDeadline && status.status === "none") {
        throw new AgentProviderProtocolError({
          code: "PROVIDER_PROTOCOL_ERROR",
          provider: "qoder",
          agentId: options.agentId,
          operation: "start_goal",
          retryable: true,
          message: "Qoder interactive mode started, but the requested Goal did not become active.",
        });
      }
      await sleep(sawGoal ? QODER_GOAL_STATUS_POLL_MS : 500);
    }

    throw new AgentProviderExecutionError({
      code: "PROVIDER_EXECUTION_ERROR",
      provider: "qoder",
      agentId: options.agentId,
      operation: "run",
      retryable: true,
      message: "Qoder Goal exceeded the provider timeout.",
    });
  } finally {
    if (processId && isProcessAlive(processId)) {
      await terminateWindowsProcessTree(processId).catch(() => {});
    }
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function launchInteractiveQoderTerminal(
  options: InteractiveQoderGoalOptions & {
    configPath: string;
    scriptPath: string;
  },
): Promise<number> {
  const powershell = resolvePowerShell7Command(options.env);
  if (!powershell) {
    throw new AgentProviderUnavailableError({
      code: "PROVIDER_UNAVAILABLE",
      provider: "qoder",
      agentId: options.agentId,
      operation: "spawn_terminal",
      retryable: true,
      message: "PowerShell 7 (pwsh) is required for the visible Qoder terminal.",
    });
  }
  const child = spawn(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    options.scriptPath,
  ], {
    cwd: options.cwd,
    windowsHide: false,
    detached: true,
    stdio: "ignore",
    env: {
      ...options.env,
      DEVSPACE_QODER_CONFIG: options.configPath,
    },
  });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  }).catch((cause) => {
    throw new AgentProviderUnavailableError({
      code: "PROVIDER_UNAVAILABLE",
      provider: "qoder",
      agentId: options.agentId,
      operation: "spawn_terminal",
      retryable: true,
      cause,
      message: "Unable to start the visible Qoder PowerShell 7 terminal.",
    });
  });
  child.unref();
  const processId = child.pid;
  if (typeof processId === "number" && Number.isSafeInteger(processId) && processId > 0) return processId;
  throw new AgentProviderUnavailableError({
    code: "PROVIDER_UNAVAILABLE",
    provider: "qoder",
    agentId: options.agentId,
    operation: "spawn_terminal",
    retryable: true,
    message: "Windows did not return a valid Qoder terminal process id.",
  });
}

export function resolvePowerShell7Command(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env.PATH;
  if (path) {
    for (const directory of path.split(delimiter)) {
      if (!directory) continue;
      const candidate = resolve(directory, "pwsh.exe");
      if (executableExists(candidate)) return candidate;
    }
  }
  const candidates = [
    env.ProgramFiles && join(env.ProgramFiles, "PowerShell", "7", "pwsh.exe"),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "PowerShell", "7", "pwsh.exe"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find(executableExists);
}

async function readNativeQoderGoalStatus(
  options: Pick<InteractiveQoderGoalOptions, "command" | "cwd" | "env" | "sessionId">,
): Promise<{ status: QoderGoalStatus; text: string }> {
  try {
    const result = await exec(options.command, [
      "-p",
      "--resume",
      options.sessionId,
      "/goal status",
    ], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 256 * 1024,
    });
    const text = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    return { status: parseQoderGoalStatus(text), text };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    const text = [failure.stdout, failure.stderr].filter(Boolean).join("\n").trim();
    return { status: parseQoderGoalStatus(text), text };
  }
}

async function terminateWindowsProcessTree(processId: number): Promise<void> {
  const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  await exec(taskkill, ["/pid", String(processId), "/T", "/F"], {
    windowsHide: true,
    timeout: 10_000,
  });
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
