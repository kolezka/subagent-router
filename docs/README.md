# Documentation

`subagent-router` now provides a working packaged Claude Code router. The supported Claude Code 2.1.268, 2.1.269 and 2.1.270 profiles route selected children to distinct configured upstream models while preserving the parent model and exercised child lifecycle continuity.

Start with the [minimal two-model example](../examples/minimal-router/README.md). It uses `terra` and `sol` aliases, environment-only gateway settings, and `bun run build`.

## Run the packaged router

Build the package, then start the bundled CLI with an operator-owned configuration:

```bash
bun run build
bun dist/cli.js serve \
  --config <operator-config> \
  --claude-version 2.1.269 \
  --host 127.0.0.1 \
  --port <port>
```

The configuration, its adjacent `models.lock.json` snapshot, and the configured gateway must already exist. The command does not create credentials or modify native client configuration.

Builds are non-destructive. A custom `BUILD_OUTPUT_DIR` must name a new or empty `dist` directory. Repeated default builds archive the previous `dist` under ignored `.build-history`.

## Inspect the configuration in a browser

`ui` starts a local read-only web console over the same offline inspection commands the CLI
exposes. It is a separate listener from `serve`, never forwards a request upstream and never
reaches the network.

```bash
bun dist/cli.js ui --config <operator-config> --port 8788
```

See [cli/UI.md](cli/UI.md) for the endpoint contract, the invariants and the gaps.

## Reproduce the local packaged check

The opt-in loopback check starts the built `dist/cli.js serve` package and uses a scripted local provider. It verifies routing and lifecycle behavior, not paid-model quality.

```bash
PROBE_PACKAGED_SERVE=1 \
PROBE_PACKAGED_CAPABILITY_PROFILE=/absolute/path/to/claude-code-2.1.268.json \
PROBE_CLAUDE_BIN=/absolute/path/to/claude/versions/2.1.268 \
PROBE_PHASES_EXERCISED=resume \
PROBE_RESUME_EXISTING_CHILD=1 \
bash tests/probes/native-claude-run.sh resume
```

## Current evidence and limits

On 2026-09-12, packaged-serve checks exercised `handler-ezphM0`, `next-turn-iscAxQ`, `nested-IWrTVw`, `compaction-Sroc4G`, and accepted resume `resume-0FieA7`. They used the pinned real Claude Code 2.1.268 client, recording proxy, built package, Bun raw fetch transport, and scripted loopback upstream. Each recorded expected routing, completion, executable identity, and capture pairing. The resume check observed the same child ids on both sides of the parent resume through native `SendMessage`; M3-A and explicit zero scaffold declaration also passed.

Direct native checks were recorded separately in `resume-3STpCB`, `next-turn-RKA2N4`, `nested-a4QSXS`, and `compaction-WH9nKg`. They establish the measured 2.1.268 profile for the exercised routes. Claude Code 2.1.269 was subsequently checked with the same driver: `next-turn-wqfgz6` (next-turn and parallel), `nested-eHKU2Q`, `compaction-ffSI2i`, and `resume-bEB1Q3` passed through packaged `serve`. No routing-code change was required. M2 is failed on 2.1.268 and unmeasured on 2.1.269; M3, M3-B2, M4, M10-freshness, and their dependent channels remain closed. Correlation bindings are in memory, expire after idle TTL, and do not survive a router restart.

On 2026-09-14, for the 0.1.0 release, the same driver was re-run on Linux against the installed Claude Code 2.1.270 through packaged `serve`: `handler-FG42W0`, `next-turn-96yRDN` (next-turn and parallel), `nested-LERVx3`, and `resume-dxqja6` with `PROBE_RESUME_EXISTING_CHILD=1`. Each child model was read out of the captured upstream request bodies, not from the client's own report. The resume run shows the same two child agent ids taking the same two upstream models on both sides of the boundary at `afterSeq` 11.

Compaction did not reproduce on that platform. Three runs (`compaction-rF0PxW`, `compaction-cq1wJY`, `compaction-quBrJZ`, the last with a later usage ramp and 14 rounds) all reached `level=compact` in the client's own debug log and then bailed with "fewer than 2 groups, nothing to compact" or "no assistant messages in summarize set". No compaction boundary was produced, so nothing was routed across one. The 2.1.270 profile's `lifecycle.compaction: passed` comes from run `compaction-pDcASg` on 2026-09-13 and was left untouched; treat it as unconfirmed on Linux until a run produces a boundary.

See [transport/GAPS.md](transport/GAPS.md) for boundaries and historical measurements, and [cli/README.md](cli/README.md) for the command reference.
