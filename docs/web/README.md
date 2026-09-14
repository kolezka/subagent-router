---
block: web
doc: README
verified_against: working tree of branch web-ui-svelte-split-installer, not yet committed
verified_on: 2026-09-14
owns:
  - src/web/server.ts
  - src/web/routes.ts
  - src/web/status.ts
  - src/web/detect.ts
  - src/web/mutate.ts
  - src/web/supervisor.ts
  - src/web/events.ts
  - src/web/assets.ts
  - src/web/api-types.ts
  - src/web/index.ts
  - src/web/app/
  - scripts/build-web.ts
depends_on:
  - core
  - catalog
  - agents
  - cli
  - transport (the router the console supervises)
---

# Web console

`subagent-router web` starts a local console that installs, configures and watches one
`subagent-router` installation. It is a separate block from the CLI: `src/web/*` for the server,
`src/web/app/*` for the Svelte 5 single-page app, `scripts/build-web.ts` for the bundle.

The `verified_against` stamp above names a working tree, not a commit, because this branch is not
merged yet. Replace it with the merge commit before treating the stamp as a normal one.

```sh
bun run build                      # builds dist/cli.js and dist/web/
bun dist/cli.js web                # console on http://127.0.0.1:8788
```

Defaults: port `8788`, host `127.0.0.1`. `serve` keeps `8787`, so the console and a router can run
at the same time. `--config` is optional: a machine with no config file is a state the console
reports and repairs, not a start-up failure.

Options: `--port <n>`, `--host <h>`, `--read-only`, plus the global `--config` and `--agents-dir`.

## What it does

Eight views, hash-routed (`#/status`, `#/setup`, ...). The header shows the version, the config
path, the config generation and two health lights (config, router).

| View | What it does |
|---|---|
| Status | Config health, router state, snapshot freshness, environment variable presence, recent events |
| Setup | Auto-detection of installed clients and gateways, then a first config written with `config init` |
| Gateway | Model source: `sourceId`, endpoint path, timeouts, and the environment variable NAMES the gateway credentials come from |
| Models | Catalog after `models sync`: alias, description, client model and enabled state per model |
| Routing | Per-agent role overrides, the default child model, and the unmarked-subagent policy, with a live route preview |
| Install | Generates the Claude Code bundle (`install`) and starts, stops or restarts the router |
| Logs | The event log and a live Server-Sent Events stream of router activity |
| Diagnostics | `doctor` and `config check` findings |

### Auto-detection

`GET /api/detect` answers with what is on the machine, and never throws on a miss: an absent binary
or an unreadable directory is a normal result.

- Installed clients (`claude`, `opencode`, `codex`): binary path, version, whether a capability
  profile covers that version, agent roots and the agent count in each.
- The environment variables the current config expects: NAME and a presence boolean only. The
  console never reads or returns a value.
- With `?probe=1`, well-known gateway ports on **loopback only**. Probing is opt-in because it is a
  side effect, and it is loopback-only because a scanner is not what this tool is.
- A previous `install` bundle, if one is in the expected place.

### Router supervision

The console owns at most one router listener inside its own process, started through the same
`startServer` the CLI's `serve` runs. There is no fork, no pid file and no respawn. If a router was
started outside the console, a bounded loopback probe of `HEALTH_PATH` reports it as running but
not owned, and the console will not stop it.

## Contract

- **Reads are `GET`, writes are `POST`.** Any other method answers `405` with an `Allow` header.
- **Every write carries `expectedGeneration`.** A config that moved under the console is refused
  with `config-generation-conflict` and HTTP 409, so two open tabs cannot overwrite each other.
- **Writes need a same-origin request and `content-type: application/json`.** Both checks exist to
  stop a foreign page from driving the console: a plain HTML form can only send three content
  types and none of them is JSON.
- **`--read-only` refuses every write** with HTTP 403. Read-only is also forced, not optional, when
  the console binds off loopback, because it has no authentication.
- **The console does not dial out.** Only `models sync`, `doctor --connect` and the opt-in gateway
  probe touch the network, and the probe stays on loopback.
- **State is read per request.** Edit the config in an editor, press Refresh, see the new
  generation. `serve` freezes one generation at start-up; the console does not.

### Endpoints

Reads:

| Endpoint | Mirrors | Query |
|---|---|---|
| `GET /api/system/status` | header payload: version, config health, router, snapshot, env | |
| `GET /api/detect` | auto-detection report | `probe=1` |
| `GET /api/config/show` | `config show` | |
| `GET /api/config/check` | `config check` | |
| `GET /api/models` | `models list` | |
| `GET /api/agents` | `agents list` | `client` |
| `GET /api/route/preview` | `route preview` | `client`, `agent`, `model`, `parent-model` |
| `GET /api/doctor` | `doctor` | |
| `GET /api/events` | the event log | `after` |
| `GET /api/events/stream` | the same log as Server-Sent Events | |

Writes (all `POST`, all JSON, all refused in read-only mode):

| Endpoint | Effect |
|---|---|
| `/api/config/init` | writes a first config at `scope: "project"` or `scope: "home"` |
| `/api/config/models/override` | sets alias, description, client model or enabled state for one model |
| `/api/config/roles` | sets or clears one agent's route override |
| `/api/config/defaults` | sets the default child model and the unmarked-subagent policy |
| `/api/config/source` | sets model-source fields and the environment variable NAMES |
| `/api/config/agent-root` | sets or clears a client's agent config root |
| `/api/models/sync` | `models sync` (the one endpoint that contacts the model source) |
| `/api/router/start`, `/api/router/stop`, `/api/router/restart` | the in-process router |
| `/api/install` | `install`: generates the client bundle into a directory you name |

Success body: `{"command": "models list", "code": 0, "payload": { ... }}`. `code` is the exit code
the same CLI command would return, carried as data: a `config check` that found problems answers
HTTP 200 with `code: 2`. Failure body: `{"error": {"code": "...", "message": "..."}}` with 409 for a
conflict, 400 for a usage or config problem, and 500 with the fixed label `web-internal-error` for
anything else.

## Invariants

- **Environment variable VALUES never enter a payload.** The config holds names, the process holds
  values, and no endpoint resolves one into the other. `tests/web/server.test.ts` puts a secret in
  the environment and fails if it appears in any response.
- **The served page runs under a lockdown CSP**: `default-src 'none'; script-src 'self'; style-src
  'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'`, plus `nosniff`, `no-referrer` and `no-store`. `scripts/build-web.ts`
  re-reads what it wrote and fails the build on an inline script, an inline style or an off-origin
  request, because the CSP is sent by a module the build script does not own.
- **A request addressed to a foreign DNS name is refused with 403.** Without that check any web
  page could point a name it controls at the console's address and read the operator's config out
  of the browser (DNS rebinding). Address literals stay allowed, because rebinding needs a name.
- **Svelte escapes text by default and the app uses no `{@html}`.** Model descriptions, agent names
  and error messages are gateway- or filesystem-controlled and are rendered as text.
- **Route handlers validate every request body at runtime.** The `*Request` types in
  `src/web/mutate.ts` are compile-time only; `src/web/routes.ts` parses each field and answers
  `web-bad-request` with HTTP 400 on a bad one. A rejected write leaves the generation unchanged.
- **No credential is ever written into a generated file.** The `install` bundle names the loopback
  router and nothing else.
- **The listener runs with Bun's development error page off**, so a failure inside a handler cannot
  return source paths or source lines.
- No CORS header is ever sent, so no other origin can read a response.

Filesystem paths are NOT hidden. A `config-missing` or `agent-file-malformed` message names the
file it failed on, so the config path, the home directory and the agent roots can appear in a
response body. That is the same text the CLI prints on stderr.

## Gaps

- **Not authenticated.** Anyone who can reach the port can read the config and, on loopback, change
  it. Keep it on loopback. A non-loopback `--host` is accepted but forced read-only.
- **The event log is in memory and bounded.** It does not survive a console restart and is not a
  persistent audit trail.
- **Router supervision ends with the console.** Stopping the console stops a router it started.
- **The route preview is the same offline simulation `route preview` performs**, with the same
  stated assumptions. It is not evidence about a real client run.
- **`install` from the console generates files; it never edits an installed client
  configuration.** Connecting the client is still a step the operator takes.
- Verified on Bun 1.4.2, Svelte 5.57.0 and Chrome. `request.url` carrying the client's Host header
  is Bun.serve behavior and is covered by a test that drives a real socket.

## Building the app

```sh
bun run build:web     # writes dist/web/{index.html,main.js,main.css}
```

`bun run build` runs the package build first and the web build second, because the package build
rotates `dist/`. Asset names are fixed, not hashed: the server serves three known paths under a
`script-src 'self'` CSP. If `dist/web/index.html` is missing, the console serves a page that tells
the operator to run the build; a missing `main.js` or `main.css` answers `503`, so a half-loaded app
fails loudly instead of rendering blank.
