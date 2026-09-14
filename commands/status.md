---
description: Report the subagent-router config, catalog and router health.
argument-hint: [path to subagent-router.json]
---

Use `$ARGUMENTS` as the config path when it is given, otherwise `./subagent-router.json`.

Run these two commands with that path and report what they return. Change nothing.

```sh
subagent-router-plugin config check --config <config> --json
subagent-router-plugin models list --config <config> --json
```

Then report, in this order:

1. Whether `config check` exited 0. If not, quote each problem code exactly as printed.
2. Which models are enabled, with the alias each one answers to.
3. Whether `ANTHROPIC_BASE_URL` is set in this session, and whether
   `curl -sf --max-time 2 "$ANTHROPIC_BASE_URL/subagent-router/control/instance"` returns a
   `handlerInstanceId`. That body is what proves a router, not another endpoint, is answering.

Never print the value of an environment variable. Names only.

`subagent-router-plugin` runs the CLI out of the installed plugin, so it reports on the plugin's
own version. Use your own build (`bun dist/cli.js`) when you need to check a different checkout.
