# Transport: invariants

- The upstream host and scheme always come from the configured gateway base, never from the
  incoming request path; `buildUpstreamUrl` mutates only `.pathname`/`.search` on a URL built from
  the trusted base. [../../src/transport/handler.ts](../../src/transport/handler.ts)
- Hop-by-hop headers (RFC 7230 6.1) and anything named in an incoming `Connection` header are
  stripped before forwarding; `gatewayHeaders` are applied last so they always win.
- A canceled response body deterministically aborts the linked upstream fetch; canceling one
  stream never merely detaches it from a still-running upstream request.
- The freshness HMAC and the marker HMAC are separate signing domains with distinct canonical
  strings; a valid marker token is never usable as a freshness proof, or vice versa.
  [../../src/transport/handler.ts](../../src/transport/handler.ts),
  [../../src/adapters/markers.ts](../../src/adapters/markers.ts)
- `createClaudeStartOutput` only emits a marker for channel B (`system`/`first-user` position); a
  `b2` or `unknown` position yields no in-body marker, ever.
  [../../src/transport/hooks.ts](../../src/transport/hooks.ts)
- The claude-hook bootstrap's `resolveTrustedStart` always returns `freshDelegation: false`: no
  measured trusted-start producer exists, so a real hook run never fabricates freshness from stdin
  content. [../../src/transport/claude-hook.ts](../../src/transport/claude-hook.ts)

Enforcement for each of these lives in [CONTRACTS.md](CONTRACTS.md).
