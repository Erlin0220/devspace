import assert from "node:assert/strict";
import { codeGraphInitArgs, isCodeGraphNotIndexedResult } from "./codegraph.js";

assert.deepEqual(
  codeGraphInitArgs(["serve", "--mcp"], "C:\\project\\demo"),
  ["init", "C:\\project\\demo"],
);

assert.deepEqual(
  codeGraphInitArgs(
    ["C:\\CodeGraph\\codegraph.js", "serve", "--mcp"],
    "C:\\project\\demo",
  ),
  ["C:\\CodeGraph\\codegraph.js", "init", "C:\\project\\demo"],
);

assert.throws(
  () => codeGraphInitArgs(["--mcp"], "C:\\project\\demo"),
  /configured arguments do not contain the "serve" command/,
);

assert.equal(
  isCodeGraphNotIndexedResult(
    "The project at C:\\project\\demo isn't indexed with codegraph (no .codegraph/ directory found walking up from it), so codegraph cannot query it.",
  ),
  true,
);
assert.equal(
  isCodeGraphNotIndexedResult("CodeGraph not initialized in C:\\project\\demo"),
  true,
);
assert.equal(
  isCodeGraphNotIndexedResult(
    "CodeGraph isn't available here — no .codegraph/ index exists in C:\\project\\demo.",
  ),
  true,
);
assert.equal(
  isCodeGraphNotIndexedResult(
    "src/example.ts\n12\tconst message = \"The project at x isn't indexed with codegraph\";",
  ),
  false,
);

console.log("codegraph tests passed");
