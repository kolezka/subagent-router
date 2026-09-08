---
block: cli
doc: INVARIANTS
verified_against: 0480ec2e5403d400cd3e1252fa5886923a01b062
verified_on: 2026-09-08
---

# CLI invariants

What the tests under `tests/cli/`, `tests/agents/`, and `tests/e2e/` hold this block to, and where
the enforcement actually lives.

## Escaping

Every stderr line, and every human-mode string that embeds untrusted input (a model ID, an agent
name, a file path), passes through `escapeControl` (`src/cli/output.ts`) before it reaches a
terminal. `--json` mode still escapes stderr diagnostics; only stdout's JSON rendering skips it,
because `JSON.stringify` already escapes control characters. Enforced by
`tests/cli/diagnostics.test.ts` and `tests/cli/output.test.ts`.

## Generation

`LoadedState.generation` (`src/io/store.ts`) is `sha256(configHash:snapshotHash)`. It changes if
and only if the bytes of `subagent-router.json` or `models.lock.json` changed. Every command that
reads state reports the generation it actually loaded (`config show`, `config check`, `route
preview`, `serve`'s own `ServeHandle.generation`); none of them cache or reuse a generation from a
previous call. Enforced by `tests/e2e/cli-workflow.test.ts` (compares generation across a full
sync/describe/preview/check/export-dry-run sequence) and `tests/io/store.test.ts`.

## Concurrent writes are rejected, never silently merged

`commitState` re-reads the config/snapshot hashes right before writing and throws
`store-conflict` if they no longer match the `LoadedState` the caller loaded from. A CLI write
command (`models sync`, `models describe`) surfaces this as exit 1 with `store-conflict` in the
diagnostic, never a silent merge or a stale overwrite. Enforced by `tests/io/store.test.ts` and the
CLI-level mapping test in `tests/cli/write.test.ts`.

## `config export` never touches a native file

`exportConfig` (`src/agents/export.ts`) only ever writes under the caller's `outputDir`. It refuses
(`export-native-root`) whenever the resolved output directory, or the concrete per-client target
inside it, equals, contains, or is contained by ANY client's candidate native agent root -- not
only the client being exported -- computed the same way file scanners themselves compute their
roots (`candidateAgentRoots`, `src/agents/inventory.ts`), so this cannot drift from what
`agents list`/`agents show` would scan for the same config. This check runs before `--force` is
even consulted; `--force` only ever permits replacing a *previous export's own output*, never a
native root. An empty, not-yet-created native root, or a symlinked one, is protected the same as a
populated one, since the check compares realpath'd directories, not directory listings.

The comparison itself folds letter case and canonicalizes Unicode composition (NFC) before
comparing two paths; the actual paths used for every real filesystem operation (mkdir, staging,
rename, written command paths) keep their original casing and byte sequence, unchanged. This is
deliberately conservative: on a case-sensitive filesystem it can refuse two genuinely distinct
directories that merely share a case- or accent-composition-folded spelling. That tradeoff is
accepted for a guard whose only job is refusing to write into or over a native agent directory; it
is scoped to this one comparison and never applied to upstream model IDs, exported/written file
paths, or model aliases. Enforced by `tests/cli/export.test.ts`'s `native root protection` suite
and `tests/cli/export-dispatch.test.ts` (the same checks reached through `runCli`).

## `config export` never writes outside the output directory

Every planned path is containment-checked (`assertPlanPathContained`, `src/agents/export.ts`)
before it is hashed, reported or written: rooted under the client dir, no empty, `.` or `..`
segment, no backslash, and resolved strictly below `<output>/<client-dir>/`. The names that feed
those paths (codex role names, OpenCode agent names taken from native frontmatter, model aliases)
are each required to be one safe path segment at their source (`assertSafePathSegment`,
`src/core/path-segment.ts`). A native OpenCode agent whose frontmatter `name` carries `..`
segments used to escape the output directory through this path; it is now `export-unsafe-name`,
exit 2, with nothing written, in real and dry runs. Enforced by `tests/cli/export.test.ts`
(file-backed OpenCode and codex traversal regressions), `tests/cli/export-dispatch.test.ts` (the
same through `runCli`) and `tests/agents/export-containment.test.ts` (the containment helper).

## `config export` writes atomically or not at all

The full artifact set (including the sidecar) is built and hashed in memory first, staged into a
temp directory under the resolved output directory, then published with a single rename. A prior
artifact set is replaced through a backup-rename-restore-on-failure sequence: if the second rename
fails, the backup is restored, so a failure never leaves neither the old nor the new set on disk. A
collision without `--force` is refused (`export-collision`) before any write. `--dry-run` returns
the exact plan, performs no filesystem write, and is not subject to the collision check (there is
nothing to replace). Enforced by `tests/cli/export.test.ts` (force replace, dry-run vs real-run
byte identity, dry-run over an existing artifact) and the collision/dry-run tests in
`tests/cli/export-dispatch.test.ts`.

## `config export` reads state once

`configExport` (`src/cli/write.ts`) loads state once, reads the agent inventory from that state's
roots and passes the same `LoadedState` into `exportConfig` (`ExportOptions.state`), so the
inventory and the sidecar's generation cannot come from two different reads of a config file that
was edited in between. `exportConfig` itself checks that a supplied state's `configPath` matches
the `configPath` argument it was called with (`resolve(configPath)`), and throws
`export-plan-invariant` otherwise: a caller cannot pass state loaded for one config path while
exporting a different one and have the two silently mixed. Enforced by `tests/cli/export.test.ts`
(a supplied state is used even when the config file is gone from disk; a state loaded from a
different config path is rejected before any write).

## Sidecar hashes describe the actual plan, never a claim about native load

Every export sidecar's `artifacts` map is computed from the exact final bytes of every other file
in the same atomic plan (`sha256` over `file.content`), after the plan is fully built and before
anything is written. It proves what was written, not that any native client read it. `doctor`,
`config check` and every export sidecar show `unknown` rather than a runtime proof when they cannot
observe a real native resolver; see GAPS.md for what remains unmeasured.

## Offline commands never call `deps.fetch`

`models list`, `models show`, `models describe`, `agents list`, `agents show`, `route preview`,
`config show`, `config check`, `config export`, and plain `doctor` (no `--connect`) never invoke
`deps.fetch`. Only `models sync` and `doctor --connect` do. `tests/e2e/cli-workflow.test.ts`
enforces this behaviorally: every offline step in that test is given a `fetch` that throws, so a
regression that reaches the network fails the test rather than merely violating an unread comment.

## `serve` freezes state at start

`startServer` loads config and snapshot exactly once and closes over that `LoadedState`; a
config/snapshot file edited after the server started is not observed by that running instance
(this is a stated design property, "immutable per generation", not a bug). A new generation
requires a new `serve` invocation. Enforced by `tests/cli/serve.test.ts` and
`tests/e2e/routing.test.ts`.

## `serve` refuses to bind on an unsupported client capability profile

`startServer` checks the loaded client capability profile (`client === 'claude-code'` and
`status === 'supported'`) before doing anything else that could bind a port: before loading the
transport profile, before `createHandler`, before `Bun.serve`. A `pending` or `unsupported`
profile is `unsupported-path`, exit 1, and no listener is ever created -- proven by asserting no
port was bound, not only by the exit code. This is deliberately independent of the transport-
profile check `createHandler`'s own `assertTransportProfileReady` still performs: a profile that
is fully `passed` for transport but still `pending` for the client is refused here specifically,
before transport is ever consulted. Cost accepted for this ruling: standalone `serve` can no
longer be used as a parent-only passthrough proxy while native support is unmeasured, even though
`createHandler` itself would let a plain parent (non-subagent) request through untouched.
`createHandler`'s own per-request gates are unchanged; an embedder that constructs `createHandler`
directly, rather than going through `serve`, is not affected by this preflight at all. Enforced by
`tests/cli/serve-dispatch.test.ts`'s two negative cases (both profiles pending; client pending
with transport fully passed) and its existing supported/passed positive control.
