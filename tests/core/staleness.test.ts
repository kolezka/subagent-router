// isSnapshotStale is new in this file (not tests/core/config.test.ts) so an import failure here
// while the function does not exist yet cannot mask that file's own parseOperatorConfig/
// parseSnapshot suite.
import { describe, expect, test } from 'bun:test';
import { isSnapshotStale } from '../../src/core/config';
import { snapshotFixture } from '../support/fixtures';

describe('isSnapshotStale', () => {
  test('a snapshot older than staleAfterSeconds is stale', async () => {
    const snapshot = await snapshotFixture();
    const fetchedAt = new Date(snapshot.fetchedAt);
    const now = new Date(fetchedAt.getTime() + 100 * 1000);
    expect(isSnapshotStale(snapshot, 50, now)).toBe(true);
  });

  test('a snapshot within staleAfterSeconds is not stale', async () => {
    const snapshot = await snapshotFixture();
    const fetchedAt = new Date(snapshot.fetchedAt);
    const now = new Date(fetchedAt.getTime() + 10 * 1000);
    expect(isSnapshotStale(snapshot, 50, now)).toBe(false);
  });

  test('no snapshot at all is never stale', () => {
    expect(isSnapshotStale(undefined, 1, new Date('2099-01-01T00:00:00.000Z'))).toBe(false);
  });
});
