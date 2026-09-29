---
name: subagents
description: Delegate bounded read-heavy or noisy investigation, independent review, and genuinely parallel work to DevSpace subagents when an advertised role fits. Prefer read_only profiles for exploration/review; use writable workers only for independent work in an isolated worktree. Keep small or tightly sequential implementation in the host.
---

# DevSpace subagents

The host owns task decomposition, product/architecture decisions, integration,
and final verification. Use subagents as bounded specialists when isolation or
parallel evidence improves the work.

Delegate proactively when at least one of these is true:

- An advertised `read_only` profile fits a bounded codebase exploration, call-path
  trace, architecture/risk investigation, test/log-output triage, or independent
  review that would otherwise consume substantial host context.
- Two or more read-only investigations are genuinely independent and can run in
  parallel without sharing mutable state.
- A large implementation item is independently scoped with explicit acceptance
  criteria and is running in an isolated DevSpace worktree.
- The user explicitly asks to use a subagent.
- A DevSpace command-recovery rule specifically calls for subagent delegation.

Keep small edits, tightly sequential debugging/implementation, Skill execution,
and work that depends on frequent host decisions in the host. The host remains the
only orchestrator; do not ask a DevSpace subagent to spawn or coordinate more
DevSpace subagents.

Prefer DevSpace's native MCP subagent tools when the host exposes them:

- run_agent starts a bounded subagent.
- get_agent reads its current state and latest result.
- continue_agent gives the same subagent another turn with its existing context.
- list_agents lists durable subagent sessions for the current workspace.

Use the CLI through the shell/process tool only as a compatibility fallback when
those native tools are unavailable.

## Choose a target

Use the profiles advertised by `open_workspace.agents` instead of guessing names.
Choose by role and description first, including the advertised `writeMode`; use a
raw provider target only when no profile fits or a specific provider is required.
Prefer `read_only` profiles whenever the task does not need edits.

Writable profiles (`allowed` or `full_access`) are for independent implementation
only. Open an isolated workspace with `open_workspace(mode=worktree)` first and run
the worker there; do not run parallel writable workers against the same checkout.

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

- A bounded read-only exploration, architecture trace, log/test triage, or risk
  investigation whose raw evidence would otherwise dominate host context.
- An independent read-only review of a non-trivial implementation or decision.
- Multiple independent read-only investigations whose results the host can merge.
- One isolated writable work item in a managed worktree with clear acceptance
  criteria and no shared mutable state with the host or another worker.
- Recovery delegation required by DevSpace after the normal host execution path
  has been attempted as specified by the server policy.
