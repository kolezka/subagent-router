# Catalog: operations

## Run the tests

    bun test tests/catalog

Real-gateway-shaped coverage (CLIProxyAPI, real loopback, not mocked):

    bun test tests/integration/cliproxyapi.test.ts

## Use from code

    import { discoverModels, checkDiscoveryConnectivity } from './src/catalog/discovery';
    import { synchronize } from './src/catalog/sync';

    const result = await synchronize(configPath, {
      env, fetch, now: () => new Date(), allowEmpty: false, dryRun: false,
    });

`synchronize` reads and writes through [core's `io/store`](../core/OPERATIONS.md); pass
`dryRun: true` to see `added`/`changed`/`missing` without writing `models.lock.json`.

## CLI

`models sync` and `models describe` dispatch is wired in `src/cli/main.ts` ([verified], direct
read). Full CLI usage is documented in `docs/cli`, owned separately; see
[../transport/OPERATIONS.md](../transport/OPERATIONS.md) for what dispatch is confirmed wired.
