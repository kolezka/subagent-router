# Transport: gaps

- **Claude Code capability is `pending`.** [verified] direct read of
  [../../tests/fixtures/capabilities/claude-code-2.1.263.json](../../tests/fixtures/capabilities/claude-code-2.1.263.json):
  every probe (`M1`-`M4`, `M10`) is `"pending"`, `status: "pending"`. `assertCapability` refuses
  every `claude-marker`/`claude-correlation`/`claude-fork` gate for this fixture, by design.
- **No measured trusted-start producer for M10-freshness.** `resolveTrustedStart` in the real
  bootstrap ([../../src/transport/claude-hook.ts](../../src/transport/claude-hook.ts)) always
  returns `freshDelegation: false`; channel B and B2 both stay closed in production until a real
  producer exists and M10-freshness passes.
- **Correlation (M1) is untested against a live client.** `CorrelationStore` itself is unit-tested
  ([../../tests/adapters/correlation.test.ts](../../tests/adapters/correlation.test.ts)), but no
  shipped Claude Code version has a passing M1 (identifier entropy) measurement.
- **Fork handling (M4, D3, requirement 19)** is covered only by the hermetic
  `unrecognized-fork-pass-through-and-recognized-fork-follows-w19` case in
  [../../tests/e2e/routing.test.ts](../../tests/e2e/routing.test.ts): a fake gateway, a synthetic
  profile. No real-client fork test exists in this worktree.
- **`bun-fetch` (default, non-raw) stays `pending`.** [verified] direct read of
  [../../tests/fixtures/capabilities/transport-bun-fetch-1.4.2.json](../../tests/fixtures/capabilities/transport-bun-fetch-1.4.2.json):
  all fields `"pending"`. Only `bun-fetch-raw` has a passing measurement; the two are not
  interchangeable, and a handler built with the default fetch adapter is refused by
  `assertTransportProfileReady`.
- Hermetic and loopback coverage
  ([../../tests/e2e/routing.test.ts](../../tests/e2e/routing.test.ts),
  [../../tests/integration/cliproxyapi.test.ts](../../tests/integration/cliproxyapi.test.ts),
  named case: "streams thinking, tool_use and message completion, only releasing the remainder
  after downstream reads the first bytes") proves the handler and a synthetic-profile,
  fixture-gateway pair behave correctly together, including causal first-byte-then-rest ordering.
  Neither is a native Claude Code run or a live CLIProxyAPI deployment; both use synthetic profiles
  or a local fixture server, not a real client or a real remote gateway.

See [../measurements/claude-code-2.1.263-partial.md](../measurements/claude-code-2.1.263-partial.md)
for a review of historical parent/child model artifacts. It is not a new native run and closes
none of the gaps above; M1, M3/M3-B2, M4, M10 and freshness stay unproven.

No status here becomes `supported` by editing a fixture; each line needs its named measurement.
