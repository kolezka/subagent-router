# Core: gaps

Core has no client-specific M1-M10 measurement of its own; it is consumed by
[catalog](../catalog/GAPS.md), [agents](../agents/GAPS.md), and
[transport](../transport/GAPS.md), which do carry pending measurements. Nothing here implies those
are resolved.

- `config.modelSource.staleAfterSeconds` is validated as a positive integer in
  [../../src/core/config.ts](../../src/core/config.ts) and now read back against
  `snapshot.fetchedAt` by `isSnapshotStale` (same file). `doctor` and `config check` report a
  `snapshot-stale` warning when it fires; this is advisory only and never fails either command or
  changes its exit code. `route preview` and `serve` do not consult it at all: a stale snapshot
  still routes and still starts a server, unchanged. See
  [cli](../cli/CONTRACTS.md#config-show--config-check) for the exact commands wired up.
- `resolveRoute`'s `freshDelegation` and `roleDefaultId` inputs are supplied entirely by callers in
  [agents](../agents/GAPS.md) and [transport](../transport/GAPS.md); core cannot itself prove a
  delegation was fresh. That proof chain (a real SubagentStart/PreToolUse hook run, a passed
  M10-freshness) is pending in both of those blocks.
- `LoadedState.generation` changing is proof a write happened, not proof any client observed it.
  Nothing in this block measures client-side reload behavior.

No remaining pending item here should be closed by editing a config value; each needs either a new
consumer wired up in a block above, or a measured producer in another block.
