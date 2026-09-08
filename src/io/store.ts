import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseOperatorConfig, parseSnapshot } from '../core/config';
import { RouterError } from '../core/errors';
import { sha256 } from '../core/hash';
import type { CatalogSnapshot, LoadedState, OperatorConfig } from '../core/types';

export function snapshotPathFor(configPath: string): string {
  return join(dirname(configPath), 'models.lock.json');
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parseJson(text: string, code: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new RouterError(code, 'file is not valid JSON');
  }
}

async function hashes(configPath: string): Promise<{
  configText: string;
  snapshotText: string | null;
  configHash: string;
  snapshotHash: string | null;
}> {
  const configText = await readOptional(configPath);
  if (configText === null) throw new RouterError('config-missing', `missing file ${configPath}`);

  const snapshotText = await readOptional(snapshotPathFor(configPath));
  return {
    configText,
    snapshotText,
    configHash: await sha256(configText),
    snapshotHash: snapshotText === null ? null : await sha256(snapshotText),
  };
}

export async function loadState(configPath: string): Promise<LoadedState> {
  const current = await hashes(configPath);
  const config = parseOperatorConfig(parseJson(current.configText, 'config-json'));
  const snapshot = current.snapshotText === null ? undefined : parseSnapshot(parseJson(current.snapshotText, 'snapshot-json'));
  const generation = await sha256(`${current.configHash}:${current.snapshotHash ?? 'none'}`);

  return {
    config,
    ...(snapshot === undefined ? {} : { snapshot }),
    expected: { configHash: current.configHash, snapshotHash: current.snapshotHash },
    generation,
  };
}

async function withLock<T>(configPath: string, work: () => Promise<T>): Promise<T> {
  const lockPath = `${configPath}.lock`;
  let handle;

  try {
    handle = await open(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new RouterError('store-locked', 'another process holds the write lock');
    }
    throw error;
  }

  try {
    return await work();
  } finally {
    try {
      await handle.close();
    } finally {
      await rm(lockPath, { force: true });
    }
  }
}

export async function commitState(
  configPath: string,
  base: LoadedState,
  change: { config?: OperatorConfig; snapshot?: CatalogSnapshot },
): Promise<void> {
  if (change.config !== undefined && change.snapshot !== undefined) {
    throw new RouterError('store-single-file', 'write config or snapshot, not both');
  }
  if (change.config === undefined && change.snapshot === undefined) {
    throw new RouterError('store-empty-change', 'no change to write');
  }

  if (change.config !== undefined) {
    parseOperatorConfig(change.config);
  } else if (change.snapshot !== undefined) {
    parseSnapshot(change.snapshot);
  }

  await withLock(configPath, async () => {
    const current = await hashes(configPath);
    if (current.configHash !== base.expected.configHash || current.snapshotHash !== base.expected.snapshotHash) {
      throw new RouterError('store-conflict', 'files changed since load; load state again');
    }

    const target = change.config !== undefined ? configPath : snapshotPathFor(configPath);
    const payload = `${JSON.stringify(change.config ?? change.snapshot, null, 2)}\n`;
    const temp = `${target}.${process.pid}.tmp`;

    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(temp, payload, { flag: 'wx' });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
  });
}
