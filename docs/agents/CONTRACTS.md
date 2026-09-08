# Agents: contracts

## readAgentInventory / getAgent

A file scan alone is `completeness: 'files-only'`; only a caller-supplied `nativeInventory` with
`completeness: 'native'` upgrades the result, and only that client's own entries merge in. A
native entry with no on-disk counterpart is forced to `availability: 'fileless'`. [verified]
against [../../src/agents/inventory.ts](../../src/agents/inventory.ts).

enforcement: [../../tests/agents/inventory.test.ts](../../tests/agents/inventory.test.ts)

## exportConfig (full native-root export protection)

Refuses to write when the output directory, or the concrete per-client target, equals, contains,
or is contained by any candidate native agent root for any client, including a root with no files
or that does not exist yet, and including a root reached only through a symlink. Runs
unconditionally, before `--force` is consulted. [verified] against
[../../src/agents/export.ts](../../src/agents/export.ts) (`assertNoOverlapWithResolvedRoots`,
`resolveRealPath`).

enforcement: [../../tests/cli/export.test.ts](../../tests/cli/export.test.ts),
`describe('native root protection')`: empty not-yet-created root, root shared across clients,
configRoot override plus additionalRoots entry, symlinked ancestor, symlinked concrete target,
permission error while resolving a root.

## assertCapability / loadCapabilityProfile (profile refusal)

A gate applies only to its declared client; a profile that is not `status: 'supported'`, whose
lifecycle phase is not proven `passed`, or whose gate-specific probes are not `passed`, throws. A
fixture declaring a different client/version than requested is a schema error, never a silent
cast. [verified] against [../../src/adapters/capabilities.ts](../../src/adapters/capabilities.ts).

enforcement: [../../tests/adapters/capabilities.test.ts](../../tests/adapters/capabilities.test.ts)

## validateOpenCodeTask / validateCodexSpawn (native runtime witness)

A `route` decision additionally requires `inventory.completeness === 'native'` and a
`NativeConfigWitness` self-reporting `source: 'authoritative-native-resolver'` with
`effectiveModel` literally equal to the decision's `upstreamModel`; an alias never substitutes for
an exact ID in the explicit-model field. [verified] against
[../../src/adapters/opencode.ts](../../src/adapters/opencode.ts) and
[../../src/adapters/codex.ts](../../src/adapters/codex.ts).

enforcement: [../../tests/adapters/opencode.test.ts](../../tests/adapters/opencode.test.ts),
[../../tests/adapters/codex.test.ts](../../tests/adapters/codex.test.ts)

## createOpenCodePlugin / runCodexPreToolUseHook (deny by throw / by hook output)

OpenCode's `tool.execute.before` has no return-value refusal path, so denial is a thrown
`RouterError`; a missing resolver context denies the same way. Codex's `PreToolUse` hook writes a
`permissionDecision: 'deny'` object for an error decision and an empty object otherwise; it never
emits `updatedInput`. [verified] against
[../../src/adapters/opencode-plugin.ts](../../src/adapters/opencode-plugin.ts) and
[../../src/adapters/codex-hook.ts](../../src/adapters/codex-hook.ts).

enforcement: [../../tests/adapters/opencode-plugin.test.ts](../../tests/adapters/opencode-plugin.test.ts),
[../../tests/adapters/codex-hook.test.ts](../../tests/adapters/codex-hook.test.ts)
