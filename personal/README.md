# Personal DevSpace

This checkout is an official **stable release plus a linear Personal Overlay**.
`personal/upstream.json` records the exact official tag and peeled commit. Neither
the connector display name nor local historical tags define the upstream version.

## Boundaries

`src/personal` owns API Token verification, lazy CodeGraph access, the thin
native MCP bridge to the existing DevSpace subagent runtime, and bounded SDK event
storage. `personal/desktop` owns the local Control Center, native tray adapter and
OS lifecycle. Upstream `config.ts` and `user-config.ts` remain unchanged.

The only core seams are optional server authentication/tool/event-store hooks,
a read-only running-process count, the identified `waitTimeMs` compatibility alias,
and home-relative **registered skill** reads. Default upstream OAuth and CLI remain
available. Personal configuration is not passed to the upstream schema.

There is no remote-memory client or memory tool in the Personal execution path.
CodeGraph is optional. Opening a workspace never waits for it. The first
`codegraph_explore` for a checkout/worktree initializes a missing workspace-local
`.codegraph/` index and then queries it; an existing index is left to CodeGraph's
own sync/version logic. Missing executables, failed indexes and tool timeouts are
reported by the optional CodeGraph tool without delaying core workspace/file/command tools.
The desktop has no enterprise gateway, enrollment, device binding, fleet
policy, tunnel owner or dependency on a Team installation. A user-managed external
tunnel may still point at the Personal MCP endpoint; it is never reconfigured here.

## Local files and commands

`PERSONAL_DEVSPACE_HOME` defaults to `~/.devspace-personal`. It contains private
`personal.json`, `auth.json`, `intent.json`, installation state and logs. Upstream
settings and workspace state stay in the existing `~/.devspace` directory unless
`runtimeConfigDir` explicitly selects another directory. The local API Token is
never returned through the Control Center or diagnostic report.
On Windows, private JSON state is hardened per file. Atomic writes are staged
inside a freshly secured empty directory, so ACL changes never recurse through
the populated Personal root, retained application versions or native build cache.

```json
{
  "schema": 1,
  "runtimeConfigDir": "C:\\Users\\example\\.devspace",
  "sourceRoot": "C:\\project\\DevSpace",
  "projectRoot": "C:\\project",
  "codegraph": { "enabled": true }
}
```

`auth.json` contains `apiToken` (at least 32 printable non-space characters).
`DEVSPACE_API_TOKEN` remains an explicit override for a directly started runtime.
OS-managed profiles clear an inherited global API Token and use their own private
file, preventing credentials from bleeding across independent profiles. The adapter checks
the configured key on every request; its short authorization-decision expiry
satisfies the SDK contract and does not rotate the API key.

```text
node personal/bin.mjs status
node personal/bin.mjs open
node personal/bin.mjs pause
node personal/bin.mjs resume
node personal/bin.mjs repair
node personal/bin.mjs diagnostics
node personal/bin.mjs gc --dry-run
node personal/bin.mjs gc
```

On Windows, Runtime, desktop and the one-shot installer have separate user-session
Task Scheduler owners and a GUI-subsystem launcher. Each launcher owns only its
own child process tree. Never launch a persistent service directly inside an MCP
command session. A failed tray/WebUI/log cache cannot stop a healthy Runtime.
When Codex is installed, install/repair resolves its absolute CLI path and pins it
as `CODEX_COMMAND` on the managed Runtime profile so subagents do not depend on a
Task Scheduler/launchd/systemd PATH snapshot. Missing Codex remains optional and
does not make Personal installation fail; a later repair refreshes the resolved
path after a Codex/NVM move.
The private `control-capability.json` is the single owner of the Control Center's
loopback token and port. If another application owns that port it uses a new port
and capability without touching the other process. A
healthy install/repair creates both Start Menu and Desktop shortcuts using the
packaged Personal logo; shortcut failure remains a desktop-only repair condition.

## Stable upgrade and installation

```text
node personal/upgrade.mjs check
node personal/upgrade.mjs prepare
node personal/upgrade.mjs replay
npm run personal:release-check
npm run personal:live
```

`check` requires agreement between the highest non-draft/non-prerelease GitHub
release and npm's highest published stable plus `latest` tag. A disagreement,
network error, deprecated release or moved stable tag fails closed. No command
selects `main`, beta, alpha, rc or a local personal tag as the official baseline.

`prepare` uses native Git worktree/rebase with command-scoped rerere enabled and
autoupdate off; it does not mutate repository Git configuration. It runs `npm ci`,
upstream typecheck/tests/build, native build and Personal regressions with bounded
stage deadlines. npm's package manifest is the canonical application-file list;
`package-lock.json` is the additional installer sidecar. The resulting
`.personal-review/candidate.json` is the single candidate manifest: official
tag/peeled commit, candidate HEAD, platform/Node identity, payload hash and
verification stages. Review `range-diff.txt`, `modifying-delta.txt` and logs
under the candidate's `.personal-review`. Native Git may drop an absorbed patch; review the
remaining need and regression, not just conflict markers. Conflicts retain the
candidate for normal `git rebase --continue` or `--abort`; the running app stays put.

`replay` rehearses this exact path against the current official stable, even when
there is no newer release. It does not invent a future version. Native binaries
can be reused from a private, source-digest-and-artifact-hash-checked build cache;
a changed native source/lock/build script requires rebuilding. Windows source
builds need Rust 1.85.1 and Zig (or explicit `CARGO`/`ZIG` paths). macOS uses system
Swift/AppKit; it does not bundle a browser framework.

After making and committing changes, use the deterministic release-check action to
generate a fresh tested candidate manifest and rehearse the current-stable replay:

```text
npm run personal:release-check
node personal/bin.mjs install C:\project\DevSpace
```

The install command verifies the exact committed revision and payload hash, then
hands off to an independent OS installer **and waits for its terminal result**.
The OS installer is the authoritative full verification boundary; the queueing
process validates the frozen candidate identity. It stages immutable application
bytes and locked production dependencies while the old Runtime remains available,
refuses a switch while shell commands or subagent turns are active, stops an idle
agent daemon before replacing Runtime code, and checks the candidate's owner,
version and overlay commit before committing. Installation never re-queries the
network to decide whether an already reviewed candidate is still “latest”; a later
release belongs to the next update check. A failed core activation restores the
previous runtime; a desktop-only failure is reported as degraded, not a core rollback.
`install-attempt.json` is the single request/progress/result record, keyed by
`requestId` and moving through queued/staging/switching/installed|failed.
Pause intent, API Token and upstream state remain outside version directories.
The current and previous immutable application directories are retained for rollback.
After successful installation, deterministic GC removes older Personal-owned installs,
stale stage directories, superseded native caches, old Personal-owned review worktrees
and logs older than 30 days. The current review candidate is retained. GC never deletes
unowned directories; `gc --dry-run` previews the same rule set.

After a healthy core activation, the installer reuses `npm install --global` to
point the CLI shims at the installed candidate. This retires legacy CLI commands
and keeps later upgrades consistent. A global-prefix permission failure is an
explicit entrypoint warning, not a reason to roll back the working Runtime.

The update page shows official notes and prepares a tested candidate. Installing
it is a separate explicit human action: the exact `candidateHead` is persisted
as the approved head before the OS installer is queued, so approval cannot silently
float to another revision.

## One-time historical import

`node personal/bin.mjs migrate` is an explicit local-only migration, not a runtime
hook. It preserves the existing API Token, OAuth owner, roots and CodeGraph
settings, snapshots private rollback files, moves Personal-only settings out of
upstream JSON and removes retired fields. A private phase journal makes an
interrupted migration resume forward from the immutable backup rather than
requiring manual partial-state cleanup. It refuses ambiguous identity or an
existing conflicting Personal configuration. It never prints credentials.
Historical tasks are touched only when their exact name and native executable
match the preserved Personal ownership record; Team and tunnel tasks are excluded.

## Verification scope

`npm test` is the complete upstream suite. `npm run test:personal` covers auth,
CodeGraph isolation, wait aliases, skill boundaries, real HTTP loss/replay without
side-effect repetition, control authentication/origin/host/port isolation and
install rollback. `personal/tests/baseline-probe.ts` and `transport-probe.ts` can
run against a pristine official worktree before deciding whether to retain a fix.

Native compilation/PE checks do not prove that a tray is visible. Windows live
acceptance is the deterministic `npm run personal:live` action; it always attempts
fixture cleanup after prepare/lifecycle/verify. macOS source support must be
reported separately from native acceptance;
never infer macOS success from Windows tests. Linux provides user services and the
Control Center, not an untested Windows-style native tray.
