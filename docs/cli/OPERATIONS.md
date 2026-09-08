---
block: cli
doc: OPERATIONS
verified_against: 688d1736a12a96dc35cb444cd93405b38b0aa77f
verified_on: 2026-09-08
---

# CLI operations

Local, offline-first usage. Nothing here starts or claims a native client integration; see
GAPS.md.

## Build once

```sh
bun install --frozen-lockfile
bun run build
```

`dist/cli.js` is the built executable (`package.json`'s `bin.subagent-router`). Every example
below assumes it exists; from source, run `bun src/bun.ts <args>` instead.

## First sync (writes `models.lock.json`)

```sh
GATEWAY_URL="https://gateway.example.internal/v1" \
MODELS_AUTH="<discovery-key>" \
  bun dist/cli.js models sync
```

`--dry-run` shows the diff without writing. `--allow-empty` accepts a genuinely empty catalog
(otherwise an empty discovery result is `sync-empty`, exit 1, and nothing is written).

## Describe a model

```sh
bun dist/cli.js models describe gateway/exact-model-id --text "Slow, careful reviewer model."
```

`--file <path>` reads the text from disk instead; `--clear` removes only the description.

## Preview a route (no agent runs, no network)

```sh
bun dist/cli.js route preview --client claude-code --agent explorer --json
```

Add `--model <ref>` or `--parent-model <model>` to simulate an explicit selection.

## Check config and catalog consistency

```sh
bun dist/cli.js config check
```

Exit 2 with a non-empty `problems` list means at least one role references an unknown agent or an
unknown `routeOverride`.

## Export a client's config (dry-run first, then write)

```sh
bun dist/cli.js config export --client opencode --output ./export --dry-run --json
# inspect the plan, then:
bun dist/cli.js config export --client opencode --output ./export
```

`--output` is required and resolved relative to the current directory. A second export to the
same `--output` requires `--force`; an `--output` that overlaps any client's native agent
directory is always refused, `--force` included. The written artifacts are references for manual
integration (see CONTRACTS.md); nothing is merged into an active `settings.json`, `opencode.json`,
or `config.toml` automatically.

## Diagnose local setup

```sh
bun dist/cli.js doctor          # offline: config, snapshot, per-client capability status
bun dist/cli.js doctor --connect # adds one real discovery connectivity check
```

## Run the local HTTP handler

```sh
GATEWAY_URL="https://gateway.example.internal/v1" \
  bun dist/cli.js serve --claude-version "<measured-version>" --port 8787
```

Refuses to start on a `pending` capability or transport profile (`unsupported-path`, exit 1); see
[../poc.md](../poc.md) for the fuller local-demo walkthrough and
[../gateways/cliproxyapi.md](../gateways/cliproxyapi.md) for a concrete external gateway.
