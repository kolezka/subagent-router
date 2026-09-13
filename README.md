# subagent-router

`subagent-router` is a project for a small, independent package that does explicit model routing for native subagents of Claude Code, OpenCode, and Codex.

Status: a local PoC of the HTTP layer and a local CLI are available (see the "CLI (local)" section below). Support for native clients still needs measurement. An external gateway, e.g. 9router or OmniRoute, handles the conversation with the provider, without a dependency on `@the-next-ai/ai-gateway`.

- [Documentation index](docs/README.md)
- [Draft of the model routing specification](docs/superpowers/specs/2026-09-06-subagent-model-routing-design.md)

## Running the PoC

```sh
bun install --frozen-lockfile
bun run poc:demo
```

[PoC instructions and limitations](docs/poc.md). The demo uses a local test gateway and a synthetic client profile.

## CLI (local)

The package also ships a local CLI (`src/cli/*`, built as `dist/cli.js`): read-only inspection
(`models list/show`, `agents list/show`, `route preview`, `config show/check`) plus writes
(`models sync`, `models describe`, `config export`, `doctor --connect`, `serve`). Everything is
local and offline except `models sync` and `doctor --connect`.

See [docs/cli/README.md](docs/cli/README.md) for the command index, [docs/cli/CONTRACTS.md](docs/cli/CONTRACTS.md)
and [docs/cli/INVARIANTS.md](docs/cli/INVARIANTS.md) for exact behavior, and
[docs/cli/OPERATIONS.md](docs/cli/OPERATIONS.md) for runnable examples. Native client integration
(Claude Code, OpenCode, or Codex actually loading an exported config) is still unmeasured; see
[docs/cli/GAPS.md](docs/cli/GAPS.md).

## Web UI (local)

`subagent-router ui` runs a local, read-only web console (default
`http://127.0.0.1:8788`). It shows the model catalog, the agent inventory, a simulation of routing
decisions, the `config check` result, and the `doctor` report. The console listens separately from
`serve`, does not forward traffic to the gateway, and does not use the network.

```sh
bun run build
bun dist/cli.js ui --config ./subagent-router.json --port 8788
```

Contract and limitations description: [docs/cli/UI.md](docs/cli/UI.md).
