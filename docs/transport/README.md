---
block: transport
doc: README
verified_against: 008ed4b05b8b28e89bfbd67d76d1ceaf220c9db0
verified_on: 2026-09-09
owns:
  - src/transport/handler.ts
  - src/transport/claude-hook.ts
  - src/transport/hooks.ts
  - src/transport/bun-fetch.ts
  - src/adapters/claude-code.ts
  - src/adapters/markers.ts
  - src/adapters/correlation.ts
depends_on:
  - core
  - agents
---

# Transport

Same rule as [core](../core/README.md): `verified_against` is the commit this block was checked
against.

## What this block is

The Claude Code path only. Unlike [agents](../agents/README.md)'s native OpenCode/Codex mode,
Claude Code talks to this router over HTTP: `createHandler` fronts the external gateway, parses an
in-body `<subagent-router .../>` marker (`src/adapters/markers.ts`), decides a route via
[core](../core/README.md)'s `resolveRoute`, and forwards the rewritten request. Accepted routing
markers are stripped from child requests before forwarding. Ignored marker-like text remains
ordinary request content.

`src/transport/claude-hook.ts` and `hooks.ts` implement the other half: Claude Code's
SubagentStart hook, which can register a one-shot freshness receipt with the running handler
(`FreshDelegationStore`) and, on channel B, emit a signed adapter-role marker. This is HTTP control
between the hook process and the handler, not a native runtime call into Claude Code; Claude Code
has no native mode in this router.

`src/transport/bun-fetch.ts` is the Bun-specific raw-fetch transport injected into the handler; the
one piece of this block with a real, non-synthetic passing measurement (see [GAPS.md](GAPS.md)).

## Immutability and opaque IDs

`createHandler` deep-clones its config/profile/source at creation time: a caller mutating the
original objects afterward cannot change a running handler's behavior. Freshness envelope fields
(`handlerInstanceId`, `agentId`, `nonce`) are bounded opaque identifiers (max 256 chars).

## See also

[CONTRACTS.md](CONTRACTS.md), [INVARIANTS.md](INVARIANTS.md), [GAPS.md](GAPS.md),
[OPERATIONS.md](OPERATIONS.md)
