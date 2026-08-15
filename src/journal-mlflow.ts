import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const JOURNAL_HELPER_PATH = fileURLToPath(new URL("../scripts/mlflow-journal.py", import.meta.url));
const JOURNAL_TIMEOUT_MS = 30_000;

export type JournalAction =
  | "start_round"
  | "record_event"
  | "complete_round"
  | "get_latest_round"
  | "record_review";

export interface JournalCommandRunner {
  run(action: JournalAction, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export class MlflowJournalRunner implements JournalCommandRunner {
  private pythonPromise?: Promise<string>;

  async run(
    action: JournalAction,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const python = await (this.pythonPromise ??= resolveMlflowPython());
    return runHelper(python, action, payload);
  }
}

async function resolveMlflowPython(): Promise<string> {
  const explicit = process.env.DEVSPACE_MLFLOW_PYTHON?.trim();
  if (explicit) return explicit;

  const home = homedir();
  const candidates = process.platform === "win32"
    ? [
        join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "uv", "tools", "mlflow", "Scripts", "python.exe"),
      ]
    : [
        join(home, ".local", "share", "uv", "tools", "mlflow", "bin", "python"),
        join(home, ".local", "share", "uv", "tools", "mlflow", "bin", "python3"),
      ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep looking. A system Python fallback below may still provide MLflow.
    }
  }

  return process.platform === "win32" ? "python" : "python3";
}

function runHelper(
  python: string,
  action: JournalAction,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [JOURNAL_HELPER_PATH, action], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`MLflow journal ${action} timed out after ${JOURNAL_TIMEOUT_MS}ms.`));
    }, JOURNAL_TIMEOUT_MS);

    const finish = (error?: Error, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result ?? {});
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`MLflow journal ${action} failed: ${stderr.trim() || `exit ${code}`}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as Record<string, unknown>;
        finish(undefined, parsed);
      } catch (error) {
        finish(
          new Error(
            `MLflow journal ${action} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });

    child.stdin.end(JSON.stringify(payload));
  });
}
