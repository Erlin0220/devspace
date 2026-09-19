# Desktop snapshot provenance

One-time source: `Erlin0220/team-devspace`, accepted desktop release 0.2.6,
commit `15ce088b890142eb7922c156e01aa637b700cb24`.

| Snapshot source | Personal adaptation |
| --- | --- |
| `client/local-control.mjs` | Loopback capability, stable-port retry/fallback and origin binding; the capability file is the single durable endpoint owner |
| `client/desktop-controller.mjs` | Serialized operations, stale-refresh rejection, safe observers and expiring notices |
| `client/state.mjs` | Private atomic JSON/file primitives only |
| `client/control.*` | Overview/settings/update/diagnostic layout and visual tokens; plain DOM, no new framework |
| `platform/windows/tds-launcher.c` | Independent Personal GUI launcher, owned Job Object and optional log sink |
| `native/tray/src/main.rs`, `Cargo.toml` | Independent Personal tray, native event loop and JSON protocol |
| `native/macos/TeamDevSpaceUI.swift` | Tray-only AppKit frontend; enrollment forms removed |
| `native/tray/zig-as.c` | Standalone build-time assembler adapter |

No Team executable, installed path, shared state, updater endpoint, gateway,
authorization service or enterprise schema is loaded at runtime. Build tools may
be supplied through ordinary `CARGO`/`ZIG` environment paths; this is not a product
dependency on the repository that originally cached those compilers.

The user owns the source snapshot. Its upstream DevSpace/MCP/Pi and native library
licenses remain applicable; upstream `LICENSE`, Cargo.lock and npm lock metadata
are retained. This is not a claim that Team DevSpace is a public upstream package.
