# Subagent profile schema

DevSpace agent profiles are user-owned markdown files with YAML
frontmatter. They describe roles such as reviewer, explorer, or implementer.
The generic CLI uses an on-demand `devspace-agentd` process so
`devspace agents run` can return while the provider keeps working. Personal
Web MCP does not add that private IPC hop: its OS-owned Runtime keeps
`LocalAgentManager` in-process and exposes `run_agent/get_agent/continue_agent/
review_agent` directly. Both paths persist logical agent identity and provider
session ids in the same SQLite-backed `LocalAgentStore`.

Profiles are discovered from:

- `~/.devspace/agents/*.md`
- `.devspace/agents/*.md`

Packaged files under `examples/agents/` are starter templates only.

## Minimal shape

```md
---
schema: devspace-agent/v1
name: reviewer
description: Read-only reviewer for bugs, security risks, and missing tests.
provider: codex
model: gpt-5.4
effort: high
writeMode: read_only
disabled: false
---

You are a read-only reviewer. Do not edit files.
Focus on correctness, security, test gaps, and maintainability.
Cite files and return concise findings.
```

## Frontmatter fields

### `schema`

Optional schema identifier:

```yaml
schema: devspace-agent/v1
```

### `name`

Stable profile identifier shown to the model and accepted by:

```bash
devspace agents run <name> "<prompt>"
```

Use lowercase kebab-case names. If omitted, DevSpace uses the filename without
`.md`.

### `description`

Required short purpose. This is exposed by `open_workspace` so the supervising
model can choose the right profile.

### `provider`

Required built-in provider id:

```yaml
provider: codex
provider: claude
provider: opencode
provider: pi
provider: cursor
provider: copilot
provider: grok
provider: qoder
provider: agy
```

Unsupported or custom providers are rejected. DevSpace maps providers to their
native integration:

- `codex`: the host-installed `codex app-server` command
- `claude`: Claude Code SDK
- `opencode`: OpenCode SDK
- `pi`: the installed Pi coding-agent SDK, one in-process session per DevSpace agent
- `cursor`: ACP
- `copilot`: ACP
- `grok`: Grok Build ACP (`grok agent stdio`)
- `qoder`: the host-installed native Qoder CLI Goal workflow.
- `agy`: the host-installed AGY CLI with stream-json conversation support.

Codex is resolved from the user's environment rather than bundled with
DevSpace. Run `codex login` normally before using it; set `CODEX_COMMAND` when
the executable is not on the normal PATH. OpenCode, Cursor, and Copilot
runtimes are started and reused by the daemon internally, while Pi is embedded
through its Node SDK.

### `model`

Optional provider model id or alias.

```yaml
model: gpt-5.4
model: sonnet
```

### `effort`

Optional provider reasoning effort, thinking level, or model variant. If omitted,
DevSpace lets the provider default apply. Values are provider-specific
passthrough strings; DevSpace does not translate names between harnesses.

```yaml
effort: low
effort: high
effort: xhigh
```

DevSpace passes this through to providers that expose a matching control:

- `claude`: SDK effort with adaptive thinking.
- `codex`: app-server model reasoning effort.
- `pi`: the AgentSession thinking-level control.
- `opencode`: model variant.
- `cursor` and `copilot`: ACP thought-level config when supported.
- `grok`: `--reasoning-effort` on startup and xAI's ACP model metadata for resumed sessions.

### `writeMode`

Optional mechanical authority for the profile:

```yaml
writeMode: read_only
writeMode: allowed
writeMode: full_access
```

`read_only` is the recommended default for explorer and reviewer profiles. It is
enforced by the provider integration rather than relying only on prompt wording.
`allowed` permits normal workspace edits. `full_access` is provider-specific and
should be reserved for profiles whose task genuinely requires that authority.
Only user-level profiles under `~/.devspace/agents` may request `full_access`;
workspace-local `.devspace/agents` profiles are repository-controlled and cannot
expand authority beyond `allowed`. Profiles that omit `writeMode` default to
`allowed` even for providers whose raw-provider default is broader. Profiles
requesting a mode that their provider cannot support fail before the turn is run.
When the host requires isolated writable workers, `allowed` and `full_access`
targets must run from a worktree workspace; the manager enforces this for both
profiles and raw-provider targets. `read_only` targets cannot attach shell
`graderCommands`, because graders execute outside the provider sandbox.

### `disabled`

Optional boolean. Disabled profiles are not exposed.

```yaml
disabled: true
```

## Markdown body

The body is the profile prompt prefix DevSpace prepends when launching that
profile. It is not included in `open_workspace` by default.

Recommended body content:

- When to use this profile.
- Whether the worker should act read-only or may make changes.
- Output format.
- Review or testing expectations.

## Model-facing workflow

The Subagent skill teaches only:

```bash
devspace agents ls --json
devspace agents targets --json
devspace agents run <profile-or-provider> "<prompt>" --json
devspace agents continue <id> "<prompt>" --json
devspace agents review <id> <approve|retry|reject> [note] --json
devspace agents show <id> --json
```

`open_workspace` exposes compact profile metadata:

```json
{
  "name": "reviewer",
  "description": "Read-only reviewer for bugs, security risks, and missing tests.",
  "provider": "codex",
  "model": "gpt-5.4",
  "effort": "high",
  "writeMode": "read_only"
}
```

`devspace agents targets` lists usable providers and profile definitions for the
current workspace. `devspace agents ls` lists existing subagent sessions; it does
not list profile definitions.

Use `devspace agents continue <id>` for a later turn. The logical agent ID is
the `agt_...` value returned by `run` or `ls`; provider session IDs are not
accepted as substitutes.

The full profile body stays out of the model context until DevSpace launches the
profile.

## Runtime lifecycle

DevSpace keeps provider sessions warm while they are active or recently used,
but persists only the provider session id and durable agent metadata. Native
sharing follows the provider boundary: Codex uses one app-server across agents,
OpenCode uses one server across sessions, ACP providers use one process across
sessions, while Claude and Pi keep one warm runtime per DevSpace agent. There is
one active turn per agent; different agents may run concurrently.

If an execution owner restarts during a turn, only its own persisted `starting`
and `running` agents become `error` with a restart message. The next
`agents continue <id>` request can continue the provider session when that
provider supports resumption and transfers execution ownership to the manager
that starts the new turn. Personal Web Runtime and the CLI daemon can therefore
share the SQLite store without reconciling each other's active executions.
Legacy pre-owner rows are claimed atomically by whichever current manager starts
first, then reconciled exactly once. Starting a new turn also uses a SQLite
compare-and-swap on the persisted status, so two managers cannot concurrently
continue the same logical agent.
The default per-workspace concurrency ceiling is also reserved atomically in
SQLite for both starts and continues, rather than enforced by per-process
in-memory counters.

Writable isolation is enforced inside `LocalAgentManager`, not trusted from an
MCP or CLI request. The manager derives checkout vs linked-worktree state from
Git at the authorized workspace root before every writable turn and records the
observed mode as durable audit metadata.

## Current non-goals

- Custom or arbitrary CLI-backed agents.
- Inferring changed files, tests, or diffs from worker output.
- Exposing raw provider transcripts by default.
- Teaching the model provider-specific CLIs.
- A second agent execution engine for Personal MCP. Its first-class MCP tools
  call the same `LocalAgentManager`/store/runtime abstractions as the CLI daemon;
  Personal keeps that manager in its already long-lived Runtime instead of
  adding another local IPC daemon.
