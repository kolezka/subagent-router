# Core: contracts

## resolveRoute

Pure function: an explicit marker wins over a role default, which wins over a global default; a
fresh delegation is required before any default applies; an explicit choice conflicting with a
correlated ID is an error, never a silent pick. [verified] against
[../../src/core/route.ts](../../src/core/route.ts).

enforcement: [../../tests/core/route.test.ts](../../tests/core/route.test.ts)

## buildCatalog / resolveModel

An override for an ID outside the snapshot never creates a model. Alias collisions (with another
model ID, or between two overrides) throw. Resolution matches an exact ID or alias, never a
different case. [verified] against [../../src/core/catalog.ts](../../src/core/catalog.ts).

enforcement: [../../tests/core/catalog.test.ts](../../tests/core/catalog.test.ts)

## parseOperatorConfig / parseSnapshot

Unknown fields, an inline header value, `inherit` without acknowledgement, a bad alias/role name,
and non-positive timeouts/limits are rejected before the config is trusted anywhere else.
[verified] against [../../src/core/config.ts](../../src/core/config.ts).

enforcement: [../../tests/core/config.test.ts](../../tests/core/config.test.ts)

## resolveSource / validateSource (independent discovery/gateway credentials)

Discovery (`modelSource`) and forwarding (`gateway`) are independent origins with independent
header channels; a discovery secret never lands in `gatewayHeaders`, and vice versa. [verified]
against [../../src/io/environment.ts](../../src/io/environment.ts).

enforcement: [../../tests/io/environment.test.ts](../../tests/io/environment.test.ts)

## loadState / commitState (immutable generations)

`generation` is a hash of `(configHash, snapshotHash)`. `commitState` refuses a write if either
file changed since `loadState`, and writes exactly one file per call via a temp-file rename.
Cleanup after a failed write (temp file, lock file) never replaces the original error: the write
error stays primary and a cleanup failure is attached to it (`runWithCleanup`,
[../../src/io/cleanup.ts](../../src/io/cleanup.ts)). Only a temp file this call created is
removed, including one whose write failed part-way; a pre-existing file at the temp path is left
alone and the write fails with `EEXIST`. [verified] against
[../../src/io/store.ts](../../src/io/store.ts).

enforcement: [../../tests/io/store.test.ts](../../tests/io/store.test.ts) (conflict, lock held,
lock released after failure, foreign temp file, failed rename leaves nothing behind, partial write
removed), [../../tests/io/cleanup.test.ts](../../tests/io/cleanup.test.ts) (error precedence,
frozen error wrapped with cause)

## Package boundary (no provider SDK, no translation, no selector)

`package.json` declares no runtime `dependencies`, only `devDependencies` (`@types/bun`,
`typescript`). [verified] direct read of [../../package.json](../../package.json): no AI SDK,
gateway client, or KB client is a runtime dependency.

enforcement: [../../tests/e2e/routing.test.ts](../../tests/e2e/routing.test.ts),
`core-and-handler-have-no-required-ai-sdk-or-kb-imports`, `no-vendor-branch-or-llm-selector`,
`package-has-no-ai-gateway-dependency-or-import`
