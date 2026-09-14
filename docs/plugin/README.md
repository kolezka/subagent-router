# Marketplace install

This repository is a Claude Code plugin and its own plugin marketplace. `/plugin install` gives an
operator the checks and commands without a clone, a build or a path to remember.

## Install

From the shared catalog:

```text
/plugin marketplace add kolezka/marketplace
/plugin install subagent-router@kolezka
```

From this repository alone:

```text
/plugin marketplace add kolezka/subagent-router
/plugin install subagent-router@subagent-router
```

Both install the same plugin. The marketplace name differs, so pick one: a plugin installed twice
under two marketplace names is two copies of the same components.

## What the plugin adds

| Component | Effect |
| --- | --- |
| `SessionStart` hook | Warns when the session is not routing. Silent when it is |
| `/subagent-router:status` | Reports `config check`, the catalog, and whether a router answers |
| `/subagent-router:setup` | Walks through connecting a client to a running router |
| `bin/subagent-router-plugin` | The router CLI, on the Bash tool's `PATH` while the plugin is enabled |

The wrapper runs the plugin's own source copy with Bun, so the CLI matches the installed plugin
ref and needs no build. Bun must be on `PATH`; without it the wrapper exits 127 and says so.

## What the plugin does not do

It does not route anything by itself. Routing is `ANTHROPIC_BASE_URL` pointing at a running
`serve`, and a plugin cannot set an environment variable for the session that loads it: a plugin's
own `settings.json` supports only `agent` and `subagentStatusLine`. So the marketplace install
covers the checks and the commands, and the connection still comes from `claude --settings`, from
the launcher `subagent-router install` generates, or from the variable set in the shell.

It also does not start the router, create a config, or write into `~/.claude`.

## How the session check decides

The hook reads the address the session actually uses, not an address configured anywhere:

1. No `ANTHROPIC_BASE_URL` means routing is off. It says so and exits.
2. Otherwise it dials `$ANTHROPIC_BASE_URL/subagent-router/control/instance` and requires a
   `handlerInstanceId` in the body. That endpoint answers inside the serving process and is never
   forwarded upstream, so the body is what tells a router apart from any other endpoint that
   returns 200.

It exits 0 in every case, including when `curl` is missing. A session-start hook that failed would
cost an operator the session, and the worst case it detects is a session that routes nothing.

## Overlap with `install`

`subagent-router install` generates a bundle that also contains a plugin named `subagent-router`
(see [../cli/INSTALL.md](../cli/INSTALL.md)). It is the same idea with the values baked in: the
generated one knows the router URL, the config path and the CLI path from the command line, while
the marketplace one derives what it can at run time. Load one of them, not both: two enabled
plugins with the same name are two session checks and two copies of each command.

The bundle is still what connects the client, whichever plugin is loaded.

## Measured

On 2026-09-14, Claude Code 2.1.270, Bun 1.4.2, Linux, against an isolated `CLAUDE_CONFIG_DIR`:

- `claude plugin validate .` passed on the marketplace manifest.
- `claude plugin marketplace add <checkout>` then `claude plugin install subagent-router@subagent-router`
  installed the plugin, and `claude plugin details subagent-router` reported 2 skills
  (`setup`, `status`), 1 `SessionStart` hook, and about 57 always-on tokens.
- From the installed copy, `bin/subagent-router-plugin --version` printed `0.1.0` with and without
  `CLAUDE_PLUGIN_ROOT` set, with no `node_modules` involved.
- The hook printed the "routing is off" line with no `ANTHROPIC_BASE_URL`, the "no router answers"
  line against a refused port and against a local endpoint that returned 200 without a
  `handlerInstanceId`, and nothing at all against one that returned the `handlerInstanceId` body.
  It exited 0 in all four cases.

`tests/plugin.test.ts` locks the same four hook cases and the manifest agreement. Both guards were
made to fail once on purpose before they were trusted.

## Limits

- Adding this checkout as a local marketplace copies the whole working directory into the plugin
  cache, including ignored files such as `node_modules` and `dist`. A GitHub source clones the
  tracked files only, so use the local path for testing and the GitHub source for real use.
- The plugin carries the whole repository, because the plugin root is the repository root. That is
  what makes the CLI wrapper work from source.
- `/subagent-router:status` and `/subagent-router:setup` need Bun for the CLI. The session check
  does not: it needs only `curl`, and says so when `curl` is missing.
- Nothing here is measured on OpenCode or Codex. The plugin format is Claude Code's.
