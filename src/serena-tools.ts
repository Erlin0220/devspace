import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import type { SerenaManager } from "./serena.js";
import type { WorkspaceRegistry } from "./workspaces.js";

interface SerenaToolLog {
  tool: string;
  workspaceId?: string;
  path?: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

interface SerenaToolRegistrationOptions {
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  serena: SerenaManager;
  logToolCall(fields: SerenaToolLog): void;
  toolMeta(kind: "search" | "edit"): { _meta: Record<string, unknown> };
}

const workspaceIdSchema = z.string().describe("Workspace identifier returned by open_workspace.");
const relativePathSchema = z.string().describe("Path relative to the opened workspace root.");
const maxAnswerCharsSchema = z.number().int().optional().describe("Maximum result length. Omit to use Serena's configured default.");

export function registerSerenaTools(
  server: McpServer,
  options: SerenaToolRegistrationOptions,
): void {
  if (!options.config.serena.enabled) return;

  const register = (
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema: z.ZodRawShape;
      serenaTool: string;
      kind: "search" | "edit";
      pathFromInput?: (input: Record<string, unknown>) => string | undefined;
      mapArguments: (input: Record<string, unknown>) => Record<string, unknown>;
    },
  ) => {
    registerAppTool(
      server,
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.inputSchema,
        outputSchema: { result: z.string() },
        ...options.toolMeta(config.kind),
        annotations: config.kind === "search"
          ? { readOnlyHint: true, openWorldHint: false }
          : {
              readOnlyHint: false,
              destructiveHint: true,
              idempotentHint: false,
              openWorldHint: false,
            },
      },
      async (input: Record<string, unknown>) => {
        const startedAt = performance.now();
        const workspaceId = String(input.workspaceId);
        const workspace = options.workspaces.getWorkspace(workspaceId);
        try {
          const response = await options.serena.callTool(
            workspace,
            config.serenaTool,
            config.mapArguments(input),
          );
          options.logToolCall({
            tool: name,
            workspaceId,
            path: config.pathFromInput?.(input),
            success: !response.isError,
            durationMs: Math.round(performance.now() - startedAt),
            error: response.isError ? response.result : undefined,
          });
          return {
            content: [{ type: "text" as const, text: response.result }],
            isError: response.isError || undefined,
            _meta: {
              tool: config.kind === "search" ? "grep" : "edit",
              card: {
                workspaceId,
                path: config.pathFromInput?.(input),
                payload: { content: [{ type: "text" as const, text: response.result }] },
              },
            },
            structuredContent: { result: response.result },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          options.logToolCall({
            tool: name,
            workspaceId,
            path: config.pathFromInput?.(input),
            success: false,
            durationMs: Math.round(performance.now() - startedAt),
            error: message,
          });
          return {
            content: [{ type: "text" as const, text: message }],
            isError: true,
            structuredContent: { result: message },
          };
        }
      },
    );
  };

  register("serena_symbols_overview", {
    title: "Serena symbols overview",
    description:
      "Get an IDE/LSP-backed overview of symbols in a source file. Prefer this before reading an unfamiliar code file in full.",
    inputSchema: {
      workspaceId: workspaceIdSchema,
      relativePath: relativePathSchema,
      depth: z.number().int().optional(),
      maxAnswerChars: maxAnswerCharsSchema,
    },
    serenaTool: "get_symbols_overview",
    kind: "search",
    pathFromInput: (input) => String(input.relativePath),
    mapArguments: (input) => ({
      relative_path: input.relativePath,
      ...(input.depth === undefined ? {} : { depth: input.depth }),
      ...(input.maxAnswerChars === undefined ? {} : { max_answer_chars: input.maxAnswerChars }),
    }),
  });

  register("serena_find_symbol", {
    title: "Serena find symbol",
    description:
      "Find classes, functions, methods, types, variables, and other code symbols by semantic name path. Use includeBody only when the implementation is needed.",
    inputSchema: {
      workspaceId: workspaceIdSchema,
      namePathPattern: z.string(),
      relativePath: z.string().optional(),
      depth: z.number().int().optional(),
      includeBody: z.boolean().optional(),
      includeInfo: z.boolean().optional(),
      substringMatching: z.boolean().optional(),
      maxMatches: z.number().int().optional(),
      maxAnswerChars: maxAnswerCharsSchema,
    },
    serenaTool: "find_symbol",
    kind: "search",
    pathFromInput: (input) => input.relativePath ? String(input.relativePath) : undefined,
    mapArguments: (input) => ({
      name_path_pattern: input.namePathPattern,
      ...(input.relativePath === undefined ? {} : { relative_path: input.relativePath }),
      ...(input.depth === undefined ? {} : { depth: input.depth }),
      ...(input.includeBody === undefined ? {} : { include_body: input.includeBody }),
      ...(input.includeInfo === undefined ? {} : { include_info: input.includeInfo }),
      ...(input.substringMatching === undefined ? {} : { substring_matching: input.substringMatching }),
      ...(input.maxMatches === undefined ? {} : { max_matches: input.maxMatches }),
      ...(input.maxAnswerChars === undefined ? {} : { max_answer_chars: input.maxAnswerChars }),
    }),
  });

  register("serena_find_references", {
    title: "Serena find references",
    description:
      "Find semantic references to a symbol across the current workspace, including a short code snippet around each reference.",
    inputSchema: {
      workspaceId: workspaceIdSchema,
      namePath: z.string(),
      relativePath: relativePathSchema,
      maxAnswerChars: maxAnswerCharsSchema,
    },
    serenaTool: "find_referencing_symbols",
    kind: "search",
    pathFromInput: (input) => String(input.relativePath),
    mapArguments: (input) => ({
      name_path: input.namePath,
      relative_path: input.relativePath,
      ...(input.maxAnswerChars === undefined ? {} : { max_answer_chars: input.maxAnswerChars }),
    }),
  });

  register("serena_find_implementations", {
    title: "Serena find implementations",
    description: "Find semantic implementations of an interface, method, class, or other symbol.",
    inputSchema: {
      workspaceId: workspaceIdSchema,
      namePath: z.string(),
      relativePath: relativePathSchema,
      includeInfo: z.boolean().optional(),
      maxAnswerChars: maxAnswerCharsSchema,
    },
    serenaTool: "find_implementations",
    kind: "search",
    pathFromInput: (input) => String(input.relativePath),
    mapArguments: (input) => ({
      name_path: input.namePath,
      relative_path: input.relativePath,
      ...(input.includeInfo === undefined ? {} : { include_info: input.includeInfo }),
      ...(input.maxAnswerChars === undefined ? {} : { max_answer_chars: input.maxAnswerChars }),
    }),
  });

  register("serena_find_declaration", {
    title: "Serena find declaration",
    description:
      "Resolve the declaration of the symbol captured by one regex group in a source file. Include enough surrounding code in the regex to make the match unambiguous.",
    inputSchema: {
      workspaceId: workspaceIdSchema,
      relativePath: relativePathSchema,
      regex: z.string(),
      containingSymbolNamePath: z.string().nullable().optional(),
      includeBody: z.boolean().optional(),
      includeInfo: z.boolean().optional(),
    },
    serenaTool: "find_declaration",
    kind: "search",
    pathFromInput: (input) => String(input.relativePath),
    mapArguments: (input) => ({
      relative_path: input.relativePath,
      regex: input.regex,
      ...(input.containingSymbolNamePath === undefined
        ? {}
        : { containing_symbol_name_path: input.containingSymbolNamePath }),
      ...(input.includeBody === undefined ? {} : { include_body: input.includeBody }),
      ...(input.includeInfo === undefined ? {} : { include_info: input.includeInfo }),
    }),
  });

  register("serena_diagnostics", {
    title: "Serena diagnostics",
    description:
      "Get LSP diagnostics for one source file, grouped by severity and symbol. Severity uses 1=error, 2=warning, 3=information, 4=hint.",
    inputSchema: {
      workspaceId: workspaceIdSchema,
      relativePath: relativePathSchema,
      startLine: z.number().int().nonnegative().optional(),
      endLine: z.number().int().optional(),
      minSeverity: z.number().int().min(1).max(4).optional(),
      maxAnswerChars: maxAnswerCharsSchema,
    },
    serenaTool: "get_diagnostics_for_file",
    kind: "search",
    pathFromInput: (input) => String(input.relativePath),
    mapArguments: (input) => ({
      relative_path: input.relativePath,
      ...(input.startLine === undefined ? {} : { start_line: input.startLine }),
      ...(input.endLine === undefined ? {} : { end_line: input.endLine }),
      ...(input.minSeverity === undefined ? {} : { min_severity: input.minSeverity }),
      ...(input.maxAnswerChars === undefined ? {} : { max_answer_chars: input.maxAnswerChars }),
    }),
  });

  register("serena_rename_symbol", {
    title: "Serena rename symbol",
    description:
      "Rename a symbol semantically throughout the current workspace. Prefer this over text replacement for cross-file code renames.",
    inputSchema: {
      workspaceId: workspaceIdSchema,
      namePath: z.string(),
      relativePath: relativePathSchema,
      newName: z.string(),
    },
    serenaTool: "rename_symbol",
    kind: "edit",
    pathFromInput: (input) => String(input.relativePath),
    mapArguments: (input) => ({
      name_path: input.namePath,
      relative_path: input.relativePath,
      new_name: input.newName,
    }),
  });

  register("serena_replace_symbol_body", {
    title: "Serena replace symbol body",
    description:
      "Replace a complete class, function, or method definition. Retrieve the current symbol with includeBody=true before using this tool.",
    inputSchema: {
      workspaceId: workspaceIdSchema,
      namePath: z.string(),
      relativePath: relativePathSchema,
      body: z.string(),
    },
    serenaTool: "replace_symbol_body",
    kind: "edit",
    pathFromInput: (input) => String(input.relativePath),
    mapArguments: (input) => ({
      name_path: input.namePath,
      relative_path: input.relativePath,
      body: input.body,
    }),
  });

  for (const insertion of [
    {
      name: "serena_insert_before_symbol",
      title: "Serena insert before symbol",
      serenaTool: "insert_before_symbol",
      description: "Insert a complete declaration or import immediately before a known symbol.",
    },
    {
      name: "serena_insert_after_symbol",
      title: "Serena insert after symbol",
      serenaTool: "insert_after_symbol",
      description: "Insert a complete declaration immediately after a known class, function, or method.",
    },
  ]) {
    register(insertion.name, {
      title: insertion.title,
      description: insertion.description,
      inputSchema: {
        workspaceId: workspaceIdSchema,
        namePath: z.string(),
        relativePath: relativePathSchema,
        body: z.string(),
      },
      serenaTool: insertion.serenaTool,
      kind: "edit",
      pathFromInput: (input) => String(input.relativePath),
      mapArguments: (input) => ({
        name_path: input.namePath,
        relative_path: input.relativePath,
        body: input.body,
      }),
    });
  }

  register("serena_safe_delete_symbol", {
    title: "Serena safe delete symbol",
    description:
      "Delete a symbol only when Serena finds no references to it; otherwise return the references and leave the code unchanged.",
    inputSchema: {
      workspaceId: workspaceIdSchema,
      namePathPattern: z.string(),
      relativePath: relativePathSchema,
    },
    serenaTool: "safe_delete_symbol",
    kind: "edit",
    pathFromInput: (input) => String(input.relativePath),
    mapArguments: (input) => ({
      name_path_pattern: input.namePathPattern,
      relative_path: input.relativePath,
    }),
  });
}
