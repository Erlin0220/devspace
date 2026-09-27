# CLI local agent daemon

Generic CLI agent execution is owned by an on-demand `devspace-agentd`
process rather than by an individual short-lived CLI invocation. This preserves
the CLI contract where a run can return an agent id while work continues:

```text
devspace agents run/continue/show/ls
          │
          ▼
    devspace-agentd
          │
          ├── LocalAgentManager
          ├── LocalAgentStore
          ├── LocalAgentRuntimePool
          └── provider runtimes
```

The CLI starts the daemon automatically when an agent command needs it;
`devspace serve` is not required for CLI local-agent execution. The daemon is
scoped to one DevSpace `stateDir`.

Personal Web MCP deliberately does **not** use this daemon. Personal DevSpace is
already an OS-owned long-lived Runtime, so it owns `LocalAgentManager` directly
and registers `run_agent/get_agent/continue_agent/review_agent/list_agents`
without a second socket, secret, PID lock, or daemon lifecycle. On Windows its
Qoder provider has one execution path: native Goal mode in a visible PowerShell
7 console. Omitted Qoder mode defaults to `goal`; explicit Qoder `turn` mode is
rejected. DevSpace persists the native Qoder session only after Qoder reports it
through `--list-sessions`, plus process evidence, grader results, attempts, and
review state in the SQLite agent record.

Communication uses a private Unix domain socket on Linux/macOS or a named pipe
on Windows. The endpoint is not exposed through the public MCP HTTP port.
Provider session identifiers and logical agent records are durable; live
provider runtimes are disposable and may be recreated after a daemon restart.
Expected subagent failures cross the daemon boundary as structured error codes,
not message-string conventions. Agent records in `error` state retain the safe
message plus `errorCode` and `errorRetryable` fields so callers can distinguish
provider cancellation, provider availability, workspace conflicts, daemon
timeouts, and similar recovery categories after a background turn completes.
Internal provider causes are kept out of the daemon payload and persisted JSON.

The CLI daemon implementation treats `better-result` as the application-failure boundary,
not as a replacement for every exception. Expected target, scope, provider,
store, and daemon failures return typed Results. Sequential fallible setup uses
`Result.gen` when it makes the success path clearer, small Result-to-Result
transformations use `map`/`andThen`, and error policy at serialization or IPC
boundaries uses exhaustive tagged-error matching. Programmer defects and broken
invariants remain exceptions; cleanup and shutdown also stay best-effort so a
secondary release failure cannot replace the primary agent failure.

The daemon state directory contains the socket or pipe identity, an atomic
lock, a PID marker, and diagnostic logs. A second client cannot start another
daemon for the same state directory. Stale lock and socket files are recovered
only after the recorded PID is no longer alive.

The daemon is started on demand and may exit after its active turns, clients,
and warm runtime idle periods have ended. Users do not need to manage it during
normal operation. Diagnostic commands are available for startup, process, and
cleanup problems:

```bash
devspace agents daemon status
devspace agents daemon stop
devspace agents daemon logs
```

Agent commands accept `--json` when a machine-readable response is needed.
They emit one compact JSON value. `run` and `continue` return only the logical
agent ID and status, `ls` returns session summaries, and `show` returns the
response or structured failure for one agent. Internal workspace paths,
provider session IDs, timestamps, and prior responses are not included in list
or receipt output. Immediate failures are emitted as
`{ error: { code, message, retryable, ... } }` with a non-zero exit code.
Successful `daemon status` and `daemon stop` output the daemon status object,
and successful `daemon logs` output is `{ "logs": "<text>" }`.

Agent identity is explicit at the client boundary. `agents run` starts a new
logical agent from a profile or provider; `agents continue <id>` continues an
existing logical agent. Provider session IDs are never accepted as logical
agent IDs, and the daemon does not resolve ambiguous prefixes.

Shutdown gives active turns a bounded graceful window. If that window expires,
the process exits with active records left durable; the next daemon startup
reconciles stale `starting` and `running` records to `error` without discarding
their `providerSessionId` or `latestResponse`.
