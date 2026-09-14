# Minimal router example

Two explicit aliases, using model IDs from the operator's available catalog:

| Alias | Upstream model | Purpose |
| --- | --- | --- |
| `terra` | `gpt-5.6-terra` | Implementation |
| `sol` | `gpt-5.6-sol` | Independent review |

The parent keeps its own model. Correlation is enabled so a child's selection can survive compaction. Unmarked children are rejected rather than assigned an unverified default.

## Build

From the repository root:

```bash
bun run build
```

## Set the gateway and sync its catalog

Set these values in your shell or secret manager, not in the JSON configuration:

```bash
export ROUTER_GATEWAY_URL="https://YOUR-GATEWAY/v1"
export ROUTER_MODELS_AUTH="<model-discovery-token>"
export ROUTER_GATEWAY_HEADERS='{"Authorization":"Bearer <gateway-token>"}'
```

Use the gateway's actual API base, including `/v1` if required. The model-discovery URL is resolved to `/v1/models` without duplicating `/v1`. `ROUTER_MODELS_AUTH` is used as a Bearer token for discovery; gateway request headers come from `ROUTER_GATEWAY_HEADERS`.

The included `models.lock.json` is a synthetic sample, not a catalog fetched from your gateway. Its `sourceFingerprint` is a placeholder, so `config check` reports `snapshot-source-mismatch` and `serve` refuses to start until `models sync` replaces it:

```bash
bun dist/cli.js models sync --config examples/minimal-router/subagent-router.json
bun dist/cli.js config check --config examples/minimal-router/subagent-router.json
```

The gateway must advertise the two exact model IDs above. If it uses different IDs, edit `modelOverrides`; the short aliases and prompt markers can stay the same. `ROUTER_SECRET` is only needed for signed hook paths, not these explicit channel-A markers.

## Start the router for Claude Code 2.1.269

```bash
bun dist/cli.js serve \
  --config examples/minimal-router/subagent-router.json \
  --claude-version 2.1.269 \
  --host 127.0.0.1 \
  --port 8787
```

In the Claude Code process that should use this router, point the API base at it while keeping your existing authentication setup:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

This process-local setting does not rewrite your installed Claude Code configuration. Use Claude Code 2.1.269 with the matching server profile; the version is the CLI program version, not the GPT model version.

## Choose a child model

Use the complete Agent input from `payloads/agent-terra.json` or `payloads/agent-sol.json`. The `prompt` field must begin with the marker:

```json
{
  "description": "Implement a change",
  "subagent_type": "general-purpose",
  "prompt": "<subagent-router v=\"1\" model=\"terra\"/>\nImplement the requested change."
}
```

For review, use `model="sol"` in that first line. Do not put the full GPT ID in the Agent tool's native `model` parameter, and do not rely on role defaults while freshness remains unmeasured. The marker tells this router which configured upstream model to select.

## Validation and limits

The pinned 2.1.269 client passed model selection, next-turn, parallel, nested, compaction and same-child resume through the existing router and the packaged `serve` command on loopback. The pinned 2.1.270 client was re-checked for 0.1.0 and passed model selection, next-turn, parallel, nested and same-child resume; compaction did not reproduce on Linux, see [docs/README.md](../../docs/README.md). No real provider call was needed for that validation. Your gateway URL, credentials and advertised model catalog must still be configured and checked in your environment.

Correlation bindings are in memory, expire after inactivity and do not survive a router restart. The example does not enable unmeasured fork or hook-based default-selection paths.

For a configuration-only check without network access, the synthetic snapshot can be used with:

```bash
ROUTER_GATEWAY_URL="https://gateway.example.invalid/v1" \
ROUTER_MODELS_AUTH="<synthetic-models-auth>" \
ROUTER_GATEWAY_HEADERS='{}' \
  bun dist/cli.js config check --config examples/minimal-router/subagent-router.json
```
