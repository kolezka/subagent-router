# Catalog: contracts

## discoverModels

Paginates via `cursor` only; rejects a redirect, a repeated cursor (cycle), `has_more: true` with
no `next_cursor`, a duplicate model ID across pages, and a result over `fetchLimit`. Auth failures
(401/403) surface as `discovery-auth` without echoing the credential. [verified] against
[../../src/catalog/discovery.ts](../../src/catalog/discovery.ts).

enforcement: [../../tests/catalog/discovery.test.ts](../../tests/catalog/discovery.test.ts)

## checkDiscoveryConnectivity

Fetches and validates exactly one page; never accumulates, never paginates, never writes. Used for
a real connectivity check, not a substitute for `discoverModels` with `fetchLimit: 1`. [verified]
against [../../src/catalog/discovery.ts](../../src/catalog/discovery.ts) (same file, separate
export).

enforcement: exercised indirectly through the shared `fetchPage` path in
[../../tests/catalog/discovery.test.ts](../../tests/catalog/discovery.test.ts); no dedicated test
for this export exists in this block.

## synchronize

A model missing from a new discovery result is kept as `status: 'missing'`, never dropped, and a
model that reappears goes back to `available`. An empty result requires `allowEmpty`. A changed
`sourceId`, or a changed effective URL under the same `sourceId`, resets the base instead of
carrying old models forward as `missing`. `dryRun` never touches disk. [verified] against
[../../src/catalog/sync.ts](../../src/catalog/sync.ts).

enforcement: [../../tests/catalog/sync.test.ts](../../tests/catalog/sync.test.ts)
