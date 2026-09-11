const DEFAULT_TIMEOUT_MS = 15_000;

export interface BasicMemoryUserConfig {
  basicMemoryEnabled?: boolean;
  basicMemoryGlobalProject?: string;
  basicMemoryAutoProvision?: boolean;
  basicMemoryProjectBasePath?: string;
  basicMemoryTimeoutMs?: number;
}

export interface BasicMemoryAuthConfig {
  basicMemoryUrl?: string;
  basicMemoryToken?: string;
}

export interface BasicMemoryConfig {
  enabled: boolean;
  url?: string;
  token?: string;
  globalProject?: string;
  autoProvision: boolean;
  projectBasePath?: string;
  timeoutMs: number;
  legacyMappingConfigured: boolean;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parsePositiveInteger(value: string | number | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function configuredString(environmentValue: string | undefined, persistedValue: string | undefined): string | undefined {
  const value = environmentValue?.trim() || persistedValue?.trim();
  return value || undefined;
}

export function parseBasicMemoryConfig(
  env: NodeJS.ProcessEnv = process.env,
  persisted: BasicMemoryUserConfig = {},
  auth: BasicMemoryAuthConfig = {},
): BasicMemoryConfig {
  const enabled = parseBoolean(env.DEVSPACE_BASIC_MEMORY, persisted.basicMemoryEnabled ?? false);
  const url = configuredString(env.DEVSPACE_BASIC_MEMORY_URL, auth.basicMemoryUrl);
  const token = configuredString(env.DEVSPACE_BASIC_MEMORY_TOKEN, auth.basicMemoryToken);
  const globalProject = configuredString(
    env.DEVSPACE_BASIC_MEMORY_GLOBAL_PROJECT,
    persisted.basicMemoryGlobalProject,
  );
  const projectBasePath = configuredString(
    env.DEVSPACE_BASIC_MEMORY_PROJECT_BASE_PATH,
    persisted.basicMemoryProjectBasePath,
  );
  const autoProvision = parseBoolean(
    env.DEVSPACE_BASIC_MEMORY_AUTO_PROVISION,
    persisted.basicMemoryAutoProvision ?? true,
  );
  const timeoutMs = parsePositiveInteger(
    env.DEVSPACE_BASIC_MEMORY_TIMEOUT_MS ?? persisted.basicMemoryTimeoutMs,
    DEFAULT_TIMEOUT_MS,
    "DEVSPACE_BASIC_MEMORY_TIMEOUT_MS",
  );
  const legacyMappingConfigured = Boolean(
    env.DEVSPACE_BASIC_MEMORY_ROOT?.trim() ||
      env.DEVSPACE_BASIC_MEMORY_PROJECT?.trim() ||
      env.DEVSPACE_BASIC_MEMORY_PROJECT_MAP?.trim(),
  );

  if (enabled && !url) {
    throw new Error(
      "Basic Memory is enabled but no endpoint is configured. Set DEVSPACE_BASIC_MEMORY_URL or basicMemoryUrl in auth.json.",
    );
  }

  if (url) {
    try {
      new URL(url);
    } catch {
      throw new Error(`Invalid DEVSPACE_BASIC_MEMORY_URL: ${url}`);
    }
  }

  if (token && token.length < 32) {
    throw new Error("DEVSPACE_BASIC_MEMORY_TOKEN must be at least 32 characters when configured.");
  }

  return {
    enabled,
    url,
    token,
    globalProject,
    autoProvision,
    projectBasePath,
    timeoutMs,
    legacyMappingConfigured,
  };
}
