import assert from "node:assert/strict";
import { BasicMemoryManager, checkpointMarkdown } from "./basic-memory.js";
import { parseBasicMemoryConfig } from "./basic-memory-config.js";
import type { Workspace } from "./workspaces.js";

const persisted = {
  basicMemoryEnabled: true,
  basicMemoryGlobalProject: "gpt",
  basicMemoryAutoProvision: true,
  basicMemoryTimeoutMs: 4321,
};
const parsed = parseBasicMemoryConfig(
  {},
  persisted,
  {
    basicMemoryUrl: "https://memory.example.test/mcp",
    basicMemoryToken: "t".repeat(40),
  },
);
assert.equal(parsed.enabled, true);
assert.equal(parsed.url, "https://memory.example.test/mcp");
assert.equal(parsed.token, "t".repeat(40));
assert.equal(parsed.globalProject, "gpt");
assert.equal(parsed.autoProvision, true);
assert.equal(parsed.timeoutMs, 4321);
assert.equal(parsed.legacyMappingConfigured, false);

const envOverride = parseBasicMemoryConfig(
  {
    DEVSPACE_BASIC_MEMORY: "0",
    DEVSPACE_BASIC_MEMORY_URL: "https://override.example.test/mcp",
    DEVSPACE_BASIC_MEMORY_TOKEN: "e".repeat(40),
    DEVSPACE_BASIC_MEMORY_GLOBAL_PROJECT: "override",
    DEVSPACE_BASIC_MEMORY_AUTO_PROVISION: "off",
    DEVSPACE_BASIC_MEMORY_PROJECT_BASE_PATH: "/srv/memory",
    DEVSPACE_BASIC_MEMORY_TIMEOUT_MS: "1234",
    DEVSPACE_BASIC_MEMORY_ROOT: "C:\\legacy",
    DEVSPACE_BASIC_MEMORY_PROJECT: "legacy",
    DEVSPACE_BASIC_MEMORY_PROJECT_MAP: "C:\\other=other",
  },
  persisted,
  {
    basicMemoryUrl: "https://memory.example.test/mcp",
    basicMemoryToken: "p".repeat(40),
  },
);
assert.equal(envOverride.enabled, false);
assert.equal(envOverride.url, "https://override.example.test/mcp");
assert.equal(envOverride.token, "e".repeat(40));
assert.equal(envOverride.globalProject, "override");
assert.equal(envOverride.autoProvision, false);
assert.equal(envOverride.projectBasePath, "/srv/memory");
assert.equal(envOverride.timeoutMs, 1234);
assert.equal(envOverride.legacyMappingConfigured, true);

assert.throws(
  () => parseBasicMemoryConfig({}, { basicMemoryEnabled: true }),
  /no endpoint is configured/,
);
assert.throws(
  () => parseBasicMemoryConfig(
    {},
    { basicMemoryEnabled: true },
    { basicMemoryUrl: "not-a-url" },
  ),
  /Invalid DEVSPACE_BASIC_MEMORY_URL/,
);
assert.throws(
  () => parseBasicMemoryConfig(
    {},
    { basicMemoryEnabled: true },
    { basicMemoryUrl: "https://memory.example.test/mcp", basicMemoryToken: "short" },
  ),
  /at least 32 characters/,
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
    memoryProject: "zggmono",
    branch: "test3",
    sha: "abc123",
  },
);
assert.match(markdown, /## Confirmed root cause/);
assert.match(markdown, /Historical events bypassed the shared reducer/);
assert.match(markdown, /SSE reconnect hypothesis was disproved/);
assert.match(markdown, /memory project: zggmono/);
assert.match(markdown, /branch: test3/);
assert.match(markdown, /SHA: abc123/);

const manager = new BasicMemoryManager({
  enabled: true,
  url: "https://memory.example.test/mcp",
  token: "t".repeat(40),
  globalProject: "gpt",
  autoProvision: true,
  projectBasePath: "/home/admin/shared-memory",
  timeoutMs: 1000,
  legacyMappingConfigured: false,
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
const gptWorkspace = {
  ...workspace,
  id: "ws-gpt",
  root: process.platform === "win32" ? "C:\\project\\gpt" : "/project/gpt",
  sourceRoot: undefined,
  mode: "checkout",
} satisfies Workspace;
const teamWorkspace = {
  ...workspace,
  id: "ws-team",
  root: process.platform === "win32" ? "C:\\project\\team-devspace" : "/project/team-devspace",
  sourceRoot: undefined,
  mode: "checkout",
} satisfies Workspace;

const projects: Array<Record<string, unknown>> = [
  {
    name: "main",
    external_id: "id-main",
    path: "/home/admin/basic-memory",
    local_path: "/home/admin/basic-memory",
    is_default: true,
  },
  {
    name: "gpt",
    external_id: "id-gpt",
    path: "/home/admin/shared-memory/gpt",
    local_path: "/home/admin/shared-memory/gpt",
    is_default: false,
  },
  {
    name: "zggmono",
    external_id: "id-zggmono",
    path: "/home/admin/shared-memory/zggmono",
    local_path: "/home/admin/shared-memory/zggmono",
    is_default: false,
  },
];
const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
let sessionCount = 0;
const fakeCall = async (name: string, args: Record<string, unknown>) => {
  calls.push({ name, args });
  if (name === "list_memory_projects") {
    return {
      result: JSON.stringify({ projects, default_project: "main", constrained_project: null }),
      isError: false,
    };
  }
  if (name === "search_notes" && args.query === null) {
    return {
      result: JSON.stringify({
        results: args.project_id === "id-zggmono" ? [{ title: "DevSpace Project Identity" }] : [],
        total: args.project_id === "id-zggmono" ? 1 : 0,
      }),
      isError: false,
    };
  }
  if (name === "search_notes") return { result: "prior decision", isError: false };
  if (name === "basic_memory_diagnostics") {
    return { result: "# Basic Memory Diagnostics\n\n## Version\n- basic-memory: 0.23.2\n- API: v2\n", isError: false };
  }
  if (name === "create_memory_project") {
    if (projects.some((project) => project.name === args.project_name)) {
      return { result: "project already exists", isError: true };
    }
    projects.push({
      name: args.project_name,
      external_id: `id-${args.project_name}`,
      path: args.project_path,
      local_path: args.project_path,
      is_default: false,
    });
    return { result: JSON.stringify({ created: true }), isError: false };
  }
  if (name === "list_directory") return { result: JSON.stringify({ nodes: [] }), isError: false };
  if (name === "write_note") return { result: "saved", isError: false };
  throw new Error(`Unexpected tool: ${name}`);
};
Object.defineProperty(manager, "withSession", {
  value: async (run: (call: typeof fakeCall) => Promise<unknown>) => {
    sessionCount += 1;
    return run(fakeCall);
  },
});

calls.length = 0;
sessionCount = 0;
const recall = await manager.recall(workspace, "workflow refresh");
assert.equal(recall.result, "prior decision");
assert.equal(sessionCount, 1);
assert.equal(calls[0]?.name, "list_memory_projects");
assert.equal(calls[1]?.name, "search_notes");
assert.equal(calls[1]?.args.project_id, "id-zggmono");
assert.equal(calls[2]?.name, "search_notes");
assert.equal(calls[2]?.args.project_id, "id-zggmono");

calls.length = 0;
sessionCount = 0;
const gptProjectRecall = await manager.recall(gptWorkspace, "plugin refresh");
assert.equal(gptProjectRecall.isError, false);
assert.match(gptProjectRecall.result, /No shared project memory exists yet for "gpt-[0-9a-f]{12}"/);
assert.equal(calls.some((call) => call.args.project_id === "id-gpt" && call.name === "search_notes"), false);

calls.length = 0;
sessionCount = 0;
const globalRecall = await manager.recallGlobal("WindowsTerminalMCP Playwright recovery");
assert.equal(globalRecall.result, "prior decision");
assert.equal(sessionCount, 1);
assert.equal(calls[0]?.name, "list_memory_projects");
assert.equal(calls[1]?.args.project_id, "id-gpt");

calls.length = 0;
sessionCount = 0;
const missingRecall = await manager.recall(teamWorkspace, "prior decisions");
assert.equal(missingRecall.isError, false);
assert.match(missingRecall.result, /No shared project memory exists yet for "team-devspace-[0-9a-f]{12}"/);
assert.equal(sessionCount, 1);
assert.equal(calls.some((call) => call.name === "create_memory_project"), false);

calls.length = 0;
sessionCount = 0;
const checkpoint = await manager.checkpoint(teamWorkspace, {
  goal: "Finish the macOS adapter",
  rootCause: "The shell app entrypoint was unreliable.",
  decision: "Use one thin AppKit adapter and keep Node as the business owner.",
  verification: "Build and contract tests passed.",
});
assert.equal(checkpoint.result, "saved");
assert.equal(sessionCount, 1);
const create = calls.find((call) => call.name === "create_memory_project");
assert.ok(create);
assert.match(String(create.args.project_name), /^team-devspace-[0-9a-f]{12}$/);
assert.match(String(create.args.project_path), /^\/home\/admin\/shared-memory\/team-devspace-[0-9a-f]{12}$/);
const createdName = String(create.args.project_name);
assert.equal(calls.some((call) => call.name === "list_directory" && call.args.project === createdName), true);
const write = calls.find((call) => call.name === "write_note");
assert.ok(write);
assert.equal(write.args.project, createdName);
assert.match(String(write.args.content), new RegExp(`memory project: ${createdName}`));
const writeMetadata = write.args.metadata as Record<string, unknown>;
assert.equal(writeMetadata.memory_project, createdName);
assert.match(String(writeMetadata.devspace_source_identity), /^(git:|path:)/);

calls.length = 0;
sessionCount = 0;
const globalCheckpoint = await manager.checkpointGlobal({
  goal: "Keep web ChatGPT tooling memory available",
  rootCause: "Workspace-bound memory required an unnecessary local workspace open.",
  decision: "Expose a fixed global memory route alongside workspace memory.",
  verification: "Global recall and checkpoint both target the configured gpt project.",
});
assert.equal(globalCheckpoint.result, "saved");
assert.equal(sessionCount, 1);
assert.equal(calls[0]?.name, "list_memory_projects");
assert.equal(calls[1]?.args.project_id, "id-gpt");

calls.length = 0;
sessionCount = 0;
const status = await manager.status(process.platform === "win32" ? "C:\\project\\new-product" : "/project/new-product");
assert.equal(status.enabled, true);
assert.equal(status.reachable, true);
assert.equal(status.version, "0.23.2");
assert.equal(status.projectCount, projects.length);
assert.equal(status.projectBase, "configured");
assert.equal(status.authentication, "bearer");
assert.match(status.workspaceProject?.name ?? "", /^new-product-[0-9a-f]{12}$/);
assert.equal(status.workspaceProject?.exists, false);
assert.equal(status.workspaceProject?.willAutoProvision, true);
assert.equal(sessionCount, 1);

calls.length = 0;
sessionCount = 0;
const statusWithoutWorkspace = await manager.status();
assert.equal(statusWithoutWorkspace.workspaceProject, undefined);
assert.equal(statusWithoutWorkspace.projectBase, "configured");
assert.equal(sessionCount, 1);

const sameNameA = await manager.status(process.platform === "win32" ? "C:\\project\\client-a\\api" : "/project/client-a/api");
const sameNameB = await manager.status(process.platform === "win32" ? "C:\\project\\client-b\\api" : "/project/client-b/api");
assert.match(sameNameA.workspaceProject?.name ?? "", /^api-[0-9a-f]{12}$/);
assert.match(sameNameB.workspaceProject?.name ?? "", /^api-[0-9a-f]{12}$/);
assert.notEqual(sameNameA.workspaceProject?.name, sameNameB.workspaceProject?.name);

const concurrentProjects: Array<Record<string, unknown>> = [
  {
    name: "gpt",
    external_id: "id-gpt",
    path: "/home/admin/shared-memory/gpt",
    local_path: "/home/admin/shared-memory/gpt",
    is_default: false,
  },
];
let initialLists = 0;
let releaseInitialLists!: () => void;
const bothInitialLists = new Promise<void>((resolve) => { releaseInitialLists = resolve; });
const concurrentCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
const concurrentCall = async (name: string, args: Record<string, unknown>) => {
  concurrentCalls.push({ name, args });
  if (name === "list_memory_projects") {
    const snapshot = concurrentProjects.map((project) => ({ ...project }));
    initialLists += 1;
    if (initialLists === 2) releaseInitialLists();
    if (initialLists <= 2) await bothInitialLists;
    return { result: JSON.stringify({ projects: snapshot, default_project: null }), isError: false };
  }
  if (name === "create_memory_project") {
    if (concurrentProjects.some((project) => project.name === args.project_name)) {
      return { result: "project already exists", isError: true };
    }
    concurrentProjects.push({
      name: args.project_name,
      external_id: `id-${args.project_name}`,
      path: args.project_path,
      local_path: args.project_path,
      is_default: false,
    });
    return { result: "created", isError: false };
  }
  if (name === "list_directory") {
    const exists = concurrentProjects.some((project) => project.name === args.project);
    return { result: JSON.stringify({ nodes: [] }), isError: !exists };
  }
  if (name === "write_note") return { result: "saved", isError: false };
  if (name === "search_notes") return { result: JSON.stringify({ results: [], total: 0 }), isError: false };
  throw new Error(`Unexpected concurrent tool: ${name}`);
};
const concurrentManager = new BasicMemoryManager({
  enabled: true,
  url: "https://memory.example.test/mcp",
  globalProject: "gpt",
  autoProvision: true,
  projectBasePath: "/home/admin/shared-memory",
  timeoutMs: 1000,
  legacyMappingConfigured: false,
});
Object.defineProperty(concurrentManager, "withSession", {
  value: async (run: (call: typeof concurrentCall) => Promise<unknown>) => run(concurrentCall),
});
const concurrentWorkspace = {
  ...teamWorkspace,
  id: "ws-concurrent",
  root: process.platform === "win32" ? "C:\\project\\concurrent-project" : "/project/concurrent-project",
} satisfies Workspace;
await Promise.all([
  concurrentManager.checkpoint(concurrentWorkspace, {
    goal: "Concurrent handoff A",
    rootCause: "Concurrent project creation needs to be idempotent.",
    decision: "Verify the project after create and accept an already-existing race.",
    verification: "First concurrent checkpoint completed.",
  }),
  concurrentManager.checkpoint(concurrentWorkspace, {
    goal: "Concurrent handoff B",
    rootCause: "Concurrent project creation needs to be idempotent.",
    decision: "Verify the project after create and accept an already-existing race.",
    verification: "Second concurrent checkpoint completed.",
  }),
]);
const createAttempts = concurrentCalls.filter((call) => call.name === "create_memory_project");
assert.equal(createAttempts.length, 2);
assert.equal(new Set(createAttempts.map((call) => call.args.project_name)).size, 1);
assert.equal(concurrentProjects.filter((project) => project.name === createAttempts[0]?.args.project_name).length, 1);
assert.equal(concurrentCalls.filter((call) => call.name === "write_note").length, 2);

console.log("basic memory tests passed");
