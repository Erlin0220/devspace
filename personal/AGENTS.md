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

Authentication, process ownership, active-command avoidance and credential
origin binding fail closed. UI, log cache, diagnostics and optional extensions
fail independently. Never reinterpret a successful command as verified native
UI, current-host schema refresh, installation success or cross-platform coverage.

Use existing workspaces and Codex tools. Long commands yield and are polled, not
restarted. Persistent apps and installers must be started through their OS owner,
not inside DevSpace/Windows MCP command trees. Touch only verified Personal jobs.
Do not display credentials, read unrelated private stores or stop Team/tunnels.

Run upstream tests plus `npm run test:personal`, then `npm run personal:live`
for native acceptance on the actual platform, and review
`git diff --diff-filter=M <official-base> HEAD`. After a final clean commit use
the single deterministic `npm run personal:release-check` action; it creates a
fresh candidate manifest and rehearses the current-stable upgrade without
fabricating a new upstream release. Commit and push only what was tested.
