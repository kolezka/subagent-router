---
block: catalog
doc: README
verified_against: null
verified_on: 2026-09-08
owns:
  - src/catalog/discovery.ts
  - src/catalog/sync.ts
depends_on:
  - core
---

# Catalog

Same caveat as [core](../core/README.md): no commit exists yet for this working tree;
`verified_against` is null on purpose.

## What this block is

Model discovery against the configured gateway's models endpoint, and `synchronize`, which turns a
discovery result into a persisted `models.lock.json` snapshot via
[core's `io/store`](../core/README.md). Discovery never follows a redirect, never invents
pagination state, and never writes anything; only `synchronize` writes, and only through
`commitState`.

## Usable now

Fully usable offline against any HTTP-speaking fixture or gateway, independent of any client
capability measurement. `discoverModels`, `checkDiscoveryConnectivity`, and `synchronize` are plain
async functions with no native-client dependency.

## Boundary

`discoverModels` takes a `FetchLike`, never a bare URL string: it is transport-agnostic and does
not know whether it is talking to a real gateway or a test double. It never calls the gateway's
forwarding endpoint; that credential channel is deliberately separate (see
[core/CONTRACTS.md](../core/CONTRACTS.md), `resolveSource`).

## See also

[CONTRACTS.md](CONTRACTS.md), [INVARIANTS.md](INVARIANTS.md), [GAPS.md](GAPS.md),
[OPERATIONS.md](OPERATIONS.md)
