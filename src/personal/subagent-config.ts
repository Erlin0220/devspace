import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  resolveSubagentsConfig,
  type SubagentRoutingConfig,
  type SubagentsConfig,
} from "../local-agent-config.js";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "../local-agent-profiles.js";
import { localAgentProviderWriteModes } from "../local-agent-runtime.js";
import { loadDevspaceFiles, writeDevspaceConfig } from "../user-config.js";

const providerIdSchema = z.enum(
  LOCAL_AGENT_PROVIDERS as [LocalAgentProvider, ...LocalAgentProvider[]],
);
const providerPatchSchema = z.object({
  id: providerIdSchema,
  enabled: z.boolean().optional(),
  model: z.string().trim().min(1).nullable().optional(),
  effort: z.string().trim().min(1).nullable().optional(),
}).strict();
const routePatchSchema = z.object({
  default: z.array(providerIdSchema).nullable().optional(),
  readOnly: z.array(providerIdSchema).nullable().optional(),
  writable: z.array(providerIdSchema).nullable().optional(),
}).strict();

export interface SubagentConfigPatch {
  enabled?: boolean;
  providers?: Array<{
    id: LocalAgentProvider;
    enabled?: boolean;
    model?: string | null;
    effort?: string | null;
  }>;
  routing?: {
    default?: LocalAgentProvider[] | null;
    readOnly?: LocalAgentProvider[] | null;
    writable?: LocalAgentProvider[] | null;
  } | null;
}

export class PersonalSubagentConfig {
  constructor(
    private readonly runtimeEnv: NodeJS.ProcessEnv,
    private readonly resolveCurrent: () => SubagentsConfig,
  ) {}

  register(server: McpServer): void {
    server.registerTool(
      "get_subagent_config",
      {
        title: "Get DevSpace subagent config",
        description:
          "Read effective runtime subagent configuration, routing priority, and provider write-mode capabilities.",
        inputSchema: {},
        outputSchema: { result: z.string() },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => resultResponse(this.snapshot()),
    );

    server.registerTool(
      "update_subagent_config",
      {
        title: "Update DevSpace subagent config",
        description:
          "Patch provider enabled/model/effort settings and default/read-only/writable routing priority. Changes affect subsequent agent starts and newly-dispatched long-run tasks without restarting Personal DevSpace.",
        inputSchema: {
          enabled: z.boolean().optional(),
          providers: z.array(providerPatchSchema).max(LOCAL_AGENT_PROVIDERS.length).optional(),
          routing: routePatchSchema.nullable().optional(),
        },
        outputSchema: { result: z.string() },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (patch) => resultResponse(this.update(patch)),
    );
  }

  update(patch: SubagentConfigPatch) {
    const files = loadDevspaceFiles(this.runtimeEnv);
    const stored = resolveSubagentsConfig(files.config.subagents, {});
    const updated = applySubagentConfigPatch(stored, patch);
    writeDevspaceConfig({ ...files.config, subagents: updated }, this.runtimeEnv);
    return this.snapshot();
  }

  snapshot() {
    return {
      config: this.resolveCurrent(),
      capabilities: LOCAL_AGENT_PROVIDERS.map((provider) => ({
        provider,
        writeModes: [...localAgentProviderWriteModes(provider)],
      })),
    };
  }
}

export function applySubagentConfigPatch(
  current: SubagentsConfig,
  patch: SubagentConfigPatch,
): SubagentsConfig {
  const providers = current.providers.map((provider) => ({ ...provider }));
  for (const update of patch.providers ?? []) {
    const index = providers.findIndex((provider) => provider.id === update.id);
    const provider = index === -1
      ? { id: update.id, enabled: update.enabled ?? false }
      : { ...providers[index] };
    if (update.enabled !== undefined) provider.enabled = update.enabled;
    if (update.model === null) delete provider.model;
    else if (update.model !== undefined) provider.model = update.model.trim();
    if (update.effort === null) delete provider.effort;
    else if (update.effort !== undefined) provider.effort = update.effort.trim();
    if (index === -1) providers.push(provider);
    else providers[index] = provider;
  }

  const routing = patch.routing === null
    ? undefined
    : patch.routing === undefined
      ? current.routing
      : patchRouting(current.routing, patch.routing);

  return resolveSubagentsConfig({
    enabled: patch.enabled ?? current.enabled,
    providers,
    ...(routing ? { routing } : {}),
  }, {});
}

function patchRouting(
  current: SubagentRoutingConfig | undefined,
  patch: NonNullable<Exclude<SubagentConfigPatch["routing"], null>>,
): SubagentRoutingConfig | undefined {
  const next: SubagentRoutingConfig = { ...(current ?? {}) };
  for (const key of ["default", "readOnly", "writable"] as const) {
    const value = patch[key];
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = [...value];
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function resultResponse(value: unknown) {
  const result = JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text" as const, text: result }],
    structuredContent: { result },
  };
}
