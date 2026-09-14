---
description: Connect this Claude Code to a running subagent-router.
argument-hint: [path to subagent-router.json]
---

Installing this plugin does not route anything on its own. A plugin cannot set an environment
variable for the session, and routing needs `ANTHROPIC_BASE_URL` to point at the router. Walk the
operator through the rest.

Use `$ARGUMENTS` as the config path when it is given, otherwise `./subagent-router.json`.

1. Report whether routing is already live: is `ANTHROPIC_BASE_URL` set, and does
   `curl -sf --max-time 2 "$ANTHROPIC_BASE_URL/subagent-router/control/instance"` return a
   `handlerInstanceId`? If both hold, say so and stop.

2. Check the config with `subagent-router-plugin config check --config <config> --json`. If the
   file is missing, say which example to copy (`examples/minimal-router/subagent-router.json` in
   the repository) and stop. If `models sync` has never run, say that and stop: `serve` refuses to
   start without a snapshot of the gateway's own catalog.

3. Generate the integration bundle into a directory the operator names, never into `~/.claude`:

   ```sh
   subagent-router-plugin install --output ./router-bundle --config <config> \
     --claude-version "$(claude --version | awk '{print $1}')"
   ```

4. Print the two commands the operator runs themselves, in this order, and do not run either:

   ```sh
   # terminal 1, with ROUTER_GATEWAY_URL and ROUTER_GATEWAY_HEADERS set in that shell
   subagent-router-plugin serve --config <config> --claude-version <version>

   # terminal 2
   ./router-bundle/claude-router
   ```

   The current session keeps its own `ANTHROPIC_BASE_URL`. Routing starts in the session the
   launcher opens, not in this one.

Never print the value of an environment variable, and never put a gateway credential in a file.
The credential belongs in `ROUTER_GATEWAY_HEADERS` in the shell that starts `serve`.
