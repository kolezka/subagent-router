# Core: invariants

- `resolveRoute` never falls back to a role or global default without `freshDelegation: true`; an
  explicit marker or a correlated ID bypasses this, a missing or expired one does not.
  [../../src/core/route.ts](../../src/core/route.ts)
- An unresolved explicit model is `unknown-model`, never silently demoted to a role default.
- `buildCatalog` disables a model whose snapshot status is `missing`, regardless of an
  `enabled: true` override. [../../src/core/catalog.ts](../../src/core/catalog.ts)
- Config and snapshot parsing reject unknown keys (`onlyKeys`) instead of ignoring them; a typo in
  operator config fails loudly rather than being silently dropped.
  [../../src/core/config.ts](../../src/core/config.ts)
- `resolveSource` rejects userinfo, a query string, and a fragment in a gateway or discovery URL,
  and rejects a header name duplicated case-insensitively within one channel.
  [../../src/io/environment.ts](../../src/io/environment.ts)
- `commitState` never writes both config and snapshot in one call, and never writes an unparseable
  payload; a conflicting concurrent edit is detected by comparing hashes, not by the lock file
  alone. A failed write reports the write error, never a cleanup error in its place; it removes
  the temp and lock files it created itself (including a half-written temp file) and never one it
  did not create. [../../src/io/store.ts](../../src/io/store.ts),
  [../../src/io/cleanup.ts](../../src/io/cleanup.ts)
- `modelAlias` / `sourceFingerprint` are case-sensitive and never trim whitespace: `gateway/model`
  and `gateway/Model ` hash to different values. [../../src/core/hash.ts](../../src/core/hash.ts)

All of the above are exercised by the enforcement tests in [CONTRACTS.md](CONTRACTS.md); none of
this depends on a native client, a gateway, or a measured capability profile.
