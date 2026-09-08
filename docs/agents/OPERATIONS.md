# Agents: operations

## Run the tests

    bun test tests/agents tests/adapters tests/cli/export.test.ts

Opt-in native harness (skips without a real OpenCode binary). [verified] direct read of
[../../tests/probes/native-opencode.test.ts](../../tests/probes/native-opencode.test.ts): the
gate is `RUN_NATIVE_PROBES`, not `SUBAGENT_ROUTER_E2E` (that name is only used, per the Task 15
brief, for the not-yet-written `tests/e2e/native-routing.test.ts`; do not conflate the two):

    RUN_NATIVE_PROBES=1 bun test tests/probes/native-opencode.test.ts

## Use from code

    import { readAgentInventory, getAgent } from './src/agents/inventory';
    import { exportConfig } from './src/agents/export';

    const inventory = await readAgentInventory('opencode', { cwd, home, env, additionalRoots: [] });
    const files = await exportConfig(configPath, 'opencode', outputDir, {
      dryRun: true, force: false, inventory, catalogRequired: false,
      resolverContext: { cwd, home, env, additionalRoots: [] },
    });

`exportConfig` with `dryRun: true` returns the planned file list without writing; drop `dryRun` to
write, and pass `force: true` only to replace an existing artifact directory (never a native root:
that check runs unconditionally, see [CONTRACTS.md](CONTRACTS.md)).

## CLI

`config export` CLI dispatch is under active integration in the parent worktree; do not treat this
doc as the source of truth for whether it is currently wired, exposed flags, or exit codes. Current
command availability is documented in `docs/cli`, owned separately; check there before assuming
either "wired" or "not wired". `exportConfig` (used directly above) is the stable, block-owned API
this block documents and is unaffected by however the CLI wiring around it evolves.
