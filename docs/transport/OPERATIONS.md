# Transport: operations

## Run the tests

    bun test tests/transport tests/adapters/claude-code.test.ts tests/adapters/markers.test.ts tests/adapters/correlation.test.ts

Hermetic end-to-end (fake gateway, synthetic profile):

    bun test tests/e2e/routing.test.ts

Real HTTP loopback against a CLIProxyAPI-shaped fixture:

    bun test tests/integration/cliproxyapi.test.ts

## Use from code

    import { createHandler } from './src/transport/handler';
    import { bunRawFetch, BUN_RAW_FETCH_ADAPTER } from './src/transport/bun-fetch';

    const handler = createHandler({
      config, snapshot, source, profile, transportProfile,
      fetch: bunRawFetch, fetchAdapter: BUN_RAW_FETCH_ADAPTER,
      trustedContext: () => ({ freshDelegation: false }),
      now: () => Date.now(), nonce: () => crypto.randomUUID(), instanceId: () => crypto.randomUUID(),
    });

`createHandler` throws if `transportProfile` does not match `fetchAdapter`, or is not fully
`"passed"`; there is no permissive default.

## CLI

Call chain for `serve`, [verified] direct read of each file: `src/cli/main.ts` dispatches `serve`
to `serveCommand` (in [../../src/cli/write.ts](../../src/cli/write.ts)), which calls `startServer`
(in [../../src/cli/serve.ts](../../src/cli/serve.ts)), which loads state once, resolves the source,
and calls `createHandler` above. Full flag documentation is owned by `docs/cli`.
