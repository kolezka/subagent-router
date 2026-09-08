# CLIProxyAPI compatibility

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) is an external gateway. This document
describes the HTTP contract this router expects from it and how the two integrate. It does not
describe a working end-to-end native-client setup: native routing capability is still pending
measurement (see "Native-client status" below and in [poc.md](../poc.md)).

## Topology

This document, and the HTTP contract it describes, cover **Claude Code marker routing only**:

```
Claude Code -> subagent-router HTTP handler (marker routing) -> CLIProxyAPI -> provider
```

OpenCode and Codex do not go through this HTTP handler. They use native validation hooks
(`src/adapters/opencode-plugin.ts`'s `tool.execute.before`, `src/adapters/codex-hook.ts`'s
PreToolUse hook) that check a model or role selection in-process, against this router's exported
config and catalog, before the client's own call proceeds. Once validated, OpenCode and Codex call
CLIProxyAPI directly with their own provider configuration; no request for them passes through
`src/transport/handler.ts`. Everything else in this document (header channels, routes, streaming
behavior) describes the Claude Code path only.

CLIProxyAPI owns the connection to the actual model provider. The operator supplies CLIProxyAPI's
own configuration and authentication; this router never talks to a provider directly and never
embeds provider credentials.

## Primary sources

Verified 2026-09-08, against the `main` branch (not a pinned commit; re-check before relying on
these for a later change):

- [`internal/api/server_routes.go`](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/internal/api/server_routes.go)
  registers an authenticated `GET /v1/models`, `POST /v1/messages`, and
  `POST /v1/messages/count_tokens`.
- [`internal/access/config_access/provider.go`](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/internal/access/config_access/provider.go)
  accepts an `Authorization: Bearer <key>` or an `X-Api-Key: <key>` header, checked against
  CLIProxyAPI's own configured `api-keys`.
- Direct-client guidance: <https://help.router-for.me/agent-client/claude-code>.

## Direct client vs this router

A direct client (see the direct-client guidance above) points `ANTHROPIC_BASE_URL` at
CLIProxyAPI's bare origin. This router works differently: the operator sets `CLIPROXYAPI_URL` to
CLIProxyAPI's `/v1` base (used as both `gateway.urlEnv` and `modelSource.baseUrlEnv` in the example
config below), and the router builds the exact `/v1/messages`, `/v1/messages/count_tokens`, and
`/v1/models` paths on top of it.

A `CLIPROXYAPI_URL` that does not end in `/v1` misroutes every forwarded request to the wrong
path. [`tests/integration/cliproxyapi.test.ts`](../../tests/integration/cliproxyapi.test.ts) proves
this against a real fixture: the request lands on `/messages` and gets a real 404. The router does
not detect or correct this by itself.

## Configuration

See [`examples/cliproxyapi/subagent-router.json`](../../examples/cliproxyapi/subagent-router.json).
Key points:

- `gateway.urlEnv` and `modelSource.baseUrlEnv` can name the same environment variable
  (`CLIPROXYAPI_URL`, ending in `/v1`), but discovery and forwarding still use two separate header
  channels: `modelSource.headersEnv`/`authEnv` for discovery, `gateway.headersEnv` for forwarding.
  Configure them separately even if the operator points both at the same local CLIProxyAPI key.
  The router never lets a discovery-only credential leak into a forwarded request.
- Model IDs in `modelOverrides` are exact, opaque, case-sensitive strings from CLIProxyAPI's own
  `GET /v1/models` response. They are independent of this router's own marker aliases (the `alias`
  field an agent's marker names, for example `<subagent-router v="1" model="fast"/>`).
- Never write a real key into the config file. Only environment variable names belong there; the
  example file above only ever holds env var names, never inline header values.

### Complete environment setup (placeholders only)

The example config references three environment variables, all required:

```sh
export CLIPROXYAPI_URL="https://cliproxyapi.internal.example/v1"
export CLIPROXYAPI_MODELS_AUTH="<cliproxyapi-api-key-used-for-discovery>"
export CLIPROXYAPI_GATEWAY_HEADERS='{"Authorization":"Bearer <cliproxyapi-api-key-used-for-forwarding>"}'
```

- `CLIPROXYAPI_URL` (`gateway.urlEnv` and `modelSource.baseUrlEnv`): CLIProxyAPI's `/v1` base.
- `CLIPROXYAPI_MODELS_AUTH` (`modelSource.authEnv`): sent as `Authorization: Bearer <value>` on
  discovery requests only (`GET /v1/models`). Never forwarded.
- `CLIPROXYAPI_GATEWAY_HEADERS` (`gateway.headersEnv`): a JSON header map sent on every forwarded
  request (`/v1/messages`, `/v1/messages/count_tokens`). Use `X-Api-Key` instead of `Authorization`
  if that is what your CLIProxyAPI deployment expects.

Every value above is a placeholder. Replace `<...>` with the real key from your own CLIProxyAPI
deployment; never commit a real value.

## Discovering exact model IDs

`models sync` is implemented (`src/cli/write.ts`, dispatched from `src/cli/main.ts`). With the
three environment variables above set and `examples/cliproxyapi/subagent-router.json` copied to
`./subagent-router.json`, run:

```sh
bun dist/cli.js models sync --dry-run
```

`--dry-run` prints the diff (`added`/`changed`/`missing`) without writing; drop it to write
`models.lock.json`. See [docs/cli/OPERATIONS.md](../cli/OPERATIONS.md) for the full CLI reference.
This is CLIProxyAPI-agnostic discovery: it exercises the same `synchronize`/`discoverModels` path
against any gateway matching the `GET /v1/models` contract below, not a CLIProxyAPI-specific proof.

Alternatively, to discover models with a one-off script instead of the built CLI, save the
following as `discover-cliproxyapi-models.ts` in the repository root, next to `package.json` (the
same place `poc.md` saves `prepare-poc.ts`), and run it with
`bun run discover-cliproxyapi-models.ts` after setting the three environment variables above:

```ts
import { synchronize } from './src/catalog/sync';
import { bunRawFetch } from './src/transport/bun-fetch';

const result = await synchronize('./subagent-router.json', {
  env: process.env,
  fetch: bunRawFetch,
  now: () => new Date(),
  allowEmpty: false,
  dryRun: true, // inspect only; drop dryRun to write models.lock.json
});
console.log(result.snapshot.models.map((m) => m.id));
```

This exact wiring (the same three env var names, the same `synchronize` call) is run against a
live loopback fixture in
[`tests/integration/cliproxyapi.test.ts`](../../tests/integration/cliproxyapi.test.ts), not merely
parsed: that test confirms the config actually discovers models, not only that its JSON is
well-formed.

This calls CLIProxyAPI's real `GET /v1/models` and prints the exact IDs it returned. Do not assume
a model name from CLIProxyAPI's own UI, or a provider's marketing name, matches the ID it actually
serves. Only a discovered `id` string is safe to put in `modelOverrides`.

## What the contract tests cover

[`tests/integration/cliproxyapi.test.ts`](../../tests/integration/cliproxyapi.test.ts) runs the real
`resolveSource`, `synchronize`/discovery, `createHandler`, and the Bun raw transport
(`src/transport/bun-fetch.ts`) against a loopback HTTP fixture shaped like CLIProxyAPI's registered
routes. All traffic stays on 127.0.0.1; no client process and no provider are involved.

The fixture's routes and its auth check (`GET /v1/models`, `POST /v1/messages`,
`POST /v1/messages/count_tokens`, `Authorization: Bearer` or `X-Api-Key`) match the primary sources
above. The exact JSON shape of its `/v1/models` response, and every SSE and error response body it
returns, are this fixture's own synthetic data: no live CLIProxyAPI process was ever run, and these
tests do not claim to cover every response shape a real CLIProxyAPI deployment might return (other
pagination shapes or error formats, for example). It checks:

- The exact `/v1/models` discovery URL, and that case-sensitive model IDs stay distinct through
  discovery, the snapshot, and the catalog.
- A marked child request rewrites `model` to the exact upstream ID, and the marker line is removed,
  before the request reaches `/v1/messages`.
- The parent's own declared model is forwarded unchanged.
- `/v1/messages/count_tokens` gets the same rewrite as `/v1/messages`.
- The operator's configured gateway `Authorization` overrides whatever `Authorization` the
  incoming request carried; a discovery-only credential never appears on a forwarded request.
- `X-Api-Key` also works for forwarding.
- An upstream authentication error, and an upstream model-not-found error, are both forwarded with
  their exact original status and body; the router never retries with a different model.
- A misconfigured (bare) `CLIPROXYAPI_URL` reaches the wrong path on the fixture and gets a real
  404, not silent correction.
- A streamed reply (thinking, tool use, message completion) passes through byte for byte and
  decodes to the exact events and arguments the fixture sent. The fixture withholds everything
  past the first frame until the client has actually read it, so a buffering regression fails the
  test on a timeout instead of passing.

These are HTTP contract checks against a controlled fixture. They do not exercise a real
CLIProxyAPI process, a real provider, or a real native client.

## Native-client status

Native Claude Code (or OpenCode, or Codex) routing through CLIProxyAPI is not yet usable
end-to-end. Client capability measurements are still pending; `poc:serve` refuses a pending
profile, and there is no supported way to bypass that refusal (see
[poc.md](../poc.md#native-client-status)). This document does not claim otherwise.

## No throughput claims

This document and its tests describe protocol shape only: URLs, headers, status codes, and decoded
message content. They make no claim about CLIProxyAPI's or any provider's latency or throughput.
