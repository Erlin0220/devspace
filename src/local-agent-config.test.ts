import assert from "node:assert/strict";
import {
  isSubagentProviderEnabled,
  resolveSubagentsConfig,
  subagentProviderConfig,
  subagentRoutingTargets,
} from "./local-agent-config.js";
import { LOCAL_AGENT_PROVIDERS } from "./local-agent-profiles.js";

const config = resolveSubagentsConfig({
  enabled: true,
  providers: [
    { id: "codex", enabled: true, model: " gpt-5.4 ", effort: " high " },
    { id: "claude", enabled: false, model: "sonnet" },
  ],
}, {});
assert.deepEqual(config, {
  enabled: true,
  providers: [
    { id: "codex", enabled: true, model: "gpt-5.4", effort: "high" },
    { id: "claude", enabled: false, model: "sonnet" },
  ],
});
assert.equal(isSubagentProviderEnabled(config, "codex"), true);
assert.equal(isSubagentProviderEnabled(config, "claude"), false);
assert.equal(isSubagentProviderEnabled(config, "pi"), false);
assert.equal(subagentProviderConfig(config, "codex")?.model, "gpt-5.4");

assert.equal(resolveSubagentsConfig(config, { DEVSPACE_SUBAGENTS: "0" }).enabled, false);
assert.equal(resolveSubagentsConfig({ ...config, enabled: false }, {
  DEVSPACE_SUBAGENTS: "1",
}).enabled, true);
assert.equal(resolveSubagentsConfig(undefined, {}).providers.length, 0);
assert.equal(resolveSubagentsConfig(true, {}).providers.length, LOCAL_AGENT_PROVIDERS.length);

const routed = resolveSubagentsConfig({
  enabled: true,
  providers: [
    { id: "codex", enabled: true },
    { id: "qoder", enabled: true },
    { id: "agy", enabled: false },
  ],
  routing: {
    default: ["qoder", "codex", "agy"],
    readOnly: ["codex", "qoder"],
  },
}, {});
assert.deepEqual(subagentRoutingTargets(routed, "allowed"), ["qoder", "codex"]);
assert.deepEqual(subagentRoutingTargets(routed, "read_only"), ["codex", "qoder"]);

assert.throws(
  () => resolveSubagentsConfig({
    enabled: true,
    providers: [{ id: "codex", enabled: true }, { id: "codex", enabled: false }],
  }, {}),
  /Duplicate subagent provider: codex/,
);
assert.throws(
  () => resolveSubagentsConfig({
    enabled: true,
    providers: [{ id: "unknown", enabled: true }],
  }, {}),
  /Invalid option/,
);
assert.throws(
  () => resolveSubagentsConfig({
    enabled: true,
    providers: [{ id: "codex", enabled: true, effort: "  " }],
  }, {}),
  /Too small/,
);
assert.throws(
  () => resolveSubagentsConfig({
    enabled: true,
    providers: [{ id: "qoder", enabled: true }],
    routing: { default: ["qoder", "qoder"] },
  }, {}),
  /Duplicate subagent routing target: qoder/,
);
