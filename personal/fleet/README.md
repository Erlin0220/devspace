# Personal Fleet Gateway

One MCP endpoint for independently installed Personal DevSpace Runtimes. This is
an optional, separately deployed Cloudflare Worker with one SQLite-backed Durable
Object for the Personal owner. It does not replace the local Runtime or desktop.
It contains no task scheduler, queue, agent loop, device installer or tunnel owner.

## Contract

1. `list_devices` reports configured ids, names, native platforms, binding ids and
   current availability. Endpoint URLs and device credentials are never returned.
2. `open_workspace` requires an explicit `deviceId` and a path on that device.
   It preserves checkout/worktree mode and returns a new opaque `workspaceId`.
3. `read`, `apply_patch`, `exec_command` and `codegraph_explore` route using that
   workspace alone. A later `deviceId` override is rejected before dispatch.
4. `exec_command` replaces numeric local process ids with opaque Fleet `sessionId`
   strings. `write_stdin` requires the original workspace and process handle.
   Identical local ids on different machines remain independent.

Workspace and process handles bind to the configured device identity, endpoint,
credential, Runtime owner, platform and upstream MCP session. Replacing any part
of a binding invalidates existing handles. A dropped backend MCP session also
fails explicitly; it is not silently recreated for existing work. There is no
cross-machine task migration, fallback device or automatic command replay.

An uncertain response after dispatch returns `OPERATION_OUTCOME_UNKNOWN` and
instructs the caller to inspect the same device before repeating an operation.
Offline/disabled devices do not block operations on their peers. Credentials are
bound to configured HTTPS endpoints; redirects are not followed.

The fixed minimal tool surface contains seven tools, including `list_devices`.
Subagent management, host widgets, resources and artifact URL proxying are not
exposed. Existing local shell authority and allowed-root enforcement remain with
each Runtime; the Gateway does not turn shell commands into a filesystem sandbox.

## MCP and state

`/mcp` implements the Streamable HTTP JSON response transport, with negotiated MCP
versions `2025-11-25`, `2025-06-18` and `2025-03-26`. It supports initialization,
notifications, ping, tool discovery/calls and frontend session deletion. It does
not advertise server-initiated notifications or a persistent GET event stream;
GET returns 405. Backend POST event streams are parsed without replaying calls.
Tool calls retain their MCP `_meta`, including the host conversation scope.

The tool input/output contracts in `runtime-catalog.json` were captured from this
checkout's Personal Runtime on official stable 1.0.8. Fleet adds explicit device
selection, opaque process handles and schema-valid structured routing errors.
An upstream contract change requires reviewing this catalog against a real
Runtime, rather than adding a generic passthrough tool.

Frontend MCP leases expire after one idle hour. Device connections and routing
records live in Durable Object storage, so a Worker restart does not reassign work.
Workspace/process handles expire after seven days. Expired records are reclaimed
when allocating handles; no background task system is added. Capacities are 256
frontend sessions, 4,096 workspace handles and 8,192 process handles. Routing
capacity is reserved before opening a workspace or dispatching a command.

## Cloudflare target and binding configuration

The selected connector is **Primary**, verified read-only on 2026-10-22:

- Account: `4498bbe09d0c6dc868f53aff6391ca6e`.
- Active zone: `568920429.xyz`.
- Independent Worker: `personal-devspace-fleet`.
- Durable Object binding/class: `FLEET` / `PersonalFleet`, SQLite migration `v1`.
- Prepared custom domain: `personal-devspace-fleet.568920429.xyz`.

The target is recorded in `wrangler.jsonc`. This development step does not create
cloud resources or DNS records. At deployment, re-check the exact hostname for
existing records; never replace a different service. The gateway has its own
secrets and Durable Object namespace and never reuses Team or Windows MCP state.

Two Cloudflare secrets are required:

- `FLEET_CLIENT_TOKEN`: a new private bearer token, at least 32 printable non-space
  characters, used by the single host/plugin connection.
- `FLEET_DEVICE_BINDINGS`: a private JSON array following `devices.example.json`.
  Each device needs a unique id, binding id, HTTPS `/mcp` endpoint and API token.
  `runtimeOwner` is the exact 20-character owner from that endpoint's
  `/personal-healthz`; it is checked before tools are dispatched. This is local
  installation ownership, not a hardware attestation.

Generate each binding id once from random bytes and preserve it when reconnecting
the same installation. Device and Fleet credentials must differ. A token rotation
or endpoint/owner replacement deliberately requires new workspace handles. Bind
only user-controlled, independently authenticated Runtime endpoints. The Gateway
does not create or reconfigure tunnels, expand allowed roots, install agents, or
change Lecoo's running instance.

Put actual values only in Cloudflare secrets or the ignored local `.dev.vars`.
The committed examples intentionally fail validation. The local Node test adapter
can opt into loopback HTTP; the deployed Worker cannot. No local Runtime API token
is packaged into the Worker bundle.

## Build and verify

From this directory:

```sh
npm ci
npm test
npm run build
npm run test:worker
npm run test:runtime
```

`build` is a Wrangler dry run. It produces `.build/worker.js` without publishing a
Worker, creating bindings or modifying DNS. `test:worker` uses real workerd and
SQLite Durable Object storage, with deterministic backend fixtures deliberately
sharing local ids. It covers concurrent calls, frontend lease persistence,
process routing after Worker restart, device rebinds and offline isolation.

`test:runtime` needs this repository's root dependencies and built `dist/` (run
`npm ci` and `npm run build` at the repository root first). It runs the complete
MCP client → real Worker/Durable Object → two real isolated DevSpace Runtime path:
files, concurrent commands, process polling, allowed-root rejection and one
offline backend. Both fixtures run on the current OS. This is not a claim of
physical Windows/Mac dual-machine or ChatGPT connector acceptance.

For a local manual run, privately fill `.dev.vars` from the example, then use
`npm run dev`. No permanent service should be launched from an MCP command tree.

## Third-step acceptance

After deploying the prepared resources with the selected Cloudflare connection,
bind the independently reachable Mac/Lecoo endpoints and configure one ChatGPT
plugin/connector with the Fleet `/mcp` endpoint and Fleet credential. Verify on
the actual devices: concurrent commands, host reconnect, gateway restart, one
device offline, binding replacement rejection and no cross-machine migration.
Cloudflare publication, physical-device binding and ChatGPT integration remain
separate from the local development checks above.
