import assert from "node:assert/strict";
import { buildCodeGraphInitArgs, needsCodeGraphInitialization } from "./codegraph.js";

assert.deepEqual(buildCodeGraphInitArgs(["serve", "--mcp"], "/repo"), [
  "init",
  "/repo",
  "-i",
]);

assert.deepEqual(
  buildCodeGraphInitArgs(["C:/codegraph/lib/dist/bin/codegraph.js", "serve", "--mcp"], "C:/repo"),
  ["C:/codegraph/lib/dist/bin/codegraph.js", "init", "C:/repo", "-i"],
);

assert.throws(
  () => buildCodeGraphInitArgs(["--mcp"], "/repo"),
  /configured server arguments do not contain the 'serve' command/,
);

assert.equal(
  needsCodeGraphInitialization("CodeGraph not initialized. Run 'codegraph init' first."),
  true,
);
assert.equal(
  needsCodeGraphInitialization("Project /repo isn't indexed. Run codegraph init in that project."),
  true,
);
assert.equal(
  needsCodeGraphInitialization("No CodeGraph project is loaded. Pass projectPath or run codegraph init."),
  true,
);
assert.equal(needsCodeGraphInitialization("Found 4 relevant symbols."), false);

console.log("codegraph tests passed");
