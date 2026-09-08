# Core: gaps

Core has no client-specific M1-M10 measurement of its own; it is consumed by
[catalog](../catalog/GAPS.md), [agents](../agents/GAPS.md), and
[transport](../transport/GAPS.md), which do carry pending measurements. Nothing here implies those
are resolved.

- `config.modelSource.staleAfterSeconds` is validated as a positive integer in
  [../../src/core/config.ts](../../src/core/config.ts), but [verified] (grep across `src/` in this
  worktree) no code path reads it back against `snapshot.fetchedAt`. No command reports catalog
  staleness; setting the field has no observable effect beyond schema validation today.
- `resolveRoute`'s `freshDelegation` and `roleDefaultId` inputs are supplied entirely by callers in
  [agents](../agents/GAPS.md) and [transport](../transport/GAPS.md); core cannot itself prove a
  delegation was fresh. That proof chain (a real SubagentStart/PreToolUse hook run, a passed
  M10-freshness) is pending in both of those blocks.
- `LoadedState.generation` changing is proof a write happened, not proof any client observed it.
  Nothing in this block measures client-side reload behavior.

No pending item here should be closed by editing a config value; each needs either a new consumer
of `staleAfterSeconds`, or a measured producer in another block.
