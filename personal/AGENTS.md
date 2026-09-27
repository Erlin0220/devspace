# Personal Overlay maintenance

Treat Personal as a thin overlay on the official stable upstream. Prefer
Personal-only code and tiny optional core seams so upstream upgrades remain
easy to replay; do not fork or duplicate upstream behavior unless a verified
Personal requirement cannot be met otherwise.

Read `README.md` here and `upstream.json` before changes. The official stable tag,
peeled commit and package version must agree. Do not use local `v1.0.9`, `main` or
any prerelease as the baseline. Preserve a recovery branch before rewriting the
short Personal series; never merge historical forks into this branch.

Prefer deleting an upstream-absorbed implementation. Keep the requirement and
regression. Personal settings/extensions/desktop live here or in `src/personal`;
keep core-file seams short and avoid changing upstream config schema. No memory
service is allowed in the execution chain. One-time private migration is not a
recurring runtime capability.

Authentication, process ownership and credential origin binding fail closed.
Installation is a forced switch: active shell commands and subagent turns do not
delay an approved upgrade; the owned Runtime and agent daemon are stopped as part
of activation. UI, log cache, diagnostics and optional extensions
fail independently. Never reinterpret a successful command as verified native
UI, current-host schema refresh, installation success or cross-platform coverage.

Use existing workspaces and Codex tools. Long commands yield and are polled, not
restarted. Persistent apps and installers must be started through their OS owner,
not inside DevSpace/Windows MCP command trees. Touch only verified Personal jobs.
Do not display credentials, read unrelated private stores or stop Team/tunnels.

Keep the development loop proportional to the change. During implementation run
the smallest affected typecheck, test, build or runtime check that proves the
changed contract; small local changes do not require the full upstream suite,
all Personal tests, native build, live acceptance or stable replay.

For a current-checkout install, a Git commit is not required. The install command
reuses a still-valid candidate. When the source tree changed, it verifies a frozen
Git-tree snapshot in a disposable worktree so the running checkout's dependencies
are never rewritten, then promotes only verified build/native outputs and installs
that exact payload.
Use `npm run personal:release-check` when an explicit release candidate receipt is
needed. Run `npm run personal:live` when
the change touches native desktop behavior, process ownership/lifecycle,
installer/shortcuts, or another behavior that requires actual-platform native
acceptance. Run `npm run personal:replay` when the upstream baseline changes,
replay/rebase behavior changes, or replayability is explicitly being checked.
Review `git diff --diff-filter=M <official-base> HEAD` when the overlay/base
relationship is relevant. Commit and push only what was tested.
