---
name: subagents
description: Delegate work to a bounded DevSpace subagent only when the user explicitly requests a subagent, when a clearly independent large task materially benefits from isolated context or parallelism without shared mutable state, or when a DevSpace recovery rule specifically requires delegation. Keep ordinary code reading, debugging, implementation, Skill execution, tests, builds, and sequential decisions in the host; do not delegate merely to reduce host context.
---

# DevSpace subagents

The host is the default executor and orchestrator. Keep work in the host unless
delegation has a concrete benefit that outweighs the loss of shared context.

Do not delegate merely because a task could be done separately, involves codebase
search, produces substantial output, or might keep the host context cleaner.
Ordinary repository inspection, diagnosis, implementation, Skill execution,
testing, building, and sequential decision-making stay with the host.

Delegate only when at least one of these is true:

- The user explicitly asks to use a subagent.
- A large, bounded task is genuinely independent and can run in parallel without
  sharing mutable state or owning the parent task's decisions.
- A clearly isolated investigation would otherwise dominate the host context and
  the host already has enough understanding to define and evaluate the result.
- A DevSpace command-recovery rule specifically calls for subagent delegation.

Prefer DevSpace's native MCP subagent tools when the host exposes them:

- run_agent starts a bounded subagent.
- get_agent reads its current state and latest result.
- continue_agent gives the same subagent another turn with its existing context.
- list_agents lists durable subagent sessions for the current workspace.

Use the CLI through the shell/process tool only as a compatibility fallback when
those native tools are unavailable.

## Choose a target

Use the profiles advertised by open_workspace.agents instead of guessing names.
Choose a matching profile when one fits. Use an enabled provider target only when
no profile fits or a specific provider is needed.

For CLI fallback only, discover targets with:

```bash
devspace agents targets --json
```

Configured profiles include a description and may define provider, model, effort,
and task instructions. Usually rely on those configured values rather than
overriding them per turn.

## Start work

Give the subagent a self-contained brief. Include the objective, relevant paths,
constraints, decisions it needs from the current conversation, and the expected
result. The subagent receives the brief and its profile instructions, not the
parent conversation.

With native MCP tools:

    run_agent(workspaceId, target, prompt)
    get_agent(workspaceId, agentId)
    continue_agent(workspaceId, agentId, prompt)
    list_agents(workspaceId)

The tool call itself is the user-visible signal that DevSpace delegated work to a
subagent; do not add a second wrapper or custom UI just to announce delegation.

For CLI fallback only:

```bash
devspace agents run <profile-or-provider> "<brief>" --json
```

The result contains a DevSpace agent `id` and its current status. Execution continues independently, so retain the ID for later inspection or follow-up.

## Inspect and continue

For native MCP tools, use get_agent to inspect a known agent, continue_agent for
another turn with the same agent, and list_agents to recover or inspect durable
sessions for the workspace. If get_agent reports running, call it again later.

For CLI fallback only:

```bash
devspace agents show <id> --json
devspace agents continue <id> "<follow-up brief>" --json
devspace agents ls --json
```

- `show` waits briefly for active work, then returns the current status and any
  available response or error.
- `continue` gives the same subagent another turn with its existing provider
  session and context.
- `ls` returns sessions belonging to the current project.

Run `devspace agents show <id> --json` again later while the status is `running`.
`completed` includes the response. `failed` includes a structured error, and
`stopped` is terminal without a successful response. Continue an agent when its
existing context is useful; start another agent for unrelated work.

## Good uses

- A user-requested independent review or investigation.
- A large read-only exploration that is clearly separable from the host's active
  reasoning and whose result the host will evaluate before acting on it.
- One isolated parallel work item with clear acceptance criteria and no shared
  mutable state with the host or another worker.
- Recovery delegation required by DevSpace after the normal host execution path
  has been attempted as specified by the server policy.
