---
block: cli
doc: CONTRACTS
verified_against: null
verified_on: 2026-09-08
---

# CLI contracts

Public behavior this block commits to. Cited by file and symbol, not by line number.

## Entry point

`runCli(argv: readonly string[], deps: CliDeps): Promise<0 | 1 | 2>` (`src/cli/main.ts`).
`--version`/`--help` exit 0. An unknown top-level command or an unmatched command path exits 2.
Otherwise the matched handler's result is rendered (`render`, `src/cli/output.ts`) and its own
exit code returned.

`CliDeps` (`src/core/types.ts`) is fully injected: `cwd`, `home`, `env`, `stdout`/`stderr`,
`isTTY`, `fetch`, `fetchAdapter`, `loadProfile`, `loadTransportProfile`, `now`. No command reads
`process.env`/`process.cwd`/global `fetch` directly; `src/bun.ts`'s `realDeps()` is the only place
that wires these to the real process.

## Exit codes

- `0`: success, including a `--dry-run` that reports a diff/plan without writing.
- `2`: usage, configuration or selection problem. `RouterError` codes starting with `config-`,
  `snapshot-`, `usage-`, the exact codes `unknown-model` and `agent-unknown`, and the export-specific
  codes `export-native-root`, `export-collision`, `export-unsafe-name`, `export-unsupported-value`,
  `export-snapshot-missing` (`isUsageOrConfigCode`/`EXPORT_USAGE_CODES`, `src/cli/main.ts`).
- `1`: everything else (I/O, network, an unclassified `RouterError`, an internal invariant such as
  `export-plan-invariant` or `export-package-root-missing`).

`--json` on stdout is machine data only (`JSON.stringify(payload)` plus a trailing newline);
otherwise `human()` renders text. Every string on stderr, and every human-mode string that embeds
untrusted input, goes through `escapeControl` (`src/cli/output.ts`) first, so a value copied from a
model ID, agent name or file path can never inject a terminal control sequence.

## `models sync [--dry-run] [--allow-empty]`

Discovers models from the configured gateway endpoint (`synchronize`, `src/catalog/sync.ts`) and
writes `models.lock.json` unless `--dry-run`. An empty discovered list without `--allow-empty` is
`sync-empty`, exit 1, and writes nothing. Payload: `{ added, changed, missing, dryRun, fetchedAt }`.

## `models describe <id-or-alias> (--text <t> | --file <path> | --clear)`

Exactly one mode. Writes or clears `modelOverrides[id].description` only; every other override
field is preserved. Works on a model with snapshot status `missing` (the description is kept, the
model stays disabled). Never touches the snapshot.

## `agents list --client <c>` / `agents show <name> --client <c>`

Read the agent inventory for one client (`readAgentInventory`, `src/agents/inventory.ts`) using
`cwd`/`home`/`env`/the client's `configRoot`/`--agents-dir` (repeatable, collected into
`additionalRoots`). Shows hidden, shadowed and unavailable entries rather than hiding them behind
one catalog-wide error.

## `route preview --client <c> --agent <name> [--model <ref>] [--parent-model <m>]`

Offline simulation only (`previewRoute`, `src/cli/read.ts`): never runs an agent, never calls
`deps.fetch`. `assumptions.freshDelegation` is always `true` and is a stated simulation assumption,
not a measurement. Payload includes `generation` (see INVARIANTS.md) and a `RouteDecision`
(`src/core/route.ts`). A selection error (`decision.kind === 'error'`) is exit 2, not 0.

## `config show` / `config check`

`config show`: `{ config, generation }`. Config in storage form only: env var *names*, never
resolved secret values, so it can never leak a value even verbatim.

`config check`: validates every role's agent reference and (when a snapshot exists) its
`routeOverride` against the catalog. `{ problems: string[], generation }`. Exit 2 iff
`problems.length > 0`.

## `config export --client <c> --output <dir> [--dry-run] [--force]`

CLI wiring for `exportConfig` (`src/agents/export.ts`); see that file for the full contract. The
CLI resolves `--output` relative to `cwd`, builds the client's agent inventory through the same
`cwd`/`home`/`env`/`configRoot`/`additionalRoots` recipe `agents list`/`agents show` use for that
client, and passes `{ cwd, home, env, additionalRoots }` through unchanged as
`ExportOptions.resolverContext`. `catalogRequired` is always `false` from the CLI; `exportConfig`
itself forces a catalog for `opencode`.

Per-client output, all under `<output>/<client-dir>/`:

- `claude-code` -> `claude/`: a read-only `settings-fragment.json` naming the built
  `dist/claude-hook.js`, absolute config/profile/sidecar paths, and only the *names* of the
  control-URL and secret env vars, never values. The active `settings.json` is never touched.
- `opencode` -> `opencode/`: one `agents/<role>@<alias>.md` per described, enabled model variant
  (`opencodeVariants`), a `plugin-fragment.json` naming `dist/opencode-plugin.js`, and a sidecar
  with `providerId` and an `upstreamModel` per alias.
- `codex` -> `codex/`: one `agents/<role>.toml` per role with a native counterpart (merged with
  `routeOverride`, encoded through this package's own `dumpToml`, never `Bun.TOML.stringify` which
  does not exist in Bun 1.3.11), an optional `model_catalog.json` when
  `harness.codex.emitModelCatalog` is set, and a `pretooluse-fragment.json` naming
  `dist/codex-hook.js`. Explicitly labeled naming-only: PreToolUse wiring is unmeasured (M7
  pending).

`--dry-run` returns the exact plan (including the sidecar) without writing. Every plan is written
atomically: staged into a temp directory under the resolved output directory, then renamed into
place; a prior artifact set is only replaced (via a backup-rename-restore-on-failure sequence) with
`--force`.

## `doctor [--connect]`

Plain `doctor` never calls `deps.fetch`; `network: false` in the payload. `--connect` adds one
extra discovery-connectivity check (`checkDiscoveryConnectivity`) on top of the same offline
report; a connectivity failure is caught, classified by `isUsageOrConfigCode`, and reported in the
payload rather than discarding the rest of the report.

## `serve [--port <n>] [--host <h>] [--claude-version <v>]`

Loads config/snapshot once (`startServer`, `src/cli/serve.ts`), resolves and validates the source,
loads the client capability profile and transport profile. Refuses to bind at all
(`unsupported-path`, exit 1) unless the loaded client profile is for `claude-code` and its status
is `supported` -- before the transport profile check, before building the handler, before
`Bun.serve`. Only once that preflight passes does it wire the shared `createHandler`
(`src/transport/handler.ts`) into a real `Bun.serve` listener. State is frozen at start: a later
edit to the config file is not observed by a running instance. Default port `8787`, host
`127.0.0.1`, matching the existing `scripts/poc-serve.ts` convention (whose own
`assertProductionCapabilityProfile` additionally rejects synthetic/hermetic version strings; that
extra production-only rule is not part of `startServer` itself, so DI synthetic `supported`
profiles keep working for this module's own hermetic tests). This preflight is standalone
`serve`'s own gate; `createHandler`'s per-request capability gates (`assertCapability`) are
unchanged and are still the only gate an embedder using `createHandler` directly goes through.
