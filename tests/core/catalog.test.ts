import { describe, expect, test } from 'bun:test';
import { buildCatalog, resolveModel } from '../../src/core/catalog';
import { RouterError } from '../../src/core/errors';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

describe('buildCatalog', () => {
  test('override replaces the alias and a model without an override keeps its m- alias', async () => {
    const snapshot = await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/other']);
    const catalog = buildCatalog(configFixture(), snapshot);
    expect(catalog.byAlias.get('fast')?.id).toBe(FIXTURE_MODEL_ID);
    expect(catalog.byId.get('gateway/other')?.alias).toBe(snapshot.models[1]?.alias);
    expect(catalog.byId.get('gateway/other')?.description).toBeUndefined();
  });

  test('an override for an ID outside the snapshot does not create a model', async () => {
    const config = configFixture({ modelOverrides: { 'gateway/ghost': { description: 'x' } } });
    const catalog = buildCatalog(config, await snapshotFixture());
    expect(catalog.byId.has('gateway/ghost')).toBe(false);
  });

  test('a missing snapshot model is disabled despite an enabled override', async () => {
    const snapshot = await snapshotFixture([FIXTURE_MODEL_ID]);
    (snapshot.models[0] as { status: string }).status = 'missing';
    const catalog = buildCatalog(configFixture(), snapshot);
    expect(catalog.byId.get(FIXTURE_MODEL_ID)?.enabled).toBe(false);
  });

  test('an alias collision with another model ID is an error', async () => {
    const config = configFixture({ modelOverrides: { 'gateway/a': { alias: 'gateway-b' } } });
    const snapshot = await snapshotFixture(['gateway/a', 'gateway-b']);
    expect(() => buildCatalog(config, snapshot)).toThrow(RouterError);
  });

  test('duplicate aliases are an error', async () => {
    const config = configFixture({
      modelOverrides: {
        'gateway/a': { alias: 'same' },
        'gateway/b': { alias: 'same' },
      },
    });
    const snapshot = await snapshotFixture(['gateway/a', 'gateway/b']);
    expect(() => buildCatalog(config, snapshot)).toThrow(RouterError);
  });
});

describe('resolveModel', () => {
  test('resolves exact IDs and aliases, but not different casing', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    expect(resolveModel(FIXTURE_MODEL_ID, catalog).id).toBe(FIXTURE_MODEL_ID);
    expect(resolveModel('fast', catalog).id).toBe(FIXTURE_MODEL_ID);
    expect(() => resolveModel('Fast', catalog)).toThrow(RouterError);
    expect(() => resolveModel('gateway/Fast-Worker', catalog)).toThrow(RouterError);
  });
});
