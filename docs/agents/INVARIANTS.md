# Agents: invariants

- File scan order is project before user before additional roots; a later root's same-named entry
  is `shadowed: true`, never dropped.
  [../../src/agents/claude-code.ts](../../src/agents/claude-code.ts),
  [opencode.ts](../../src/agents/opencode.ts), [codex.ts](../../src/agents/codex.ts)
- A native inventory can only add or override entries for its own declared client; an entry for a
  different client never leaks into another client's result.
  [../../src/agents/inventory.ts](../../src/agents/inventory.ts)
- `exportConfig` never writes into a client's native config file (`settings.json`,
  `opencode.json`, `config.toml`); it only writes read-only fragments and per-role artifact files
  under an operator-chosen `outputDir`. [../../src/agents/export.ts](../../src/agents/export.ts)
- Export identity fields (secret env name, control-URL env name, client-version env name) are
  always env-var *names*, never resolved values; no secret or runtime URL is ever baked into a
  written artifact.
- A Codex or OpenCode role name is a bounded, path-safe segment (`assertSafePathSegment`) before it
  is joined into an output path; a traversal attempt is rejected before any file is written.
- `dumpToml` supports a fixed, small subset (strings, numbers, booleans, one level of tables); an
  unsupported shape throws rather than silently dropping or mangling a field.
- Both native validators treat a present-but-invalid explicit-model value as an error, never as
  "no selection" that falls through to a role or global default.

Enforcement for each of these lives in [CONTRACTS.md](CONTRACTS.md).
