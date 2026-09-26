import * as z from "zod/v4";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

const providerSchema = z.object({
  id: z.enum(LOCAL_AGENT_PROVIDERS as [LocalAgentProvider, ...LocalAgentProvider[]]),
  enabled: z.boolean(),
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
}).strict();

const providerListSchema = z.array(
  z.enum(LOCAL_AGENT_PROVIDERS as [LocalAgentProvider, ...LocalAgentProvider[]]),
);

const routingSchema = z.object({
  default: providerListSchema.optional(),
  readOnly: providerListSchema.optional(),
  writable: providerListSchema.optional(),
}).strict();

const subagentsSchema = z.object({
  enabled: z.boolean(),
  providers: z.array(providerSchema),
  routing: routingSchema.optional(),
}).strict().superRefine((value, context) => {
  const seen = new Set<LocalAgentProvider>();
  for (const [index, provider] of value.providers.entries()) {
    if (seen.has(provider.id)) {
      context.addIssue({
        code: "custom",
        path: ["providers", index, "id"],
        message: `Duplicate subagent provider: ${provider.id}`,
      });
    }
    seen.add(provider.id);
  }
  for (const key of ["default", "readOnly", "writable"] as const) {
    const route = value.routing?.[key];
    if (!route) continue;
    const routeSeen = new Set<LocalAgentProvider>();
    for (const [index, provider] of route.entries()) {
      if (routeSeen.has(provider)) {
        context.addIssue({
          code: "custom",
          path: ["routing", key, index],
          message: `Duplicate subagent routing target: ${provider}`,
        });
      }
      routeSeen.add(provider);
    }
  }
});

export type SubagentProviderConfig = z.infer<typeof providerSchema>;
export type SubagentRoutingConfig = z.infer<typeof routingSchema>;
export type SubagentsConfig = z.infer<typeof subagentsSchema>;
export type StoredSubagentsConfig = boolean | SubagentsConfig;

export function resolveSubagentsConfig(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): SubagentsConfig {
  const stored = value === undefined
    ? { enabled: false, providers: [] }
    : typeof value === "boolean"
      ? legacySubagentsConfig(value)
      : subagentsSchema.parse(value);
  return {
    ...stored,
    enabled: env.DEVSPACE_SUBAGENTS === undefined
      ? stored.enabled
      : parseBoolean(env.DEVSPACE_SUBAGENTS),
  };
}

export function subagentProviderConfig(
  config: SubagentsConfig,
  provider: LocalAgentProvider,
): SubagentProviderConfig | undefined {
  return config.providers.find((entry) => entry.id === provider);
}

export function isSubagentProviderEnabled(
  config: SubagentsConfig,
  provider: LocalAgentProvider,
): boolean {
  return config.enabled && subagentProviderConfig(config, provider)?.enabled === true;
}

export function subagentRoutingTargets(
  config: SubagentsConfig,
  writeMode: "read_only" | "allowed" | "full_access" | undefined,
): LocalAgentProvider[] {
  if (!config.enabled) return [];
  const route = writeMode === "read_only"
    ? config.routing?.readOnly ?? config.routing?.default
    : config.routing?.writable ?? config.routing?.default;
  const candidates = route ?? config.providers.map((provider) => provider.id);
  const enabled = new Set(
    config.providers
      .filter((provider) => provider.enabled)
      .map((provider) => provider.id),
  );
  return candidates.filter((provider) => enabled.has(provider));
}

function legacySubagentsConfig(enabled: boolean): SubagentsConfig {
  return {
    enabled,
    providers: enabled
      ? LOCAL_AGENT_PROVIDERS.map((id) => ({ id, enabled: true }))
      : [],
  };
}

function parseBoolean(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
