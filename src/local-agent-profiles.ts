import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ServerConfig } from "./config.js";
import type { LocalAgentWriteMode } from "./local-agent-runtime.js";

export type LocalAgentProvider = "codex" | "claude" | "opencode" | "pi" | "cursor" | "copilot" | "grok" | "qoder" | "agy";

export const LOCAL_AGENT_PROVIDERS: readonly LocalAgentProvider[] = [
  "codex",
  "claude",
  "opencode",
  "pi",
  "cursor",
  "copilot",
  "grok",
  "qoder",
  "agy",
];

export interface LocalAgentProfile {
  name: string;
  description: string;
  provider: LocalAgentProvider;
  model?: string;
  effort?: string;
  writeMode?: LocalAgentWriteMode;
  filePath: string;
  body: string;
  disabled: boolean;
}

export interface LocalAgentProfileSummary {
  name: string;
  description: string;
  provider: LocalAgentProvider;
  model?: string;
  effort?: string;
  writeMode?: LocalAgentWriteMode;
}

export function localAgentProfileWriteMode(profile: LocalAgentProfile): LocalAgentWriteMode {
  return profile.writeMode ?? "allowed";
}

interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_DELIMITER = "---";
const PROVIDERS = new Set<LocalAgentProvider>(LOCAL_AGENT_PROVIDERS);

export async function loadLocalAgentProfiles(
  config: ServerConfig,
  workspaceRoot: string,
  options: { includeDisabled?: boolean } = {},
): Promise<LocalAgentProfile[]> {
  if (!config.subagents.enabled) return [];

  const profileDirs = [
    { directory: config.devspaceAgentsDir, allowFullAccess: true },
    { directory: join(workspaceRoot, ".devspace", "agents"), allowFullAccess: false },
  ];
  const profilesByName = new Map<string, LocalAgentProfile>();

  for (const { directory, allowFullAccess } of profileDirs) {
    for (const profile of await loadProfilesFromDirectory(directory, allowFullAccess)) {
      profilesByName.set(profile.name, profile);
    }
  }

  return Array.from(profilesByName.values())
    .filter((profile) => options.includeDisabled || !profile.disabled)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function summarizeLocalAgentProfile(
  profile: LocalAgentProfile,
): LocalAgentProfileSummary {
  return {
    name: profile.name,
    description: profile.description,
    provider: profile.provider,
    model: profile.model,
    effort: profile.effort,
    writeMode: localAgentProfileWriteMode(profile),
  };
}

async function loadProfilesFromDirectory(
  directory: string,
  allowFullAccess: boolean,
): Promise<LocalAgentProfile[]> {
  const resolvedDirectory = resolve(directory);
  if (!existsSync(resolvedDirectory)) return [];

  const entries = await readdir(resolvedDirectory, { withFileTypes: true });
  const profiles: LocalAgentProfile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;

    const filePath = join(resolvedDirectory, entry.name);
    try {
      profiles.push(await loadProfileFile(filePath, allowFullAccess));
    } catch (error) {
      console.warn(`Skipping invalid subagent profile ${filePath}: ${errorMessage(error)}`);
    }
  }

  return profiles;
}

async function loadProfileFile(filePath: string, allowFullAccess: boolean): Promise<LocalAgentProfile> {
  const content = await readFile(filePath, "utf8");
  const parsed = parseFrontmatter(content, filePath);
  return profileFromFrontmatter(parsed.frontmatter, parsed.body, filePath, allowFullAccess);
}

function parseFrontmatter(content: string, filePath: string): ParsedFrontmatter {
  const normalized = content.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    throw new Error(`Subagent profile is missing frontmatter: ${filePath}`);
  }

  const endIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONTMATTER_DELIMITER,
  );
  if (endIndex === -1) {
    throw new Error(`Subagent profile frontmatter is not closed: ${filePath}`);
  }

  return {
    frontmatter: parseProfileYaml(lines.slice(1, endIndex).join("\n"), filePath),
    body: lines.slice(endIndex + 1).join("\n").trim(),
  };
}

function parseProfileYaml(source: string, filePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(source) ?? {};
  } catch (error) {
    throw new Error(`Unable to parse subagent profile frontmatter: ${filePath}: ${errorMessage(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Subagent profile frontmatter must be a mapping: ${filePath}`);
  }

  return parsed as Record<string, unknown>;
}

function profileFromFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
  filePath: string,
  allowFullAccess: boolean,
): LocalAgentProfile {
  const name = readString(frontmatter, "name") ?? basename(filePath, ".md");
  const description = readString(frontmatter, "description");
  const provider = readProvider(frontmatter, filePath);
  if (!description) {
    throw new Error(`Subagent profile is missing description: ${filePath}`);
  }

  const writeMode = readWriteMode(frontmatter, filePath);
  if (writeMode === "full_access" && !allowFullAccess) {
    throw new Error(`Workspace subagent profiles cannot request full_access: ${filePath}`);
  }

  return {
    name,
    description,
    provider,
    model: readString(frontmatter, "model"),
    effort: readString(frontmatter, "effort"),
    writeMode,
    filePath,
    body,
    disabled: frontmatter.disabled === true,
  };
}

function readWriteMode(
  frontmatter: Record<string, unknown>,
  filePath: string,
): LocalAgentWriteMode | undefined {
  const value = readString(frontmatter, "writeMode");
  if (value === undefined) return undefined;
  if (value === "read_only" || value === "allowed" || value === "full_access") return value;
  throw new Error(`Subagent profile writeMode must be read_only, allowed, or full_access: ${filePath}`);
}

function readProvider(frontmatter: Record<string, unknown>, filePath: string): LocalAgentProvider {
  const provider = readString(frontmatter, "provider");
  if (!provider) {
    throw new Error(`Subagent profile is missing provider: ${filePath}`);
  }
  if (!PROVIDERS.has(provider as LocalAgentProvider)) {
    const prefix = LOCAL_AGENT_PROVIDERS.slice(0, -1).join(", ");
    const last = LOCAL_AGENT_PROVIDERS.at(-1);
    throw new Error(
      `Subagent profile provider must be ${prefix}, or ${last}: ${filePath}`,
    );
  }
  return provider as LocalAgentProvider;
}

export function isLocalAgentProvider(value: string): value is LocalAgentProvider {
  return PROVIDERS.has(value as LocalAgentProvider);
}

function readString(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const value = frontmatter[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
