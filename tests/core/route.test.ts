import { describe, expect, test } from 'bun:test';
import { buildCatalog } from '../../src/core/catalog';
import { resolveRoute } from '../../src/core/route';
import type { RouteDecision, RouteInput } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

const OTHER = 'gateway/other';

function child(patch: Partial<RouteInput>): RouteInput {
  return { client: 'claude-code', scope: 'child', explicitIds: [], freshDelegation: true, ignoredMarkers: 0, ...patch };
}

describe('resolveRoute', () => {
  const cases: Array<[string, RouteInput, RouteDecision]> = [
    ['rodzic bez markera', { client: 'claude-code', scope: 'parent', explicitIds: [], ignoredMarkers: 0 }, { kind: 'pass-through', reason: 'parent', ignoredMarkers: 0 }],
    ['rodzic z cytowanym markerem', { client: 'claude-code', scope: 'parent', explicitIds: [], ignoredMarkers: 2 }, { kind: 'pass-through', reason: 'parent', ignoredMarkers: 2 }],
    ['jawny wybór wygrywa z rolą', child({ explicitIds: [OTHER], roleDefaultId: FIXTURE_MODEL_ID }), { kind: 'route', upstreamModel: OTHER, source: 'explicit', ignoredMarkers: 0 }],
    ['rola bez jawnego wyboru', child({ role: 'claude-code:explorer', roleDefaultId: FIXTURE_MODEL_ID }), { kind: 'route', upstreamModel: FIXTURE_MODEL_ID, clientModel: 'haiku', source: 'role-default', ignoredMarkers: 0 }],
    ['korelacja bez markera', child({ correlatedId: OTHER }), { kind: 'route', upstreamModel: OTHER, source: 'correlated', ignoredMarkers: 0 }],
    ['korelacja wygrywa z domyślną trasą roli', child({ role: 'claude-code:explorer', roleDefaultId: FIXTURE_MODEL_ID, correlatedId: OTHER }), { kind: 'route', upstreamModel: OTHER, source: 'correlated', ignoredMarkers: 0 }],
    ['jawny wybór zgodny z korelacją', child({ explicitIds: [OTHER], correlatedId: OTHER }), { kind: 'route', upstreamModel: OTHER, source: 'explicit', ignoredMarkers: 0 }],
    ['jawny wybór sprzeczny z korelacją', child({ explicitIds: [FIXTURE_MODEL_ID], correlatedId: OTHER }), { kind: 'error', code: 'correlation-conflict', ignoredMarkers: 0 }],
    ['nieznany jawny model nie spada do roli', child({ explicitIds: ['gateway/none'], roleDefaultId: FIXTURE_MODEL_ID }), { kind: 'error', code: 'unknown-model', ignoredMarkers: 0 }],
    ['adapter oznacza nierozwiązany jawny token jako błąd przed defaultem', child({ explicitIds: [], explicitError: 'unknown-model', roleDefaultId: FIXTURE_MODEL_ID }), { kind: 'error', code: 'unknown-model', ignoredMarkers: 0 }],
    ['dwa różne jawne markery', child({ explicitIds: [OTHER, FIXTURE_MODEL_ID] }), { kind: 'error', code: 'conflicting-markers', ignoredMarkers: 0 }],
    ['niepoprawny marker w autoryzowanej pozycji', child({ markerError: 'invalid-marker', roleDefaultId: FIXTURE_MODEL_ID }), { kind: 'error', code: 'invalid-marker', ignoredMarkers: 0 }],
    ['dziecko bez wskazania mimo świeżej delegacji', child({}), { kind: 'error', code: 'missing-selection', ignoredMarkers: 0 }],
    ['brak dowodu świeżej delegacji nie stosuje role defaultu', child({ freshDelegation: false, roleDefaultId: FIXTURE_MODEL_ID }), { kind: 'error', code: 'missing-selection', ignoredMarkers: 0 }],
  ];

  test.each(cases)('%s', async (_name, input, expected) => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture([FIXTURE_MODEL_ID, OTHER]));
    expect(resolveRoute(input, configFixture(), catalog)).toEqual(expected);
  });

  test('globalny default działa tylko bez roli i bez jawnego wyboru', async () => {
    const config = configFixture({ defaults: { child: OTHER, unmarkedSubagent: 'error' } });
    const catalog = buildCatalog(config, await snapshotFixture([FIXTURE_MODEL_ID, OTHER]));
    expect(resolveRoute(child({}), config, catalog)).toEqual({ kind: 'route', upstreamModel: OTHER, source: 'global-default', ignoredMarkers: 0 });
  });

  test('inherit z potwierdzeniem przepuszcza dziecko bez wskazania', async () => {
    const config = configFixture({ defaults: { child: null, unmarkedSubagent: 'inherit', unmarkedSubagentAcknowledged: true } });
    const catalog = buildCatalog(config, await snapshotFixture());
    expect(resolveRoute(child({}), config, catalog)).toEqual({ kind: 'pass-through', reason: 'inherit-allowed', ignoredMarkers: 0 });
  });

  test('inherit bez potwierdzenia odrzuca dziecko bez wskazania', async () => {
    const config = configFixture({ defaults: { child: null, unmarkedSubagent: 'inherit' } });
    const catalog = buildCatalog(config, await snapshotFixture());
    expect(resolveRoute(child({}), config, catalog)).toEqual({ kind: 'error', code: 'missing-selection', ignoredMarkers: 0 });
  });

  test('model missing albo wyłączony daje model-not-allowed bez fallbacku', async () => {
    const snapshot = await snapshotFixture([FIXTURE_MODEL_ID, OTHER]);
    (snapshot.models[1] as { status: string }).status = 'missing';
    const config = configFixture({ defaults: { child: FIXTURE_MODEL_ID, unmarkedSubagent: 'error' } });
    const catalog = buildCatalog(config, snapshot);
    expect(resolveRoute(child({ explicitIds: [OTHER] }), config, catalog)).toEqual({ kind: 'error', code: 'model-not-allowed', ignoredMarkers: 0 });
  });
});
