# Stable overlay review — 2026-09-15

## Authoritative inputs

- Official `Waishnav/devspace` stable `v1.0.8`, peeled commit
  `fe712e2b6c07231d2a76503bf2a674b165850616`, agrees with npm `latest`.
- Local historical `v1.0.9` is a Personal tag, not an official stable release.
  Official tags are fetched into an independent remote-reference namespace.
- Desktop is a one-time snapshot of Team 0.2.6 at
  `15ce088b890142eb7922c156e01aa637b700cb24`, not a runtime dependency.
- Recovery branch/tag: `backup/personal-pre-stable-20260915` and
  `personal-pre-stable-20260915`; the original dirty documentation was committed
  there before resetting the working baseline. Both were pushed before edits.

## Historical behavior, not historical implementation

| Requirement | Evidence and decision |
| --- | --- |
| API Token | Keep isolated adapter. Every request validates the current private key; upstream OAuth stays intact. No private fields in the upstream config schema. |
| CodeGraph | Keep a thin Personal extension. Workspace open never waits for it; the first graph query initializes a missing workspace-local index through the CodeGraph CLI. Existing indexes remain CodeGraph-owned. Missing executable, malformed config, failed index or timed-out tool must not affect core tools. |
| Remote memory | Remove implementation, tools, old CLI/config schema/tests/prompts. No remote-memory call in runtime, startup or tools. Explicit one-time migration removes retired local fields while preserving private rollback files. |
| `waitTimeMs` | Pristine stable advertises only `yieldTimeMs`; the installed connector sends `waitTimeMs`. Keep a minimal alias, reject contradictory values before execution, retain tests. |
| Home-relative skill paths | Pristine stable probe fails advertised `~/.../SKILL.md`. Resolve only registered/activated skill paths; reject unrelated home reads and traversal. |
| Windows shell/NUL rewrite | Remove the private string-rewriting parser. Native CMD redirection and command output pass regression. |
| Pi startup workaround | Do not migrate the old RPC workaround into stable's SDK path. Keep upstream code/dependency lock and upstream tests. |
| MCP response recovery | Pristine default transport has no replay store. Keep only bounded per-runtime storage plugged into the official SDK; do not retain old transport/retry code. Real HTTP-drop regressions on locked SDK 1.29 recover fast/delayed responses without repeating side effects. Oversize events invalidate their stream cursor rather than replaying across a gap. |
| Desktop | Independent Personal native executables and private state. Core Runtime and optional desktop use separate OS owners. No installed Team files, binding, gateway, fleet policy or tunnel owner. |
| Upgrade | Native Git worktree/rebase/rerere/range-diff. Official stable must agree with npm; no main/prerelease fallback. A clean rebase is not behavioral validation. |

## Review findings fixed

Authentication uses the SDK's required authorization expiry without expiring the
static API key. OS-owned profiles clear inherited API Token environment values so
independent installations cannot accidentally authenticate with another profile's
key. API secrets never appear in the Control Center or diagnostic projection.

Localized Windows task errors are not parsed as ownership/existence signals;
successful structured task enumeration distinguishes absence from query failure.
Only verified Personal task names and launcher paths can be stopped or replaced.
An independent OS installer, not an MCP child process, owns runtime replacement.

Optional control-port conflicts, tray observers and diagnostic
projection failures do not roll back a healthy core. Pause intent survives
restart/install. Partial stop refuses activation; failed candidate readiness
restores the previous runtime; rollback failure is reported explicitly. Installation
requires verified application bytes, the tested Node version and private auth.
An approved installation force-stops the owned Runtime; active
shell commands and subagent turns do not block the switch. One
`install-attempt.json` owns queue/progress/result state.

## Recorded verification and limits

The pristine stable worktree and the overlay each passed the full upstream
`npm test` command. The overlay passed typecheck/build, Personal regressions,
and Windows native Rust tests/GUI-subsystem checks. No Node/browser/Team binary is
introduced as a Personal runtime dependency.

An independently Task-Scheduler-owned fixture passed real MCP authentication,
command execution, `apply_patch`, the installed CodeGraph executable and a native
tray-visible handshake. Real local-control operations passed pause, restart while
paused, resume, and control availability while the Runtime was stopped.

Browser inspection passed all four page tabs, one visible panel at a time,
desktop-width overflow checks, hash removal and redacted diagnostics. A separate
browser batch was interrupted by the automation context/dialog handling; do not
misreport that interrupted batch as a passed browser lifecycle test. The actual
lifecycle was tested independently through its authenticated local API and OS jobs.

The macOS AppKit source has a separate arm64/x86_64 compile workflow. A Windows
pass, a successful Swift compile or a tray-visible protocol event is not proof of
interactive macOS install/update acceptance. Report its actual CI/native status.

Final per-revision verification, worktree replay and installation outcomes are
recorded in the ignored `.personal-review/candidate.json` manifest and private
installation state, not hard-coded here. A terminal installed attempt and the
health endpoint's exact overlay commit are required before claiming that the real
installed Runtime was replaced.

## Code organization review — 2026-09-27

The overlay was reviewed again after the local-install candidate flow was
simplified. The cleanup kept behavior and security boundaries intact while
removing replay noise:

- Runtime ownership identity now lives in a lightweight `personal/ownership.mjs`
  module. Runtime startup no longer imports the full desktop/OS platform adapter
  merely to compute its owner id.
- CLI commands load the desktop/update stack only when the selected command needs
  it. The OS-owned Runtime path no longer eagerly imports Control Center, Qoder,
  upgrade discovery or desktop platform code.
- `personal/upstream.mjs` is the single reader/shape validator for the recorded
  official baseline. Artifact, Runtime, desktop and upgrade code no longer parse
  `upstream.json` independently.
- Candidate recording has one identity contract: `candidateHead + sourceTree`.
  The retired commit-string compatibility branch and its clean-check helper were
  removed.
- Desktop status reads the installation attempt once per snapshot, idle checks use
  Runtime facts directly, and project-root fallback has one derivation.
- Upgrade approval now passes the persisted approved head/payload identity to the
  installer. A failure to write the post-install review projection can no longer
  reinterpret an already committed healthy Runtime as a failed installation.
- The unused core `openExternalUrl` implementation and its self-only test were
  deleted; Personal desktop already owns browser launching.

`personal/desktop/platform.mjs` remains the explicit OS ownership boundary.
Durable subagent execution now lives in the existing SQLite-backed local agent
store instead of a second Personal long-run state machine.

The main upstream replay hotspot is still `src/server.ts`: optional Personal
hooks, MCP replay/session retention, dynamic subagent resolution, the wait-time
compatibility alias and tool instructions all meet there. Keep future additions
behind the existing option hooks rather than adding new Personal-specific branches
to generic server flow.

## Execution and recovery contract follow-up - 2026-09-27

The unused `initialStdin` process extension and its self-only regression were
removed; ordinary stdin continues through the existing session write contract.
Personal command-recovery hints now require the Personal extension option, so
an upstream-only server does not advertise unregistered recovery tools.

Deterministic graders reuse the existing bounded output buffer and process-tree
termination primitive. Windows commands use Node's shell quoting while POSIX
keeps the existing login-shell arguments. Manager shutdown also stops graders
and prevents later acceptance commands from starting. Completion and approval
share one check requiring a matching successful result for every configured
grader; review intent and initial review status derive from the same value.

Runtime health distinguishes receiving an HTTP response from verified owned
readiness, and does not follow redirects. Stop checks require the endpoint to
stop responding rather than merely stop reporting a healthy owned Runtime.
GC reads all retention-owner records before deleting anything and preserves
existing read errors instead of converting them to absent state. Regressions
cover these failure paths, dry-run equivalence, actual command execution and
grader process shutdown; no replacement state machine or dependency was added.

## Qoder native Goal launch follow-up - 2026-09-27

Qoder now has one Windows execution path: a visible native Goal TUI. Hidden
`mode=turn` execution was removed; omitted mode defaults to Goal for Qoder and an
explicit Qoder turn is rejected. The background Runtime uses PowerShell 7 only
as the launcher and creates a separate visible PowerShell 7 console whose direct
child is `qodercli`; the previous detached `stdio: ignore` launch is gone.

The provider-generated session id is no longer persisted as though it were
already durable. After the visible TUI starts, DevSpace waits on Qoder's public
`--list-sessions` output for that exact session id, persists it only then, and
only afterwards begins `/goal status` resume polling. This removes the startup
race that produced transient `Invalid session identifier`/exit 42 probes before
Qoder had created the session.
