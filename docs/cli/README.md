---
block: cli
doc: README
verified_against: 008ed4b05b8b28e89bfbd67d76d1ceaf220c9db0
verified_on: 2026-09-09
owns:
  - src/cli/main.ts
  - src/cli/args.ts
  - src/cli/read.ts
  - src/cli/write.ts
  - src/cli/serve.ts
  - src/cli/output.ts
  - src/cli/version-probe.ts
  - src/agents/export.ts
depends_on:
  - core
  - catalog
  - agents
  - transport (serve command only)
---

# CLI

This block is `subagent-router`'s command-line surface: `src/cli/*` plus the config-export
subsystem in `src/agents/export.ts`. `verified_against` names the commit every claim in this
block was checked against, file by file and test by test; a later commit is not covered until the
stamp is refreshed.

## What exists today

- Read-only inspection: `models list`, `models show`, `agents list`, `agents show`, `route
  preview`, `config show`, `config check`, `doctor`.
- Writes: `models sync`, `models describe`, `config export`, `doctor --connect`, `serve`, `install`.

Inspection and config export use local config, snapshots and native agent files. `models sync`
and `doctor --connect` contact the model source; `serve` listens for requests and forwards them
to the configured gateway. None of these commands proves native-client compatibility; see
[GAPS.md](GAPS.md).

## Command index

| Command | Network | Writes |
|---|---|---|
| `models list` / `models show <id-or-alias>` | no | no |
| `models sync [--dry-run] [--allow-empty]` | yes | `models.lock.json` (unless `--dry-run`) |
| `models describe <id-or-alias> (--text \| --file \| --clear)` | no | `modelOverrides` in the config file |
| `agents list --client <c>` / `agents show <name> --client <c>` | no | no |
| `route preview --client <c> --agent <name> [--model <ref>] [--parent-model <m>]` | no | no |
| `config show` / `config check` | no | no |
| `config export --client <c> --output <dir> [--dry-run] [--force]` | no | artifact tree under `<dir>/<client>/` (unless `--dry-run`) |
| `doctor [--connect]` | only with `--connect` | no |
| `serve [--port <n>] [--host <h>] [--claude-version <v>]` | per request, via the configured gateway | no |
| `web [--port <n>] [--host <h>] [--read-only]` (alias: `ui`) | only what the console is asked to do | config file and bundles, through the console |
| `install --output <dir> [--client claude-code] [--port <n>] [--host <h>] [--claude-version <v>] [--parent-model <m>] [--dry-run] [--force]` | no | integration bundle under `<dir>` (unless `--dry-run`) |

See [CONTRACTS.md](CONTRACTS.md) for exact per-command behavior and [INVARIANTS.md](INVARIANTS.md)
for what must hold across all of them.

## Related documentation

- [../web/README.md](../web/README.md): the `web` command, a local console that installs,
  configures and watches the router. It is its own block (`src/web/*`) with its own stamp, so
  nothing in the YAML header here covers it.
- [INSTALL.md](INSTALL.md): the `install` command and the Claude Code bundle it generates. Also
  newer than the stamp above, so `src/cli/install.ts` and `src/install/claude-code.ts` are not
  covered by it either.
- [../poc.md](../poc.md): local HTTP demo and the external-gateway entry point `serve` uses.
- [../gateways/cliproxyapi.md](../gateways/cliproxyapi.md): CLIProxyAPI as a concrete external
  gateway.
- [../superpowers/specs/2026-09-06-subagent-model-routing-design.md](../superpowers/specs/2026-09-06-subagent-model-routing-design.md):
  the design this CLI implements.

The other documentation blocks each record their own verified source revision:

- [../core/README.md](../core/README.md): routing core, config/snapshot parsing, catalog
  resolution, hashing.
- [../catalog/README.md](../catalog/README.md): discovery and `synchronize`, which this CLI's
  `models sync` wraps.
- [../agents/README.md](../agents/README.md): native agent inventory and adapters this CLI's
  `agents list`/`agents show`/`config export` read.
- [../transport/README.md](../transport/README.md): the HTTP handler this CLI's `serve` wraps.
