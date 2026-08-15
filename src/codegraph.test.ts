import assert from "node:assert/strict";
import { buildCodeGraphInitArgs, needsCodeGraphInitialization } from "./codegraph.js";

assert.deepEqual(
  buildCodeGraphInitArgs(["serve", "--mcp"], "C:\\project\\demo"),
  ["init", "C:\\project\\demo", "-i"],
);

assert.deepEqual(
  buildCodeGraphInitArgs(
    ["C:\\CodeGraph\\codegraph.js", "serve", "--mcp"],
    "C:\\project\\demo",
  ),
  ["C:\\CodeGraph\\codegraph.js", "init", "C:\\project\\demo", "-i"],
);

assert.throws(
  () => buildCodeGraphInitArgs(["--mcp"], "C:\\project\\demo"),
  /configured server arguments do not contain the 'serve' command/,
);

assert.equal(
  needsCodeGraphInitialization(
    "The project at C:\\project\\demo isn't indexed with codegraph (no .codegraph/ directory found walking up from it), so codegraph cannot query it.",
  ),
  true,
);
assert.equal(
  needsCodeGraphInitialization("CodeGraph not initialized. Run 'codegraph init' first."),
  true,
);
assert.equal(
  needsCodeGraphInitialization(
    "CodeGraph isn't available here — no .codegraph/ index exists in C:\\project\\demo.",
  ),
  true,
);
assert.equal(
  needsCodeGraphInitialization(
    "No CodeGraph project is loaded. Pass projectPath or run codegraph init.",
  ),
  true,
);
assert.equal(
  needsCodeGraphInitialization("Project /repo isn't indexed. Run codegraph init in that project."),
  true,
);
assert.equal(needsCodeGraphInitialization("Found 4 relevant symbols."), false);
assert.equal(
  needsCodeGraphInitialization(
    "src/example.ts\n12\tconst message = \"The project at x isn't indexed with codegraph. Run codegraph init.\";",
  ),
  false,
);

console.log("codegraph tests passed");
