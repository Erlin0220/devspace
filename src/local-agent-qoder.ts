import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  AgentProviderExecutionError,
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
  captureAgentProviderResult,
} from "./local-agent-errors.js";
import type {
  LocalAgentDriver,
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
  LocalAgentWriteMode,
} from "./local-agent-runtime.js";

const exec = promisify(execFile);

const QODER_TURN_TIMEOUT_MS = 4 * 60 * 60_000;
const QODER_GOAL_STATUS_POLL_MS = 5_000;
const QODER_SESSION_READY_POLL_MS = 250;
const QODER_GOAL_START_GRACE_MS = 20_000;
const QODER_CONTEXT_WINDOW = "1000000";
const LEGACY_REMOTE_SESSION = /^qs_[A-Za-z0-9]+$/;

export function qoderInteractiveGoalArgs(
  input: Pick<
    LocalAgentRunInput,
    "providerSessionId" | "writeMode" | "model" | "effort" | "prompt" | "goalTurns"
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
  input: Pick<LocalAgentRunInput, "prompt" | "goalTurns">,
): string {
  const objective = input.prompt.trim().replace(/\s+/g, " ");
  return `/goal ${objective} --turns ${input.goalTurns ?? 200}`;
}

export class QoderCliRuntime implements LocalAgentRuntime {
  readonly provider = "qoder" as const;
  private closed = false;
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
        if (this.activeProcessId) {
          throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: this.provider,
            agentId: this.agentId,
            operation: "run",
            retryable: false,
            message: "Qoder CLI runtime already has an active Goal.",
          });
        }
        if (input.executionMode !== "goal") {
          throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: this.provider,
            agentId: this.agentId,
            operation: "run",
            retryable: false,
            message: "Qoder execution uses only the native visible Goal TUI; start it with mode=goal.",
          });
        }
        if (process.platform !== "win32") {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            agentId: this.agentId,
            operation: "run",
            retryable: false,
            message: "The native visible Qoder Goal TUI is currently supported only on Windows.",
          });
        }

        const sessionId = input.providerSessionId ?? randomUUID();

        try {
          const completed = await runInteractiveQoderGoal({
            command: this.command,
            args: qoderInteractiveGoalArgs(input, sessionId, this.agentId),
            cwd: resolve(input.workspaceRoot),
            env: this.env,
            agentId: this.agentId,
            sessionId,
            timeoutMs: QODER_TURN_TIMEOUT_MS,
            onSessionReady: async () => callbacks?.onSessionId?.(sessionId),
            onProcessId: async (processId) => {
              this.activeProcessId = processId;
              await callbacks?.onProcessId?.(processId);
            },
            onProgress: callbacks?.onProgress,
          });
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
              type: "qoder_cli_tui_goal",
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

interface InteractiveQoderGoalOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  agentId: string;
  sessionId: string;
  timeoutMs: number;
  onSessionReady(): Promise<void> | void;
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
    await waitForQoderSession(options, processId, startupDeadline);
    await options.onSessionReady();
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
  const launcher = [
    "$ErrorActionPreference='Stop'",
    "$childArgs = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"' + $env:DEVSPACE_QODER_SCRIPT + '\"'",
    "$p = Start-Process -FilePath $env:DEVSPACE_QODER_PWSH -ArgumentList $childArgs -WorkingDirectory $env:DEVSPACE_QODER_CWD -WindowStyle Normal -PassThru",
    "[Console]::Out.Write($p.Id)",
  ].join("; ");
  let launched: Awaited<ReturnType<typeof exec>>;
  try {
    launched = await exec(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(launcher, "utf16le").toString("base64"),
    ], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      env: {
        ...options.env,
        DEVSPACE_QODER_PWSH: powershell,
        DEVSPACE_QODER_CWD: options.cwd,
        DEVSPACE_QODER_SCRIPT: options.scriptPath,
        DEVSPACE_QODER_CONFIG: options.configPath,
      },
    });
  } catch (cause) {
    throw new AgentProviderUnavailableError({
      code: "PROVIDER_UNAVAILABLE",
      provider: "qoder",
      agentId: options.agentId,
      operation: "spawn_terminal",
      retryable: true,
      cause,
      message: "Unable to start the visible Qoder PowerShell 7 terminal.",
    });
  }
  const processId = Number(String(launched.stdout).trim());
  if (Number.isSafeInteger(processId) && processId > 0) return processId;
  throw new AgentProviderUnavailableError({
    code: "PROVIDER_UNAVAILABLE",
    provider: "qoder",
    agentId: options.agentId,
    operation: "spawn_terminal",
    retryable: true,
    message: "Windows did not return a valid Qoder terminal process id.",
  });
}

async function waitForQoderSession(
  options: Pick<InteractiveQoderGoalOptions, "command" | "cwd" | "env" | "sessionId" | "agentId">,
  processId: number,
  deadline: number,
): Promise<void> {
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    if (await qoderSessionExists(options, Math.min(10_000, remainingMs))) return;
    if (!isProcessAlive(processId)) {
      throw new AgentProviderExecutionError({
        code: "PROVIDER_EXECUTION_ERROR",
        provider: "qoder",
        agentId: options.agentId,
        operation: "create_session",
        retryable: true,
        message: "The interactive Qoder terminal closed before creating its session.",
      });
    }
    await sleep(QODER_SESSION_READY_POLL_MS);
  }
  throw new AgentProviderProtocolError({
    code: "PROVIDER_PROTOCOL_ERROR",
    provider: "qoder",
    agentId: options.agentId,
    operation: "create_session",
    retryable: true,
    message: "Qoder started, but its session did not become available before the startup deadline.",
  });
}

async function qoderSessionExists(
  options: Pick<InteractiveQoderGoalOptions, "command" | "cwd" | "env" | "sessionId">,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const result = await exec(options.command, ["--list-sessions"], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 512 * 1024,
    });
    return qoderSessionListContains(
      [result.stdout, result.stderr].filter(Boolean).join("\n"),
      options.sessionId,
    );
  } catch {
    return false;
  }
}

export function qoderSessionListContains(output: string, sessionId: string): boolean {
  return output.includes(`[${sessionId}]`);
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
