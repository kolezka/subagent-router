# Core: operations

Everything here is a plain function call; there is no CLI wired to core in isolation. Full CLI
usage is owned separately by `docs/cli` (see [../transport/OPERATIONS.md](../transport/OPERATIONS.md)
for what is already wired today).

## Run the tests

    bun test tests/core tests/io

## Use from code

    import { parseOperatorConfig, parseSnapshot } from './src/core/config';
    import { buildCatalog, resolveModel } from './src/core/catalog';
    import { resolveRoute } from './src/core/route';
    import { loadState, commitState } from './src/io/store';
    import { resolveSource, validateSource } from './src/io/environment';

`loadState(configPath)` reads and validates both files and returns a `generation` hash.
`commitState(configPath, base, { snapshot })` (or `{ config }`) writes one of them back, rejecting
a stale `base`. Neither function talks to a network or a gateway.

## Import from Node (no Bun)

The published `./core` entrypoint (`dist/core.js` after `bun run build`) is plain ESM importable by
`node`. [verified] [../../tests/package.test.ts](../../tests/package.test.ts) builds it and
imports it under real `node`, then exercises `resolveRoute`/`buildCatalog` end to end.
