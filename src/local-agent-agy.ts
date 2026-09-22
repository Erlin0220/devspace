import {
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  AgentProviderCancelledError,
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
} from "./local-agent-runtime.js";

const AGY_PRINT_TIMEOUT = "15m";
const AGY_TURN_TIMEOUT_MS = 16 * 60_000;
const AGY_TERMINATION_GRACE_MS = 1_000;
const MAX_TURN_ITEMS = 10_000;
const MAX_STDERR_BYTES = 32 * 1024;
const require = createRequire(import.meta.url);
const crossSpawn = require("cross-spawn") as typeof import("node:child_process").spawn & {
  sync: typeof import("node:child_process").spawnSync;
};

export interface ResolvedAgyCommand {
  executable: string;
}

export type AgyCommandResolver = (env: NodeJS.ProcessEnv) => ResolvedAgyCommand | undefined;
type AgySpawn = typeof import("node:child_process").spawn;

export function agyCommandEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  const tunnelProxy = nonEmpty(env.AGY_HTTP_PROXY) ?? nonEmpty(env.OPENAI_TUNNEL_HTTP_PROXY);
  if (tunnelProxy) {
    next.HTTP_PROXY = nonEmpty(next.HTTP_PROXY) ?? tunnelProxy;
    next.HTTPS_PROXY = nonEmpty(next.HTTPS_PROXY) ?? tunnelProxy;
    next.ALL_PROXY = nonEmpty(next.ALL_PROXY) ?? tunnelProxy;
  }
  mirrorProxyCase(next, "HTTP_PROXY", "http_proxy");
  mirrorProxyCase(next, "HTTPS_PROXY", "https_proxy");
  mirrorProxyCase(next, "ALL_PROXY", "all_proxy");
  mirrorProxyCase(next, "NO_PROXY", "no_proxy");
  return next;
}

export function resolveAgyCommand(env: NodeJS.ProcessEnv = process.env): ResolvedAgyCommand | undefined {
  const executable = resolveExecutable(env.AGY_COMMAND ?? "agy", env);
  if (!executable) return undefined;
  const helpResult = crossSpawn.sync(executable, ["--help"], {
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: 5_000,
    shell: false,
  });
  if (helpResult.error || helpResult.status !== 0) return undefined;
  const help = `${helpResult.stdout ?? ""}\n${helpResult.stderr ?? ""}`;
  if (
    !help.includes("--input-format")
    || !help.includes("--output-format")
    || !help.includes("--conversation")
  ) {
    return undefined;
  }
  return { executable };
}

export function agyCommandArgs(input: LocalAgentRunInput): string[] {
  if (input.writeMode === "read_only") {
    throw new AgentProviderProtocolError({
      code: "PROVIDER_PROTOCOL_ERROR",
      provider: "agy",
      operation: "configure_permissions",
      retryable: false,
      message: "AGY does not expose a hard read-only headless mode; DevSpace will not map read_only to advisory plan mode.",
    });
  }
  const args = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--disable-slash-commands",
    "--print-timeout", AGY_PRINT_TIMEOUT,
  ];
  if (input.providerSessionId) args.push("--conversation", input.providerSessionId);
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);
  args.push("--mode", "accept-edits");
  if (input.writeMode === "full_access") args.push("--dangerously-skip-permissions");
  else args.push("--sandbox");
  return args;
}

export function parseAgyStreamLine(line: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(line) as unknown;
    const record = asRecord(parsed);
    if (!record) throw new TypeError("AGY stream event must be a JSON object.");
    return record;
  } catch (cause) {
    throw new AgentProviderProtocolError({
      code: "PROVIDER_PROTOCOL_ERROR",
      provider: "agy",
      operation: "parse_stream",
      retryable: false,
      cause,
      message: "AGY emitted malformed stream-json output.",
    });
  }
}

export function extractAgyConversationId(event: Record<string, unknown>): string | undefined {
  return directString(event.conversation_id)
    ?? directString(asRecord(event.init)?.conversation_id)
    ?? directString(asRecord(event.result)?.conversation_id);
}

export class AgyRuntime implements LocalAgentRuntime {
  readonly provider = "agy" as const;
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private closed = false;

  constructor(
    private readonly command: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly spawn: AgySpawn = crossSpawn,
    private readonly turnTimeoutMs = AGY_TURN_TIMEOUT_MS,
  ) {}

  async run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks) {
    return captureAgentProviderResult({
      provider: this.provider,
      operation: "run",
      run: async (): Promise<LocalAgentRunResult> => {
        if (!this.isAlive()) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            operation: "run",
            retryable: true,
            message: "AGY runtime is closed.",
          });
        }

        const child = this.spawn(this.command, agyCommandArgs(input), {
          cwd: resolve(input.workspaceRoot),
          env: agyCommandEnvironment(this.env),
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
          shell: false,
        });
        this.children.add(child);

        let spawnError: unknown;
        let stderr = "";
        let timedOut = false;
        child.once("error", (error) => { spawnError = error; });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = appendTail(stderr, chunk.toString("utf8"), MAX_STDERR_BYTES);
        });
        const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
          child.once("close", (code, signal) => resolveClose({ code, signal }));
        });
        let forceKillTimer: NodeJS.Timeout | undefined;
        const timer = setTimeout(() => {
          timedOut = true;
          if (child.exitCode === null) {
            terminateProcessTree(child, "SIGTERM", process.platform !== "win32");
            forceKillTimer = setTimeout(() => {
              if (child.exitCode === null) {
                terminateProcessTree(child, "SIGKILL", process.platform !== "win32");
              }
            }, 1_000);
            forceKillTimer.unref();
          }
        }, this.turnTimeoutMs);
        timer.unref();

        let providerSessionId = input.providerSessionId;
        let persistedSessionId: string | undefined;
        let terminalResult: Record<string, unknown> | undefined;
        const items: unknown[] = [];
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        try {
          child.stdin.end(`${JSON.stringify({
            event: "user",
            message: { content: input.prompt },
          })}\n`);

          for await (const line of lines) {
            if (!line.trim()) continue;
            const event = parseAgyStreamLine(line);
            items.push(event);
            if (items.length > MAX_TURN_ITEMS) items.shift();

            const nextSessionId = extractAgyConversationId(event);
            if (nextSessionId) {
              providerSessionId = nextSessionId;
              if (persistedSessionId !== nextSessionId) {
                await callbacks?.onSessionId?.(nextSessionId);
                persistedSessionId = nextSessionId;
              }
            }
            if (event.event === "result") terminalResult = asRecord(event.result);
          }

          const { code, signal } = await closePromise;
          if (timedOut) {
            throw new AgentProviderExecutionError({
              code: "PROVIDER_EXECUTION_ERROR",
              provider: this.provider,
              operation: "run",
              retryable: true,
              cause: stderr.trim() || undefined,
              message: "AGY agent turn timed out.",
            });
          }
          if (spawnError) {
            throw new AgentProviderUnavailableError({
              code: "PROVIDER_UNAVAILABLE",
              provider: this.provider,
              operation: "run",
              retryable: true,
              cause: spawnError,
              message: "AGY executable could not be started.",
            });
          }
          if (!terminalResult) {
            throw new AgentProviderProtocolError({
              code: "PROVIDER_PROTOCOL_ERROR",
              provider: this.provider,
              operation: "run",
              retryable: false,
              cause: { code, signal, stderr: stderr.trim() || undefined },
              message: "AGY stream ended without a terminal result event.",
            });
          }

          const status = directString(terminalResult.status)?.toUpperCase();
          if (status === "CANCELED" || status === "INTERRUPTED") {
            throw new AgentProviderCancelledError({
              code: "PROVIDER_CANCELLED",
              provider: this.provider,
              operation: "run",
              retryable: false,
              cause: terminalResult,
              message: `AGY agent turn ended with status ${status}.`,
            });
          }
          if (status !== "SUCCESS") {
            const providerMessage = directString(terminalResult.error);
            throw new AgentProviderExecutionError({
              code: "PROVIDER_EXECUTION_ERROR",
              provider: this.provider,
              operation: "run",
              retryable: false,
              cause: terminalResult,
              message: providerMessage
                ? `AGY agent execution failed: ${providerMessage}`
                : `AGY agent turn ended with status ${status ?? "UNKNOWN"}.`,
            });
          }
          if (code !== 0 || signal) {
            throw new AgentProviderExecutionError({
              code: "PROVIDER_EXECUTION_ERROR",
              provider: this.provider,
              operation: "run",
              retryable: false,
              cause: { code, signal, stderr: stderr.trim() || undefined },
              message: "AGY process exited unsuccessfully after reporting a result.",
            });
          }
          if (!providerSessionId) {
            throw new AgentProviderProtocolError({
              code: "PROVIDER_PROTOCOL_ERROR",
              provider: this.provider,
              operation: "open_conversation",
              retryable: false,
              cause: terminalResult,
              message: "AGY did not return a conversation id.",
            });
          }
          const finalResponse = directString(terminalResult.response);
          if (!finalResponse) {
            throw new AgentProviderProtocolError({
              code: "PROVIDER_PROTOCOL_ERROR",
              provider: this.provider,
              operation: "run",
              retryable: false,
              cause: terminalResult,
              message: "AGY returned SUCCESS without a final response.",
            });
          }
          return {
            provider: this.provider,
            providerSessionId,
            finalResponse,
            items,
          };
        } finally {
          clearTimeout(timer);
          if (forceKillTimer) clearTimeout(forceKillTimer);
          lines.close();
          await stopAgyChild(child);
          this.children.delete(child);
        }
      },
    });
  }

  async releaseSession(_providerSessionId: string): Promise<void> {
    // AGY conversations are durable and are resumed explicitly with --conversation.
  }

  isAlive(): boolean {
    return !this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.children].map(stopAgyChild));
  }
}

export class AgyLocalAgentDriver implements LocalAgentDriver {
  readonly provider = "agy" as const;
  readonly idleTimeoutMs = 5 * 60_000;
  private commandResolved = false;
  private resolvedCommand?: ResolvedAgyCommand;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly commandResolver: AgyCommandResolver = resolveAgyCommand,
  ) {}

  runtimeKey(_context: LocalAgentRuntimeContext): string {
    const command = this.resolveCommand()?.executable ?? this.env.AGY_COMMAND ?? "agy";
    return `agy:${command}`;
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
            message: "AGY executable with stream-json support was not found.",
          });
        }
        return new AgyRuntime(command.executable, this.env);
      },
    });
  }

  private resolveCommand(): ResolvedAgyCommand | undefined {
    if (!this.commandResolved) {
      this.resolvedCommand = this.commandResolver(this.env);
      this.commandResolved = true;
    }
    return this.resolvedCommand;
  }
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (command.includes("/") || command.includes("\\")) return command;
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], {
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout?.split(/\r?\n/).find((line) => line.trim())?.trim() || undefined;
}

function appendTail(current: string, next: string, maxBytes: number): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  return Buffer.from(combined, "utf8").subarray(-maxBytes).toString("utf8");
}

async function stopAgyChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (childExited(child)) return;
  terminateProcessTree(child, "SIGTERM", process.platform !== "win32");
  if (await waitForChildExit(child, AGY_TERMINATION_GRACE_MS)) return;
  terminateProcessTree(child, "SIGKILL", process.platform !== "win32");
  await waitForChildExit(child, AGY_TERMINATION_GRACE_MS);
}

function childExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (childExited(child)) return Promise.resolve(true);
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

function directString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function mirrorProxyCase(env: NodeJS.ProcessEnv, upper: string, lower: string): void {
  const value = nonEmpty(env[upper]) ?? nonEmpty(env[lower]);
  if (!value) return;
  env[upper] = value;
  env[lower] = value;
}
