# Personal DevSpace

This checkout is an official **stable release plus a linear Personal Overlay**.
`personal/upstream.json` records the exact official tag and peeled commit. Neither
the connector display name nor local historical tags define the upstream version.

## Boundaries

`src/personal` owns API Token verification, lazy CodeGraph and bounded SDK event
storage. `personal/desktop` owns the local Control Center, native tray adapter and
OS lifecycle. Upstream `config.ts` and `user-config.ts` remain unchanged.

The only core seams are optional server authentication/tool/event-store hooks,
a read-only running-process count, the identified `waitTimeMs` compatibility alias,
and home-relative **registered skill** reads. Default upstream OAuth and CLI remain
available. Personal configuration is not passed to the upstream schema.

There is no remote-memory client or memory tool in the Personal execution path.
CodeGraph is optional and lazy; a missing executable or failed index only fails its
own tool. The desktop has no enterprise gateway, enrollment, device binding, fleet
policy, tunnel owner or dependency on a Team installation. A user-managed external
tunnel may still point at the Personal MCP endpoint; it is never reconfigured here.

## Local files and commands

`PERSONAL_DEVSPACE_HOME` defaults to `~/.devspace-personal`. It contains private
`personal.json`, `auth.json`, `intent.json`, installation state and logs. Upstream
settings and workspace state stay in the existing `~/.devspace` directory unless
`runtimeConfigDir` explicitly selects another directory. The local API Token is
never returned through the Control Center or diagnostic report.

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
```

On Windows, Runtime, desktop and the one-shot installer have separate user-session
Task Scheduler owners and a GUI-subsystem launcher. Each launcher owns only its
own child process tree. Never launch a persistent service directly inside an MCP
command session. A failed tray/WebUI/log cache cannot stop a healthy Runtime.
The Control Center remembers its loopback port; if another application owns that
port it uses a new port and capability without touching the other process.

## Stable upgrade and installation

```text
node personal/upgrade.mjs check
node personal/upgrade.mjs prepare
node personal/upgrade.mjs replay
```

`check` requires agreement between the highest non-draft/non-prerelease GitHub
release and npm's highest published stable plus `latest` tag. A disagreement,
network error, deprecated release or moved stable tag fails closed. No command
selects `main`, beta, alpha, rc or a local personal tag as the official baseline.

`prepare` uses native Git worktree/rebase with rerere enabled and autoupdate off.
It runs `npm ci`, upstream typecheck/tests/build, native build and Personal
regressions. Review `range-diff.txt`, `modifying-delta.txt` and logs under the
candidate's `.personal-review`. Native Git may drop an absorbed patch; review the
remaining need and regression, not just conflict markers. Conflicts retain the
candidate for normal `git rebase --continue` or `--abort`; the running app stays put.

`replay` rehearses this exact path against the current official stable, even when
there is no newer release. It does not invent a future version. Native binaries
can be reused from a private, source-digest-and-artifact-hash-checked build cache;
a changed native source/lock/build script requires rebuilding. Windows source
builds need Rust 1.85.1 and Zig (or explicit `CARGO`/`ZIG` paths). macOS uses system
Swift/AppKit; it does not bundle a browser framework.

After making and committing changes, generate a fresh tested artifact receipt:

```text
node personal/verify.mjs
node personal/bin.mjs install C:\project\DevSpace
```

The install command verifies the exact committed revision and payload hash, then
hands off to an independent OS installer. It stages immutable application bytes
and locked production dependencies while the old Runtime remains available,
refuses an active-command switch, and checks the candidate's owner, version and
overlay commit before committing. A failed core activation restores the previous
runtime; a desktop-only failure is reported as degraded, not a core rollback.
`install-result.json` records the real outcome. A queued result is **not** success.
Pause intent, API Token and upstream state remain outside version directories.
Previous application directories are retained for rollback; there is no automatic
deletion of old versions or user data.

After a healthy core activation, the installer reuses `npm install --global` to
point the CLI shims at the installed candidate. This retires legacy CLI commands
and keeps later upgrades consistent. A global-prefix permission failure is an
explicit entrypoint warning, not a reason to roll back the working Runtime.

The update page shows official notes and prepares a reviewed candidate. Installing
it is a separate explicit action, never an unattended promotion of upstream code.

## One-time historical import

`node personal/bin.mjs migrate` is an explicit local-only migration, not a runtime
hook. It preserves the existing API Token, OAuth owner, roots and CodeGraph
settings, snapshots private rollback files, moves Personal-only settings out of
upstream JSON and removes retired fields. It refuses ambiguous identity or an
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
acceptance must exercise the OS-managed packaged Runtime and rendered Control
Center. macOS source support must be reported separately from native acceptance;
never infer macOS success from Windows tests. Linux provides user services and the
Control Center, not an untested Windows-style native tray.
