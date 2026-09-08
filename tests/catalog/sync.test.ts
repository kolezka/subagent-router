import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synchronize } from '../../src/catalog/sync';
import { sha256 } from '../../src/core/hash';
import type { FetchLike } from '../../src/core/types';
import { snapshotPathFor } from '../../src/io/store';
import { configFixture } from '../support/fixtures';

const env = { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 'secret-token' };
const now = () => new Date('2026-09-06T12:00:00.000Z');

function listing(ids: string[]): FetchLike {
  return async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
}

let dir = '';
let configPath = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-sync-'));
  configPath = join(dir, 'subagent-router.json');
  await writeFile(configPath, JSON.stringify(configFixture()));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('synchronize', () => {
  test('pierwszy sync zapisuje snapshot z fingerprintem i fetchedAt', async () => {
    const result = await synchronize(configPath, { env, fetch: listing(['gateway/fast-worker']), now, allowEmpty: false, dryRun: false });
    expect(result.added).toEqual(['gateway/fast-worker']);
    const saved = JSON.parse(await readFile(snapshotPathFor(configPath), 'utf8'));
    expect(saved.fetchedAt).toBe('2026-09-06T12:00:00.000Z');
    expect(saved.sourceId).toBe('test-gateway');
    expect(saved.models[0].alias.startsWith('m-')).toBe(true);
  });

  test('zniknięty model zostaje jako missing, powrót przywraca available', async () => {
    await synchronize(configPath, { env, fetch: listing(['a', 'b']), now, allowEmpty: false, dryRun: false });
    const second = await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    expect(second.missing).toEqual(['b']);
    expect(second.snapshot.models.find((m) => m.id === 'b')?.status).toBe('missing');
    const third = await synchronize(configPath, { env, fetch: listing(['a', 'b']), now, allowEmpty: false, dryRun: false });
    expect(third.changed).toEqual(['b']);
    expect(third.snapshot.models.find((m) => m.id === 'b')?.status).toBe('available');
  });

  test('dry-run raportuje diff i nie zmienia hashy plików', async () => {
    await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    const before = await sha256(await readFile(snapshotPathFor(configPath), 'utf8'));
    const result = await synchronize(configPath, { env, fetch: listing(['a', 'c']), now, allowEmpty: false, dryRun: true });
    expect(result.added).toEqual(['c']);
    expect(await sha256(await readFile(snapshotPathFor(configPath), 'utf8'))).toBe(before);
  });

  test('nieudany fetch zachowuje poprzedni snapshot bajt w bajt', async () => {
    await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    const before = await readFile(snapshotPathFor(configPath), 'utf8');
    const failing: FetchLike = async () => new Response('{broken', { status: 200 });
    await expect(synchronize(configPath, { env, fetch: failing, now, allowEmpty: false, dryRun: false })).rejects.toMatchObject({ code: 'discovery-json' });
    expect(await readFile(snapshotPathFor(configPath), 'utf8')).toBe(before);
  });

  test('pusta lista wymaga allowEmpty i nie usuwa wcześniejszych wpisów', async () => {
    await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    await expect(synchronize(configPath, { env, fetch: listing([]), now, allowEmpty: false, dryRun: false })).rejects.toMatchObject({ code: 'sync-empty' });
    const result = await synchronize(configPath, { env, fetch: listing([]), now, allowEmpty: true, dryRun: false });
    expect(result.snapshot.models.map((m) => [m.id, m.status])).toEqual([['a', 'missing']]);
  });

  test('sync nie zmienia pliku operatora', async () => {
    const before = await readFile(configPath, 'utf8');
    await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  test('zmiana endpointu przy tym samym sourceId odrzuca stary snapshot poza sync', async () => {
    await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    const moved = { ...env, GATEWAY_URL: 'http://127.0.0.1:9000/v1' };
    const result = await synchronize(configPath, { env: moved, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    expect(result.snapshot.sourceFingerprint).not.toBe((await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: true })).snapshot.sourceFingerprint);
  });

  test('zmiana sourceId nie przenosi modeli starej bramy jako missing', async () => {
    await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    await writeFile(configPath, JSON.stringify(configFixture({ modelSource: { ...configFixture().modelSource, sourceId: 'other-gateway' } })));
    const result = await synchronize(configPath, { env, fetch: listing(['b']), now, allowEmpty: false, dryRun: false });
    expect(result.added).toEqual(['b']);
    expect(result.missing).toEqual([]);
    expect(result.snapshot.models.map((m) => m.id)).toEqual(['b']);
  });

  test('zmiana samego effectiveModelsUrl (ten sam sourceId) też resetuje bazę, bez missing ze starej bramy', async () => {
    await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    await writeFile(configPath, JSON.stringify(configFixture({ modelSource: { ...configFixture().modelSource, endpointPath: '/v2/models' } })));
    const result = await synchronize(configPath, { env, fetch: listing(['b']), now, allowEmpty: false, dryRun: false });
    expect(result.added).toEqual(['b']);
    expect(result.missing).toEqual([]);
    expect(result.snapshot.models.map((m) => m.id)).toEqual(['b']);
  });
});
