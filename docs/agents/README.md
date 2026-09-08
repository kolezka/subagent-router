---
block: agents
doc: README
verified_against: 008ed4b05b8b28e89bfbd67d76d1ceaf220c9db0
verified_on: 2026-09-09
owns:
  - src/agents/inventory.ts
  - src/agents/export.ts
  - src/agents/claude-code.ts
  - src/agents/codex.ts
  - src/agents/opencode.ts
  - src/adapters/capabilities.ts
  - src/adapters/opencode.ts
  - src/adapters/opencode-plugin.ts
  - src/adapters/codex.ts
  - src/adapters/codex-hook.ts
depends_on:
  - core
  - catalog  # data-flow only: the models.lock.json snapshot catalog/sync.ts produces, not a code import
---

# Agents

Same rule as [core](../core/README.md): `verified_against` is the commit this block was checked
against.

## What this block is

Two distinct things:

1. **Native mode.** OpenCode and Codex are meant to talk to the external gateway directly, never
   through the HTTP handler in [transport](../transport/README.md). `src/adapters/opencode.ts`,
   `opencode-plugin.ts`, `codex.ts`, and `codex-hook.ts` are guards that run inside those clients
   (an OpenCode plugin hook, a Codex `PreToolUse` hook) and either let a spawn proceed unmodified
   or deny it. They never forward a request themselves.
2. **Agent inventory and export.** `inventory.ts` reads each client's on-disk agent/role
   definitions (Markdown with YAML frontmatter for Claude Code and OpenCode, TOML for Codex);
   `export.ts` writes read-only integration artifacts into an operator-chosen output directory,
   never into a client's native config file.

`src/adapters/capabilities.ts` is the capability-profile loader and gate shared with
[transport](../transport/README.md)'s Claude gates; documented here because native-mode refusal is
its primary consumer.

The dependency on [catalog](../catalog/README.md) is data-flow, not an import edge: `export.ts`
imports `buildCatalog` from `../core/catalog` and reads the `models.lock.json` snapshot that
`catalog/sync.ts` produces (via [core](../core/README.md)'s `loadState`). [verified] grep of
`src/agents/export.ts`: no import from `../catalog/discovery` or `../catalog/sync`.

## Profile refusal, by construction

Matching child-spawn hooks fail closed when native runtime context or measured capabilities are
missing. Other tools are left unchanged. No measured production resolver exists for either
client today (see [GAPS.md](GAPS.md)); support needs real M6/M6-runtime (OpenCode) or M7 (Codex)
evidence, not a config flag.

## See also

[CONTRACTS.md](CONTRACTS.md), [INVARIANTS.md](INVARIANTS.md), [GAPS.md](GAPS.md),
[OPERATIONS.md](OPERATIONS.md)
