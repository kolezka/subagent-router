import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouterError } from '../../src/core/errors';
import type { CatalogSnapshot } from '../../src/core/types';
import { commitState, loadState, snapshotPathFor } from '../../src/io/store';
import { configFixture, snapshotFixture } from '../support/fixtures';

let dir = '';
let configPath = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-store-'));
  configPath = join(dir, 'subagent-router.json');
  await writeFile(configPath, JSON.stringify(configFixture()));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('store', () => {
  test('loadState without a snapshot returns a null snapshot hash and stable generation', async () => {
    const first = await loadState(configPath);
    const second = await loadState(configPath);
    expect(first.snapshot).toBeUndefined();
    expect(first.expected.snapshotHash).toBeNull();
    expect(first.generation).toBe(second.generation);
  });

  test('commitState writes a snapshot beside the config and changes generation', async () => {
    const base = await loadState(configPath);
    await commitState(configPath, base, { snapshot: await snapshotFixture() });
    const after = await loadState(configPath);
    expect(JSON.parse(await readFile(snapshotPathFor(configPath), 'utf8')).sourceId).toBe('test-gateway');
    expect(after.generation).not.toBe(base.generation);
  });

  test('rejects a concurrent config edit without overwriting it', async () => {
    const base = await loadState(configPath);
    const foreign = configFixture({ defaults: { child: null, unmarkedSubagent: 'error' } });
    foreign.modelOverrides['gateway/fast-worker'] = { description: 'external change' };
    await writeFile(configPath, JSON.stringify(foreign));
    const mine = configFixture();
    mine.modelOverrides['gateway/fast-worker'] = { description: 'my change' };
    await expect(commitState(configPath, base, { config: mine })).rejects.toMatchObject({ code: 'store-conflict' });
    expect(JSON.parse(await readFile(configPath, 'utf8')).modelOverrides['gateway/fast-worker'].description).toBe('external change');
  });

  test('rejects a change to both files at once', async () => {
    const base = await loadState(configPath);
    await expect(commitState(configPath, base, { config: configFixture(), snapshot: await snapshotFixture() })).rejects.toMatchObject({ code: 'store-single-file' });
  });

  test('reports malformed on-disk snapshot JSON as a RouterError', async () => {
    await writeFile(snapshotPathFor(configPath), '{broken');
    await expect(loadState(configPath)).rejects.toBeInstanceOf(RouterError);
  });

  test('does not leave a temporary file after a failed write', async () => {
    const base = await loadState(configPath);
    await writeFile(configPath, JSON.stringify(configFixture({ version: 1 })) + ' ');
    await expect(commitState(configPath, base, { config: configFixture() })).rejects.toMatchObject({ code: 'store-conflict' });
    const entries = (await import('node:fs/promises')).readdir(dir);
    expect((await entries).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  test('does not write an invalid snapshot', async () => {
    const base = await loadState(configPath);
    const configBefore = await readFile(configPath, 'utf8');
    const invalidSnapshot = { ...(await snapshotFixture()), sourceId: '' } as unknown as CatalogSnapshot;

    await expect(commitState(configPath, base, { snapshot: invalidSnapshot })).rejects.toMatchObject({ code: 'snapshot-schema' });
    expect(await readFile(configPath, 'utf8')).toBe(configBefore);
    await expect(readFile(snapshotPathFor(configPath), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
