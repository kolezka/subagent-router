import { describe, expect, test } from 'bun:test';
import { codexHookOutput, validateCodexSpawn } from '../../src/adapters/codex';
import { buildCatalog } from '../../src/core/catalog';
import type { AgentInventory, CapabilityProfile, NativeRuntimeContext } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

// A synthetic POSITIVE fixture must be `completeness: 'native'`: a files-only scan can never by
// itself justify a `route` decision (the same rule opencode.test.ts's own inventory fixture
// follows, and the constraint validateOpenCodeTask already enforces). `filesOnlyInventory` below
// (same entries, only the completeness flag flipped) proves the files-only-refuses-route rule
// that finding 5 requires codex to enforce too, matching OpenCode's own adapter.
const inventory: AgentInventory = {
  entries: [{ client: 'codex', name: 'reviewer', scope: 'user', path: '/h/.codex/agents/reviewer.toml', declaredModel: 'gateway/base', hidden: false, native: {}, availability: 'available', shadowed: false }],
  completeness: 'native',
  diagnostics: [],
};
const filesOnlyInventory: AgentInventory = { ...inventory, completeness: 'files-only' };
const supported: CapabilityProfile = { client: 'codex', version: 'synthetic-hermetic', status: 'supported', correlation: false, correlationEntropy: 'pending', fork: false, adapterMarkerPosition: 'unknown', probes: { M5: 'passed', M7: 'passed', M9: 'passed', M10: 'passed', 'M10-freshness': 'passed' }, lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' } };

function nativeContext(effectiveModel = FIXTURE_MODEL_ID, patch: Partial<NativeRuntimeContext> = {}): NativeRuntimeContext {
  return {
    lifecyclePhase: 'next-turn', freshDelegation: true,
    nativeConfig: {
      source: 'authoritative-native-resolver', effectiveModel,
      expectedGeneration: 'fixture-generation', actualGeneration: 'fixture-generation', artifactHash: 'fixture-artifact-hash',
    },
    ...patch,
  };
}

describe('validateCodexSpawn', () => {
  test('jawny model z katalogu daje route, model spoza katalogu daje unknown-model', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    expect(validateCodexSpawn({ model: FIXTURE_MODEL_ID, prompt: 'x' }, inventory, configFixture(), catalog, supported, nativeContext())).toMatchObject({ kind: 'route', upstreamModel: FIXTURE_MODEL_ID, source: 'explicit' });
    expect(validateCodexSpawn({ model: 'gateway/ghost', prompt: 'x' }, inventory, configFixture(), catalog, supported, nativeContext())).toMatchObject({ kind: 'error', code: 'unknown-model' });
    expect(validateCodexSpawn({ model: 'fast', prompt: 'x' }, inventory, configFixture(), catalog, supported, nativeContext())).toMatchObject({ kind: 'error', code: 'unknown-model' });
  });

  test('files-only inventory nie jest runtime proof: nawet z autorytatywnym witness route staje się unsupported-path (jawny model)', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    expect(
      validateCodexSpawn({ model: FIXTURE_MODEL_ID, prompt: 'x' }, filesOnlyInventory, configFixture(), catalog, supported, nativeContext()),
    ).toMatchObject({ kind: 'error', code: 'unsupported-path' });
  });

  test('files-only inventory nie jest runtime proof: nawet z autorytatywnym witness route staje się unsupported-path (role-default)', async () => {
    const config = configFixture({ roles: { 'codex:reviewer': { routeOverride: FIXTURE_MODEL_ID } } });
    const catalog = buildCatalog(config, await snapshotFixture());
    expect(
      validateCodexSpawn({ role: 'reviewer', prompt: 'x' }, filesOnlyInventory, config, catalog, supported, nativeContext()),
    ).toMatchObject({ kind: 'error', code: 'unsupported-path' });
  });

  test('rola bez modelu używa routeOverride, a jawny model wygrywa z rolą', async () => {
    const config = configFixture({ roles: { 'codex:reviewer': { routeOverride: FIXTURE_MODEL_ID } } });
    const catalog = buildCatalog(config, await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/other']));
    expect(validateCodexSpawn({ role: 'reviewer', prompt: 'x' }, inventory, config, catalog, supported, nativeContext())).toMatchObject({ kind: 'route', upstreamModel: FIXTURE_MODEL_ID, source: 'role-default' });
    expect(validateCodexSpawn({ role: 'reviewer', model: 'gateway/other', prompt: 'x' }, inventory, config, catalog, supported, nativeContext('gateway/other'))).toMatchObject({ kind: 'route', upstreamModel: 'gateway/other', source: 'explicit' });
  });

  test('spawn bez modelu i bez roli z trasą to missing-selection', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    expect(validateCodexSpawn({ prompt: 'x' }, inventory, configFixture(), catalog, supported, nativeContext())).toMatchObject({ kind: 'error', code: 'missing-selection' });
  });

  test('profil bez zaliczonego M7 odmawia całego adaptera', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const profile: CapabilityProfile = { ...supported, status: 'pending', probes: { M7: 'failed' } };
    expect(validateCodexSpawn({ model: FIXTURE_MODEL_ID, prompt: 'x' }, inventory, configFixture(), catalog, profile, nativeContext())).toMatchObject({ kind: 'error', code: 'unsupported-path' });
  });

  test('present-but-invalid model nie spada do defaultu roli', async () => {
    const config = configFixture({ roles: { 'codex:reviewer': { routeOverride: FIXTURE_MODEL_ID } } });
    const catalog = buildCatalog(config, await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/raw-fast-id']));
    for (const model of [null, '', 42, 'fast', 'gateway/ghost'] as const) {
      expect(validateCodexSpawn({ role: 'reviewer', model }, inventory, config, catalog, supported, nativeContext())).toMatchObject({ kind: 'error', code: 'unknown-model' });
    }
  });

  test('rola z jawnym modelem wymaga M9 przed natywną precedencją', async () => {
    const config = configFixture({ roles: { 'codex:reviewer': { routeOverride: FIXTURE_MODEL_ID } } });
    const profile: CapabilityProfile = { ...supported, probes: { ...supported.probes, M9: 'pending' } };
    const catalog = buildCatalog(config, await snapshotFixture());
    expect(validateCodexSpawn({ role: 'reviewer', model: FIXTURE_MODEL_ID }, inventory, config, catalog, profile, nativeContext())).toMatchObject({ kind: 'error', code: 'unsupported-path' });
  });
});

describe('codexHookOutput', () => {
  test('błąd daje deny z kodem, sukces nie wystawia allow ani updatedInput', () => {
    const denied = codexHookOutput({ kind: 'error', code: 'model-not-allowed', ignoredMarkers: 0 });
    expect(denied).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'subagent-router: model-not-allowed' } });
    expect(codexHookOutput({ kind: 'route', upstreamModel: 'x', source: 'explicit', ignoredMarkers: 0 })).toEqual({});
  });
});
