import { describe, expect, test } from 'bun:test';
import { createOpenCodePlugin } from '../../src/adapters/opencode-plugin';
import { buildCatalog } from '../../src/core/catalog';
import { RouterError } from '../../src/core/errors';
import type { AgentInventory, CapabilityProfile, NativeRuntimeContext } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

const snapshotGeneration = 'fixture-generation';
const artifactHash = 'fixture-artifact-hash';

// A NATIVE-complete inventory: files-only is separately proven insufficient in opencode.test.ts,
// so these cases isolate the plugin's own guards rather than re-testing the validator's.
const inventory: AgentInventory = {
  entries: [
    {
      client: 'opencode',
      name: 'reviewer',
      scope: 'project',
      path: '/x/.opencode/agents/reviewer.md',
      declaredModel: 'inherit',
      hidden: false,
      body: 'Sprawdzaj regresje.',
      native: { description: 'Przegląd', tools: { bash: false }, permission: { edit: 'deny' }, mode: 'subagent' },
      availability: 'available',
      shadowed: false,
    },
  ],
  completeness: 'native',
  diagnostics: [],
};

// Synthetic only. No shipped profile is 'supported' (every measured fixture is 'pending'), so this
// exists purely to exercise the allow path; it is never evidence that OpenCode is supported.
const supported: CapabilityProfile = {
  client: 'opencode',
  version: '1.18.29',
  status: 'supported',
  correlation: false,
  correlationEntropy: 'pending',
  fork: false,
  adapterMarkerPosition: 'unknown',
  probes: { M6: 'passed', 'M6-runtime': 'passed', M10: 'passed', 'M10-freshness': 'passed' },
  lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' },
};

function nativeContext(patch: Partial<NativeRuntimeContext['nativeConfig']> = {}): NativeRuntimeContext {
  return {
    lifecyclePhase: 'next-turn',
    freshDelegation: true,
    nativeConfig: {
      source: 'authoritative-native-resolver',
      providerId: 'gateway',
      effectiveModel: FIXTURE_MODEL_ID,
      expectedGeneration: snapshotGeneration,
      actualGeneration: snapshotGeneration,
      artifactHash,
      ...patch,
    },
  };
}

async function baseDeps(): Promise<{
  inventory: AgentInventory;
  config: ReturnType<typeof configFixture>;
  catalog: ReturnType<typeof buildCatalog>;
  profile: CapabilityProfile;
}> {
  const config = configFixture();
  return { inventory, config, catalog: buildCatalog(config, await snapshotFixture()), profile: supported };
}

const taskInput = { tool: 'task', args: { subagent_type: 'reviewer@fast', description: 'y', prompt: 'x' } };

/**
 * External test driver. It interprets the callback's outcome and only runs the continuation spy
 * on success — mirroring what OpenCode itself does with a `tool.execute.before` that returns
 * versus one that throws. The spy is never a router dependency.
 */
async function drive(
  plugin: { 'tool.execute.before': (input: unknown, output: unknown) => Promise<void> },
  input: unknown,
): Promise<{ continued: number; error?: unknown; passedInput?: unknown }> {
  let continued = 0;
  let passedInput: unknown;
  const continueNativeTask = (received: unknown): void => {
    continued += 1;
    passedInput = received;
  };
  try {
    await plugin['tool.execute.before'](input, {});
  } catch (error) {
    return { continued, error };
  }
  continueNativeTask(input);
  return { continued, passedInput };
}

describe('createOpenCodePlugin', () => {
  test('denies-before-stubbed-opencode-continuation', async () => {
    const deps = await baseDeps();
    let validated = 0;
    const plugin = createOpenCodePlugin({
      ...deps,
      resolveNativeRuntimeContext: async () => {
        validated += 1;
        return nativeContext();
      },
    });

    // 'reviewer@ghost' is a real role with an alias that resolves to nothing in the catalog.
    const result = await drive(plugin, { tool: 'task', args: { subagent_type: 'reviewer@ghost', description: 'y', prompt: 'x' } });

    // The native refusal mechanism is a throw: returning a value would be ignored by OpenCode
    // and the spawn would proceed.
    expect(result.error).toBeInstanceOf(RouterError);
    expect((result.error as RouterError).code).toBe('unknown-model');
    expect(validated).toBe(1);
    expect(result.continued).toBe(0);
    // This test does NOT and cannot claim no native request was made: it never launches OpenCode.
    // Only the opt-in M6-runtime scenario with a real client and capture gateway proves that.
  });

  test('allows-stubbed-continuation-with-synthetic-authoritative-context', async () => {
    const deps = await baseDeps();
    const plugin = createOpenCodePlugin({ ...deps, resolveNativeRuntimeContext: async () => nativeContext() });

    const result = await drive(plugin, taskInput);

    expect(result.error).toBeUndefined();
    expect(result.continued).toBe(1);
    // The plugin never rewrites the call: no updatedInput, no substituted subagent_type.
    expect(result.passedInput).toEqual(taskInput);
  });

  test('requires-effective-native-model-and-artifact-generation', async () => {
    const deps = await baseDeps();

    // No resolver at all: a missing witness is indistinguishable from an unmeasured runtime.
    const noContext = await drive(
      createOpenCodePlugin({ ...deps, resolveNativeRuntimeContext: async () => undefined }),
      taskInput,
    );
    expect((noContext.error as RouterError).code).toBe('unsupported-path');
    expect(noContext.continued).toBe(0);

    // A witness that does not come from an authoritative resolver.
    const notAuthoritative = await drive(
      createOpenCodePlugin({
        ...deps,
        resolveNativeRuntimeContext: async () => nativeContext({ source: 'sidecar-file' as never }),
      }),
      taskInput,
    );
    expect((notAuthoritative.error as RouterError).code).toBe('unsupported-path');

    // A different effective model than the one the decision routed to.
    const wrongModel = await drive(
      createOpenCodePlugin({ ...deps, resolveNativeRuntimeContext: async () => nativeContext({ effectiveModel: 'gateway/other' }) }),
      taskInput,
    );
    expect((wrongModel.error as RouterError).code).toBe('unsupported-path');

    // Self-consistent witness, but it disagrees with the router's OWN trusted expectations.
    // Without the independent comparison this case would wrongly pass.
    const wrongGeneration = await drive(
      createOpenCodePlugin({
        ...deps,
        expectations: { generation: snapshotGeneration, artifactHash },
        resolveNativeRuntimeContext: async () =>
          nativeContext({ expectedGeneration: 'stale-generation', actualGeneration: 'stale-generation' }),
      }),
      taskInput,
    );
    expect((wrongGeneration.error as RouterError).code).toBe('unsupported-path');
    expect(wrongGeneration.continued).toBe(0);

    const wrongHash = await drive(
      createOpenCodePlugin({
        ...deps,
        expectations: { generation: snapshotGeneration, artifactHash },
        resolveNativeRuntimeContext: async () => nativeContext({ artifactHash: 'other-hash' }),
      }),
      taskInput,
    );
    expect((wrongHash.error as RouterError).code).toBe('unsupported-path');

    // Positive control: matching expectations still allow the call, so the checks above reject
    // specific mismatches rather than denying everything.
    const matching = await drive(
      createOpenCodePlugin({
        ...deps,
        expectations: { generation: snapshotGeneration, artifactHash },
        resolveNativeRuntimeContext: async () => nativeContext(),
      }),
      taskInput,
    );
    expect(matching.error).toBeUndefined();
    expect(matching.continued).toBe(1);
  });

  test('compares-provider-separately-from-opaque-upstream-id', async () => {
    const deps = await baseDeps();

    // providerId 'gateway' and effectiveModel 'gateway/fast-worker' are checked as two separate
    // fields. The opaque upstream ID is never split on its second slash to recover a provider.
    const ok = await drive(
      createOpenCodePlugin({
        ...deps,
        resolveNativeRuntimeContext: async () => nativeContext({ providerId: 'gateway', effectiveModel: 'gateway/fast-worker' }),
      }),
      taskInput,
    );
    expect(ok.error).toBeUndefined();
    expect(ok.continued).toBe(1);

    // A witness whose provider differs is refused even though the opaque model ID still begins
    // with the string 'gateway/'.
    const wrongProvider = await drive(
      createOpenCodePlugin({
        ...deps,
        resolveNativeRuntimeContext: async () => nativeContext({ providerId: 'other-provider' }),
      }),
      taskInput,
    );
    expect((wrongProvider.error as RouterError).code).toBe('unsupported-path');
    expect(wrongProvider.continued).toBe(0);
  });

  test('lifecyclePhase w args jest ignorowane i nie zastępuje trusted context', async () => {
    const deps = await baseDeps();
    // The profile proves only the 'next-turn' phase; 'nested' is pending.
    const profile: CapabilityProfile = {
      ...supported,
      lifecycle: { ...supported.lifecycle, nested: 'pending' },
    };
    const plugin = createOpenCodePlugin({
      ...deps,
      profile,
      // Trusted context says 'nested', which the profile has NOT proven.
      resolveNativeRuntimeContext: async () => ({ ...nativeContext(), lifecyclePhase: 'nested' as const }),
    });

    // args claims a phase the profile did pass. It must be ignored entirely.
    const result = await drive(plugin, {
      tool: 'task',
      args: { subagent_type: 'reviewer@fast', description: 'y', prompt: 'x', lifecyclePhase: 'next-turn' },
    });

    expect((result.error as RouterError).code).toBe('unsupported-path');
    expect(result.continued).toBe(0);
  });

  test('narzędzia inne niż task przechodzą nietknięte i nie wołają resolvera', async () => {
    const deps = await baseDeps();
    let resolverCalls = 0;
    const plugin = createOpenCodePlugin({
      ...deps,
      resolveNativeRuntimeContext: async () => {
        resolverCalls += 1;
        return nativeContext();
      },
    });

    const result = await drive(plugin, { tool: 'bash', args: { command: 'true' } });

    expect(result.error).toBeUndefined();
    expect(result.continued).toBe(1);
    expect(resolverCalls).toBe(0);
  });
});
