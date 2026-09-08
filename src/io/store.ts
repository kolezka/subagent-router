import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseOperatorConfig, parseSnapshot } from '../core/config';
import { RouterError } from '../core/errors';
import { sha256 } from '../core/hash';
import type { CatalogSnapshot, LoadedState, OperatorConfig } from '../core/types';
import { runWithCleanup } from './cleanup';

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

  const lockHandle = handle;
  // The lock file is ours (created with wx above), so removing it on every exit path is correct.
  // runWithCleanup keeps the work error primary if close or rm fails as well.
  return runWithCleanup(work, async () => {
    try {
      await lockHandle.close();
    } finally {
      await rm(lockPath, { force: true });
    }
  });
}

// Creates `temp` exclusively and writes `payload` into it. Split from the rename so a failure
// between create and a complete write (ENOSPC, EIO) still leaves `tempCreated` true in the caller
// and the half-written file gets removed instead of blocking every later commit with EEXIST.
async function writeTempPayload(temp: string, payload: string): Promise<void> {
  const handle = await open(temp, 'wx');
  try {
    await handle.writeFile(payload);
  } finally {
    await handle.close();
  }
}

export interface CommitStateOptions {
  // Test seam only: replaces the temp-file write to simulate a failure after the file exists.
  writePayload?: (temp: string, payload: string) => Promise<void>;
}

export async function commitState(
  configPath: string,
  base: LoadedState,
  change: { config?: OperatorConfig; snapshot?: CatalogSnapshot },
  options: CommitStateOptions = {},
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
    // Only a temp file this call created is removed on failure. `tempCreated` is set once the
    // exclusive create can no longer have been refused: any later failure (partial write, rename)
    // means the file at `temp` is ours. If the create itself was refused (EEXIST), the file at
    // `temp` belongs to someone else and stays.
    let tempCreated = false;
    const writePayload = options.writePayload ?? writeTempPayload;
    await runWithCleanup(
      async () => {
        try {
          await writePayload(temp, payload);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') tempCreated = true;
          throw error;
        }
        tempCreated = true;
        await rename(temp, target);
      },
      async () => {
        if (tempCreated) await rm(temp, { force: true });
      },
    );
  });
}
