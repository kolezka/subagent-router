---
block: catalog
doc: README
verified_against: 0480ec2e5403d400cd3e1252fa5886923a01b062
verified_on: 2026-09-08
owns:
  - src/catalog/discovery.ts
  - src/catalog/sync.ts
depends_on:
  - core
---

# Catalog

Same rule as [core](../core/README.md): `verified_against` is the commit this block was checked
against.

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
