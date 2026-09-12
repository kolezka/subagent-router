// Hermetic tests for resume-proof.ts. Never opens the real claude binary: every site check here
// runs against the few-hundred-byte stand-in tests/support/resume-proof-fixture.ts writes.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouterError } from '../../src/core/errors';
import { loadResumeProof, RESUME_INSPECTION_CLAIM, verifyResumeProofAgainstBinary } from './resume-proof';
import { SYNTHETIC_RESUME_SITES, writeSyntheticResumeBinary, writeSyntheticResumeProof } from '../support/resume-proof-fixture';

const REAL_PROOFS = join(import.meta.dir, '..', 'fixtures', 'resume-proofs');

let dir = '';
let binaryPath = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-resume-proof-'));
  binaryPath = join(dir, 'fake-client-binary');
  await writeSyntheticResumeBinary(binaryPath);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function loadOrThrow(client: string, version: string, proofsDir: string) {
  const proof = await loadResumeProof(client, version, proofsDir);
  if (proof === undefined) throw new Error(`expected a proof for ${client} ${version}`);
  return proof;
}

describe('loadResumeProof: the recorded 2.1.268 evidence', () => {
  test('loads the dd-verified 2.1.268 record with the no-continuation claim and all five sites', async () => {
    const proof = await loadOrThrow('claude-code', '2.1.268', REAL_PROOFS);

    expect(proof.method).toBe('dd');
    expect(proof.claim).toBe(RESUME_INSPECTION_CLAIM);
    expect(proof.claim).toBe('takeover-continuation-sites-inspected');
    expect(proof.continuationPath).toBe('takeover-handoff');
    // The one path that continues a child with its old id was read, never exercised. Recording
    // that as false is what keeps the resume verdict honest about its own limit.
    expect(proof.continuationPathMeasured).toBe(false);
    expect(proof.sites.map((site) => site.name).sort()).toEqual([
      'adopt-gate',
      'orphan-continue',
      'orphan-gate',
      'restore-on-mount',
      'resume-override',
    ]);
  });

  test('no 2.1.267 record is filed: that build re-issues child ids for a different measured reason', async () => {
    expect(await loadResumeProof('claude-code', '2.1.267', REAL_PROOFS)).toBeUndefined();
  });

  test('the recorded record cites a binary path and byte offsets, never an inlined copy of the binary', async () => {
    const proof = await loadOrThrow('claude-code', '2.1.268', REAL_PROOFS);
    expect(proof.binaryPath.length).toBeGreaterThan(0);
    for (const site of proof.sites) expect(Number.isInteger(site.offset) && site.offset >= 0).toBe(true);
    expect((await stat(join(REAL_PROOFS, 'claude-code-2.1.268.json'))).size).toBeLessThan(4096);
  });
});

describe('loadResumeProof: validation', () => {
  test('a file that does not exist is absence, not an error', async () => {
    expect(await loadResumeProof('claude-code', '1.0.0', dir)).toBeUndefined();
  });

  test('a client or version declared inside the file that disagrees with the file name is an error', async () => {
    await writeSyntheticResumeProof(dir, { binaryPath, version: '9.9.9', patch: { version: '8.8.8' } });
    const wrongVersion = await loadResumeProof('claude-code', '9.9.9', dir).catch((caught: unknown) => caught);
    expect(wrongVersion).toBeInstanceOf(RouterError);

    await writeSyntheticResumeProof(dir, { binaryPath, version: '9.9.8', patch: { client: 'opencode' } });
    const wrongClient = await loadResumeProof('claude-code', '9.9.8', dir).catch((caught: unknown) => caught);
    expect(wrongClient).toBeInstanceOf(RouterError);
  });

  test('an empty or non-string claim is an error: the judge compares against it', async () => {
    for (const claim of ['', 42, undefined]) {
      await writeSyntheticResumeProof(dir, { binaryPath, patch: { claim } });
      const error = await loadResumeProof('claude-code', '9.9.9', dir).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RouterError);
      expect((error as RouterError).message).toContain('claim');
    }
  });

  test('a non-boolean continuationPathMeasured is an error: an unmeasured path may not read as measured', async () => {
    for (const measured of ['false', 0, undefined]) {
      await writeSyntheticResumeProof(dir, { binaryPath, patch: { continuationPathMeasured: measured } });
      const error = await loadResumeProof('claude-code', '9.9.9', dir).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RouterError);
      expect((error as RouterError).message).toContain('continuationPathMeasured');
    }
  });

  test('a method other than dd, a missing binaryPath, a bad inspectedAt and an empty continuationPath are all errors', async () => {
    for (const patch of [{ method: 'eyeballed' }, { binaryPath: '' }, { inspectedAt: 'last tuesday' }, { continuationPath: '' }]) {
      await writeSyntheticResumeProof(dir, { binaryPath, patch });
      const error = await loadResumeProof('claude-code', '9.9.9', dir).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RouterError);
    }
  });

  test('a negative, fractional or non-numeric offset is an error', async () => {
    for (const offset of [-1, 1.5, '16']) {
      const first = SYNTHETIC_RESUME_SITES[0] as (typeof SYNTHETIC_RESUME_SITES)[number];
      const sites = [{ ...first, offset: offset as unknown as number }, ...SYNTHETIC_RESUME_SITES.slice(1)];
      await writeSyntheticResumeProof(dir, { binaryPath, sites });
      const error = await loadResumeProof('claude-code', '9.9.9', dir).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RouterError);
    }
  });

  test('an empty literal is an error: a zero-length read matches every offset', async () => {
    const first = SYNTHETIC_RESUME_SITES[0] as (typeof SYNTHETIC_RESUME_SITES)[number];
    const sites = [{ ...first, literal: '' }, ...SYNTHETIC_RESUME_SITES.slice(1)];
    await writeSyntheticResumeProof(dir, { binaryPath, sites });
    const error = await loadResumeProof('claude-code', '9.9.9', dir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RouterError);
  });

  test('a missing required site name is an error: four of the five sites describe only part of the path', async () => {
    await writeSyntheticResumeProof(dir, { binaryPath, sites: SYNTHETIC_RESUME_SITES.slice(0, 4) });
    const error = await loadResumeProof('claude-code', '9.9.9', dir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RouterError);
    expect((error as RouterError).message).toContain('resume-override');
  });
});

describe('verifyResumeProofAgainstBinary', () => {
  test('every site matches when each literal really sits at its declared offset', async () => {
    await writeSyntheticResumeProof(dir, { binaryPath });
    const proof = await loadOrThrow('claude-code', '9.9.9', dir);

    const verification = await verifyResumeProofAgainstBinary(proof);
    expect(verification.binaryPresent).toBe(true);
    expect(verification.sitesTotal).toBe(5);
    expect(verification.sitesVerified).toBe(5);
    expect(verification.mismatchedSites).toEqual([]);
  });

  test('a site whose offset is off by one byte is reported mismatched by name', async () => {
    const shifted = SYNTHETIC_RESUME_SITES.map((site) => (site.name === 'adopt-gate' ? { ...site, offset: site.offset + 1 } : site));
    await writeSyntheticResumeProof(dir, { binaryPath, sites: shifted });
    const proof = await loadOrThrow('claude-code', '9.9.9', dir);

    const verification = await verifyResumeProofAgainstBinary(proof);
    expect(verification.mismatchedSites).toEqual(['adopt-gate']);
    expect(verification.sitesVerified).toBe(4);
  });

  test('an absent binary verifies nothing rather than silently reporting success', async () => {
    await writeSyntheticResumeProof(dir, { binaryPath: join(dir, 'no-such-binary') });
    const proof = await loadOrThrow('claude-code', '9.9.9', dir);

    const verification = await verifyResumeProofAgainstBinary(proof);
    expect(verification.binaryPresent).toBe(false);
    expect(verification.sitesVerified).toBe(0);
    expect(verification.sitesTotal).toBe(5);
  });
});
