---
block: cli
doc: README
verified_against: null
verified_on: 2026-09-08
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
subsystem in `src/agents/export.ts`. `verified_against` is `null` because this describes the
uncommitted state of this worktree (branch `feat/complete-routing`), not a landed commit; no
commit SHA is invented here. Re-verify and fill in `verified_against` once this work is committed.

## What exists today

- Read-only inspection: `models list`, `models show`, `agents list`, `agents show`, `route
  preview`, `config show`, `config check`, `doctor`.
- Writes: `models sync`, `models describe`, `config export`, `doctor --connect`, `serve`.

All of it is local: config, snapshot and native agent file inspection. `models sync` and `doctor
--connect` are the only commands that touch the network. `serve` starts a real HTTP listener, but
does not itself prove a native client (Claude Code, OpenCode, Codex) talks to it correctly; see
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

See [CONTRACTS.md](CONTRACTS.md) for exact per-command behavior and [INVARIANTS.md](INVARIANTS.md)
for what must hold across all of them.

## Related documentation

- [../poc.md](../poc.md): local HTTP demo and the external-gateway entry point `serve` uses.
- [../gateways/cliproxyapi.md](../gateways/cliproxyapi.md): CLIProxyAPI as a concrete external
  gateway.
- [../superpowers/specs/2026-09-06-subagent-model-routing-design.md](../superpowers/specs/2026-09-06-subagent-model-routing-design.md):
  the design this CLI implements.

A separate integration slice's documentation blocks now exist alongside this one, each with the
same `verified_against: null` caveat (uncommitted worktree, no commit to check against yet):

- [../core/README.md](../core/README.md): routing core, config/snapshot parsing, catalog
  resolution, hashing.
- [../catalog/README.md](../catalog/README.md): discovery and `synchronize`, which this CLI's
  `models sync` wraps.
- [../agents/README.md](../agents/README.md): native agent inventory and adapters this CLI's
  `agents list`/`agents show`/`config export` read.
- [../transport/README.md](../transport/README.md): the HTTP handler this CLI's `serve` wraps.
