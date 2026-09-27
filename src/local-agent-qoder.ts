import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
        const args = [...qoderCliArgs(input, sessionId, this.agentId), qoderPrompt(input)];
        await callbacks?.onSessionId?.(sessionId);

        try {
          const completed = process.platform === "win32" && this.env.DEVSPACE_QODER_VISIBLE_TERMINAL !== "0"
            ? await runVisibleQoderTurn({
              command: this.command,
              args,
              cwd: resolve(input.workspaceRoot),
              env: this.env,
              agentId: this.agentId,
              timeoutMs: QODER_TURN_TIMEOUT_MS,
              onProcessId: async (processId) => {
                this.activeProcessId = processId;
                await callbacks?.onProcessId?.(processId);
              },
            })
            : await this.runHidden(args, input, callbacks);
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
              type: "qoder_cli",
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

interface VisibleQoderRunOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  agentId: string;
  timeoutMs: number;
  onProcessId(processId: number): Promise<void>;
}

async function runVisibleQoderTurn(
  options: VisibleQoderRunOptions,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; processId: number }> {
  const runDir = await mkdtemp(join(tmpdir(), "devspace-qoder-"));
  const stdoutPath = join(runDir, "stdout.log");
  const stderrPath = join(runDir, "stderr.log");
  const resultPath = join(runDir, "result.json");
  const configPath = join(runDir, "run.json");
  const runnerPath = join(runDir, "runner.cjs");
  const commandPath = join(runDir, "run.cmd");
  await writeFile(configPath, JSON.stringify({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    stdoutPath,
    stderrPath,
    resultPath,
  }, null, 2) + "\n", { mode: 0o600 });
  await writeFile(runnerPath, qoderTerminalRunnerSource(), { mode: 0o600 });
  await writeFile(commandPath, [
    "@echo off",
    `title DevSpace Qoder ${options.agentId}`,
    "\"%DEVSPACE_QODER_NODE%\" \"%DEVSPACE_QODER_RUNNER%\" \"%DEVSPACE_QODER_CONFIG%\"",
    "set \"_DEVSPACE_QODER_EXIT=%errorlevel%\"",
    "del \"%~f0\" >nul 2>&1",
    "exit /b %_DEVSPACE_QODER_EXIT%",
    "",
  ].join("\r\n"), { mode: 0o600 });

  try {
  const powershell = join(
    options.env.SystemRoot ?? process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = [
    "$ErrorActionPreference='Stop'",
    "$arg = '/d /c \"' + $env:DEVSPACE_QODER_CMD + '\"'",
    "$p = Start-Process -FilePath $env:DEVSPACE_QODER_COMSPEC -ArgumentList $arg -WorkingDirectory $env:DEVSPACE_QODER_CWD -WindowStyle Normal -PassThru",
    "[Console]::Out.Write($p.Id)",
  ].join("; ");
  const launched = await exec(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-STA",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ], {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 64 * 1024,
    env: {
      ...options.env,
      DEVSPACE_QODER_COMSPEC: options.env.ComSpec ?? process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
      DEVSPACE_QODER_CMD: commandPath,
      DEVSPACE_QODER_CWD: options.cwd,
      DEVSPACE_QODER_NODE: process.execPath,
      DEVSPACE_QODER_RUNNER: runnerPath,
      DEVSPACE_QODER_CONFIG: configPath,
    },
  });
  const processId = Number(launched.stdout.trim());
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new AgentProviderUnavailableError({
      code: "PROVIDER_UNAVAILABLE",
      provider: "qoder",
      agentId: options.agentId,
      operation: "spawn_terminal",
      retryable: true,
      message: "Windows did not return a valid Qoder terminal process id.",
    });
  }
  await options.onProcessId(processId);

  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const result = await readQoderTerminalResult(resultPath);
    if (result) {
      return {
        exitCode: result.exitCode,
        stdout: await readFile(stdoutPath, "utf8").catch(() => ""),
        stderr: [
          await readFile(stderrPath, "utf8").catch(() => ""),
          result.error ?? "",
        ].filter(Boolean).join("\n").trim(),
        processId,
      };
    }
    if (!isProcessAlive(processId)) {
      await sleep(300);
      const afterExit = await readQoderTerminalResult(resultPath);
      if (afterExit) continue;
      return {
        exitCode: null,
        stdout: await readFile(stdoutPath, "utf8").catch(() => ""),
        stderr: (await readFile(stderrPath, "utf8").catch(() => "")).trim()
          || "The visible Qoder terminal was closed before it produced a result.",
        processId,
      };
    }
    await sleep(250);
  }

  await terminateWindowsProcessTree(processId).catch(() => {});
  throw new AgentProviderExecutionError({
    code: "PROVIDER_EXECUTION_ERROR",
    provider: "qoder",
    agentId: options.agentId,
    operation: "run",
    retryable: true,
    message: "Qoder CLI turn exceeded the provider timeout.",
  });
  } finally {
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}

function qoderTerminalRunnerSource(): string {
  return [
    '"use strict";',
    'const { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    'const configPath = process.argv[2];',
    'if (!configPath) throw new Error("Missing Qoder terminal run configuration.");',
    'const config = JSON.parse(readFileSync(configPath, "utf8"));',
    'rmSync(configPath, { force: true });',
    'const stdoutFd = openSync(config.stdoutPath, "a", 0o600);',
    'const stderrFd = openSync(config.stderrPath, "a", 0o600);',
    'let finished = false;',
    'const child = spawn(config.command, config.args, {',
    '  cwd: config.cwd,',
    '  env: process.env,',
    '  stdio: ["inherit", "pipe", "pipe"],',
    '  windowsHide: false,',
    '  shell: process.platform === "win32" && /\\.(?:cmd|bat)$/i.test(config.command),',
    '});',
    'child.stdout?.on("data", chunk => { process.stdout.write(chunk); writeSync(stdoutFd, chunk); });',
    'child.stderr?.on("data", chunk => { process.stderr.write(chunk); writeSync(stderrFd, chunk); });',
    'const finish = (exitCode, error) => {',
    '  if (finished) return;',
    '  finished = true;',
    '  closeSync(stdoutFd);',
    '  closeSync(stderrFd);',
    '  const temporary = config.resultPath + ".tmp";',
    '  writeFileSync(temporary, JSON.stringify({ schema: 1, exitCode, error, finishedAt: new Date().toISOString() }) + "\\n", { mode: 0o600 });',
    '  renameSync(temporary, config.resultPath);',
    '  process.exitCode = exitCode ?? 1;',
    '};',
    'child.once("error", error => finish(null, error.message));',
    'child.once("close", code => finish(code));',
    '',
  ].join("\n");
}

async function readQoderTerminalResult(
  resultPath: string,
): Promise<{ exitCode: number | null; error?: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(resultPath, "utf8")) as Record<string, unknown>;
    return {
      exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
      ...(typeof value.error === "string" && value.error ? { error: value.error } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
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
