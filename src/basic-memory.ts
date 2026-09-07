import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { BasicMemoryConfig } from "./basic-memory-config.js";
import type { Workspace } from "./workspaces.js";

const execFileAsync = promisify(execFile);

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

interface BasicMemoryDirectoryNode {
  type?: string;
  note_type?: string;
  title?: string;
  permalink?: string;
}

interface BasicMemoryDirectoryResult {
  nodes?: BasicMemoryDirectoryNode[];
}

interface BasicMemoryNoteResult {
  title?: string;
  content?: string;
}

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
  metadata: { branch?: string; sha?: string; workspaceRoot: string; sourceRoot?: string },
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
    `- workspace: ${metadata.workspaceRoot}`,
    ...(metadata.sourceRoot ? [`- source root: ${metadata.sourceRoot}`] : []),
    ...(metadata.branch ? [`- branch: ${metadata.branch}`] : []),
    ...(metadata.sha ? [`- SHA: ${metadata.sha}`] : []),
  ].join("\n");
}

async function gitValue(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true });
    const value = stdout.trim();
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

  supports(workspace: Workspace): boolean {
    return this.routeFor(workspace) !== undefined;
  }

  async recall(workspace: Workspace, query: string): Promise<BasicMemoryToolResult> {
    const route = this.assertSupported(workspace);
    return this.callTool("search_notes", {
      query,
      page_size: 5,
      output_format: "text",
      ...(route.project ? { project: route.project } : {}),
    });
  }

  async bootstrapContext(workspace: Workspace): Promise<string | undefined> {
    const route = this.routeFor(workspace);
    if (!route) return undefined;
    try {
      const listing = await this.callTool("list_directory", {
        dir_name: "checkpoints",
        depth: 1,
        sort: "updated_desc",
        page_size: 10,
        output_format: "json",
        ...(route.project ? { project: route.project } : {}),
      });
      if (listing.isError) return undefined;

      const directory = parseJsonResult<BasicMemoryDirectoryResult>(listing.result);
      const checkpoints =
        directory?.nodes
          ?.filter(
            (node) =>
              node.type === "file" &&
              node.note_type === "checkpoint" &&
              typeof node.permalink === "string" &&
              node.permalink.length > 0,
          )
          .slice(0, 3) ?? [];
      if (checkpoints.length === 0) return undefined;

      const notes = await Promise.all(
        checkpoints.map((checkpoint) =>
          this.callTool("read_note", {
            identifier: checkpoint.permalink,
            output_format: "json",
            include_frontmatter: false,
            ...(route.project ? { project: route.project } : {}),
          }),
        ),
      );
      const sections = notes.flatMap((response, index) => {
        if (response.isError) return [];
        const note = parseJsonResult<BasicMemoryNoteResult>(response.result);
        const content = note?.content?.trim();
        if (!content) return [];
        const title = note?.title?.trim() || checkpoints[index]?.title?.trim() || "Checkpoint";
        return [`## ${title}\n\n${content}`];
      });
      return sections.length > 0 ? `# Recent project checkpoints\n\n${sections.join("\n\n---\n\n")}` : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Shared project memory unavailable: ${message}`;
    }
  }

  async checkpoint(
    workspace: Workspace,
    input: ProjectMemoryCheckpointInput,
  ): Promise<BasicMemoryToolResult> {
    const route = this.assertSupported(workspace);
    const projectRoot = workspace.sourceRoot ?? workspace.root;
    const [branch, sha] = await Promise.all([
      gitValue(["branch", "--show-current"], workspace.root),
      gitValue(["rev-parse", "HEAD"], workspace.root),
    ]);
    const content = checkpointMarkdown(input, {
      branch,
      sha,
      workspaceRoot: workspace.root,
      ...(workspace.sourceRoot ? { sourceRoot: workspace.sourceRoot } : {}),
    });

    return this.callTool("write_note", {
      title: checkpointTitle(input.goal),
      content,
      directory: "checkpoints",
      tags: ["checkpoint", "devspace"],
      note_type: "checkpoint",
      metadata: {
        devspace_workspace_root: workspace.root,
        project_root: projectRoot,
        ...(branch ? { git_branch: branch } : {}),
        ...(sha ? { git_sha: sha } : {}),
      },
      overwrite: false,
      ...(route.project ? { project: route.project } : {}),
    });
  }

  async close(): Promise<void> {
    // Requests intentionally use short-lived MCP sessions, so there is no long-lived transport to close.
  }

  private routeFor(workspace: Workspace): { project?: string } | undefined {
    if (!this.config.enabled) return undefined;
    const projectRoot = normalizePath(workspace.sourceRoot ?? workspace.root);
    if (this.config.root && projectRoot === normalizePath(this.config.root)) {
      return { project: this.config.project };
    }
    const mapping = this.config.projectMappings.find((entry) => projectRoot === normalizePath(entry.root));
    return mapping ? { project: mapping.project } : undefined;
  }

  private assertSupported(workspace: Workspace): { project?: string } {
    if (!this.config.enabled) {
      throw new Error("Basic Memory integration is disabled.");
    }
    const route = this.routeFor(workspace);
    if (!route) {
      throw new Error(`Basic Memory is not configured for workspace: ${workspace.root}`);
    }
    return route;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<BasicMemoryToolResult> {
    if (!this.config.url) throw new Error("Basic Memory URL is not configured.");

    const client = new Client({ name: "devspace-basic-memory", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(this.config.url));
    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Basic Memory connection timed out after ${this.config.timeoutMs}ms.`)),
            this.config.timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
      const response = await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: this.config.timeoutMs },
      );
      return {
        result: resultText(response.content),
        isError: response.isError === true,
      };
    } finally {
      if (transport.sessionId) {
        await transport.terminateSession().catch(() => undefined);
      }
      await client.close().catch(() => undefined);
    }
  }
}
