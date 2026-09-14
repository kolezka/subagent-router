# subagent-router 0.1.0 — handoff

Local, untracked. Written 2026-09-14 because the Outline MCP server rejected its
configured Authorization header (HTTP 401, `AUTH_HEADER_REJECTED`) for the whole session,
so the checkpoint doc `subagent-model-routing-context-cMNTb4A7WJ` could be neither read
nor updated. Copy this into Outline once that server works again.

## State

Branch `subagent-router-0-1-0-release`, 6 commits on top of `origin/main` (`3b3f341`).
PR: https://github.com/kolezka/subagent-router/pull/19

| Commit | Scope |
| --- | --- |
| `cf6082c` | `fix:` config check validates the snapshot source |
| `f3f2ca0` | `test:` compaction probe ramp overridable |
| `5d8785e` | `chore:` release 0.1.0 |
| `144e088` | `docs:` status, evidence and limits |
| `d0557a7` | `feat:` install generates a Claude Code integration bundle |
| `58595b4` | `docs:` install command and its measured run |

Tree gate before each commit: `bun run typecheck` clean, `bun test` 844 pass / 1 skip /
0 fail (833 before the installer), `bun run build` succeeds, `bun dist/cli.js --version`
prints `0.1.0`.

## Done

- [x] Clean checkout, `bun install --frozen-lockfile`, `bun run build`.
- [x] Gateway config readable and its catalog sync path documented.
- [x] Packaged `dist/cli.js serve` run for real, not a handler import.
- [x] Real pinned Claude Code 2.1.270 connected to it through an isolated
      `HOME`/`CLAUDE_CONFIG_DIR` and a loopback test gateway.
- [x] Two children take two different upstream models; the parent keeps its own.
- [x] Selection survives the next turn, parallel children, nesting and a real resume of an
      existing child. Every model read from the captured upstream body on the gateway side.
- [x] Web console run and checked over HTTP and in a browser.
- [x] Clear errors on a mismatched snapshot, a missing config and an unknown model.
- [x] Version 0.1.0, `CHANGELOG.md`, `docs/RELEASING.md`.
- [x] PR opened with release notes.
- [x] `install` command: generates a 7-file Claude Code bundle into a named directory,
      never edits an installed client configuration, names no provider and no credential.
      Measured with the real 2.1.270 binary: the generated `settings.json` alone connects
      the client with no `ANTHROPIC_BASE_URL` in the environment, and `--parent-model`
      arrives at the gateway.

## Run ids

- `handler-FG42W0` — alpha `a553974300ad965e1` to `gateway/fast-worker`, beta
  `a8af859653769846f` to `gateway/smart-worker`, parent `probe-parent-model`.
- `next-turn-96yRDN` — two requests per child, model preserved, interleaved.
- `nested-LERVx3` — grandchild `ac91083eb9841207a` under parent `a1cb4bab0794b2e11`.
- `resume-dxqja6` — `PROBE_RESUME_EXISTING_CHILD=1`, boundary `afterSeq` 11, same two ids
  take the same two models on both sides.
- `compaction-rF0PxW`, `compaction-cq1wJY`, `compaction-quBrJZ` — all failed to produce a
  boundary. Documented as an open limit, not tuned further and not faked.

## Instrument failure, self-caught

While measuring `install --parent-model`, I ran `rm -f /tmp/sr-gateway-requests.log` while
the mock gateway still held an open write fd. Writes went to the unlinked inode, so the
log read empty, and I briefly concluded that Claude Code 2.1.270 rejects an unknown
`ANTHROPIC_MODEL` client-side before any request leaves. The client's own
`api_error_status: 404` proved a request had left. After restarting the gateway and
validating the log with a `curl` positive control, the correct result is that
`--parent-model gpt-5.6-terra` does reach the gateway. The client only warns that the id
is outside its own catalog. Lesson recorded in `.ai/lessons.md`.

## Blocked, waiting on the owner

- Merge, tag `v0.1.0`, any publication. `private: true` stays until told otherwise.
- Outline update (server returns 401).
- No real gateway URL or credentials were given, so every run used the loopback test
  gateway. A real-gateway check is still unmeasured.
- The `Agent` tool in this session only offered `sonnet`, `opus`, `haiku`, `fable`, so the
  requested `gpt-5.6-terra` / `gpt-5.6-sol` subagents were unavailable. No subagents used.

## Deliberately out of 0.1.0

OpenCode and Codex certification, new hook channels, model-quality benchmarks, any write
path in the web console.
