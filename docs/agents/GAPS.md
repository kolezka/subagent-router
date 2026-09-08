# Agents: gaps

No shipped capability fixture in this repository reports `status: 'supported'` for OpenCode or
Codex. [verified] direct read of
[../../tests/fixtures/capabilities/opencode-1.18.29.json](../../tests/fixtures/capabilities/opencode-1.18.29.json)
and
[codex-pending.json](../../tests/fixtures/capabilities/codex-pending.json): every probe is
`"pending"`. Nothing in this block's own code changes that; a status change requires a real
measurement run through `tests/probes/run.ts`, never an edit to a fixture file.

- **M6 / M6-runtime (OpenCode).** Whether `tool.execute.before` actually runs before spawn, for the
  running version, is unmeasured. The production `resolveNativeRuntimeContext` needs
  `PluginInput.client.app.agents()` wired up; no such wiring exists yet (see the docstring in
  [../../src/adapters/opencode-plugin.ts](../../src/adapters/opencode-plugin.ts)). A
  positive/negative-control spawn test exists only as an opt-in harness:
  [../../tests/probes/native-opencode.test.ts](../../tests/probes/native-opencode.test.ts) (skips
  without a real OpenCode binary).
- **M7 / M9 (Codex).** No production `resolveNativeRuntimeContext` exists for Codex at all; the
  real bootstrap in [../../src/adapters/codex-hook.ts](../../src/adapters/codex-hook.ts) always
  passes `async () => undefined`, so `validateCodexSpawn`'s `route` branch is exercised today only
  by synthetic, explicitly-marked test profiles. [verified] there is no
  `tests/e2e/native-routing.test.ts` file in this worktree (checked directly); only its planned
  named cases are described in the Task 15 brief.
- **Export vs. runtime.** `exportConfig` producing a correct artifact tree
  ([../../tests/cli/export.test.ts](../../tests/cli/export.test.ts)) is not evidence any client
  loaded it; the sidecar hash proves what was written, never that it was read.
- Codex's PreToolUse wiring is explicitly marked `_status: "naming-only... unmeasured"` in its own
  exported fragment; treat that string as authoritative over any status claimed elsewhere.

Turning either fixture into `status: 'supported'` by hand, without a passing M6/M6-runtime or M7
measurement, would be a fabricated result, not a fix.
