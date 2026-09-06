# Local extensions

This fork keeps local-only integrations behind `src/local-extensions.ts` so upstream DevSpace files stay close to the official tree.

## CodeGraph

CodeGraph is optional and disabled by default. When enabled, DevSpace exposes the read-only `codegraph_explore` tool. The selected workspace root is supplied automatically. If a workspace has not been indexed yet, DevSpace initializes CodeGraph once and retries the exploration.

Environment variables:

- `DEVSPACE_CODEGRAPH=1`
- `DEVSPACE_CODEGRAPH_COMMAND=<command>`
- `DEVSPACE_CODEGRAPH_STARTUP_TIMEOUT_MS=30000`
- `DEVSPACE_CODEGRAPH_TOOL_TIMEOUT_MS=120000`

Persisted `~/.devspace/config.json` keys are `codegraphEnabled`, `codegraphCommand`, `codegraphArgs`, `codegraphStartupTimeoutMs`, and `codegraphToolTimeoutMs`.

## Upgrade rule

Keep new local integrations behind the extension facade instead of importing them directly into `server.ts`. Core upstream files should only contain small generic hooks for extension configuration, tool registration, and lifecycle shutdown.
