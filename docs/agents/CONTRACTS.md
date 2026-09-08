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

## exportConfig / opencodeVariants (output-directory containment)

Every planned file path must be rooted under the client dir, free of empty, `.` and `..`
segments and backslashes, and resolve strictly below the concrete client target
(`assertPlanPathContained`, `export-plan-invariant`); the check runs before hashing, before the
dry-run return and before any write. The names that become file names are validated at their
source as single safe path segments (`assertSafePathSegment`, `export-unsafe-name`): codex role
names in `buildCodexFiles`, OpenCode agent names and model aliases in `opencodeVariants`. An
OpenCode agent name comes verbatim from native frontmatter and is untrusted. [verified] against
[../../src/agents/export.ts](../../src/agents/export.ts),
[../../src/adapters/opencode.ts](../../src/adapters/opencode.ts) and
[../../src/core/path-segment.ts](../../src/core/path-segment.ts).

enforcement: [../../tests/cli/export.test.ts](../../tests/cli/export.test.ts) (file-backed
OpenCode traversal, real and dry run; codex traversal),
[../../tests/cli/export-dispatch.test.ts](../../tests/cli/export-dispatch.test.ts) (through
`runCli`), [../../tests/agents/export-containment.test.ts](../../tests/agents/export-containment.test.ts)

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

## parseAgentMarkdown (exact body text)

The body returned is the exact original substring of the file after the closing frontmatter
delimiter's line terminator: whatever mix of CRLF/LF, blank lines and trailing whitespace the
source file used is preserved byte for byte, never normalized through a `join('\n')`. A file
with no frontmatter passes through unchanged as the body. [verified] against
[../../src/agents/claude-code.ts](../../src/agents/claude-code.ts) (`bodyAfterLine`).

enforcement: [../../tests/agents/inventory.test.ts](../../tests/agents/inventory.test.ts),
`describe('parseAgentMarkdown boundaries')` and the CRLF fixture case in
`describe('body and parser errors do not modify or leak source content')`

## parseAgentMarkdown / listTomlAgents / readOpencodeAgents (safe parse errors)

A malformed YAML, TOML or JSON agent file throws `RouterError('agent-file-malformed', ...)` with
a message built only from the file path, never from the underlying parser's own exception
message, which could otherwise echo raw source content (including secrets) back into CLI output.
[verified] against [../../src/agents/claude-code.ts](../../src/agents/claude-code.ts),
[../../src/agents/codex.ts](../../src/agents/codex.ts),
[../../src/agents/opencode.ts](../../src/agents/opencode.ts).

enforcement: [../../tests/agents/inventory.test.ts](../../tests/agents/inventory.test.ts),
sentinel-secret and fault-injection cases in
`describe('body and parser errors do not modify or leak source content')`

## buildCodexFiles (catalog validation, no-snapshot naming-only exception)

When a catalog was built (a snapshot exists), each exported role's `routeOverride` is resolved
against it; an unresolvable ID/alias or a resolved-but-disabled model throws before any file is
written (`unknown-model`/`model-not-allowed`, the same codes `route.ts`'s live resolver uses).
When no snapshot exists, this check does not run: `routeOverride` is emitted into the role's TOML
as-is, unverified. This is the documented no-snapshot, naming-only export path, not a bug.
[verified] against [../../src/agents/export.ts](../../src/agents/export.ts) (`buildCodexFiles`).

enforcement: [../../tests/cli/export-catalog.test.ts](../../tests/cli/export-catalog.test.ts)
