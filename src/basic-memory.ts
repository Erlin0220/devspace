import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { BasicMemoryConfig } from "./basic-memory-config.js";
import { git } from "./git.js";
import type { Workspace } from "./workspaces.js";

const SOURCE_IDENTITY_TAG = "devspace-project-identity";

export interface ProjectMemoryCheckpointInput {
  goal: string;
  rootCause: string;
  decision: string;
  verification: string;
  rejectedApproaches?: string[];
  openItems?: string[];
}

export interface BasicMemoryToolResult {
  result: string;
  isError: boolean;
}

export interface BasicMemoryStatus {
  enabled: boolean;
  reachable: boolean;
  endpointOrigin?: string;
  version?: string;
  projectCount?: number;
  globalProject?: string;
  authentication: "bearer" | "none";
  autoProvision: boolean;
  projectBase: "configured" | "unavailable";
  workspaceProject?: {
    name: string;
    exists: boolean;
    willAutoProvision: boolean;
  };
  legacyMappingConfigured: boolean;
}

interface BasicMemoryProjectRecord {
  name: string;
  external_id?: string;
  qualified_name?: string | null;
}

interface BasicMemoryProjectsResult {
  projects: BasicMemoryProjectRecord[];
}

interface WorkspaceProjectCandidate {
  name: string;
  projectRoot: string;
  sourceIdentity: string;
  route?: { name: string; id?: string };
}

interface BasicMemorySearchResult {
  results?: unknown[];
  total?: number;
}

type BasicMemoryCall = (
  name: string,
  args: Record<string, unknown>,
) => Promise<BasicMemoryToolResult>;

function parseJsonResult<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function normalizePath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function projectNameFromRoot(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  const name = trimmed.split(/[\\/]/).pop()?.trim();
  if (!name || name === "." || name === ".." || /[\r\n\x00]/.test(name)) {
    throw new Error(`Cannot derive a Basic Memory project name from workspace root: ${root}`);
  }
  return name;
}

function normalizedRemotePath(value: string): string {
  return value.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
}

function normalizeGitRemote(value: string): string | undefined {
  const remote = value.trim();
  if (!remote) return undefined;

  if (!remote.includes("://") && !/^[a-zA-Z]:[\\/]/.test(remote)) {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(remote);
    if (scp) {
      const path = normalizedRemotePath(scp[2]);
      return path ? `${scp[1].toLowerCase()}/${path}` : undefined;
    }
  }

  try {
    const parsed = new URL(remote);
    if (parsed.protocol === "file:") return `file:${normalizePath(decodeURIComponent(parsed.pathname))}`;
    const path = normalizedRemotePath(parsed.pathname);
    return parsed.host && path ? `${parsed.host.toLowerCase()}/${path}` : undefined;
  } catch {
    return undefined;
  }
}

async function sourceIdentityForRoot(root: string): Promise<{ sourceIdentity: string; stableName: string }> {
  const canonical = await canonicalExistingPath(root);
  const remote = canonical.exists ? await gitOrigin(canonical.path) : undefined;
  const normalizedRemote = remote ? normalizeGitRemote(remote) : undefined;
  if (remote && !normalizedRemote) {
    throw new Error(`Cannot normalize Git origin for Basic Memory project identity: ${remote}`);
  }
  const sourceIdentity = normalizedRemote
    ? `git:${normalizedRemote}`
    : `path:${normalizePath(canonical.path)}`;
  const suffix = createHash("sha256").update(sourceIdentity).digest("hex").slice(0, 12);
  return {
    sourceIdentity,
    stableName: `${projectNameFromRoot(root)}-${suffix}`,
  };
}

async function canonicalExistingPath(root: string): Promise<{ path: string; exists: boolean }> {
  try {
    return { path: await realpath(root), exists: true };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT" || code === "ENOTDIR") return { path: root, exists: false };
    throw error;
  }
}

async function gitOrigin(root: string): Promise<string | undefined> {
  try {
    await git(root, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git repository/i.test(message)) return undefined;
    throw new Error(`Git repository detection failed while resolving Basic Memory identity: ${message}`);
  }

  const remotes = (await git(root, ["remote"])).stdout.split(/\r?\n/).map((value) => value.trim());
  if (!remotes.includes("origin")) return undefined;
  const remote = (await git(root, ["remote", "get-url", "origin"])).stdout.trim();
  if (!remote) throw new Error("Git origin is configured but has no URL.");
  return remote;
}

function remotePathJoin(base: string, child: string): string {
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  const trimmed = base.replace(/[\\/]+$/, "");
  return trimmed ? `${trimmed}${separator}${child}` : `${separator}${child}`;
}

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content ?? null, null, 2);
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return String(item);
      if ("text" in item && typeof item.text === "string") return item.text;
      return JSON.stringify(item, null, 2);
    })
    .join("\n");
}

function resultError(prefix: string, response: BasicMemoryToolResult): Error {
  const detail = response.result.replace(/\s+/g, " ").trim().slice(0, 360);
  return new Error(detail ? `${prefix}: ${detail}` : prefix);
}

function checkpointTitle(goal: string, date = new Date()): string {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  const summary = goal.replace(/\s+/g, " ").trim().slice(0, 72) || "project work";
  return `Checkpoint ${stamp} - ${summary}`;
}

function markdownList(items: string[] | undefined): string {
  if (!items?.length) return "- None";
  return items.map((item) => `- ${item}`).join("\n");
}

export function checkpointMarkdown(
  input: ProjectMemoryCheckpointInput,
  metadata: { branch?: string; sha?: string; workspaceRoot?: string; sourceRoot?: string; memoryProject?: string },
): string {
  return [
    "## Goal",
    input.goal.trim(),
    "",
    "## Confirmed root cause",
    input.rootCause.trim(),
    "",
    "## Decision",
    input.decision.trim(),
    "",
    "## Verification",
    input.verification.trim(),
    "",
    "## Rejected approaches",
    markdownList(input.rejectedApproaches),
    "",
    "## Open items",
    markdownList(input.openItems),
    "",
    "## Evidence",
    ...(metadata.workspaceRoot ? [`- workspace: ${metadata.workspaceRoot}`] : []),
    ...(metadata.sourceRoot ? [`- source root: ${metadata.sourceRoot}`] : []),
    ...(metadata.memoryProject ? [`- memory project: ${metadata.memoryProject}`] : []),
    ...(metadata.branch ? [`- branch: ${metadata.branch}`] : []),
    ...(metadata.sha ? [`- SHA: ${metadata.sha}`] : []),
  ].join("\n");
}

async function gitValue(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const value = (await git(cwd, args)).stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export class BasicMemoryManager {
  constructor(private readonly config: BasicMemoryConfig) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  get globalEnabled(): boolean {
    return this.config.enabled && Boolean(this.config.globalProject);
  }

  get endpointOrigin(): string | undefined {
    if (!this.config.url) return undefined;
    try {
      return new URL(this.config.url).origin;
    } catch {
      return undefined;
    }
  }

  async recall(workspace: Workspace, query: string): Promise<BasicMemoryToolResult> {
    this.assertEnabled();
    return this.withSession(async (call) => {
      const candidate = await this.resolveWorkspaceProject(workspace, call, false);
      if (!candidate.route) {
        return {
          result: `No shared project memory exists yet for "${candidate.name}". A verified project checkpoint will create it automatically.`,
          isError: false,
        };
      }
      return this.search(call, candidate.route, query);
    });
  }

  async recallGlobal(query: string): Promise<BasicMemoryToolResult> {
    const projectName = this.assertGlobalProject();
    return this.withSession(async (call) => {
      const projects = await this.listProjects(call);
      const project = this.uniqueProject(projects, projectName);
      if (!project) throw new Error(`Global Basic Memory project "${projectName}" does not exist.`);
      return this.search(call, {
        name: project.name,
        ...(project.external_id ? { id: project.external_id } : {}),
      }, query);
    });
  }

  async checkpoint(
    workspace: Workspace,
    input: ProjectMemoryCheckpointInput,
  ): Promise<BasicMemoryToolResult> {
    this.assertEnabled();
    const projectRoot = workspace.sourceRoot ?? workspace.root;
    const [branch, sha] = await Promise.all([
      gitValue(["branch", "--show-current"], workspace.root),
      gitValue(["rev-parse", "HEAD"], workspace.root),
    ]);

    return this.withSession(async (call) => {
      const candidate = await this.resolveWorkspaceProject(workspace, call, true);
      if (!candidate.route) {
        throw new Error(`Basic Memory project "${candidate.name}" could not be resolved after provisioning.`);
      }
      const content = checkpointMarkdown(input, {
        branch,
        sha,
        workspaceRoot: workspace.root,
        ...(workspace.sourceRoot ? { sourceRoot: workspace.sourceRoot } : {}),
        memoryProject: candidate.route.name,
      });
      return call("write_note", {
        title: checkpointTitle(input.goal),
        content,
        directory: "checkpoints",
        tags: ["checkpoint", "devspace"],
        note_type: "checkpoint",
        metadata: {
          devspace_workspace_root: workspace.root,
          project_root: projectRoot,
          memory_project: candidate.route.name,
          devspace_source_identity: candidate.sourceIdentity,
          ...(branch ? { git_branch: branch } : {}),
          ...(sha ? { git_sha: sha } : {}),
        },
        overwrite: false,
        ...this.projectTarget(candidate.route),
      });
    });
  }

  async checkpointGlobal(input: ProjectMemoryCheckpointInput): Promise<BasicMemoryToolResult> {
    const projectName = this.assertGlobalProject();
    return this.withSession(async (call) => {
      const projects = await this.listProjects(call);
      const project = this.uniqueProject(projects, projectName);
      if (!project) throw new Error(`Global Basic Memory project "${projectName}" does not exist.`);
      const route = {
        name: project.name,
        ...(project.external_id ? { id: project.external_id } : {}),
      };
      return call("write_note", {
        title: checkpointTitle(input.goal),
        content: checkpointMarkdown(input, { memoryProject: project.name }),
        directory: "checkpoints",
        tags: ["checkpoint", "devspace", "global-memory"],
        note_type: "checkpoint",
        metadata: { memory_project: project.name },
        overwrite: false,
        ...this.projectTarget(route),
      });
    });
  }

  async status(projectRoot?: string): Promise<BasicMemoryStatus> {
    if (!this.config.enabled) {
      return {
        enabled: false,
        reachable: false,
        authentication: this.config.token ? "bearer" : "none",
        autoProvision: this.config.autoProvision,
        projectBase: this.config.projectBasePath ? "configured" : "unavailable",
        legacyMappingConfigured: this.config.legacyMappingConfigured,
      };
    }
    this.assertEnabled();

    return this.withSession(async (call) => {
      const projects = await this.listProjects(call);
      const diagnostics = await call("basic_memory_diagnostics", {});
      const candidate = projectRoot ? await this.workspaceProjectCandidate(projectRoot, projects, call) : undefined;
      const basePath = this.config.projectBasePath;
      const version = diagnostics.isError
        ? undefined
        : /- basic-memory:\s*([^\s]+)/.exec(diagnostics.result)?.[1];
      return {
        enabled: true,
        reachable: true,
        endpointOrigin: this.endpointOrigin,
        version,
        projectCount: projects.projects.length,
        globalProject: this.config.globalProject,
        authentication: this.config.token ? "bearer" : "none",
        autoProvision: this.config.autoProvision,
        projectBase: this.config.projectBasePath ? "configured" : "unavailable",
        ...(candidate ? {
          workspaceProject: {
            name: candidate.name,
            exists: Boolean(candidate.route),
            willAutoProvision: !candidate.route && this.config.autoProvision && Boolean(basePath),
          },
        } : {}),
        legacyMappingConfigured: this.config.legacyMappingConfigured,
      };
    });
  }

  async close(): Promise<void> {
    // Each logical operation owns one short-lived MCP session; there is no persistent transport to close.
  }

  private assertEnabled(): void {
    if (!this.config.enabled) throw new Error("Basic Memory integration is disabled.");
    if (!this.config.url) throw new Error("Basic Memory URL is not configured.");
  }

  private assertGlobalProject(): string {
    this.assertEnabled();
    if (!this.config.globalProject) {
      throw new Error("Global Basic Memory project is not configured.");
    }
    return this.config.globalProject;
  }

  private async resolveWorkspaceProject(
    workspace: Workspace,
    call: BasicMemoryCall,
    allowCreate: boolean,
  ): Promise<WorkspaceProjectCandidate> {
    const projectRoot = workspace.sourceRoot ?? workspace.root;
    const projects = await this.listProjects(call);
    const candidate = await this.workspaceProjectCandidate(projectRoot, projects, call);
    if (candidate.route || !allowCreate) return candidate;
    if (!this.config.autoProvision) {
      throw new Error(
        `Basic Memory project "${candidate.name}" does not exist and automatic project provisioning is disabled.`,
      );
    }

    const basePath = this.config.projectBasePath;
    if (!basePath) {
      throw new Error(
        `Basic Memory project "${candidate.name}" does not exist and basicMemoryProjectBasePath is not configured. ` +
          "Configure the Basic Memory server-side project parent once before enabling automatic provisioning.",
      );
    }
    const projectPath = remotePathJoin(basePath, candidate.name);
    const created = await call("create_memory_project", {
      project_name: candidate.name,
      project_path: projectPath,
      set_default: false,
      output_format: "json",
    });

    const verified = await call("list_directory", {
      dir_name: "/",
      depth: 1,
      page_size: 1,
      output_format: "json",
      project: candidate.name,
    });
    if (verified.isError) {
      if (created.isError) throw resultError(`Basic Memory could not create project "${candidate.name}"`, created);
      throw resultError(`Basic Memory created project "${candidate.name}" but could not verify it`, verified);
    }

    return {
      ...candidate,
      route: { name: candidate.name },
    };
  }

  private async workspaceProjectCandidate(
    projectRoot: string,
    projects: BasicMemoryProjectsResult,
    call: BasicMemoryCall,
  ): Promise<WorkspaceProjectCandidate> {
    const baseName = projectNameFromRoot(projectRoot);
    const identity = await sourceIdentityForRoot(projectRoot);
    const stable = this.uniqueProject(projects, identity.stableName);
    if (stable) {
      return {
        name: stable.name,
        projectRoot,
        sourceIdentity: identity.sourceIdentity,
        route: { name: stable.name, ...(stable.external_id ? { id: stable.external_id } : {}) },
      };
    }

    const legacy = baseName === this.config.globalProject ? undefined : this.uniqueProject(projects, baseName);
    if (legacy && await this.projectClaimsIdentity(legacy, identity.sourceIdentity, call)) {
      return {
        name: legacy.name,
        projectRoot,
        sourceIdentity: identity.sourceIdentity,
        route: { name: legacy.name, ...(legacy.external_id ? { id: legacy.external_id } : {}) },
      };
    }

    return {
      name: identity.stableName,
      projectRoot,
      sourceIdentity: identity.sourceIdentity,
    };
  }

  private async projectClaimsIdentity(
    project: BasicMemoryProjectRecord,
    sourceIdentity: string,
    call: BasicMemoryCall,
  ): Promise<boolean> {
    const response = await call("search_notes", {
      query: null,
      page_size: 1,
      output_format: "json",
      tags: [SOURCE_IDENTITY_TAG],
      metadata_filters: { devspace_source_identity: sourceIdentity },
      ...this.projectTarget({
        name: project.name,
        ...(project.external_id ? { id: project.external_id } : {}),
      }),
    });
    if (response.isError) {
      throw resultError(`Basic Memory identity lookup failed for legacy project "${project.name}"`, response);
    }
    const parsed = parseJsonResult<BasicMemorySearchResult>(response.result);
    return (parsed?.total ?? parsed?.results?.length ?? 0) > 0;
  }

  private uniqueProject(
    projects: BasicMemoryProjectsResult,
    name: string,
  ): BasicMemoryProjectRecord | undefined {
    const matches = projects.projects.filter((project) => project.name === name || project.qualified_name === name);
    if (matches.length > 1) {
      throw new Error(
        `Basic Memory project name "${name}" is ambiguous across workspaces; use a unique project name before using it through DevSpace.`,
      );
    }
    return matches[0];
  }

  private projectTarget(route: { name: string; id?: string }): Record<string, string> {
    return route.id ? { project_id: route.id } : { project: route.name };
  }

  private async search(
    call: BasicMemoryCall,
    route: { name: string; id?: string },
    query: string,
  ): Promise<BasicMemoryToolResult> {
    return call("search_notes", {
      query,
      page_size: 5,
      output_format: "text",
      ...this.projectTarget(route),
    });
  }

  private async listProjects(call: BasicMemoryCall): Promise<BasicMemoryProjectsResult> {
    const response = await call("list_memory_projects", { output_format: "json" });
    if (response.isError) throw resultError("Basic Memory project discovery failed", response);
    const value = parseJsonResult<{ projects?: unknown }>(response.result);
    if (!value || !Array.isArray(value.projects)) {
      throw new Error("Basic Memory returned an invalid project list.");
    }
    const projects = value.projects.flatMap((project) => {
      if (!project || typeof project !== "object" || !("name" in project) || typeof project.name !== "string") {
        return [];
      }
      const record = project as Record<string, unknown>;
      return [{
        name: project.name,
        ...(typeof record.external_id === "string" ? { external_id: record.external_id } : {}),
        ...(typeof record.qualified_name === "string" || record.qualified_name === null
          ? { qualified_name: record.qualified_name as string | null }
          : {}),
      } satisfies BasicMemoryProjectRecord];
    });
    return { projects };
  }

  private async withSession<T>(
    run: (call: BasicMemoryCall) => Promise<T>,
    timeoutMs = this.config.timeoutMs,
  ): Promise<T> {
    this.assertEnabled();
    const client = new Client({ name: "devspace-basic-memory", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(this.config.url!),
      this.config.token
        ? { requestInit: { headers: { authorization: `Bearer ${this.config.token}` } } }
        : undefined,
    );
    let connectTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) => {
          connectTimer = setTimeout(
            () => reject(new Error(`Basic Memory connection timed out after ${timeoutMs}ms.`)),
            timeoutMs,
          );
          connectTimer.unref?.();
        }),
      ]);
      if (connectTimer) clearTimeout(connectTimer);

      const call: BasicMemoryCall = async (name, args) => {
        const response = await client.callTool(
          { name, arguments: args },
          undefined,
          { timeout: timeoutMs },
        );
        return {
          result: resultText(response.content),
          isError: response.isError === true,
        };
      };
      return await run(call);
    } finally {
      if (connectTimer) clearTimeout(connectTimer);
      if (transport.sessionId) {
        await transport.terminateSession().catch(() => undefined);
      }
      await client.close().catch(() => undefined);
    }
  }
}
