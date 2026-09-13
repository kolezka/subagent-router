# Full router example

A fuller `subagent-router.json` than `examples/minimal-router`. It shows every section the
schema accepts and the three places a child's model can come from.

## What the config does

| Alias | Upstream model | Client alias | Enabled | Purpose |
| --- | --- | --- | --- | --- |
| `haiku` | `claude-haiku-4-5-20251001` | (none) | yes | Discovery, file lookup, small summaries |
| `sonnet` | `claude-sonnet-5` | (none) | yes | Default child model |
| `opus` | `claude-opus-5` | (none) | yes | Orchestration, rarely a child |
| `terra` | `gpt-5.6-terra` | `sonnet` | yes | Fast independent implementation |
| `sol` | `gpt-5.6-sol` | `opus` | yes | Independent review, hard bugs |
| `legacy` | `gpt-5.6-legacy` | (none) | no | Advertised by the gateway, blocked for subagents |

Selection order for a fresh child delegation, first match wins:

1. An explicit marker in the prompt, for example `<subagent-router v="1" model="sol"/>`.
2. A `roles` entry for `<client>:<agent-name>`. Here `claude-code:explorer` goes to `haiku`,
   `claude-code:implementer` to `terra`, `claude-code:reviewer` to `sol`.
3. `defaults.child`, here `sonnet`.

A child that is not a fresh delegation and carries no marker is rejected (`unmarkedSubagent:
"error"`). To let such a child inherit the parent's model, set `"unmarkedSubagent": "inherit"`
together with `"unmarkedSubagentAcknowledged": true`; the acknowledgement is required.

`clientModel` is the alias the client uses to set its own limits. The gateway still serves the
upstream ID. `terra` is reported to Claude Code as `sonnet` and `sol` as `opus`. The router does
not correct any limit mismatch that follows from that pairing.

`legacy` stays in the catalog (so `models list` shows it) but routes to it fail with
`model-not-allowed`.

The parent process always keeps its own model. Correlation is on, so a child's selection survives
compaction. Codex catalog export is on (`emitModelCatalog: true`).

## Environment

Set these in your shell or secret manager, never in the JSON:

```bash
export ROUTER_GATEWAY_URL="https://YOUR-GATEWAY/v1"
export ROUTER_MODELS_AUTH="<model-discovery-token>"
export ROUTER_MODELS_HEADERS='{}'
export ROUTER_GATEWAY_HEADERS='{"Authorization":"Bearer <gateway-token>"}'
export ROUTER_SECRET="<random-secret-for-signed-hook-paths>"
```

`headersEnv` arrays may only name environment variables. Inline header values are rejected by
`config check`.

## Check it offline

The included `models.lock.json` is synthetic. The sample agents under `agents/claude-code/` exist
only so the `roles` section resolves; pass that directory with `--agents-dir`.

```bash
bun run build
ROUTER_GATEWAY_URL="https://gateway.example.invalid/v1" \
ROUTER_MODELS_AUTH="<synthetic>" \
ROUTER_MODELS_HEADERS='{}' \
ROUTER_GATEWAY_HEADERS='{}' \
  bun dist/cli.js config check \
    --config examples/full-router/subagent-router.json \
    --agents-dir examples/full-router/agents/claude-code
```

Simulate a few decisions:

```bash
bun dist/cli.js route preview --client claude-code --agent reviewer \
  --config examples/full-router/subagent-router.json \
  --agents-dir examples/full-router/agents/claude-code
# role-default -> gpt-5.6-sol, clientModel opus

bun dist/cli.js route preview --client claude-code --agent reviewer --model haiku \
  --config examples/full-router/subagent-router.json \
  --agents-dir examples/full-router/agents/claude-code
# explicit -> claude-haiku-4-5-20251001

bun dist/cli.js route preview --client claude-code --agent explorer --model legacy \
  --config examples/full-router/subagent-router.json \
  --agents-dir examples/full-router/agents/claude-code
# error model-not-allowed
```

## Use it for real

Replace the snapshot with your gateway's catalog, then re-check:

```bash
bun dist/cli.js models sync --config examples/full-router/subagent-router.json
bun dist/cli.js config check --config examples/full-router/subagent-router.json
```

The gateway must advertise the exact model IDs in `modelOverrides`. If it uses other IDs, change
the keys; aliases and prompt markers can stay. Drop `--agents-dir` once your real agent
definitions live in `.claude/agents` (project) or `~/.claude/agents` (user); every role name must
resolve to an agent the inventory can see or `config check` reports it.

Serving is the same as in `examples/minimal-router/README.md`: `serve --config ... --claude-version
<pinned>` and point the client at it with `ANTHROPIC_BASE_URL`. Native client integration remains
unmeasured for anything beyond what `docs/cli/GAPS.md` lists.
