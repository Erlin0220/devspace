# Configuration Reference

DevSpace can be configured through `devspace init`, persisted config files, or
environment variables.

The default files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Use another config directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config npx @waishnav/devspace serve
```

## Commands

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
npx @waishnav/devspace doctor
npx @waishnav/devspace config get
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
npx @waishnav/devspace config set basicMemoryEnabled true
npx @waishnav/devspace config set basicMemoryGlobalProject gpt
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `DEVSPACE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `DEVSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `DEVSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `DEVSPACE_API_TOKEN` | Optional static Bearer token for clients that support API-key authentication. Must be at least 32 characters. OAuth remains enabled for existing clients. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `DEVSPACE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.devspace/worktrees`. |
| `DEVSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/devspace`. |

## Native Artifact Download

Native-file download is disabled by default. Enable it when ChatGPT needs to hand
an attached or generated file into an already-open workspace:

```bash
DEVSPACE_ARTIFACTS=1 npx @waishnav/devspace serve
```

This feature currently supports Linux. It is not registered on macOS, Windows,
or BSD because the secure publication path depends on traversable,
descriptor-anchored directory paths provided by Linux procfs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_ARTIFACTS` | `0` | Expose `download_artifact` for trusted native files. |
| `DEVSPACE_ARTIFACT_MAX_FILE_BYTES` | `104857600` | Maximum streamed size of one file (100 MiB). |

The same settings may be persisted in `~/.devspace/config.json` as
`artifactsEnabled` and `artifactMaxFileBytes`.

`download_artifact` accepts the native file object supplied by the MCP connector,
a `workspaceId` returned by `open_workspace`, and a relative workspace `path`.
DevSpace safely creates missing parent directories, refuses to overwrite an
existing destination, and returns only the normalized workspace-relative path.
It does not accept conflict modes, expected hashes, arbitrary URL strings, local
paths, embedded credentials, or extra object fields.

There is no artifact root, total quota, TTL, pinning, persistent database record,
or background artifact cleanup service. See [Native File Download](artifact-exchange.md)
for the supported connector shape and security boundaries.

## OAuth

DevSpace uses a single-user OAuth approval flow by default. Set `DEVSPACE_API_TOKEN` to additionally accept a static Bearer token for trusted clients such as a ChatGPT Business custom app configured with API-key authentication. OAuth stays enabled so existing connectors continue to work.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Shared Project Memory

When the optional Basic Memory integration is enabled, DevSpace derives a deterministic project discovery identity from the workspace source checkout. A normalized Git `origin` is preferred so SSH/HTTPS clones of the same repository converge; repositories without an origin fall back to the canonical real filesystem path. New Basic Memory projects use a readable `<repo>-<identity-hash>` name, so unrelated repositories with the same directory name cannot silently share memory. Once a project is resolved, DevSpace prefers Basic Memory's immutable `project_id` for subsequent calls. Managed worktrees use `sourceRoot` and therefore share the source project's identity. The model never chooses a Basic Memory project directly.

Existing legacy projects with plain names can be retained by adding a one-time `devspace-project-identity` marker in that Basic Memory project. The configured global project name is reserved and is never reused as a workspace project. Project discovery is read-only: `open_workspace` does not contact Basic Memory at all, and `project_memory_recall` never creates a project. If the project does not exist yet, the first `project_memory_checkpoint` creates it automatically and verifies that the new project is usable before writing the checkpoint. This keeps read-only tools read-only while removing the old requirement to edit a per-project mapping and restart DevSpace whenever a repository is added.

Automatic provisioning requires one deployment-level `basicMemoryProjectBasePath` that points to the Basic Memory server's project parent directory. DevSpace never infers this server-side filesystem path from existing projects. If it is missing, project recall remains read-only and checkpoint reports an actionable configuration error instead of guessing storage layout.

Persisted settings live in `~/.devspace/config.json`; the Basic Memory endpoint and optional bearer token are stored separately in `~/.devspace/auth.json`. Prefer a normal HTTPS endpoint protected by a bearer token over putting a secret in the URL path.

| Persisted key | Environment override | Purpose |
| --- | --- | --- |
| `basicMemoryEnabled` | `DEVSPACE_BASIC_MEMORY` | Enable the Basic Memory integration. |
| `basicMemoryUrl` in `auth.json` | `DEVSPACE_BASIC_MEMORY_URL` | Streamable HTTP MCP endpoint. |
| `basicMemoryToken` in `auth.json` | `DEVSPACE_BASIC_MEMORY_TOKEN` | Optional bearer token sent in the HTTP `Authorization` header. |
| `basicMemoryGlobalProject` | `DEVSPACE_BASIC_MEMORY_GLOBAL_PROJECT` | Fixed global memory project exposed through `global_memory_recall` / `global_memory_checkpoint`; reserved from workspace routing. |
| `basicMemoryAutoProvision` | `DEVSPACE_BASIC_MEMORY_AUTO_PROVISION` | Allow the first project checkpoint to create a missing project. Defaults to `true`. |
| `basicMemoryProjectBasePath` | `DEVSPACE_BASIC_MEMORY_PROJECT_BASE_PATH` | Server-side parent directory for automatically created projects; required when auto-provisioning is enabled. |
| `basicMemoryTimeoutMs` | `DEVSPACE_BASIC_MEMORY_TIMEOUT_MS` | Per-operation timeout. Defaults to `15000`. |

Configure non-secret values through `devspace config set <key> <value>`. Set the bearer token with `devspace config set basicMemoryToken --stdin` so it is never placed in process arguments or shell history; `DEVSPACE_BASIC_MEMORY_TOKEN` remains available for managed environments. `basicMemoryUrl` and `basicMemoryToken` are written to `auth.json`; the other keys are written to `config.json`. On Windows, DevSpace removes inherited ACLs from `auth.json` and grants access only to the current user, SYSTEM, and Administrators. Configuration changes require restarting the DevSpace server, but creating or opening a new repository no longer requires any configuration change or restart.

`DEVSPACE_BASIC_MEMORY_ROOT`, `DEVSPACE_BASIC_MEMORY_PROJECT`, and `DEVSPACE_BASIC_MEMORY_PROJECT_MAP` are legacy routing variables. They are ignored by project resolution and reported by `devspace doctor` so they can be removed after migration. Existing Basic Memory projects are discovered from Basic Memory itself, which remains the project-memory source of truth.

`open_workspace` stays independent of Basic Memory network health. Historical context is fetched only when the model calls `project_memory_recall`, while verified durable handoff is written through `project_memory_checkpoint`. Each recall, checkpoint, or doctor operation uses one short-lived Basic Memory MCP session.

## Tool Modes

`DEVSPACE_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default. Exposes `open_workspace`, `read`, `write`, `edit`, and `bash`. Clients use `bash` with tools such as `rg`, `find`, and `ls` for inspection. |
| `full` | Exposes the minimal tools plus dedicated `grep`, `glob`, and `ls` tools. |
| `codex` | Experimental. Exposes `open_workspace`, `read`, `apply_patch`, `exec_command`, and `write_stdin`. Existing mutation and shell tools are hidden. |

`DEVSPACE_MINIMAL_TOOLS` remains a backward-compatible alias when
`DEVSPACE_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.
The `codex` mode must be selected through `DEVSPACE_TOOL_MODE` and always uses
its fixed short tool names regardless of `DEVSPACE_TOOL_NAMING`.

Codex-mode commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions.

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Default. Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to `open_workspace` and `show_changes`. |
| `off` | Disables widget UI. |

## Skills

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `DEVSPACE_SUBAGENTS` | Optional master override for the persisted Subagents configuration. |
| `DEVSPACE_AGENT_DIR` | Defaults to `~/.codex`; its `skills` child is loaded for compatibility. |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated additional skill directories. |

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- the bundled `subagents` skill when Subagents are enabled, unless `~/.devspace/skills/subagents/SKILL.md` exists
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When Subagents are enabled, DevSpace discovers agent profiles
from:

- `~/.devspace/agents/*.md`
- project `.devspace/agents/*.md`

Enable providers and set their defaults in `~/.devspace/config.json`:

```json
{
  "subagents": {
    "enabled": true,
    "providers": [
      {
        "id": "codex",
        "enabled": true,
        "model": "gpt-5.4",
        "effort": "high"
      },
      {
        "id": "claude",
        "enabled": true,
        "model": "sonnet"
      },
      {
        "id": "grok",
        "enabled": true,
        "model": "grok-4.5",
        "effort": "low"
      }
    ]
  }
}
```

Each entry controls one provider. Providers omitted from the array are disabled.
`model` and `effort` are optional defaults; an invocation override wins over a
profile value, which wins over the provider default. The legacy boolean
`"subagents": true` remains readable and enables every provider, but new
configuration should use the explicit object form.

`devspace agents targets` shows usable providers and profiles for the current
workspace. Add `--json` for a compact list of exact target names and their
selection metadata. Disabled, unavailable, and unconfigured providers are
omitted. Provider availability is runtime state and never rewrites the
configuration.

Grok Build is discovered from the `grok` executable. Authenticate it with
`grok login` or `XAI_API_KEY`; DevSpace does not read or store Grok credentials.
Grok supports `grok-build` by default and validates explicit model and effort
values against the ACP session metadata when available. Set `GROK_COMMAND` when
the executable is not on the normal PATH. If your Grok installation selects a
custom agent profile, set `GROK_AGENT_PROFILE` to that profile's path; DevSpace
passes it to `grok agent stdio` without writing to Grok's configuration.

`open_workspace` returns a compact catalog containing profile names,
descriptions, providers, and optional models/effort levels so the host model can choose an
agent without reading provider-specific launch details. Disabled or unavailable
providers and their profiles are omitted from this model-facing catalog. `devspace agents ls`
lists existing subagent sessions for the current workspace, scoped by the
workspace environment injected into shell commands. The `subagents`
skill teaches the model to use only the minimal `devspace agents ls`,
`devspace agents targets`, `devspace agents run`, `devspace agents continue`,
and `devspace agents show` workflow.

For Codex, Claude Code, OpenCode, Pi, or another supported Coding Agent, use
the Skills CLI to install the same skill. DevSpace setup prints this command but
does not run it or write into agent skill directories:

```bash
npx skills add Waishnav/devspace --skill subagents --global
```

Starter profile templates are available under `examples/agents/`. Copy or adapt
them into one of the active profile directories before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
npx @waishnav/devspace serve
```

## Logging

| Variable | Default |
| --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` |
| `DEVSPACE_LOG_FORMAT` | `json` |
| `DEVSPACE_LOG_REQUESTS` | `1` |
| `DEVSPACE_LOG_ASSETS` | `0` |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` |
| `DEVSPACE_TRUST_PROXY` | `0` |

Set `DEVSPACE_LOG_FORMAT=pretty` for local debugging.

Set `DEVSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

`DEVSPACE_TRUST_PROXY` must name the trusted reverse-proxy boundary explicitly.
Use a hop count such as `1` when exactly one local reverse proxy sits in front of
DevSpace, or a comma-separated IP/CIDR list such as
`127.0.0.1,10.0.0.0/8`. Boolean `true` is intentionally rejected because it
trusts the entire forwarded chain.

## Env-Only Example

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_WORKTREE_ROOT="$HOME/.devspace/worktrees" \
DEVSPACE_ARTIFACTS="1" \
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_WIDGETS="full" \
npx @waishnav/devspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.
