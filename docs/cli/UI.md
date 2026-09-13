# Web console (`ui`)

`subagent-router ui` starts a local, read-only web console for the router. It is part of the CLI
block (`src/cli/ui.ts`, `src/cli/ui-page.ts`) and is newer than the `verified_against` stamp in
[README.md](README.md); this document is not stamped yet and makes no claim about any other file
in the block.

```sh
bun dist/cli.js ui --config ./subagent-router.json --port 8788
# console on http://127.0.0.1:8788 (read-only)
```

Defaults: port `8788`, host `127.0.0.1`. `serve` keeps `8787`, so both can run at once against the
same config.

## What it is for

Everything the CLI can already answer offline, in one page you can keep open while editing the
config: model catalog, agent inventory per client, a simulated route decision, `config check`
findings and the `doctor` report.

## Contract

- **GET only.** Every other method answers `405`. There is no write endpoint: the console cannot
  run `models sync`, `models describe`, `config export` or any other mutation.
- **No network.** No endpoint calls the configured gateway or model source. `doctor` here is the
  offline report; there is no `--connect` equivalent.
- **Not a routing path.** The console is a separate listener from `serve` and never forwards a
  request upstream. Nothing in the measured client lifecycle goes through it.
- **State is read per request**, unlike `serve`, which freezes one generation at startup. Edit the
  config, press Refresh, see the new generation.
- The `--config` and `--agents-dir` values given to `ui` are used for every request, so the console
  inspects exactly what the same invocation's `models list` / `agents list` would.

### Endpoints

| Endpoint | Mirrors | Query |
|---|---|---|
| `GET /` | the console page itself | |
| `GET /api/status` | generation, config path, snapshot summary | |
| `GET /api/doctor` | `doctor` | |
| `GET /api/config/check` | `config check` | |
| `GET /api/config/show` | `config show` | |
| `GET /api/models` | `models list` | |
| `GET /api/agents` | `agents list` | `client` |
| `GET /api/route/preview` | `route preview` | `client`, `agent`, `model`, `parent-model` |

Success body: `{"command": "models list", "code": 0, "payload": { ... }}`. `code` is the exit code
the same CLI command would return, carried as data: a `config check` that found problems answers
HTTP 200 with `code: 2`, and so does a route preview whose simulated decision is an error. Failure
body: `{"error": {"code": "snapshot-missing", "message": "..."}}` with HTTP 400 for a usage or
config problem and 500 for anything else.

## Invariants

- **The console never renders untrusted text as markup.** Model descriptions, agent names and
  error messages are gateway- or filesystem-controlled. The page builds its DOM with
  `createElement` and `textContent` only; `tests/cli/ui.test.ts` fails if a markup sink appears in
  the served document.
- **Responses carry a lockdown CSP** (`default-src 'none'`, `connect-src 'self'`, no external
  origin) plus `nosniff`, `no-referrer` and `no-store`. The page is inline-only and loads nothing
  from the network.
- **A request addressed to a foreign DNS name is refused with 403.** Without that check, any web
  page could point a hostname it controls at the console's address and read the operator's config
  out of the browser (DNS rebinding); the same-origin policy does not prevent it. Address literals
  stay allowed, because rebinding needs a name.
- **`config show` exposes environment variable NAMES, never resolved values.** That holds for the
  console because it holds for the config object itself: the gateway credential lives in the
  process environment and no endpoint resolves it into a response body. `tests/cli/ui.test.ts`
  puts a secret in the environment and fails if it appears in a response.
- **A malformed `Host` answers `400` as JSON**, and the listener runs with Bun's development error
  page off, so a failure inside the handler cannot return source paths or source lines.
- No CORS header is ever sent, so no other origin can read a response.

Filesystem paths are NOT hidden. A `config-missing` or `agent-file-malformed` message names the
file it failed on, so the config path, the home directory and the agent roots (`CLAUDE_CONFIG_DIR`,
`--agents-dir`) can appear in a response body. That is the same text the CLI prints on stderr; it
matters here only because a reader of the port is not always the operator.

## Gaps

- Not authenticated. Anyone who can reach the port can read the config. Keep it on loopback.
  `--host` accepts any bind address, and a non-loopback one (`0.0.0.0`, a LAN address) prints a
  warning on stderr but is not refused.
- Read-only by design. Editing roles, overrides or defaults still goes through the CLI.
- No live view of a running `serve` instance: correlation bindings live in that process's memory
  and are not exposed anywhere. The console shows configuration and simulation, not live traffic.
- The route preview is the same offline simulation `route preview` performs, with the same stated
  assumptions (`authenticatedChild`, `freshDelegation`, `runtimeCapabilityNotProven`). It is not
  evidence about a real client run.
- Verified on Bun 1.4.2 and Chrome. `request.url` carrying the client's Host header is Bun.serve
  behavior and is covered by a test that drives a real socket.
