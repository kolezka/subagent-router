import { describe, expect, test } from 'bun:test';
import { runCodexPreToolUseHook } from '../../src/adapters/codex-hook';
import type { CodexHookDeps } from '../../src/adapters/codex-hook';
import { RouterError } from '../../src/core/errors';
import { buildCatalog } from '../../src/core/catalog';
import type { AgentInventory, CapabilityProfile, NativeRuntimeContext } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

// `completeness: 'native'`: a files-only scan can never justify the `route` decision the
// synthetic-positive test below exercises (validateCodexSpawn now enforces this, mirroring
// OpenCode's own adapter); every denial-path test here fails for its own explicit reason well
// before that check is reached, so the flip does not affect them.
const inventory: AgentInventory = {
  entries: [{ client: 'codex', name: 'reviewer', scope: 'user', path: '/h/.codex/agents/reviewer.toml', declaredModel: 'gateway/base', hidden: false, native: {}, availability: 'available', shadowed: false }],
  completeness: 'native',
  diagnostics: [],
};

const supported: CapabilityProfile = {
  client: 'codex',
  version: 'synthetic-hermetic',
  status: 'supported',
  correlation: false,
  correlationEntropy: 'pending',
  fork: false,
  adapterMarkerPosition: 'unknown',
  probes: { M5: 'passed', M7: 'passed', M9: 'passed', M10: 'passed', 'M10-freshness': 'passed' },
  lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' },
};

function nativeContext(effectiveModel = FIXTURE_MODEL_ID, patch: Partial<NativeRuntimeContext['nativeConfig']> = {}): NativeRuntimeContext {
  return {
    lifecyclePhase: 'next-turn',
    freshDelegation: true,
    nativeConfig: {
      source: 'authoritative-native-resolver',
      effectiveModel,
      expectedGeneration: 'fixture-generation',
      actualGeneration: 'fixture-generation',
      artifactHash: 'fixture-artifact-hash',
      ...patch,
    },
  };
}

function jsonStdin(payload: unknown): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function rawStdin(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function collectStdout(): { stream: WritableStream<Uint8Array>; text: () => string } {
  const chunks: Uint8Array[] = [];
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  });
  return { stream, text: () => new TextDecoder().decode(concat(chunks)) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * External test driver mirroring what Codex itself would do with this hook's real output: read
 * the PreToolUse decision, and only proceed toward the actual native spawn when it is not a deny.
 * `continueNativeSpawn` is purely a test spy, never a router dependency -- the hook itself never
 * calls it and never launches a child (see the docstring on `runCodexPreToolUseHook`). This does
 * NOT and cannot prove that Codex was actually stopped: only an opt-in scenario with a real client
 * and a capture gateway proves that a denial prevented a native request.
 */
async function drive(deps: CodexHookDeps, toolInput: unknown, toolName = 'Agent'): Promise<{ continued: number; output: unknown }> {
  const out = collectStdout();
  await runCodexPreToolUseHook(jsonStdin({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput }), out.stream, deps);
  const output: unknown = JSON.parse(out.text());
  const denied = isRecord(output) && isRecord(output.hookSpecificOutput) && output.hookSpecificOutput.permissionDecision === 'deny';
  let continued = 0;
  const continueNativeSpawn = (): void => {
    continued += 1;
  };
  if (!denied) continueNativeSpawn();
  return { continued, output };
}

describe('runCodexPreToolUseHook', () => {
  test('reads-stdin-writes-pretooluse-deny', async () => {
    const config = configFixture();
    const catalog = buildCatalog(config, await snapshotFixture());
    const deps: CodexHookDeps = { inventory, config, catalog, profile: supported, resolveNativeRuntimeContext: async () => nativeContext() };

    const { output } = await drive(deps, { model: 'gateway/ghost', prompt: 'x' });

    expect(output).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'subagent-router: unknown-model' },
    });
  });

  test('deny-skips-stubbed-native-continuation', async () => {
    const config = configFixture();
    const catalog = buildCatalog(config, await snapshotFixture());
    const deps: CodexHookDeps = { inventory, config, catalog, profile: supported, resolveNativeRuntimeContext: async () => nativeContext() };

    const { continued } = await drive(deps, { model: 'gateway/ghost', prompt: 'x' });

    expect(continued).toBe(0);
  });

  test('synthetic-positive-calls-stubbed-native-continuation', async () => {
    // Synthetic only: no shipped Codex profile is 'supported' (codex-pending.json is the only
    // fixture, and it is 'pending'). This exercises the allow path in isolation; it is never
    // evidence that a real Codex client accepts this hook's decision.
    const config = configFixture();
    const catalog = buildCatalog(config, await snapshotFixture());
    const deps: CodexHookDeps = { inventory, config, catalog, profile: supported, resolveNativeRuntimeContext: async () => nativeContext() };

    const { output, continued } = await drive(deps, { model: FIXTURE_MODEL_ID, prompt: 'x' });

    expect(output).toEqual({});
    expect(continued).toBe(1);
  });

  test('rejects-present-but-invalid-model-before-role-default', async () => {
    const config = configFixture({ roles: { 'codex:reviewer': { routeOverride: FIXTURE_MODEL_ID } } });
    const catalog = buildCatalog(config, await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/raw-fast-id']));
    const deps: CodexHookDeps = { inventory, config, catalog, profile: supported, resolveNativeRuntimeContext: async () => nativeContext() };

    // 'fast' is a real alias (for FIXTURE_MODEL_ID) but never a valid explicit selection: an
    // invalid-but-present model must deny, never silently fall back to the role's routeOverride.
    const { output, continued } = await drive(deps, { role: 'reviewer', model: 'fast', prompt: 'x' });

    expect(output).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'subagent-router: unknown-model' },
    });
    expect(continued).toBe(0);
  });

  test('requires-native-witness-generation-and-artifact', async () => {
    const config = configFixture();
    const catalog = buildCatalog(config, await snapshotFixture());

    const noWitness: CodexHookDeps = { inventory, config, catalog, profile: supported, resolveNativeRuntimeContext: async () => undefined };
    const missing = await drive(noWitness, { model: FIXTURE_MODEL_ID, prompt: 'x' });
    expect(missing.output).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'subagent-router: unsupported-path' },
    });
    expect(missing.continued).toBe(0);

    const mismatchedGeneration: CodexHookDeps = {
      inventory,
      config,
      catalog,
      profile: supported,
      resolveNativeRuntimeContext: async () => nativeContext(FIXTURE_MODEL_ID, { actualGeneration: 'a-different-generation' }),
    };
    const genMismatch = await drive(mismatchedGeneration, { model: FIXTURE_MODEL_ID, prompt: 'x' });
    expect((genMismatch.output as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason).toBe(
      'subagent-router: unsupported-path',
    );
    expect(genMismatch.continued).toBe(0);

    const emptyArtifact: CodexHookDeps = {
      inventory,
      config,
      catalog,
      profile: supported,
      resolveNativeRuntimeContext: async () => nativeContext(FIXTURE_MODEL_ID, { artifactHash: '' }),
    };
    const artifactMissing = await drive(emptyArtifact, { model: FIXTURE_MODEL_ID, prompt: 'x' });
    expect((artifactMissing.output as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason).toBe(
      'subagent-router: unsupported-path',
    );
    expect(artifactMissing.continued).toBe(0);
  });

  test('requires-m9-for-explicit-model-with-role', async () => {
    const config = configFixture({ roles: { 'codex:reviewer': { routeOverride: FIXTURE_MODEL_ID } } });
    const catalog = buildCatalog(config, await snapshotFixture());
    const profile: CapabilityProfile = { ...supported, probes: { ...supported.probes, M9: 'pending' } };
    const deps: CodexHookDeps = { inventory, config, catalog, profile, resolveNativeRuntimeContext: async () => nativeContext() };

    const { output, continued } = await drive(deps, { role: 'reviewer', model: FIXTURE_MODEL_ID, prompt: 'x' });

    expect(output).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'subagent-router: unsupported-path' },
    });
    expect(continued).toBe(0);
  });

  test('non-matching-event-or-tool-no-ops-without-consulting-the-resolver', async () => {
    const config = configFixture();
    const catalog = buildCatalog(config, await snapshotFixture());
    let resolverCalls = 0;
    const deps: CodexHookDeps = {
      inventory,
      config,
      catalog,
      profile: supported,
      resolveNativeRuntimeContext: async () => {
        resolverCalls += 1;
        return nativeContext();
      },
    };

    const wrongEvent = collectStdout();
    await runCodexPreToolUseHook(
      jsonStdin({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { model: FIXTURE_MODEL_ID } }),
      wrongEvent.stream,
      deps,
    );
    expect(JSON.parse(wrongEvent.text())).toEqual({});

    const wrongTool = collectStdout();
    await runCodexPreToolUseHook(
      jsonStdin({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { model: FIXTURE_MODEL_ID } }),
      wrongTool.stream,
      deps,
    );
    expect(JSON.parse(wrongTool.text())).toEqual({});

    const missingToolInput = collectStdout();
    await runCodexPreToolUseHook(jsonStdin({ hook_event_name: 'PreToolUse', tool_name: 'Agent' }), missingToolInput.stream, deps);
    expect(JSON.parse(missingToolInput.text())).toEqual({});

    expect(resolverCalls).toBe(0);
  });

  test('malformed-or-non-object-stdin-throws-invalid-hook-input-not-silent-success', async () => {
    const config = configFixture();
    const catalog = buildCatalog(config, await snapshotFixture());
    const deps: CodexHookDeps = { inventory, config, catalog, profile: supported, resolveNativeRuntimeContext: async () => nativeContext() };

    const bodies: ReadableStream<Uint8Array>[] = [jsonStdin('not-an-object'), jsonStdin([1, 2, 3]), rawStdin('{not valid json')];

    for (const body of bodies) {
      const out = collectStdout();
      let caught: unknown;
      try {
        await runCodexPreToolUseHook(body, out.stream, deps);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RouterError);
      expect((caught as RouterError).code).toBe('invalid-hook-input');
      expect(out.text()).toBe('');
    }
  });
});
