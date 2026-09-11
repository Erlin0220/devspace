# Local extensions

This fork keeps local-only integrations behind `src/local-extensions.ts` so upstream DevSpace files stay close to the official tree.

## CodeGraph

CodeGraph is optional and disabled by default. When enabled, DevSpace exposes the read-only `codegraph_explore` tool. The selected workspace root is supplied automatically. If a workspace has not been indexed yet, DevSpace initializes CodeGraph once and retries the exploration.

Environment variables:

- `DEVSPACE_CODEGRAPH=1`
- `DEVSPACE_CODEGRAPH_COMMAND=<command>`
- `DEVSPACE_CODEGRAPH_STARTUP_TIMEOUT_MS=30000`
- `DEVSPACE_CODEGRAPH_TOOL_TIMEOUT_MS=120000`

Persisted `~/.devspace/config.json` keys are `codegraphEnabled`, `codegraphCommand`, `codegraphArgs`, `codegraphStartupTimeoutMs`, and `codegraphToolTimeoutMs`.

## Basic Memory

Basic Memory remains an edge integration, not a DevSpace-owned memory database. DevSpace exposes only four semantic tools: project/global recall and project/global checkpoint. Basic Memory owns projects, Markdown persistence, indexing, and search.

Project routing starts from `workspace.sourceRoot ?? workspace.root`; managed worktrees therefore share the source checkout's memory. DevSpace uses a normalized Git `origin` as the preferred discovery identity and falls back to the canonical real filesystem path when no origin exists. New projects use `<repo>-<identity-hash>` names, preventing unrelated same-name directories from sharing memory; after resolution, Basic Memory's `project_id` is preferred for calls. Existing plain-name projects are reused only when a one-time `devspace-project-identity` marker proves ownership. The configured global project name is always reserved from workspace routing.

`open_workspace` performs no Basic Memory network call. Full historical context is recalled on demand through `project_memory_recall`, while a missing project is created only by the write-capable `project_memory_checkpoint`. Each recall, checkpoint, or doctor operation owns one short-lived MCP session. The server-side project parent is configured once through `basicMemoryProjectBasePath`; DevSpace does not infer remote storage layout, and adding a new local repository does not require editing a project map or restarting DevSpace.

Stable settings use `~/.devspace/config.json`; the Basic Memory endpoint and optional bearer token are stored in `~/.devspace/auth.json`. The token is sent in the HTTP `Authorization` header and is accepted from stdin or environment configuration rather than ordinary CLI arguments. On Windows, `auth.json` is written with an explicit non-inherited ACL limited to the current user, SYSTEM, and Administrators. Legacy `DEVSPACE_BASIC_MEMORY_ROOT`, `DEVSPACE_BASIC_MEMORY_PROJECT`, and `DEVSPACE_BASIC_MEMORY_PROJECT_MAP` values are ignored by routing and surfaced by `devspace doctor` for cleanup.

## Upgrade rule

Keep new local integrations behind the extension facade instead of importing them directly into `server.ts`. Core upstream files should only contain small generic hooks for extension configuration, tool registration, and lifecycle shutdown.
