# Transport: contracts

## createHandler (Claude marker HTTP forwarding)

Routes `POST /v1/messages` and `/v1/messages/count_tokens` only. Every `/subagent-router/control/*`
path is handled locally and never forwarded: `GET control/instance` and `POST control/delegations`
are answered directly, any other method on those two is `405`, and any other `control/*` path is
`404`. Every remaining path (not `/v1/messages(...)`, not `control/*`) is forwarded raw, unread. A
parent request is never marker-parsed. A child request without a resolvable selection gets `422
missing-selection` and the gateway is never called. Streaming, backpressure, and client disconnect
propagate to the real upstream fetch via a linked `AbortController`. [verified] against
[../../src/transport/handler.ts](../../src/transport/handler.ts).

enforcement: [../../tests/transport/handler.test.ts](../../tests/transport/handler.test.ts), the
`unknown-or-method-mismatched-control-path-never-forwards-upstream` case

## Marker parsing and stripping

A marker is only accepted from the position (`system`, `first-user`) the measured profile actually
authorizes; an unauthorized-but-well-formed adapter marker is silently ignored, while genuinely
malformed grammar is `invalid-marker`. [verified] against
[../../src/adapters/markers.ts](../../src/adapters/markers.ts).

enforcement: [../../tests/adapters/markers.test.ts](../../tests/adapters/markers.test.ts)

## normalizeClaudeRequest / enrichParentTools (child/parent split)

Scope is decided by a recognized `x-anthropic-billing-header` block in `system`, matched as a whole
line, never a bare substring; ordinary prose mentioning the header text does not count. [verified]
against [../../src/adapters/claude-code.ts](../../src/adapters/claude-code.ts).

enforcement: [../../tests/adapters/claude-code.test.ts](../../tests/adapters/claude-code.test.ts)

## FreshDelegationStore / freshness envelope (immutable per-generation, opaque IDs)

A freshness receipt is bound to one exact `handlerInstanceId`, consumed exactly once, and rejected
if replayed, expired relative to its own `issuedAtMs`, or in conflict with a still-live pending
entry for the same agent. [verified] against
[../../src/transport/handler.ts](../../src/transport/handler.ts).

enforcement: [../../tests/transport/handler.test.ts](../../tests/transport/handler.test.ts), the
`freshness-*` and `fresh-store-*` cases

## bunRawFetch (real transport measurement)

Disables auto-decompression and redirect-following so the handler sees exact upstream bytes and
headers. [verified] against [../../src/transport/bun-fetch.ts](../../src/transport/bun-fetch.ts)
and the fixture it produces:
[../../tests/fixtures/capabilities/transport-bun-fetch-raw-1.4.2.json](../../tests/fixtures/capabilities/transport-bun-fetch-raw-1.4.2.json)
(`status`/`gzipBytes`/`responseHeaders` all `"passed"`).

enforcement: [../../tests/transport/bun-fetch.test.ts](../../tests/transport/bun-fetch.test.ts)
