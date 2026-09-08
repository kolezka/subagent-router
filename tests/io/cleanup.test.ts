import { describe, expect, test } from 'bun:test';
import { runWithCleanup, suppressedErrors } from '../../src/io/cleanup';

describe('runWithCleanup', () => {
  test('returns the work result after running cleanup', async () => {
    const calls: string[] = [];
    const result = await runWithCleanup(
      async () => {
        calls.push('work');
        return 42;
      },
      async () => {
        calls.push('cleanup');
      },
    );
    expect(result).toBe(42);
    expect(calls).toEqual(['work', 'cleanup']);
  });

  test('a work failure is rethrown unchanged after cleanup runs', async () => {
    const original = new Error('work failed');
    let cleaned = false;
    await expect(
      runWithCleanup(
        async () => {
          throw original;
        },
        async () => {
          cleaned = true;
        },
      ),
    ).rejects.toBe(original);
    expect(cleaned).toBe(true);
  });

  test('when both work and cleanup fail, the work error stays primary and the cleanup error is attached', async () => {
    const original = new Error('work failed');
    const cleanupFailure = new Error('cleanup failed');
    let caught: unknown;
    try {
      await runWithCleanup(
        async () => {
          throw original;
        },
        async () => {
          throw cleanupFailure;
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
    expect(suppressedErrors(caught)).toEqual([cleanupFailure]);
  });

  test('a cleanup failure after successful work is thrown, never swallowed', async () => {
    const cleanupFailure = new Error('cleanup failed');
    await expect(
      runWithCleanup(
        async () => 'ok',
        async () => {
          throw cleanupFailure;
        },
      ),
    ).rejects.toBe(cleanupFailure);
  });

  test('a frozen work error cannot be extended, so it is wrapped with cause instead of masked by a TypeError', async () => {
    const original = Object.freeze(new Error('frozen work failure'));
    const cleanupFailure = new Error('cleanup failed');
    let caught: unknown;
    try {
      await runWithCleanup(
        async () => {
          throw original;
        },
        async () => {
          throw cleanupFailure;
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as Error).cause).toBe(original);
    expect(suppressedErrors(caught)).toEqual([cleanupFailure]);
  });

  test('a non-object work failure is wrapped so the cleanup error is not lost', async () => {
    let caught: unknown;
    try {
      await runWithCleanup(
        async () => {
          throw 'plain string';
        },
        async () => {
          throw new Error('cleanup failed');
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('plain string');
    expect(suppressedErrors(caught)).toHaveLength(1);
  });
});
