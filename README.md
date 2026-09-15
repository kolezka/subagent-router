# subagent-router

`subagent-router` is a project for a small, independent package that does explicit model routing for native subagents of Claude Code, OpenCode, and Codex.

Status: 0.1.0. The packaged `serve` command routes native Claude Code subagents to explicitly
chosen upstream models while the parent keeps its own model. An external gateway, e.g. 9router or
OmniRoute, handles the conversation with the provider, without a dependency on
`@the-next-ai/ai-gateway`. OpenCode and Codex adapters exist in the source tree but are not part of
what 0.1.0 claims.

- [Changelog](CHANGELOG.md)
- [Documentation index](docs/README.md)
- [License](LICENSE) (source-available, noncommercial use only)
- [Draft of the model routing specification](docs/superpowers/specs/2026-09-06-subagent-model-routing-design.md)

## Quickstart from a clean checkout

```sh
bun install --frozen-lockfile
bun run build

export ROUTER_GATEWAY_URL="https://YOUR-GATEWAY/v1"
export ROUTER_MODELS_AUTH="<model-discovery-token>"
export ROUTER_GATEWAY_HEADERS='{"Authorization":"Bearer <gateway-token>"}'

bun dist/cli.js web
```

Open `http://127.0.0.1:8788` and work down the left side: **Setup** detects your installed clients
and writes the first config, **Gateway** names the environment variables the credentials come from,
**Models** runs the catalog sync, **Routing** picks the child models, **Install** generates the
Claude Code bundle and starts the router. **Status** and **Logs** show what the router is doing.

Export the gateway variables in the shell that starts the console. The config holds variable NAMES;
the values stay in the process environment and never enter a config file, a bundle or an API
response. The console tells you which named variable is still missing.

[Full description of the console](docs/web/README.md).

### The same thing from the CLI

```sh
cp examples/minimal-router/subagent-router.json ./subagent-router.json
bun dist/cli.js models sync --config ./subagent-router.json
bun dist/cli.js config check --config ./subagent-router.json
bun dist/cli.js serve --config ./subagent-router.json --claude-version "$(claude --version)" --host 127.0.0.1 --port 8787
```

`models sync` is required before `serve`. The snapshot shipped in the example is a placeholder and
`config check` reports `snapshot-source-mismatch` until you replace it with your own gateway's
catalog. Pass the version number only to `--claude-version`, for example `2.1.270`.

## Connect your Claude Code

The console's **Install** view generates the integration files into a directory you name. So does
`install` on the command line. Neither edits your installed Claude Code configuration.

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

## Install from a marketplace

The repository is also a Claude Code plugin and its own marketplace. In Claude Code:

```text
/plugin marketplace add kolezka/marketplace
/plugin install subagent-router@kolezka
```

`kolezka/subagent-router` works as a marketplace too, if you prefer the single-repository catalog.

The plugin adds a session-start check, `/subagent-router:status`, `/subagent-router:setup`, and the
router CLI on the Bash tool's `PATH`. It does not route by itself: a plugin cannot set
`ANTHROPIC_BASE_URL` for the session, so the connection still comes from the bundle above or from
the variable. Details in [docs/plugin/README.md](docs/plugin/README.md).

Select a child model with a marker on the first line of the Agent prompt:

```
<subagent-router v="1" model="terra"/>
Implement the requested change.
```

[Full example with both aliases](examples/minimal-router/README.md).

## What 0.1.0 does not cover

- OpenCode and Codex clients. The adapters are present but unmeasured, so no support is claimed.
- Authentication on the web console. Keep it on loopback; off loopback it forces itself read-only.
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

## Web console (local)

`subagent-router web` runs a local console (default `http://127.0.0.1:8788`, alias `ui`). It is a
Svelte app in `src/web/app`, served by `src/web/*`, and it manages the whole installation: it
detects installed clients and local gateways, writes the first config, edits the model catalog and
the routing rules, generates the Claude Code bundle, starts and stops the router, and streams its
events. The console listens separately from `serve` and never forwards traffic to the gateway.

```sh
bun run build
bun dist/cli.js web --port 8788
```

`--config` is optional; a machine with no config is the console's starting point, not an error.
Writes need a same-origin JSON request and the config generation you last read, so two open tabs
cannot overwrite each other. `--read-only` refuses every write, and a bind off loopback forces
read-only, because the console has no authentication.

Contract, invariants and limitations: [docs/web/README.md](docs/web/README.md).

## License

`subagent-router` is released under the [PolyForm Noncommercial License 1.0.0](LICENSE)
(SPDX: `PolyForm-Noncommercial-1.0.0`). The source is public: you may read it, run it, change it
and redistribute it, as long as the purpose is noncommercial.

Permitted without asking:

- personal use, hobby projects, private study, research and experiments
- use by charities, schools, universities, public research bodies and government institutions
- forks, patches and derived works, under the same terms

Not permitted: any use for a commercial purpose, including use inside a for-profit company, use in
a paid product or service, and use in consulting work done for a fee.

This is a source-available license, not an OSI-approved open source license. The Open Source
Definition does not allow a restriction on the field of use, so the noncommercial limit puts this
project outside that definition.

For a commercial license, contact the maintainer through
[GitHub](https://github.com/kolezka/subagent-router) before you use the project at work.
