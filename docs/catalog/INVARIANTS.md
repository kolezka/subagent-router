# Catalog: invariants

- Codepoint order, not locale collation, decides the sort of `added`/`changed`/`missing` and of
  `snapshot.models`. [../../src/catalog/sync.ts](../../src/catalog/sync.ts)
- An alias is assigned once, at first discovery of an ID; a later sync of the same ID keeps its
  existing alias even if the naming scheme would otherwise produce a different one.
- A pagination cursor is compared against every cursor already visited in the same
  `discoverModels` call, not only the previous one, so a longer cycle is still caught.
  [../../src/catalog/discovery.ts](../../src/catalog/discovery.ts)
- `synchronize` never writes when the fetch itself throws: a bad JSON body, an auth failure, or a
  schema violation leaves the on-disk snapshot byte-for-byte unchanged.
- A model ID is compared exactly as received; discovery never trims, lowercases, or otherwise
  normalizes an upstream ID before using it as a map key.

Enforcement for each of these lives in [CONTRACTS.md](CONTRACTS.md).
