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
| CodeGraph | Keep a lazy Personal extension and local CLI initialization. Missing executable, malformed config, failed index or timed-out tool must not affect core tools. |
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

Optional control-port conflicts, endpoint caches, tray observers and diagnostic
projection failures do not roll back a healthy core. Pause intent survives
restart/install. Partial stop refuses activation; failed candidate readiness
restores the previous runtime; rollback failure is reported explicitly. Installation
requires verified application bytes, the tested Node version, private auth and a
trustworthy idle state. A queued install is not reported as completed.

## Recorded verification and limits

The pristine stable worktree and the overlay each passed the full upstream
`npm test` command. The overlay passed typecheck/build, 31 Personal regressions,
and Windows native Rust tests/GUI-subsystem checks. The native helpers total
764,928 bytes; no Node/browser/Team binary is committed to this overlay.

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
recorded in ignored `.personal-review` receipts and private installation state,
not hard-coded here. `install-result.json` and the health endpoint's exact overlay
commit are required before claiming that the real installed Runtime was replaced.
