# install

`install` generates the files that connect your own Claude Code to a running router. It writes
only into the directory you name. It never edits `~/.claude/settings.json`, a project
`.claude/settings.json` or any other installed client configuration.

```sh
bun dist/cli.js install \
  --output ./router-bundle \
  --config ./subagent-router.json \
  --claude-version 2.1.270
```

## What it writes

| File | Purpose |
| --- | --- |
| `settings.json` | `env` block with `ANTHROPIC_BASE_URL`, a placeholder `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_MODEL` when `--parent-model` is given |
| `claude-router` | Launcher: checks the router, then runs `claude --settings <bundle>/settings.json "$@"` |
| `.claude-plugin/plugin.json` | Plugin identity |
| `hooks/hooks.json` | Registers the session check |
| `hooks/check-router.sh` | `SessionStart` check, silent when healthy, never blocks a session |
| `commands/status.md` | `/subagent-router:status`, reports `config check` and the catalog |
| `README.md` | The three steps, written against the values you passed |

## Why it is a settings file and not a plugin

A Claude Code plugin manifest cannot set environment variables. A plugin's own `settings.json`
supports only `agent` and `subagentStatusLine`. Routing has to come from `ANTHROPIC_BASE_URL`, so
the bundle supplies it through `claude --settings`, a per-invocation level that overrides project
and user settings without editing either.

The plugin therefore carries the parts a plugin can carry: the session-start check and the status
command. Loading it is optional:

```sh
claude --settings ./router-bundle/settings.json --plugin-dir ./router-bundle
```

The marketplace plugin ([../plugin/README.md](../plugin/README.md)) carries the same two components
under the same plugin name, with values derived at run time instead of baked in. Enable one of the
two, not both.

## Provider independence

The bundle names one address: the loopback router. The router forwards to the gateway named by
`ROUTER_GATEWAY_URL`, so changing gateway or provider never changes a generated file. No provider
name, model vendor or credential appears in the bundle.

## The placeholder token

`settings.json` sets `ANTHROPIC_AUTH_TOKEN` to a value that is deliberately not a credential.

The router starts from the client's own request headers and replaces only the headers named in
`ROUTER_GATEWAY_HEADERS` (`buildUpstreamHeaders` in `src/transport/handler.ts`). A client that is
logged in to Anthropic would otherwise forward that real token to a third-party gateway. The
placeholder stops that. Put the gateway's own credential in `ROUTER_GATEWAY_HEADERS`, in the shell
that starts `serve`.

## Refusals

| Code | Cause |
| --- | --- |
| `install-missing-output` | `--output` was not given |
| `install-unsupported-client` | `--client` was not `claude-code`. OpenCode and Codex integration is unmeasured, so nothing is generated for them |
| `install-collision` | A file in the bundle already exists. Pass `--force` to replace it |
| `export-native-root` | The output directory overlaps a native agent directory. The same guard `config export` uses |

All four exit 2.

## Measured

On 2026-09-14, against the installed Claude Code 2.1.270 binary, an isolated `HOME` and
`CLAUDE_CONFIG_DIR`, the packaged `dist/cli.js serve`, and a loopback mock gateway:

- With no `ANTHROPIC_BASE_URL` in the process environment, `claude --settings <bundle>/settings.json`
  sent `HEAD /v1/api/hello` and two `POST /v1/messages` through the router to the gateway. The
  settings file alone is enough.
- With `--parent-model gpt-5.6-terra`, the gateway received `model=gpt-5.6-terra` on both requests.
  The client also warns that the id is not in its own catalog and then assumes a 200k context
  window for it. Set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` if the real window is larger.
- `hooks/check-router.sh` printed a warning with the router down, a different warning when
  `ANTHROPIC_BASE_URL` pointed elsewhere, and nothing at all when both were correct. It exited 0
  in every case.
- `claude-router` exited 2 with the `serve` command line when the router was down, and ran the
  real client when it was up, passing its arguments through.

Child model selection itself is not re-measured by `install`. It is the same `ANTHROPIC_BASE_URL`
path the native probe runs cover; see [../README.md](../README.md).
