import { homedir } from "node:os";
import { join } from "node:path";
import type { DevspaceUserConfig } from "./user-config.js";

const DEFAULT_CODEGRAPH_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_CODEGRAPH_TOOL_TIMEOUT_MS = 120_000;

export interface CodeGraphConfig {
  enabled: boolean;
  command: string;
  args: string[];
  startupTimeoutMs: number;
  toolTimeoutMs: number;
}

export type CodeGraphUserConfig = DevspaceUserConfig & {
  codegraphEnabled?: boolean;
  codegraphCommand?: string;
  codegraphArgs?: string[];
  codegraphStartupTimeoutMs?: number;
  codegraphToolTimeoutMs?: number;
};

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function numberConfigValue(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function defaultCodeGraphInstallDir(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "codegraph", "current");
}

function defaultCodeGraphCommand(): string {
  return process.platform === "win32"
    ? join(defaultCodeGraphInstallDir(), "node.exe")
    : "codegraph";
}

function defaultCodeGraphArgs(): string[] {
  return process.platform === "win32"
    ? [
        join(defaultCodeGraphInstallDir(), "lib", "dist", "bin", "codegraph.js"),
        "serve",
        "--mcp",
      ]
    : ["serve", "--mcp"];
}

export function parseCodeGraphConfig(
  env: NodeJS.ProcessEnv,
  config: CodeGraphUserConfig,
): CodeGraphConfig {
  return {
    enabled: env.DEVSPACE_CODEGRAPH === undefined
      ? config.codegraphEnabled === true
      : parseBoolean(env.DEVSPACE_CODEGRAPH),
    command: env.DEVSPACE_CODEGRAPH_COMMAND
      ?? config.codegraphCommand
      ?? defaultCodeGraphCommand(),
    args: config.codegraphArgs ?? defaultCodeGraphArgs(),
    startupTimeoutMs: parsePositiveInteger(
      env.DEVSPACE_CODEGRAPH_STARTUP_TIMEOUT_MS
        ?? numberConfigValue(config.codegraphStartupTimeoutMs),
      DEFAULT_CODEGRAPH_STARTUP_TIMEOUT_MS,
      "DEVSPACE_CODEGRAPH_STARTUP_TIMEOUT_MS",
    ),
    toolTimeoutMs: parsePositiveInteger(
      env.DEVSPACE_CODEGRAPH_TOOL_TIMEOUT_MS
        ?? numberConfigValue(config.codegraphToolTimeoutMs),
      DEFAULT_CODEGRAPH_TOOL_TIMEOUT_MS,
      "DEVSPACE_CODEGRAPH_TOOL_TIMEOUT_MS",
    ),
  };
}
