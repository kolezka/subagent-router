# Releasing

Short checklist. The package is `private: true` and is not published to a registry, so a release
means a tagged, verified commit on `main`, nothing more.

## 1. Verify the tree

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

All four must pass with their real exit codes. Do not pipe them through anything that swallows a
non-zero exit.

## 2. Exercise the packaged CLI, not just the tests

```sh
bun dist/cli.js --version
bun dist/cli.js config check --config ./subagent-router.json
bun dist/cli.js ui --config ./subagent-router.json --port 8788
```

Open `http://127.0.0.1:8788` and confirm the catalog, agents, route preview and diagnostics render.

## 3. Re-measure the client you claim to support

```sh
PROBE_CLAUDE_BIN="$(command -v claude)" \
PROBE_PACKAGED_SERVE=1 \
PROBE_PACKAGED_CAPABILITY_PROFILE=tests/fixtures/capabilities/claude-code-<version>.json \
  bash tests/probes/native-claude-run.sh handler
```

Repeat for `next-turn`, `nested` and `resume`. Read the model out of each
`capture/*-post-handler-upstream.json` on the gateway side. A `PARENT_FINAL_OK` result and a
`supported` field are not evidence on their own.

## 4. Bump the version

`package.json` and the `VERSION` literal in `src/cli/main.ts` must match. The test
`the version the CLI prints is the version the package declares` fails if they drift.

## 5. Write the changelog entry

Record what was verified and against which client version, plus the limits that stay open. Do not
carry a passing flag over from an older client version.

## 6. Merge and tag

Open a pull request, get it reviewed, merge it. Tag only after the merge, and only with explicit
approval from the repository owner:

```sh
git tag -a v0.1.0 -m "subagent-router 0.1.0"
git push origin v0.1.0
```

Do not remove `private: true` and do not publish to a registry without a separate decision.
