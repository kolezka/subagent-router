# Marker routing PoC

A local HTTP proof of concept for `subagent-router`. Provider calls belong to an external gateway such as 9router or OmniRoute. This package does not use `@the-next-ai/ai-gateway`, translate provider protocols, or run an agent loop.

## Run the local demo

From the repository root, using Bun 1.4.2:

```sh
bun install --frozen-lockfile
bun run poc:demo
```

The command starts a loopback fixture gateway and the real routing handler. It uses a **synthetic client capability profile** and the measured `bun-fetch-raw` transport. It checks:

- The parent model remains `claude-parent-model`.
- The marked child selects `demo-gateway/child-worker`.
- The decoded reply is exactly `fixture-reply-ok`.
- An unmarked child returns `422` with `missing-selection` and is not forwarded.

The command exits nonzero if a check fails and closes its servers. Temporary config files stay under `tests/tmp/` and are removed afterward. This is not a native Claude Code run, a provider call, or a benchmark of either gateway.

```sh
bun run typecheck
bun test
bun run poc:serve --help
```

## Native-client status

**Native Claude Code support is not yet verified.** The shipped client profile is `pending`. `poc:serve` refuses it with exit `2`; changing it by hand to `supported` is not a compatibility measurement.

`tests/probes/run.ts` contains initial probe infrastructure, but its native proof extractors are not complete. Running that script alone does not produce a supported profile. Real-client marker placement, provenance, lifecycle, and freshness measurements remain work in the implementation plan. OpenCode, Codex, discovery, full CLI, and release packaging are also not part of this local milestone.

## External-gateway entry point

Once a measured client profile exists:

```sh
GATEWAY_URL=https://gateway.example.internal/v1 \
  bun run poc:serve \
  --config ./out/subagent-router.json \
  --profile ./measured-profiles \
  --transport-profile ./tests/fixtures/capabilities \
  --claude-version <measured-version> \
  --port 8787
```

`--profile` and `--transport-profile` name directories, not individual files. The listener binds to `127.0.0.1`. Unknown or duplicate arguments are rejected. `--help` exits without loading configuration or opening a listener.

The external gateway must accept and return the harness-facing Anthropic Messages protocol. Provider authentication and translation happen there. Gateway URL and headers come from operator configuration and environment, never from a prompt. No installed harness settings or agent definitions are edited by these commands.

The raw transport disables automatic decompression and redirect following. Its shipped profile covers Bun 1.4.2 only. Default Bun `fetch` did not preserve gzip bytes in the local control test; it must not reuse the raw adapter's profile. A different runtime needs its own measurement.

## Prepare a snapshot without discovery

There is no `models sync` command yet. For a single-model experiment, save the following as `prepare-poc.ts` in the repository root. Replace the gateway URL and model ID with the exact values exposed by your gateway, then run `bun run prepare-poc.ts`. It writes only to `./out` and makes no network requests.

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { modelAlias, sourceFingerprint } from './src/core/hash';
import { parseOperatorConfig, parseSnapshot } from './src/core/config';

const sourceId = 'poc-gateway';
const gatewayUrl = 'https://gateway.example.internal/v1';
const upstreamModel = 'gateway/exact-model-id';
const config = parseOperatorConfig({
  version: 1,
  modelSource: {
    sourceId, baseUrlEnv: 'GATEWAY_URL', endpointPath: '/v1/models',
    headersEnv: [], timeoutMs: 10000, fetchLimit: 1000, staleAfterSeconds: 86400,
  },
  modelOverrides: { [upstreamModel]: { alias: 'worker', description: 'PoC worker.', enabled: true } },
  roles: {},
  defaults: { child: null, unmarkedSubagent: 'error' },
  agentRoots: {
    'claude-code': { configRoot: null }, opencode: { configRoot: null }, codex: { configRoot: null },
  },
  gateway: { urlEnv: 'GATEWAY_URL', headersEnv: [] },
  harness: {
    claudeCode: { correlation: 'off', secretEnv: 'ROUTER_SECRET' },
    opencode: { providerId: 'gateway' }, codex: { emitModelCatalog: false },
  },
});
const snapshot = parseSnapshot({
  version: 1, sourceId,
  sourceFingerprint: await sourceFingerprint(sourceId, gatewayUrl, `${gatewayUrl}/models`),
  fetchedAt: new Date().toISOString(),
  models: [{ id: upstreamModel, alias: await modelAlias(upstreamModel), status: 'available', metadata: {} }],
});
await mkdir('./out', { recursive: true });
await writeFile('./out/subagent-router.json', `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
await writeFile('./out/models.lock.json', `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
```

The snapshot fingerprint must match the endpoint supplied to `poc:serve`. This example deliberately refuses to overwrite existing files. If the gateway requires headers, use the config's environment references rather than putting credentials into committed files.

## Integration surface

- `src/core/route.ts`: pure routing decision.
- `src/adapters/claude-code.ts`: child normalization and parent tool descriptions.
- `src/transport/handler.ts`: shared HTTP handler, including capability gates and freshness control.
- `src/transport/bun-fetch.ts`: Bun-specific raw transport injected into the handler.
- `src/cli/serve.ts`: server startup with config and snapshot loaded once.

The wider scope remains in the [implementation plan](superpowers/plans/2026-09-06-subagent-model-routing.md).
