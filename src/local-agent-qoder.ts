import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
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

const QODER_STARTUP_TIMEOUT_MS = 30_000;
const QODER_REMOTE_CONTROL_TIMEOUT_MS = 20_000;
const QODER_SANITIZE_TIMEOUT_MS = 60_000;
const QODER_TURN_TIMEOUT_MS = 4 * 60 * 60_000;
const QODER_RUNTIME_IDLE_TIMEOUT_MS = 65 * 60_000;
const QODER_TERMINAL_TAIL_CHARS = 768 * 1024;
const QODER_STDERR_TAIL_CHARS = 32 * 1024;
const QODER_MAX_TRACKED_TURNS = 1_000;
const QODER_PROMPT_MARKER = "Type your message or @path/to/file";
const QODER_TRUST_MARKER = "Do you trust the files in this folder?";
const QODER_REMOTE_UNAVAILABLE_MARKER = "Remote session service not available";
const QODER_BOOTSTRAP_PROMPT = "Reply exactly DEVSPACE_REMOTE_BOOTSTRAP_READY and do nothing else.";

type QoderPty = import("node-pty").IPty;
type QoderPtyModule = typeof import("node-pty");

interface QoderTrackedInput {
  index: number;
  text: string;
  record: Record<string, unknown>;
}

interface QoderTrackedResult {
  index: number;
  record: Record<string, unknown>;
}

interface QoderTrackedTurn {
  index: number;
  key: string;
  input?: QoderTrackedInput;
}

export function isQoderRemoteSessionId(value: string | undefined): boolean {
  return Boolean(value && /^qs_[A-Za-z0-9]+$/.test(value));
}

export function qoderRemoteSessionUrl(sessionId: string): string {
  return `https://qoder.com/agents/session/${sessionId}`;
}

export function qoderRemoteWorkerArgs(
  context: Pick<LocalAgentRuntimeContext, "agentId" | "writeMode" | "model" | "effort">,
  remoteSessionId: string,
  options: { toolsIsolated?: boolean } = {},
): string[] {
  return [
    "--remote-control", remoteSessionId,
    ...(options.toolsIsolated ? qoderNoToolsArgs() : []),
    ...qoderAuthorityArgs(context),
  ];
}

export function qoderRemoteControllerArgs(
  input: Pick<LocalAgentRunInput, "writeMode" | "model" | "effort">,
  remoteSessionId: string,
): string[] {
  return ["--remote-session", remoteSessionId, ...qoderAuthorityArgs(input)];
}

export function qoderBootstrapArgs(
  context: LocalAgentRuntimeContext,
  localSessionId: string,
): string[] {
  const sessionArgs = context.providerSessionId && !isQoderRemoteSessionId(context.providerSessionId)
    ? ["--resume", context.providerSessionId]
    : ["--session-id", localSessionId];
  return [
    ...sessionArgs,
    "--name", `DevSpace ${context.agentId}`.slice(0, 80),
    ...qoderNoToolsArgs(),
    ...qoderAuthorityArgs(context),
  ];
}

export function extractQoderRemoteSessionId(text: string): string | undefined {
  return text.match(/https:\/\/qoder\.com\/agents\/session\/(qs_[A-Za-z0-9]+)/)?.[1]
    ?? text.match(/Session ID:\s*(qs_[A-Za-z0-9]+)/i)?.[1];
}

export function parseQoderRemoteWorkerLine(line: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(line) as unknown;
    const record = asRecord(parsed);
    if (!record) throw new TypeError("Qoder Remote Control worker event must be a JSON object.");
    return record;
  } catch (cause) {
    throw new AgentProviderProtocolError({
      code: "PROVIDER_PROTOCOL_ERROR",
      provider: "qoder",
      operation: "parse_remote_worker_stream",
      retryable: false,
      cause,
      message: "Qoder Remote Control worker emitted malformed JSONL output.",
    });
  }
}

export function qoderRemoteInputText(event: Record<string, unknown>): string | undefined {
  if (event.type !== "user" || event.subtype !== "remote_input") return undefined;
  const content = asRecord(event.message)?.content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map(asRecord)
    .filter((part): part is Record<string, unknown> => Boolean(part))
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text));
  return parts.length > 0 ? parts.join("") : undefined;
}

export function qoderTopLevelUserTurnKey(event: Record<string, unknown>): string | undefined {
  if (event.type !== "user" || event.parent_tool_use_id) return undefined;
  const message = asRecord(event.message);
  if (message?.role !== "user") return undefined;
  const content = message.content;
  const hasPromptText = typeof content === "string"
    ? Boolean(content.trim())
    : Array.isArray(content) && content.some((part) => {
        const record = asRecord(part);
        return record?.type === "text" && typeof record.text === "string" && Boolean(record.text.trim());
      });
  if (!hasPromptText) return undefined;
  return directString(event.uuid) ?? directString(event.event_id);
}

export function qoderPromptInputChunks(prompt: string): string[] {
  const safe = prompt
    .replaceAll("\u0000", "")
    .replaceAll("\u001b", "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  const lines = safe.split("\n");
  const chunks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]) chunks.push(lines[index]!);
    if (index < lines.length - 1) chunks.push("\n");
  }
  chunks.push("\r");
  return chunks;
}

export class QoderRemoteControlRuntime implements LocalAgentRuntime {
  readonly provider = "qoder" as const;
  private closed = false;
  private activeTurn = false;
  private activeController?: QoderRemoteController;

  private constructor(
    private readonly command: string,
    readonly sessionId: string,
    private readonly workspaceRoot: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly nodePty: QoderPtyModule,
    private readonly worker: QoderRemoteWorker,
  ) {}

  static async create(input: {
    command: string;
    context: LocalAgentRuntimeContext;
    env: NodeJS.ProcessEnv;
  }): Promise<QoderRemoteControlRuntime> {
    const nodePty = await loadNodePty(input.context.agentId);
    const workspaceRoot = resolve(input.context.workspaceRoot);
    const reattachingRemoteSession = isQoderRemoteSessionId(input.context.providerSessionId);
    const remoteSessionId = reattachingRemoteSession
      ? input.context.providerSessionId!
      : await bootstrapRemoteSession({
          command: input.command,
          context: input.context,
          env: input.env,
          nodePty,
          workspaceRoot,
        });

    // Qoder's interactive /remote-control bootstrap always contributes a
    // synthetic <local-command-caveat> turn to a newly-created remote session.
    // Drain that vendor-generated turn in a native worker with tools disabled
    // before starting the real DevSpace worker. This prevents bootstrap
    // history from executing repository tools and also ensures its result
    // cannot be mistaken for the first DevSpace task result.
    if (!reattachingRemoteSession) {
      const sanitizer = QoderRemoteWorker.start({
        command: input.command,
        args: qoderRemoteWorkerArgs(input.context, remoteSessionId, { toolsIsolated: true }),
        env: input.env,
        workspaceRoot,
        remoteSessionId,
      });
      try {
        await sanitizer.initialize();
        await sanitizer.waitForBackgroundTurnCompletion(QODER_SANITIZE_TIMEOUT_MS);
      } finally {
        await sanitizer.close();
      }
    }

    const worker = QoderRemoteWorker.start({
      command: input.command,
      args: qoderRemoteWorkerArgs(input.context, remoteSessionId),
      env: input.env,
      workspaceRoot,
      remoteSessionId,
    });
    try {
      await worker.initialize();
      return new QoderRemoteControlRuntime(
        input.command,
        remoteSessionId,
        workspaceRoot,
        input.env,
        nodePty,
        worker,
      );
    } catch (error) {
      await worker.close();
      throw error;
    }
  }

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
            message: "Qoder Remote Control worker is not running.",
          });
        }
        if (resolve(input.workspaceRoot) !== this.workspaceRoot) {
          throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: this.provider,
            operation: "run",
            retryable: false,
            message: "Qoder Remote Control runtime cannot be reused across workspaces.",
          });
        }
        if (input.providerSessionId && input.providerSessionId !== this.sessionId) {
          throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: this.provider,
            operation: "resume_session",
            retryable: false,
            message: "Qoder Remote Control runtime session does not match the persisted remote session.",
          });
        }
        if (this.activeTurn) {
          throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: this.provider,
            operation: "run",
            retryable: false,
            message: "Qoder Remote Control runtime already has an active DevSpace turn.",
          });
        }

        await callbacks?.onSessionId?.(this.sessionId);
        this.activeTurn = true;
        const controller = await QoderRemoteController.create({
          command: this.command,
          args: qoderRemoteControllerArgs(input, this.sessionId),
          env: this.env,
          nodePty: this.nodePty,
          workspaceRoot: this.workspaceRoot,
        });
        this.activeController = controller;
        try {
          const checkpoint = this.worker.checkpoint();
          await controller.submit(input.prompt);
          const remoteInput = await this.worker.waitForInput(
            input.prompt,
            checkpoint,
            QODER_STARTUP_TIMEOUT_MS,
          );
          const completed = await this.worker.waitForResult(remoteInput.index, QODER_TURN_TIMEOUT_MS);
          const result = completed.record;
          if (result.is_error === true || result.subtype !== "success") {
            throw new AgentProviderExecutionError({
              code: "PROVIDER_EXECUTION_ERROR",
              provider: this.provider,
              operation: "run",
              retryable: false,
              cause: result,
              message: "Qoder Remote Control worker turn failed.",
            });
          }
          const finalResponse = directString(result.result);
          if (!finalResponse) {
            throw new AgentProviderProtocolError({
              code: "PROVIDER_PROTOCOL_ERROR",
              provider: this.provider,
              operation: "read_result",
              retryable: false,
              cause: result,
              message: "Qoder Remote Control worker completed without a final response.",
            });
          }
          return {
            provider: this.provider,
            providerSessionId: this.sessionId,
            finalResponse,
            items: [remoteInput.record, result],
          };
        } finally {
          if (this.activeController === controller) this.activeController = undefined;
          await controller.close();
          this.activeTurn = false;
        }
      },
    });
  }

  async releaseSession(_providerSessionId: string): Promise<void> {
    // The qs_* Remote Control identity is durable in Qoder. Runtime eviction
    // only disconnects the local worker; the next runtime can reattach with
    // --remote-control <id> and preserve Web/Desktop continuity.
  }

  isAlive(): boolean {
    return !this.closed && this.worker.isAlive();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const controller = this.activeController;
    this.activeController = undefined;
    await controller?.close();
    await this.worker.close();
  }
}

export class QoderRemoteControlLocalAgentDriver implements LocalAgentDriver {
  readonly provider = "qoder" as const;
  readonly idleTimeoutMs = QODER_RUNTIME_IDLE_TIMEOUT_MS;
  private commandResolved = false;
  private resolvedCommand?: string;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly commandResolver: (env: NodeJS.ProcessEnv) => string | undefined = resolveQoderCommand,
  ) {}

  runtimeKey(context: LocalAgentRuntimeContext): string {
    const command = this.resolveCommand() ?? this.env.QODER_COMMAND ?? "qodercli";
    return [
      "qoder-native-remote-control",
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
            message: "Qoder native CLI executable was not found.",
          });
        }
        return QoderRemoteControlRuntime.create({ command, context, env: this.env });
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
      const candidate = resolve(directory, `qodercli${extension}`);
      if (executableExists(candidate)) return candidate;
    }
  }
  return undefined;
}

class QoderRemoteWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly detached: boolean;
  private readonly inputs: QoderTrackedInput[] = [];
  private readonly pendingTurns: QoderTrackedTurn[] = [];
  private readonly seenTurnKeys = new Set<string>();
  private readonly completedResults = new Map<number, QoderTrackedResult>();
  private readonly waiters = new Set<() => void>();
  private nextIndex = 0;
  private initRecord?: Record<string, unknown>;
  private backgroundTurnsSeen = 0;
  private backgroundTurnsCompleted = 0;
  private protocolError?: Error;
  private stderrTail = "";
  private alive = true;
  private closed = false;

  private constructor(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    workspaceRoot: string,
    private readonly remoteSessionId: string,
  ) {
    this.detached = process.platform !== "win32";
    this.child = spawn(command, args, {
      cwd: workspaceRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: this.detached,
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = appendTail(this.stderrTail, chunk, QODER_STDERR_TAIL_CHARS);
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.acceptLine(line));
    this.child.once("error", (error) => {
      this.protocolError = error;
      this.alive = false;
      this.notify();
    });
    this.child.once("close", () => {
      this.alive = false;
      this.notify();
    });
  }

  static start(input: {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    workspaceRoot: string;
    remoteSessionId: string;
  }): QoderRemoteWorker {
    return new QoderRemoteWorker(
      input.command,
      input.args,
      input.env,
      input.workspaceRoot,
      input.remoteSessionId,
    );
  }

  async initialize(): Promise<void> {
    const init = await this.waitFor(
      () => this.initRecord,
      QODER_STARTUP_TIMEOUT_MS,
      "Qoder native Remote Control worker did not initialize.",
    );
    const remoteId = directString(init.remote_session_id) ?? directString(init.session_id);
    if (remoteId !== this.remoteSessionId) {
      throw new AgentProviderProtocolError({
        code: "PROVIDER_PROTOCOL_ERROR",
        provider: "qoder",
        operation: "initialize_remote_worker",
        retryable: false,
        cause: init,
        message: "Qoder native Remote Control worker attached to an unexpected remote session.",
      });
    }
  }

  checkpoint(): number {
    return this.nextIndex;
  }

  isAlive(): boolean {
    return this.alive && !this.closed && this.child.exitCode === null && !this.child.killed;
  }

  async waitForInput(prompt: string, checkpoint: number, timeoutMs: number): Promise<QoderTrackedInput> {
    return this.waitFor(
      () => this.inputs.find((input) => input.index >= checkpoint && input.text === prompt),
      timeoutMs,
      "Qoder Remote Control controller did not deliver the DevSpace task to the native worker.",
    );
  }

  async waitForResult(inputIndex: number, timeoutMs: number): Promise<QoderTrackedResult> {
    const completed = await this.waitFor(
      () => this.completedResults.get(inputIndex),
      timeoutMs,
      "Qoder native Remote Control worker did not complete the DevSpace task before the timeout.",
    );
    this.completedResults.delete(inputIndex);
    return completed;
  }

  async waitForBackgroundTurnCompletion(timeoutMs: number): Promise<void> {
    await this.waitFor(
      () => this.backgroundTurnsSeen > 0 && this.backgroundTurnsCompleted >= this.backgroundTurnsSeen
        ? true
        : undefined,
      timeoutMs,
      "Qoder Remote Control sanitizer did not finish the bootstrap background turn before the timeout.",
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.alive = false;
    this.notify();
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (this.child.exitCode !== null) return;
    terminateProcessTree(this.child, "SIGTERM", this.detached);
    if (!await waitForChildExit(this.child, 1_000)) {
      terminateProcessTree(this.child, "SIGKILL", this.detached);
    }
  }

  private acceptLine(line: string): void {
    if (!line.trim()) return;
    let record: Record<string, unknown>;
    try {
      record = parseQoderRemoteWorkerLine(line);
    } catch (error) {
      this.protocolError = error instanceof Error ? error : new Error(String(error));
      this.notify();
      return;
    }
    const index = this.nextIndex++;
    if (record.type === "system" && record.subtype === "remote_worker_init") {
      this.initRecord = record;
    }
    const inputText = qoderRemoteInputText(record);
    const turnKey = qoderTopLevelUserTurnKey(record);
    if (turnKey && !this.seenTurnKeys.has(turnKey)) {
      this.seenTurnKeys.add(turnKey);
      let input: QoderTrackedInput | undefined;
      if (inputText !== undefined) {
        input = { index, text: inputText, record };
        this.inputs.push(input);
        trimFront(this.inputs, QODER_MAX_TRACKED_TURNS);
      } else {
        this.backgroundTurnsSeen += 1;
      }
      this.pendingTurns.push({ index, key: turnKey, input });
    }
    if (record.type === "result") {
      const turn = this.pendingTurns.shift();
      if (turn?.input) {
        this.completedResults.set(turn.input.index, { index, record });
      } else if (turn) {
        this.backgroundTurnsCompleted += 1;
      }
    }
    this.notify();
  }

  private async waitFor<T>(
    read: () => T | undefined,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.protocolError) throw this.protocolError;
      const value = read();
      if (value !== undefined) return value;
      if (!this.isAlive()) {
        throw new AgentProviderUnavailableError({
          code: "PROVIDER_UNAVAILABLE",
          provider: "qoder",
          operation: "remote_worker_stream",
          retryable: true,
          cause: this.stderrTail.trim() || undefined,
          message: "Qoder native Remote Control worker exited unexpectedly.",
        });
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new AgentProviderExecutionError({
          code: "PROVIDER_EXECUTION_ERROR",
          provider: "qoder",
          operation: "remote_worker_stream",
          retryable: true,
          cause: this.stderrTail.trim() || undefined,
          message: timeoutMessage,
        });
      }
      await this.waitForChange(Math.min(remaining, 250));
    }
  }

  private waitForChange(timeoutMs: number): Promise<void> {
    return new Promise((resolveChange) => {
      let timer: NodeJS.Timeout | undefined;
      const wake = () => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(wake);
        resolveChange();
      };
      this.waiters.add(wake);
      timer = setTimeout(wake, timeoutMs);
      timer.unref();
    });
  }

  private notify(): void {
    for (const waiter of Array.from(this.waiters)) waiter();
  }
}

class QoderRemoteController {
  private closed = false;

  private constructor(private readonly terminal: QoderTerminal) {}

  static async create(input: {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    nodePty: QoderPtyModule;
    workspaceRoot: string;
  }): Promise<QoderRemoteController> {
    const terminal = spawnQoderTerminal(input);
    const controller = new QoderRemoteController(terminal);
    try {
      const startupCheckpoint = terminal.checkpoint();
      await prepareInteractiveTerminal(terminal, "Qoder Remote Control controller");
      await terminal.waitFor(
        (text) => normalizeQoderTerminalText(text)
          .toLowerCase()
          .includes("remote worker state: connected"),
        startupCheckpoint,
        QODER_REMOTE_CONTROL_TIMEOUT_MS,
        "Qoder Remote Control controller became interactive before its remote worker was connected.",
      );
      await delay(150);
      return controller;
    } catch (error) {
      await controller.close();
      throw error;
    }
  }

  async submit(prompt: string): Promise<void> {
    await writeQoderTerminalPrompt(this.terminal, prompt);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.terminal.close();
  }
}

class QoderTerminal {
  private buffer = "";
  private bufferStart = 0;
  private totalCharacters = 0;
  private alive = true;

  constructor(private readonly pty: QoderPty) {
    pty.onData((data) => this.append(data));
    pty.onExit(() => { this.alive = false; });
  }

  checkpoint(): number {
    return this.totalCharacters;
  }

  textSince(checkpoint: number): string {
    const index = Math.max(0, checkpoint - this.bufferStart);
    return this.buffer.slice(index);
  }

  isAlive(): boolean {
    return this.alive;
  }

  write(data: string): void {
    if (!this.alive) {
      throw new AgentProviderUnavailableError({
        code: "PROVIDER_UNAVAILABLE",
        provider: "qoder",
        operation: "write_terminal",
        retryable: true,
        message: "Qoder terminal exited before DevSpace could send input.",
      });
    }
    this.pty.write(data);
  }

  close(): void {
    if (!this.alive) return;
    this.alive = false;
    try {
      this.pty.kill();
    } catch {
      // The ConPTY may already have exited.
    }
  }

  async waitFor(
    predicate: (text: string) => boolean,
    checkpoint: number,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!this.alive) {
        throw new AgentProviderUnavailableError({
          code: "PROVIDER_UNAVAILABLE",
          provider: "qoder",
          operation: "wait_terminal",
          retryable: true,
          message: "Qoder terminal exited unexpectedly.",
        });
      }
      if (predicate(this.textSince(checkpoint))) return;
      if (Date.now() >= deadline) {
        throw new AgentProviderExecutionError({
          code: "PROVIDER_EXECUTION_ERROR",
          provider: "qoder",
          operation: "wait_terminal",
          retryable: true,
          message: timeoutMessage,
        });
      }
      await delay(50);
    }
  }

  private append(data: string): void {
    this.buffer += data;
    this.totalCharacters += data.length;
    if (this.buffer.length <= QODER_TERMINAL_TAIL_CHARS) return;
    const remove = this.buffer.length - QODER_TERMINAL_TAIL_CHARS;
    this.buffer = this.buffer.slice(remove);
    this.bufferStart += remove;
  }
}

async function bootstrapRemoteSession(input: {
  command: string;
  context: LocalAgentRuntimeContext;
  env: NodeJS.ProcessEnv;
  nodePty: QoderPtyModule;
  workspaceRoot: string;
}): Promise<string> {
  const localSessionId = randomUUID();
  const terminal = spawnQoderTerminal({
    command: input.command,
    args: qoderBootstrapArgs(input.context, localSessionId),
    env: input.env,
    nodePty: input.nodePty,
    workspaceRoot: input.workspaceRoot,
  });
  try {
    await prepareInteractiveTerminal(terminal, "Qoder Remote Control bootstrap");
    const bootstrapTurn = terminal.checkpoint();
    await writeQoderTerminalPrompt(terminal, QODER_BOOTSTRAP_PROMPT);
    await terminal.waitFor(
      (text) => text.includes("| Working"),
      bootstrapTurn,
      QODER_STARTUP_TIMEOUT_MS,
      "Qoder Remote Control bootstrap did not start its neutral setup turn.",
    );
    await terminal.waitFor(
      (text) => {
        const working = text.lastIndexOf("| Working");
        const ready = text.lastIndexOf("| Ready");
        return working >= 0 && ready > working;
      },
      bootstrapTurn,
      QODER_STARTUP_TIMEOUT_MS,
      "Qoder Remote Control bootstrap did not finish its neutral setup turn.",
    );
    const checkpoint = terminal.checkpoint();
    terminal.write("/remote-control\r");
    await terminal.waitFor(
      (text) => {
        if (text.includes(QODER_REMOTE_UNAVAILABLE_MARKER)) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: "qoder",
            agentId: input.context.agentId,
            operation: "enable_remote_control",
            retryable: true,
            message: "Qoder Remote Control service is unavailable for this CLI session.",
          });
        }
        return Boolean(extractQoderRemoteSessionId(text));
      },
      checkpoint,
      QODER_REMOTE_CONTROL_TIMEOUT_MS,
      "Qoder did not create a Remote Control session before the startup timeout.",
    );
    const remoteSessionId = extractQoderRemoteSessionId(terminal.textSince(checkpoint));
    if (!remoteSessionId) {
      throw new AgentProviderProtocolError({
        code: "PROVIDER_PROTOCOL_ERROR",
        provider: "qoder",
        agentId: input.context.agentId,
        operation: "enable_remote_control",
        retryable: false,
        message: "Qoder enabled Remote Control without returning a remote session id.",
      });
    }
    await delay(250);
    return remoteSessionId;
  } finally {
    terminal.close();
  }
}

async function prepareInteractiveTerminal(terminal: QoderTerminal, label: string): Promise<void> {
  const checkpoint = terminal.checkpoint();
  await terminal.waitFor(
    (text) => text.includes(QODER_PROMPT_MARKER) || text.includes(QODER_TRUST_MARKER),
    checkpoint,
    QODER_STARTUP_TIMEOUT_MS,
    `${label} did not become ready.`,
  );
  const startupText = terminal.textSince(checkpoint);
  if (startupText.includes(QODER_TRUST_MARKER) && !startupText.includes(QODER_PROMPT_MARKER)) {
    // DevSpace already authorizes this exact workspace root before a local
    // agent can start. Confirming Qoder's duplicate trust gate does not expand
    // the caller's authority.
    terminal.write("\r");
    await terminal.waitFor(
      (text) => text.includes(QODER_PROMPT_MARKER),
      checkpoint,
      QODER_STARTUP_TIMEOUT_MS,
      `${label} did not reach the input prompt after workspace trust confirmation.`,
    );
  }
}

async function writeQoderTerminalPrompt(terminal: QoderTerminal, prompt: string): Promise<void> {
  for (const chunk of qoderPromptInputChunks(prompt)) {
    if (chunk === "\r") await delay(80);
    terminal.write(chunk);
    if (chunk === "\n") await delay(50);
  }
}

function spawnQoderTerminal(input: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  nodePty: QoderPtyModule;
  workspaceRoot: string;
}): QoderTerminal {
  let pty: QoderPty;
  try {
    pty = input.nodePty.spawn(input.command, input.args, {
      cwd: input.workspaceRoot,
      env: {
        ...input.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
      name: "xterm-256color",
      cols: 120,
      rows: 36,
    });
  } catch (cause) {
    throw new AgentProviderUnavailableError({
      code: "PROVIDER_UNAVAILABLE",
      provider: "qoder",
      operation: "create_terminal",
      retryable: true,
      cause,
      message: "Unable to start the Qoder Remote Control terminal.",
    });
  }
  return new QoderTerminal(pty);
}

async function loadNodePty(agentId: string): Promise<QoderPtyModule> {
  try {
    return await import("node-pty");
  } catch (cause) {
    throw new AgentProviderUnavailableError({
      code: "PROVIDER_UNAVAILABLE",
      provider: "qoder",
      agentId,
      operation: "create_runtime",
      retryable: false,
      cause,
      message: "Qoder native Remote Control requires the installed node-pty dependency.",
    });
  }
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
      message: "Qoder native Remote Control does not expose a hard read-only mode; DevSpace will not weaken read_only to an advisory prompt.",
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

function qoderNoToolsArgs(): string[] {
  return [
    "--tools", "",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--disallowed-tools", "mcp__qw-builtin__present_files",
  ];
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function directString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function appendTail(current: string, chunk: string, maxCharacters: number): string {
  const next = current + chunk;
  return next.length <= maxCharacters ? next : next.slice(next.length - maxCharacters);
}

export function normalizeQoderTerminalText(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[(\d*)C/g, (_match, count: string) => " ".repeat(Number(count || "1")))
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ");
}

function trimFront<T>(values: T[], maxItems: number): void {
  if (values.length > maxItems) values.splice(0, values.length - maxItems);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
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
