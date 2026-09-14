# subagent-router

`subagent-router` is a project for a small, independent package that does explicit model routing for native subagents of Claude Code, OpenCode, and Codex.

Status: 0.1.0. The packaged `serve` command routes native Claude Code subagents to explicitly
chosen upstream models while the parent keeps its own model. An external gateway, e.g. 9router or
OmniRoute, handles the conversation with the provider, without a dependency on
`@the-next-ai/ai-gateway`. OpenCode and Codex adapters exist in the source tree but are not part of
what 0.1.0 claims.

- [Changelog](CHANGELOG.md)
- [Documentation index](docs/README.md)
- [Draft of the model routing specification](docs/superpowers/specs/2026-09-06-subagent-model-routing-design.md)

## Quickstart from a clean checkout

```sh
bun install --frozen-lockfile
bun run build

cp examples/minimal-router/subagent-router.json ./subagent-router.json
export ROUTER_GATEWAY_URL="https://YOUR-GATEWAY/v1"
export ROUTER_MODELS_AUTH="<model-discovery-token>"
export ROUTER_GATEWAY_HEADERS='{"Authorization":"Bearer <gateway-token>"}'

bun dist/cli.js models sync --config ./subagent-router.json
bun dist/cli.js config check --config ./subagent-router.json
bun dist/cli.js serve --config ./subagent-router.json --claude-version "$(claude --version)" --host 127.0.0.1 --port 8787
```

`models sync` is required before `serve`. The snapshot shipped in the example is a placeholder and
`config check` reports `snapshot-source-mismatch` until you replace it with your own gateway's
catalog. Pass the version number only to `--claude-version`, for example `2.1.270`.

## Connect your Claude Code

`install` generates the integration files into a directory you name. It never edits your installed
Claude Code configuration.

```sh
bun dist/cli.js install --output ./router-bundle --config ./subagent-router.json --claude-version 2.1.270
./router-bundle/claude-router
```

The launcher checks the router, then runs `claude --settings ./router-bundle/settings.json` and
passes your arguments through. The bundle also carries an optional plugin with a session-start
check and a `/subagent-router:status` command. Details and the measured results are in
[docs/cli/INSTALL.md](docs/cli/INSTALL.md).

Without the bundle, one process at a time:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

Select a child model with a marker on the first line of the Agent prompt:

```
<subagent-router v="1" model="terra"/>
Implement the requested change.
```

[Full example with both aliases](examples/minimal-router/README.md).

## What 0.1.0 does not cover

- OpenCode and Codex clients. The adapters are present but unmeasured, so no support is claimed.
- Writes from the web console. The console is read-only.
- Survival of routing across client-side compaction. The decision fires on Claude Code 2.1.270 but
  the client's reactive compactor bailed in every local run, so the phase is unproven here.
- Publishing to a registry. The package stays `private: true`.

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
[docs/cli/OPERATIONS.md](docs/cli/OPERATIONS.md) for runnable examples. Claude Code integration is
measured against a pinned client binary; OpenCode and Codex are not. See
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
