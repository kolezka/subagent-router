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

## 2026-09-14 — marketplace install

Done on branch `subagent-router-marketplace-install`, commit `7ca3958`:

- [x] Repository root is a plugin root: `.claude-plugin/plugin.json`, `hooks/`, `commands/`, `bin/`.
- [x] Repository is its own marketplace: `.claude-plugin/marketplace.json`, plugin `source: "./"`.
- [x] Session check derives the router address from `ANTHROPIC_BASE_URL` and requires a
      `handlerInstanceId` body. Exits 0 in all four measured cases.
- [x] `bin/subagent-router-plugin` runs the installed plugin's `src/bun.ts` with Bun, no build,
      no `node_modules`.
- [x] `tests/plugin.test.ts`, 7 tests, both guards made to fail once before being trusted.
- [x] Measured against Claude Code 2.1.270 with an isolated `CLAUDE_CONFIG_DIR`:
      validate, marketplace add, install, details (2 skills, 1 hook).

Waiting on the owner:

- [ ] Push the branch and open the PR against `kolezka/subagent-router`.
- [ ] Add the entry to `kolezka/marketplace` (merge only after this lands on `main`, because the
      entry uses `ref: main`).

## 2026-09-14 — web console split, Svelte, installer and status view

Branch `web-ui-svelte-split-installer`. Request: move the web out of `src/cli`, rebuild it in
Svelte, make it install/configure/manage the whole installation (claude-code-router as the
reference), simplify installation, add auto-detection, add a status/activity/logs view.

### Plan, all done

- [x] Move the console out of the CLI block. `src/cli/ui.ts` and `src/cli/ui-page.ts` deleted,
      `src/web/*` created: `server.ts`, `routes.ts`, `status.ts`, `detect.ts`, `mutate.ts`,
      `supervisor.ts`, `events.ts`, `assets.ts`, `api-types.ts`, `index.ts`.
- [x] Svelte 5 app in `src/web/app`, bundled by `scripts/build-web.ts` into `dist/web/`
      (`index.html`, `main.js`, `main.css`, fixed names, no hash). Build refuses a partial
      bundle, an inline script or style, and any off-origin request.
- [x] `web` command (`ui` kept as an alias), `--port`, `--host`, `--read-only`.
      `--config` optional: no config is a reported state, not a start-up failure.
- [x] Write endpoints: `config init` (project or home scope), model overrides, roles, defaults,
      source, agent roots, `models sync`, `install`, router start/stop/restart. Every write
      carries `expectedGeneration`; a stale one is 409 `config-generation-conflict`.
- [x] Auto-detection endpoint: clients and versions, capability-profile coverage, agent roots and
      counts, expected environment variables (names plus presence only), earlier bundles,
      opt-in loopback gateway probe.
- [x] Status, activity and logs: `/api/system/status`, a bounded in-memory `EventLog`, and
      `/api/events/stream` (SSE) fed by a new fire-and-forget observer seam on the transport
      handler.
- [x] Security guards: Host allowlist against DNS rebinding, Origin check plus mandatory
      `content-type: application/json` on writes, forced read-only off loopback, lockdown CSP.
- [x] Tests `tests/web/*` and `tests/transport/handler-observer.test.ts`.
- [x] Docs: `docs/web/README.md` added, `docs/cli/UI.md` removed, `docs/README.md`,
      `docs/cli/README.md`, `README.md` and `CHANGELOG.md` updated.

### Review

- Tree gate: `bun run typecheck` clean, `bun test` 944 pass / 1 skip / 0 fail over 66 files,
  `bun run build` writes 6 entrypoints plus `dist/web/` with the CSP check passing.
- End-to-end on a config-less `/tmp` directory with `bun dist/cli.js web --port 8899`: status
  reports `configHealth: "missing"`, detect finds `claude` 2.1.270 with 12 agents,
  `config init` creates the file and the next status reads `ok` with a generation, a
  cross-origin POST is 403, a form-encoded POST is 400, SSE streams.
- In a browser: all eight views render with no console error, the environment table shows names
  and a missing state and never a value, a same-origin write returns 200 and the same write
  replayed with the stale generation returns 409.
- Known cosmetic issue, not fixed: one environment variable that serves two purposes renders as
  two rows in `EnvTable`. It is name-plus-purpose pairs by design; check the keying if it
  confuses operators.
- No GitHub issue or discussion exists in `kolezka/subagent-router` (both lists empty on
  2026-09-14), so nothing to link or close.

### Waiting on the owner

- [ ] Commit, push the branch and open the PR.
- [ ] Replace the `verified_against` value in `docs/web/README.md` with the merge commit.
