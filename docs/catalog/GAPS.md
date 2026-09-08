# Catalog: gaps

Catalog carries no M1-M10 measurement of its own; those are client-side (see
[../agents/GAPS.md](../agents/GAPS.md), [../transport/GAPS.md](../transport/GAPS.md)). Its own
gaps are about the gateway contract and staleness reporting, not native support.

- Discovery is tested against a fake `FetchLike` in
  [../../tests/catalog/discovery.test.ts](../../tests/catalog/discovery.test.ts) and, at a real
  loopback level, in
  [../../tests/integration/cliproxyapi.test.ts](../../tests/integration/cliproxyapi.test.ts) (one
  specific gateway shape, CLIProxyAPI). Neither proves any other gateway's models endpoint matches
  the assumed `{data, has_more, next_cursor}` contract; a different real gateway needs its own
  contract test before `synchronize` against it is trusted.
- `checkDiscoveryConnectivity` (the `doctor --connect` producer) has no dedicated test in this
  block; it is only exercised through `discoverModels`'s shared `fetchPage` path.
- No code path in this block, or in [core](../core/GAPS.md), enforces `staleAfterSeconds`; a
  snapshot can be arbitrarily old with no warning from `synchronize` or from discovery.

None of the above blocks catalog's offline usability; they are gaps in gateway-contract coverage
and staleness reporting, not in the pure sync/discovery logic itself.
