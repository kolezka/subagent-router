import { describe, expect, test } from 'bun:test';
import { opencodeVariants, validateOpenCodeTask } from '../../src/adapters/opencode';
import { buildCatalog } from '../../src/core/catalog';
import type { AgentInventory, CapabilityProfile, NativeRuntimeContext } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

// NOTE on deviation from the plan doc's literal Step-1 fixture: the plan's own copy used
// `completeness: 'files-only'` for every test including the positive `route` ones. That is
// self-contradictory with this same task's own rule ("Files-only inventory ... nie są runtime
// proof") and with the coordinator's explicit correction: a synthetic POSITIVE fixture must be
// `completeness: 'native'`, since a files-only scan can never by itself justify a `route`
// decision. `inventory` below is therefore `native`; `filesOnlyInventory` (same entries, only the
// completeness flag flipped) is added separately to prove the files-only-rejects-route rule the
// plan text asserted but never actually tested.
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
const filesOnlyInventory: AgentInventory = { ...inventory, completeness: 'files-only' };

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
const pending: CapabilityProfile = { ...supported, status: 'pending', probes: {} };
const snapshotGeneration = 'fixture-generation';
const FIXTURE_NATIVE_CONTEXT: NativeRuntimeContext = {
  lifecyclePhase: 'next-turn',
  freshDelegation: true,
  nativeConfig: {
    source: 'authoritative-native-resolver',
    providerId: 'gateway',
    effectiveModel: FIXTURE_MODEL_ID,
    expectedGeneration: snapshotGeneration,
    actualGeneration: snapshotGeneration,
    artifactHash: 'fixture-artifact-hash',
  },
};

describe('opencodeVariants', () => {
  test('wariant zachowuje narzędzia, uprawnienia i treść, zmienia tylko nazwę, opis, hidden i model', async () => {
    const files = opencodeVariants(
      inventory,
      configFixture(),
      buildCatalog(configFixture(), await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/undescribed'])),
      snapshotGeneration,
    );
    expect(files.map((f) => f.relativePath)).toEqual(['opencode/agents/reviewer@fast.md']);
    const content = files[0]?.content ?? '';
    expect(content).toContain('name: reviewer@fast');
    expect(content).toContain(`model: gateway/${FIXTURE_MODEL_ID}`);
    expect(content).toContain('hidden: true');
    expect(content).toContain('bash: false');
    expect(content).toContain('edit: deny');
    expect(content.trimEnd().endsWith('Sprawdzaj regresje.')).toBe(true);
    expect(content).not.toContain('undescribed');
  });

  test('modele bez własnej deklaracji "path" trafiają do jednego fragmentu opencode.agents.json', async () => {
    const inlineInventory: AgentInventory = {
      entries: [
        {
          client: 'opencode',
          name: 'planner',
          scope: 'project-config',
          declaredModel: 'inherit',
          hidden: false,
          native: { description: 'Planuje', mode: 'subagent' },
          availability: 'available',
          shadowed: false,
        },
      ],
      completeness: 'native',
      diagnostics: [],
    };
    const files = opencodeVariants(inlineInventory, configFixture(), buildCatalog(configFixture(), await snapshotFixture()), snapshotGeneration);
    expect(files.map((f) => f.relativePath)).toEqual(['opencode/opencode.agents.json']);
    const parsed = JSON.parse(files[0]?.content ?? '{}');
    expect(parsed.agent['planner@fast'].model).toBe(`gateway/${FIXTURE_MODEL_ID}`);
    expect(parsed.snapshotGeneration).toBe(snapshotGeneration);
  });
});

describe('validateOpenCodeTask', () => {
  test('wariant znany w katalogu daje route z dokładnym upstreamModel', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const decision = validateOpenCodeTask(
      { subagent_type: 'reviewer@fast', prompt: 'x', description: 'y' },
      inventory,
      configFixture(),
      catalog,
      supported,
      FIXTURE_NATIVE_CONTEXT,
    );
    expect(decision).toEqual({ kind: 'route', upstreamModel: FIXTURE_MODEL_ID, clientModel: 'haiku', source: 'explicit', ignoredMarkers: 0 });
  });

  test('files-only inventory nie jest runtime proof: nawet z autorytatywnym witness route staje się unsupported-path', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const decision = validateOpenCodeTask(
      { subagent_type: 'reviewer@fast', prompt: 'x', description: 'y' },
      filesOnlyInventory,
      configFixture(),
      catalog,
      supported,
      FIXTURE_NATIVE_CONTEXT,
    );
    expect(decision).toMatchObject({ kind: 'error', code: 'unsupported-path' });
  });

  test('wariant z aliasem spoza katalogu i nieznana rola dają błąd, bez zmiany args', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const args = { subagent_type: 'reviewer@ghost', prompt: 'x', description: 'y' };
    expect(validateOpenCodeTask(args, inventory, configFixture(), catalog, supported, FIXTURE_NATIVE_CONTEXT)).toMatchObject({
      kind: 'error',
      code: 'unknown-model',
    });
    expect(
      validateOpenCodeTask({ subagent_type: 'nobody@fast', prompt: 'x', description: 'y' }, inventory, configFixture(), catalog, supported, FIXTURE_NATIVE_CONTEXT),
    ).toMatchObject({ kind: 'error', code: 'unsupported-path' });
    expect(args.subagent_type).toBe('reviewer@ghost');
  });

  test('bazowa rola bez wariantu przechodzi jako pass-through dziedziczenia natywnego tylko przy jawnym inherit', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    expect(validateOpenCodeTask({ subagent_type: 'reviewer' }, inventory, configFixture(), catalog, supported, FIXTURE_NATIVE_CONTEXT)).toMatchObject({
      kind: 'error',
      code: 'missing-selection',
    });
    const config = configFixture({ defaults: { child: null, unmarkedSubagent: 'inherit', unmarkedSubagentAcknowledged: true } });
    expect(validateOpenCodeTask({ subagent_type: 'reviewer' }, inventory, config, catalog, supported, FIXTURE_NATIVE_CONTEXT)).toMatchObject({
      kind: 'pass-through',
      reason: 'inherit-allowed',
    });
  });

  test('profil pending odmawia z unsupported-path', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    expect(validateOpenCodeTask({ subagent_type: 'reviewer@fast' }, inventory, configFixture(), catalog, pending, FIXTURE_NATIVE_CONTEXT)).toMatchObject({
      kind: 'error',
      code: 'unsupported-path',
    });
  });

  test('odrzuca present-but-invalid variant przed role defaultem i nie myli aliasu z raw ID', async () => {
    const config = configFixture({ roles: { 'opencode:reviewer': { routeOverride: FIXTURE_MODEL_ID } } });
    const catalog = buildCatalog(config, await snapshotFixture([FIXTURE_MODEL_ID, 'ghost']));
    for (const subagent_type of [null, '', 42, 'reviewer@ghost'] as const) {
      expect(validateOpenCodeTask({ subagent_type }, inventory, config, catalog, supported, FIXTURE_NATIVE_CONTEXT)).toMatchObject({
        kind: 'error',
        code: 'unknown-model',
      });
    }
  });

  test('rozdziela conflicting expectedGeneration/actualGeneration od nonempty-hash: każdy osobno daje unsupported-path', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const mismatchedGeneration: NativeRuntimeContext = {
      ...FIXTURE_NATIVE_CONTEXT,
      nativeConfig: { ...FIXTURE_NATIVE_CONTEXT.nativeConfig, actualGeneration: 'a-different-generation' },
    };
    expect(
      validateOpenCodeTask({ subagent_type: 'reviewer@fast' }, inventory, configFixture(), catalog, supported, mismatchedGeneration),
    ).toMatchObject({ kind: 'error', code: 'unsupported-path' });

    const emptyHash: NativeRuntimeContext = {
      ...FIXTURE_NATIVE_CONTEXT,
      nativeConfig: { ...FIXTURE_NATIVE_CONTEXT.nativeConfig, artifactHash: '' },
    };
    expect(validateOpenCodeTask({ subagent_type: 'reviewer@fast' }, inventory, configFixture(), catalog, supported, emptyHash)).toMatchObject({
      kind: 'error',
      code: 'unsupported-path',
    });

    const mismatchedModel: NativeRuntimeContext = {
      ...FIXTURE_NATIVE_CONTEXT,
      nativeConfig: { ...FIXTURE_NATIVE_CONTEXT.nativeConfig, effectiveModel: 'gateway/some-other-model' },
    };
    expect(validateOpenCodeTask({ subagent_type: 'reviewer@fast' }, inventory, configFixture(), catalog, supported, mismatchedModel)).toMatchObject({
      kind: 'error',
      code: 'unsupported-path',
    });
  });
});
