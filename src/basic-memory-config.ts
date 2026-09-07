import { resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface BasicMemoryProjectMapping {
  root: string;
  project: string;
}

export interface BasicMemoryConfig {
  enabled: boolean;
  url?: string;
  root?: string;
  project?: string;
  projectMappings: BasicMemoryProjectMapping[];
  timeoutMs: number;
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function parseProjectMappings(value: string | undefined): BasicMemoryProjectMapping[] {
  if (!value?.trim()) return [];
  return value.split(";").map((entry) => {
    const separator = entry.lastIndexOf("=");
    const root = entry.slice(0, separator).trim();
    const project = entry.slice(separator + 1).trim();
    if (separator < 1 || !root || !project) {
      throw new Error(`Invalid DEVSPACE_BASIC_MEMORY_PROJECT_MAP entry: ${entry}`);
    }
    return { root: resolve(root), project };
  });
}

export function parseBasicMemoryConfig(env: NodeJS.ProcessEnv = process.env): BasicMemoryConfig {
  const enabled = parseBoolean(env.DEVSPACE_BASIC_MEMORY);
  const url = env.DEVSPACE_BASIC_MEMORY_URL?.trim();
  const root = env.DEVSPACE_BASIC_MEMORY_ROOT?.trim();
  const project = env.DEVSPACE_BASIC_MEMORY_PROJECT?.trim();
  const projectMappings = parseProjectMappings(env.DEVSPACE_BASIC_MEMORY_PROJECT_MAP);

  if (enabled && !url) {
    throw new Error("DEVSPACE_BASIC_MEMORY_URL is required when DEVSPACE_BASIC_MEMORY is enabled.");
  }
  if (enabled && !root) {
    throw new Error("DEVSPACE_BASIC_MEMORY_ROOT is required when DEVSPACE_BASIC_MEMORY is enabled.");
  }

  if (url) {
    try {
      new URL(url);
    } catch {
      throw new Error(`Invalid DEVSPACE_BASIC_MEMORY_URL: ${url}`);
    }
  }

  return {
    enabled,
    url,
    root: root ? resolve(root) : undefined,
    project: project || undefined,
    projectMappings,
    timeoutMs: parsePositiveInteger(
      env.DEVSPACE_BASIC_MEMORY_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      "DEVSPACE_BASIC_MEMORY_TIMEOUT_MS",
    ),
  };
}
