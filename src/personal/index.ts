import { createHash, timingSafeEqual } from "node:crypto";
import type { ServerConfig } from "../config.js";
import type { CreateServerOptions } from "../server.js";
import { PersonalCodeGraph, type CodeGraphOptions } from "./codegraph.js";
import { ReplayPool } from "./replay.js";

export interface PersonalExtensionsConfig { apiToken?: string; codegraph?: CodeGraphOptions }

export function personalExtensions(config: ServerConfig, personal: PersonalExtensionsConfig): CreateServerOptions {
  if (personal.apiToken !== undefined && !/^[\x21-\x7e]{32,4096}$/.test(personal.apiToken)) {
    throw new Error("Personal API Token must contain 32..4096 printable non-space characters");
  }
  const expected = personal.apiToken === undefined ? undefined : createHash("sha256").update(personal.apiToken).digest();
  const codegraph = new PersonalCodeGraph(personal.codegraph ?? {});
  const replay = new ReplayPool();
  return {
    verifyAccessToken: token => {
      if (!expected || token.length > 4096 || !timingSafeEqual(createHash("sha256").update(token).digest(), expected)) return undefined;
      // This is a short-lived authorization decision, not a rotating API key.
      // Every request rechecks the configured key before receiving this decision.
      return Promise.resolve({ token, clientId: "personal-api-token", scopes: [...config.oauth.scopes],
        expiresAt: Math.floor(Date.now() / 1000) + 60, resource: new URL("/mcp", config.publicBaseUrl) });
    },
    registerTools: (server, workspaces) => codegraph.register(server, workspaces),
    createEventStore: () => replay.createStore(),
    dispose: async () => { replay.close(); await codegraph.close(); },
  };
}
