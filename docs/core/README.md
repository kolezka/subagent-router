---
block: core
doc: README
verified_against: 0480ec2e5403d400cd3e1252fa5886923a01b062
verified_on: 2026-09-08
owns:
  - src/core/types.ts
  - src/core/route.ts
  - src/core/config.ts
  - src/core/catalog.ts
  - src/core/errors.ts
  - src/core/hash.ts
  - src/io/environment.ts
  - src/io/store.ts
  - src/io/cleanup.ts
depends_on: []
---

# Core

`verified_against` names the commit every claim in this block was checked against; a later commit
is not covered until the stamp is refreshed.

## What this block is

The runtime-agnostic routing decision, config/snapshot parsing, the model catalog, and the file
store that loads and commits config/snapshot state. [verified] `../../src/index.ts` re-exports
exactly these modules as the public `./core` entrypoint, with a comment that it must stay free of
Bun globals and `node:` imports.

`src/io/environment.ts` and `src/io/store.ts` live outside `src/core/` but belong here: they are
the only readers/writers of config and snapshot state, and `catalog`, `agents`, and `transport` all
depend on them rather than touching the filesystem directly.

## Usable now

`resolveRoute`, `buildCatalog`, `parseOperatorConfig`, `parseSnapshot`, and the hash helpers work
fully offline, in Node or Bun, with no client measurement required. This is not a claim about
native client support; that lives in [agents](../agents/README.md) and
[transport](../transport/README.md).

## See also

[CONTRACTS.md](CONTRACTS.md), [INVARIANTS.md](INVARIANTS.md), [GAPS.md](GAPS.md),
[OPERATIONS.md](OPERATIONS.md), [../catalog/README.md](../catalog/README.md),
[../agents/README.md](../agents/README.md), [../transport/README.md](../transport/README.md)
