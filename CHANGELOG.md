# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- `subagent-router web` replaces the read-only `ui` console (`ui` stays as an alias). The console is
  now its own block, `src/web/*`, with a Svelte 5 app in `src/web/app` bundled by
  `scripts/build-web.ts` into `dist/web/`. It manages a whole installation from the browser: eight
  views for status, setup, gateway, models, routing, install, logs and diagnostics. See
  [docs/web/README.md](docs/web/README.md).
- Auto-detection (`GET /api/detect`): installed clients with their versions, whether a capability
  profile covers that version, agent roots and agent counts, the environment variables the config
  expects (names and a presence boolean, never a value), previously generated bundles, and, opt-in
  with `?probe=1`, well-known gateway ports on loopback only.
- Write endpoints for the whole configuration: first config (`config init`, project or home scope),
  model overrides, per-agent roles, defaults, model source, agent roots, `models sync` and
  `install`. Every write carries `expectedGeneration` and is refused with
  `config-generation-conflict` and HTTP 409 if the file moved underneath it.
- Router supervision from the console: start, stop and restart an in-process router through the
  same `startServer` the CLI's `serve` uses. A router started outside the console is detected by a
  bounded loopback health probe and reported as running but not owned.
- A status and activity view: config health, router state, snapshot freshness, environment variable
  presence, plus an event log and a live `GET /api/events/stream` Server-Sent Events feed fed by a
  new fire-and-forget observer seam on the transport handler.
- `bun run build:web`, and `bun run build` now chains the package build and the web build in that
  order. The web build fails on a partial bundle, on an inline script or style, and on an
  off-origin request, so the bundle can never outrun the lockdown CSP the server sends.
- `tests/web/*` covers the endpoint table, the refusals, detection, mutations, the supervisor and
  the event log, with a secret in the environment as a positive control for a leak.

- The repository is now a Claude Code plugin and its own plugin marketplace, so it installs with
  `/plugin marketplace add kolezka/marketplace` and `/plugin install subagent-router@kolezka`. The
  plugin adds a session-start router check, `/subagent-router:status`, `/subagent-router:setup`, and
  `subagent-router-plugin` on the Bash tool's `PATH`, which runs the CLI from the installed plugin's
  source with Bun. See [docs/plugin/README.md](docs/plugin/README.md).
- `tests/plugin.test.ts` locks the manifests against `package.json` and the four session-check
  cases, including a positive control for the silent one.

### Changed

- The console accepts writes on loopback. It refuses all of them with `--read-only`, and it forces
  read-only when it binds off loopback, because it has no authentication. Writes also need a
  same-origin request and `content-type: application/json`.
- `--config` is now optional for the console. A machine with no config file is a reported state
  that the setup view repairs, not a start-up failure. The console retargets itself when it writes
  a config at a new path, and refuses to retarget while it owns a running router.
- `docs/cli/UI.md` is superseded by [docs/web/README.md](docs/web/README.md).

### Known limits

- The console has no authentication. Anyone who can reach the port can read the config and, on a
  loopback bind, change it. Its event log lives in memory and does not survive a restart.
- A router the console starts stops with the console. There is no fork, no pid file and no respawn.
- The plugin does not route by itself and never will: a plugin cannot set `ANTHROPIC_BASE_URL` for
  the session that loads it. The bundle from `install`, or the variable, still makes the
  connection.
- The bundle `install` generates carries a plugin with the same name. Enable one of the two.

## 0.1.0 - 2026-09-14

First usable release. The package stays `private: true` and is not published to a registry.

### Added

- `install --output <dir>` generates a Claude Code integration bundle: a `--settings` file pointing
  at the router, a launcher, and an optional plugin with a session-start check and a
  `/subagent-router:status` command. It writes only into the directory you name and never edits an
  installed client configuration. The bundle names no provider, no model vendor and no credential;
  the only address in it is the loopback router. See [docs/cli/INSTALL.md](docs/cli/INSTALL.md).
- Quickstart in the README that takes a clean checkout to a running router.
- `CHANGELOG.md` and [docs/RELEASING.md](docs/RELEASING.md).
- Regression test locking the version the CLI prints to the version `package.json` declares.

### Changed

- `config check` now runs the same snapshot source validation `serve` runs before it binds a port.
  A snapshot fingerprinted against a different gateway, or written by a different `sourceId`, is now
  a problem with exit code 2 instead of a clean check followed by a `serve` that refuses to start.
  This also surfaces in the web console, which mirrors `config check`.
- `tests/probes/native-claude-run.sh` accepts `PROBE_CHILD_READ_ROUNDS` and
  `PROBE_CHILD_USAGE_RAMP_AFTER_ROUNDS` from the environment. Defaults are unchanged.

### Verified

Measured against the installed Claude Code 2.1.270 binary, driven through the packaged
`dist/cli.js serve` and a loopback test gateway. Each claim below is a model observed on the
gateway side, not a client-side report.

- Two children of one parent take different upstream models while the parent keeps its own.
- A child keeps its model on its second request in the same session.
- Two children run in parallel and neither takes the other's model.
- A grandchild carrying `x-claude-code-parent-agent-id` is routed.
- A real resume of the same session routes the same child identities to the same models.
- A bundle generated by `install` connects the client on its own. With no `ANTHROPIC_BASE_URL` in
  the process environment, `claude --settings <bundle>/settings.json` reached the gateway through
  the router, and `--parent-model` arrived at the gateway as the parent model.

### Known limits

- OpenCode and Codex adapters are present but unmeasured. No support is claimed.
- The web console is read-only.
- Compaction is unproven on this platform. The client's autocompact decision fires, but its
  reactive compactor bailed with "no assistant messages in summarize set" in every local run, so no
  compaction boundary was produced to route across.
- Correlation bindings live in the serving process's memory. They expire after inactivity and do
  not survive a router restart.
- `install` generates for Claude Code only. It refuses `--client opencode` and `--client codex`
  with `install-unsupported-client`, because neither is measured.
- The router forwards the client's own `Authorization` header unless `ROUTER_GATEWAY_HEADERS`
  replaces it. The generated `settings.json` therefore sets `ANTHROPIC_AUTH_TOKEN` to a placeholder
  that is not a credential. Run `serve` with the gateway credential in `ROUTER_GATEWAY_HEADERS`.
