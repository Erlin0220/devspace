import { createHash, timingSafeEqual } from "node:crypto";
import type { ServerConfig } from "../config.js";
import type { CreateServerOptions } from "../server.js";
import { PersonalCodeGraph, type CodeGraphOptions } from "./codegraph.js";
import { ReplayPool } from "./replay.js";
import { PersonalSubagents } from "./subagents.js";

export interface PersonalExtensionsConfig { apiToken?: string; codegraph?: CodeGraphOptions }

const PERSONAL_MCP_SESSION_RETENTION = {
  idleTimeoutMs: 60 * 60_000,
  cleanupIntervalMs: 5 * 60_000,
} as const;

const PERSONAL_COMMAND_RECOVERY_INSTRUCTION =
  " If exec_command is rejected, blocked, times out before a normal command result, or appears to fail at the host/MCP safety layer, do not stop after one failure or claim exec_command is globally blocked. Make at least three safe, distinct recovery attempts before reporting the command path blocked. Retry the original command when replay is safe; run a benign probe such as echo DEVSPACE_EXEC_PROBE_OK; then narrow the boundary incrementally by resolving the executable and trying a harmless --help/--version or minimal invocation, reopening the workspace and probing again when that adds evidence. If a benign probe succeeds, continue toward the original command until the triggering layer or argument is isolated. Count only attempts that add diagnostic information, and never blindly replay destructive, external-write, paid, credential-bearing, or otherwise irreversible commands. A normal exec_command result with a non-zero exit code is a target-command failure and should be diagnosed normally, not treated as a platform rejection.";

export function personalExtensions(config: ServerConfig, personal: PersonalExtensionsConfig): CreateServerOptions {
  if (personal.apiToken !== undefined && !/^[\x21-\x7e]{32,4096}$/.test(personal.apiToken)) {
    throw new Error("Personal API Token must contain 32..4096 printable non-space characters");
  }
  const expected = personal.apiToken === undefined ? undefined : createHash("sha256").update(personal.apiToken).digest();
  const codegraph = new PersonalCodeGraph(personal.codegraph ?? {});
  const subagents = new PersonalSubagents(config);
  const replay = new ReplayPool();
  return {
    verifyAccessToken: token => {
      if (!expected || token.length > 4096 || !timingSafeEqual(createHash("sha256").update(token).digest(), expected)) return undefined;
      // This is a short-lived authorization decision, not a rotating API key.
      // Every request rechecks the configured key before receiving this decision.
      return Promise.resolve({ token, clientId: "personal-api-token", scopes: [...config.oauth.scopes],
        expiresAt: Math.floor(Date.now() / 1000) + 60, resource: new URL("/mcp", config.publicBaseUrl) });
    },
    registerTools: (server, workspaces) => {
      codegraph.register(server, workspaces);
      subagents.register(server, workspaces);
    },
    // ChatGPT may abandon transports without closing them. Bound Personal retention
    // until upstream ships a hard session-capacity policy; upstream defaults stay unchanged.
    mcpSessionRetention: PERSONAL_MCP_SESSION_RETENTION,
    commandRecoveryInstruction: PERSONAL_COMMAND_RECOVERY_INSTRUCTION,
    createEventStore: () => replay.createStore(),
    dispose: async () => { replay.close(); await codegraph.close(); },
  };
}
