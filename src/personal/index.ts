import { createHash, timingSafeEqual } from "node:crypto";
import type { ServerConfig } from "../config.js";
import type { CreateServerOptions } from "../server.js";
import { PersonalCodeGraph, type CodeGraphOptions } from "./codegraph.js";
import { ReplayPool } from "./replay.js";
import { PersonalSubagents } from "./subagents.js";
import { PersonalSubagentConfig } from "./subagent-config.js";
import { PersonalLongruns } from "./longrun.js";
import type { SubagentsConfig } from "../local-agent-config.js";

export interface PersonalExtensionsConfig {
  apiToken?: string;
  codegraph?: CodeGraphOptions;
  stateHome?: string;
  runtimeEnv?: NodeJS.ProcessEnv;
  resolveSubagentsConfig?: () => SubagentsConfig;
}

const PERSONAL_MCP_SESSION_RETENTION = {
  idleTimeoutMs: 60 * 60_000,
  cleanupIntervalMs: 5 * 60_000,
} as const;

const PERSONAL_COMMAND_RECOVERY_INSTRUCTION =
  "If exec_command is blocked before a normal result, make one safe diagnostic attempt. If still blocked and open_workspace advertises a usable local subagent, use run_agent for the same legitimate objective. Never use recovery to bypass policy, authorization, approval, payment, credentials, or destructive-action boundaries. For diagnosis, prefer a safe replay or benign probe such as echo DEVSPACE_EXEC_PROBE_OK. After run_agent returns an agent id, reuse it with get_agent/continue_agent; start another for that objective only after terminal failure. A normal non-zero exec_command result is a command failure, not a blocked execution path. ";

export function personalExtensions(config: ServerConfig, personal: PersonalExtensionsConfig): CreateServerOptions {
  if (personal.apiToken !== undefined && !/^[\x21-\x7e]{32,4096}$/.test(personal.apiToken)) {
    throw new Error("Personal API Token must contain 32..4096 printable non-space characters");
  }
  const expected = personal.apiToken === undefined ? undefined : createHash("sha256").update(personal.apiToken).digest();
  const codegraph = new PersonalCodeGraph(personal.codegraph ?? {});
  const subagents = new PersonalSubagents(config);
  const resolveSubagentsConfig = personal.resolveSubagentsConfig ?? (() => config.subagents);
  const subagentConfig = new PersonalSubagentConfig(
    personal.runtimeEnv ?? process.env,
    resolveSubagentsConfig,
  );
  let longruns: PersonalLongruns | undefined;
  const replay = new ReplayPool();
  return {
    verifyAccessToken: token => {
      if (!expected || token.length > 4096 || !timingSafeEqual(createHash("sha256").update(token).digest(), expected)) return undefined;
      // This is a short-lived authorization decision, not a rotating API key.
      // Every request rechecks the configured key before receiving this decision.
      return Promise.resolve({ token, clientId: "personal-api-token", scopes: [...config.oauth.scopes],
        expiresAt: Math.floor(Date.now() / 1000) + 60, resource: new URL("/mcp", config.publicBaseUrl) });
    },
    registerTools: (server, workspaces, processSessions) => {
      codegraph.register(server, workspaces);
      subagents.register(server, workspaces);
      subagentConfig.register(server);
      longruns ??= new PersonalLongruns(
        config,
        processSessions,
        personal.stateHome ?? config.stateDir,
        undefined,
        resolveSubagentsConfig,
      );
      longruns.register(server, workspaces);
    },
    // ChatGPT may abandon transports without closing them. Bound Personal retention
    // until upstream ships a hard session-capacity policy; upstream defaults stay unchanged.
    mcpSessionRetention: PERSONAL_MCP_SESSION_RETENTION,
    commandRecoveryInstruction: PERSONAL_COMMAND_RECOVERY_INSTRUCTION,
    createEventStore: () => replay.createStore(),
    dispose: async () => {
      replay.close();
      await longruns?.close();
      await codegraph.close();
    },
  };
}
