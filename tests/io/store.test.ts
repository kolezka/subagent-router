import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

  test('a temp file this process did not create survives a failed commit', async () => {
    // commitState stages through `<target>.<pid>.tmp` with the exclusive flag, so a file already
    // there makes the write fail. That foreign file is not ours to delete: cleanup must only
    // remove a temp file commitState itself created.
    const base = await loadState(configPath);
    const foreignTemp = `${snapshotPathFor(configPath)}.${process.pid}.tmp`;
    await writeFile(foreignTemp, 'not ours');

    await expect(commitState(configPath, base, { snapshot: await snapshotFixture() })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(foreignTemp, 'utf8')).toBe('not ours');
    await expect(readFile(snapshotPathFor(configPath), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('an existing lock file yields store-locked and is left in place', async () => {
    const base = await loadState(configPath);
    const lockPath = `${configPath}.lock`;
    await writeFile(lockPath, '');
    await expect(commitState(configPath, base, { snapshot: await snapshotFixture() })).rejects.toMatchObject({ code: 'store-locked' });
    expect(await readFile(lockPath, 'utf8')).toBe('');
    await expect(readFile(snapshotPathFor(configPath), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('the lock is released after a failed commit, so the next commit succeeds', async () => {
    const base = await loadState(configPath);
    await writeFile(configPath, JSON.stringify(configFixture({ version: 1 })) + ' ');
    await expect(commitState(configPath, base, { config: configFixture() })).rejects.toMatchObject({ code: 'store-conflict' });
    await expect(readFile(`${configPath}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const fresh = await loadState(configPath);
    await commitState(configPath, fresh, { snapshot: await snapshotFixture() });
    expect(JSON.parse(await readFile(snapshotPathFor(configPath), 'utf8')).sourceId).toBe('test-gateway');
  });

  test('a failed rename leaves no temp file, no lock file and the config untouched', async () => {
    // A directory at the snapshot path makes the final rename fail after the temp file was written.
    const base = await loadState(configPath);
    const configBefore = await readFile(configPath, 'utf8');
    await mkdir(snapshotPathFor(configPath));

    await expect(commitState(configPath, base, { snapshot: await snapshotFixture() })).rejects.toMatchObject({ code: 'EISDIR' });
    const names = await readdir(dir);
    expect(names.filter((name) => name.includes('.tmp') || name.endsWith('.lock'))).toEqual([]);
    expect(await readFile(configPath, 'utf8')).toBe(configBefore);
  });

  test('a temp file created by this call but never fully written is removed, so the next commit is not blocked', async () => {
    // Simulates open succeeding and the write failing (ENOSPC, EIO): the temp file exists, was
    // created by us, and must not be left behind to block every later commit with EEXIST.
    const base = await loadState(configPath);
    const snapshot = await snapshotFixture();
    const temp = `${snapshotPathFor(configPath)}.${process.pid}.tmp`;
    const failure = new Error('simulated write failure');

    await expect(
      commitState(configPath, base, { snapshot }, {
        writePayload: async () => {
          await writeFile(temp, 'partial', { flag: 'wx' });
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    await expect(readFile(temp, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const fresh = await loadState(configPath);
    await commitState(configPath, fresh, { snapshot });
    expect(JSON.parse(await readFile(snapshotPathFor(configPath), 'utf8')).sourceId).toBe('test-gateway');
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
