import assert from "node:assert/strict";
import { BasicMemoryManager, checkpointMarkdown } from "./basic-memory.js";
import { parseBasicMemoryConfig } from "./basic-memory-config.js";
import type { Workspace } from "./workspaces.js";

const mappedGptRoot = process.platform === "win32" ? "C:\\project\\gpt" : "/project/gpt";
const parsed = parseBasicMemoryConfig({
  DEVSPACE_BASIC_MEMORY: "1",
  DEVSPACE_BASIC_MEMORY_URL: "https://memory.example.test/mcp",
  DEVSPACE_BASIC_MEMORY_ROOT: "C:\\project\\zggmono",
  DEVSPACE_BASIC_MEMORY_PROJECT: "zggmono",
  DEVSPACE_BASIC_MEMORY_PROJECT_MAP: `${mappedGptRoot}=gpt`,
  DEVSPACE_BASIC_MEMORY_TIMEOUT_MS: "4321",
});
assert.equal(parsed.enabled, true);
assert.equal(parsed.url, "https://memory.example.test/mcp");
assert.equal(parsed.project, "zggmono");
assert.deepEqual(parsed.projectMappings, [{ root: mappedGptRoot, project: "gpt" }]);
assert.equal(parsed.timeoutMs, 4321);

assert.throws(
  () => parseBasicMemoryConfig({ DEVSPACE_BASIC_MEMORY: "1" }),
  /DEVSPACE_BASIC_MEMORY_URL is required/,
);
assert.throws(
  () => parseBasicMemoryConfig({ DEVSPACE_BASIC_MEMORY_PROJECT_MAP: "invalid" }),
  /Invalid DEVSPACE_BASIC_MEMORY_PROJECT_MAP entry/,
);

const markdown = checkpointMarkdown(
  {
    goal: "Fix workflow refresh state",
    rootCause: "Historical events bypassed the shared reducer.",
    decision: "Use the same reducer for live and historical events.",
    verification: "Playwright E2E passed after refresh.",
    rejectedApproaches: ["SSE reconnect hypothesis was disproved."],
    openItems: ["Algorithm contract still needs resolved_artifact_version."],
  },
  {
    workspaceRoot: "C:\\project\\zggmono",
    branch: "test3",
    sha: "abc123",
  },
);
assert.match(markdown, /## Confirmed root cause/);
assert.match(markdown, /Historical events bypassed the shared reducer/);
assert.match(markdown, /SSE reconnect hypothesis was disproved/);
assert.match(markdown, /branch: test3/);
assert.match(markdown, /SHA: abc123/);

const manager = new BasicMemoryManager({
  enabled: true,
  url: "https://memory.example.test/mcp",
  root: process.platform === "win32" ? "C:\\project\\zggmono" : "/project/zggmono",
  project: "zggmono",
  projectMappings: [
    {
      root: process.platform === "win32" ? "C:\\project\\gpt" : "/project/gpt",
      project: "gpt",
    },
  ],
  timeoutMs: 1000,
});
const workspace = {
  id: "ws-test",
  root: process.platform === "win32" ? "C:\\project\\zggmono-worktree" : "/tmp/zggmono-worktree",
  sourceRoot: process.platform === "win32" ? "C:\\project\\zggmono" : "/project/zggmono",
  mode: "worktree",
  skills: [],
  skillDiagnostics: [],
  agentProfiles: [],
  activatedSkillDirs: new Set<string>(),
} satisfies Workspace;
assert.equal(manager.supports(workspace), true);
const gptWorkspace = {
  ...workspace,
  id: "ws-gpt",
  root: process.platform === "win32" ? "C:\\project\\gpt" : "/project/gpt",
  sourceRoot: undefined,
  mode: "checkout",
} satisfies Workspace;
assert.equal(manager.supports(gptWorkspace), true);

const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
Object.defineProperty(manager, "callTool", {
  value: async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "search_notes") {
      return { result: "prior decision", isError: false };
    }
    if (name === "list_directory") {
      return {
        result: JSON.stringify({
          nodes: [
            { type: "file", note_type: "checkpoint", title: "Newest", permalink: "zggmono/checkpoints/newest" },
            { type: "file", note_type: "note", title: "Ignore", permalink: "zggmono/checkpoints/ignore" },
            { type: "file", note_type: "checkpoint", title: "Older", permalink: "zggmono/checkpoints/older" },
          ],
        }),
        isError: false,
      };
    }
    if (name === "read_note") {
      return {
        result: JSON.stringify({ title: String(args.identifier), content: `content for ${args.identifier}` }),
        isError: false,
      };
    }
    throw new Error(`Unexpected tool: ${name}`);
  },
});

const recall = await manager.recall(workspace, "workflow refresh");
assert.equal(recall.result, "prior decision");
assert.equal(calls[0]?.name, "search_notes");
assert.equal(calls[0]?.args.project, "zggmono");
assert.equal("search_type" in (calls[0]?.args ?? {}), false);

const gptRecall = await manager.recall(gptWorkspace, "plugin refresh");
assert.equal(gptRecall.result, "prior decision");
assert.equal(calls[1]?.args.project, "gpt");

calls.length = 0;
const bootstrap = await manager.bootstrapContext(workspace);
assert.match(bootstrap ?? "", /# Recent project checkpoints/);
assert.match(bootstrap ?? "", /content for zggmono\/checkpoints\/newest/);
assert.match(bootstrap ?? "", /content for zggmono\/checkpoints\/older/);
assert.doesNotMatch(bootstrap ?? "", /checkpoints\/ignore/);
assert.equal(calls[0]?.name, "list_directory");
assert.equal(calls[0]?.args.sort, "updated_desc");
assert.equal(calls.filter((call) => call.name === "read_note").length, 2);

console.log("basic memory tests passed");
