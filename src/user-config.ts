import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { StoredSubagentsConfig } from "./local-agent-config.js";
import type { BasicMemoryAuthConfig, BasicMemoryUserConfig } from "./basic-memory-config.js";

export interface DevspaceUserConfig extends BasicMemoryUserConfig {
  host?: string;
  port?: number;
  allowedRoots?: string[];
  publicBaseUrl?: string | null;
  allowedHosts?: string[];
  stateDir?: string;
  worktreeRoot?: string;
  artifactsEnabled?: boolean;
  artifactMaxFileBytes?: number;
  agentDir?: string;
  subagents?: StoredSubagentsConfig;
}

export interface DevspaceAuthConfig extends BasicMemoryAuthConfig {
  ownerToken?: string;
}

export interface DevspaceFiles {
  dir: string;
  configPath: string;
  authPath: string;
  configExists: boolean;
  authExists: boolean;
  config: DevspaceUserConfig;
  auth: DevspaceAuthConfig;
}

export function devspaceConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(expandHomePath(env.DEVSPACE_CONFIG_DIR ?? join(homedir(), ".devspace")));
}

export function devspaceConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "config.json");
}

export function devspaceAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "auth.json");
}

export function devspaceSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "skills");
}

export function devspaceAgentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "agents");
}

export function loadDevspaceFiles(env: NodeJS.ProcessEnv = process.env): DevspaceFiles {
  const dir = devspaceConfigDir(env);
  const configPath = join(dir, "config.json");
  const authPath = join(dir, "auth.json");
  const configExists = existsSync(configPath);
  const authExists = existsSync(authPath);

  return {
    dir,
    configPath,
    authPath,
    configExists,
    authExists,
    config: configExists ? readJsonFile<DevspaceUserConfig>(configPath) : {},
    auth: authExists ? readJsonFile<DevspaceAuthConfig>(authPath) : {},
  };
}

export function writeDevspaceConfig(
  config: DevspaceUserConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = devspaceConfigPath(env);
  mkdirSync(devspaceConfigDir(env), { recursive: true });
  writeJsonFile(filePath, config, 0o600);
  return filePath;
}

export function writeDevspaceAuth(
  auth: DevspaceAuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = devspaceAuthPath(env);
  mkdirSync(devspaceConfigDir(env), { recursive: true });
  if (process.platform === "win32") {
    if (!existsSync(filePath)) writeFileSync(filePath, "", { flag: "wx" });
    hardenAuthFile(filePath);
  }
  writeJsonFile(filePath, auth, 0o600);
  return filePath;
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

function readJsonFile<T>(filePath: string): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${filePath}: ${reason}`);
  }
}

function writeJsonFile(filePath: string, value: unknown, mode: number): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode });
}

function hardenAuthFile(filePath: string): void {
  if (process.platform !== "win32") return;

  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const system32 = join(systemRoot, "System32");
  const userInfo = execFileSync(join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const sid = /"([^"]+)"\s*$/.exec(userInfo)?.[1];
  if (!sid) throw new Error("Unable to resolve the current Windows user SID for auth.json ACL hardening.");

  execFileSync(
    join(system32, "icacls.exe"),
    [
      filePath,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:(F)`,
      "*S-1-5-18:(F)",
      "*S-1-5-32-544:(F)",
    ],
    { stdio: "ignore", windowsHide: true },
  );
}
