import assert from "node:assert/strict";
import { parseCodeGraphConfig } from "./codegraph-config.js";

const defaults = parseCodeGraphConfig({}, {});
assert.equal(defaults.enabled, false);
assert.equal(defaults.startupTimeoutMs, 30_000);
assert.equal(defaults.toolTimeoutMs, 120_000);

const fromEnv = parseCodeGraphConfig(
  {
    DEVSPACE_CODEGRAPH: "1",
    DEVSPACE_CODEGRAPH_COMMAND: "custom-codegraph",
    DEVSPACE_CODEGRAPH_STARTUP_TIMEOUT_MS: "12345",
    DEVSPACE_CODEGRAPH_TOOL_TIMEOUT_MS: "54321",
  },
  {},
);
assert.equal(fromEnv.enabled, true);
assert.equal(fromEnv.command, "custom-codegraph");
assert.equal(fromEnv.startupTimeoutMs, 12_345);
assert.equal(fromEnv.toolTimeoutMs, 54_321);

const fromFile = parseCodeGraphConfig({}, {
  codegraphEnabled: true,
  codegraphCommand: "persisted-codegraph",
  codegraphArgs: ["serve", "--mcp"],
  codegraphStartupTimeoutMs: 12_345,
  codegraphToolTimeoutMs: 54_321,
});
assert.equal(fromFile.enabled, true);
assert.equal(fromFile.command, "persisted-codegraph");
assert.deepEqual(fromFile.args, ["serve", "--mcp"]);
assert.equal(fromFile.startupTimeoutMs, 12_345);
assert.equal(fromFile.toolTimeoutMs, 54_321);

assert.throws(
  () => parseCodeGraphConfig({ DEVSPACE_CODEGRAPH_TOOL_TIMEOUT_MS: "0" }, {}),
  /Invalid DEVSPACE_CODEGRAPH_TOOL_TIMEOUT_MS: 0/,
);

console.log("codegraph config tests passed");
