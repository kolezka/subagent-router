// Hermetic tests for generator-proof.ts. Never opens the real claude binary: every site check
// here runs against the few-hundred-byte stand-in tests/support/generator-proof-fixture.ts writes.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouterError } from '../../src/core/errors';
import { loadGeneratorProof, verifyGeneratorProofAgainstBinary } from './generator-proof';
import { SYNTHETIC_SITES, writeSyntheticGeneratorBinary, writeSyntheticGeneratorProof } from '../support/generator-proof-fixture';

const REAL_PROOFS = join(import.meta.dir, '..', 'fixtures', 'generator-proofs');

let dir = '';
let binaryPath = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-generator-proof-'));
  binaryPath = join(dir, 'fake-client-binary');
  await writeSyntheticGeneratorBinary(binaryPath);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function loadOrThrow(client: string, version: string, proofsDir: string) {
  const proof = await loadGeneratorProof(client, version, proofsDir);
  if (proof === undefined) throw new Error(`expected a proof for ${client} ${version}`);
  return proof;
}

describe('loadGeneratorProof: the recorded 2.1.268 evidence', () => {
  test('loads the dd-verified 2.1.268 proof with 64 bits from crypto.randomBytes and all four sites', async () => {
    const proof = await loadOrThrow('claude-code', '2.1.268', REAL_PROOFS);

    expect(proof.method).toBe('dd');
    expect(proof.randomBytes).toBe(8);
    expect(proof.bits).toBe(64);
    expect(proof.entropySource).toBe('crypto.randomBytes');
    expect(proof.idPattern).toBe('^a[0-9a-f]{16}$');
    expect(proof.sites.map((site) => site.name).sort()).toEqual(['generator', 'header', 'import', 'spawn']);

    // The id pattern must actually accept the unlabelled shape the generator emits and reject a
    // label-shaped or wrong-length id, or judgeM1's shape check would be decorative.
    const idShape = new RegExp(proof.idPattern);
    expect(idShape.test('a0123456789abcdef')).toBe(true);
    expect(idShape.test('aworker-0123456789abcdef')).toBe(false);
    expect(idShape.test('a0123456789abcde')).toBe(false);
  });

  test('no 2.1.267 proof is recorded: its compaction-continuity clause is unmeasured', async () => {
    expect(await loadGeneratorProof('claude-code', '2.1.267', REAL_PROOFS)).toBeUndefined();
  });

  test('the recorded proof cites a binary path and byte offsets, never an inlined copy of the binary', async () => {
    const proof = await loadOrThrow('claude-code', '2.1.268', REAL_PROOFS);
    expect(proof.binaryPath.length).toBeGreaterThan(0);
    for (const site of proof.sites) expect(Number.isInteger(site.offset) && site.offset >= 0).toBe(true);
    // A whole-binary copy could never fit in a file this size; this locks the cite-do-not-carry
    // shape rather than the exact byte count.
    expect((await stat(join(REAL_PROOFS, 'claude-code-2.1.268.json'))).size).toBeLessThan(4096);
  });
});

describe('loadGeneratorProof: validation', () => {
  test('a file that does not exist is absence, not an error', async () => {
    expect(await loadGeneratorProof('claude-code', '1.0.0', dir)).toBeUndefined();
  });

  test('a client or version declared inside the file that disagrees with the file name is an error', async () => {
    await writeSyntheticGeneratorProof(dir, { binaryPath, version: '9.9.9', patch: { version: '8.8.8' } });
    const wrongVersion = await loadGeneratorProof('claude-code', '9.9.9', dir).catch((caught: unknown) => caught);
    expect(wrongVersion).toBeInstanceOf(RouterError);

    await writeSyntheticGeneratorProof(dir, { binaryPath, version: '9.9.8', patch: { client: 'opencode' } });
    const wrongClient = await loadGeneratorProof('claude-code', '9.9.8', dir).catch((caught: unknown) => caught);
    expect(wrongClient).toBeInstanceOf(RouterError);
  });

  test('bits must equal randomBytes * 8', async () => {
    await writeSyntheticGeneratorProof(dir, { binaryPath, patch: { randomBytes: 8, bits: 128 } });
    const error = await loadGeneratorProof('claude-code', '9.9.9', dir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RouterError);
    expect((error as RouterError).message).toContain('bits');
  });

  test('a negative, fractional or non-numeric offset is an error', async () => {
    for (const offset of [-1, 1.5, '16']) {
      const first = SYNTHETIC_SITES[0] as (typeof SYNTHETIC_SITES)[number];
      const sites = [{ ...first, offset: offset as unknown as number }, ...SYNTHETIC_SITES.slice(1)];
      await writeSyntheticGeneratorProof(dir, { binaryPath, sites });
      const error = await loadGeneratorProof('claude-code', '9.9.9', dir).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RouterError);
    }
  });

  test('an empty literal is an error: a zero-length read matches every offset', async () => {
    const first = SYNTHETIC_SITES[0] as (typeof SYNTHETIC_SITES)[number];
    const sites = [{ ...first, literal: '' }, ...SYNTHETIC_SITES.slice(1)];
    await writeSyntheticGeneratorProof(dir, { binaryPath, sites });
    const error = await loadGeneratorProof('claude-code', '9.9.9', dir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RouterError);
  });

  test('a missing required site name is an error', async () => {
    await writeSyntheticGeneratorProof(dir, { binaryPath, sites: SYNTHETIC_SITES.slice(0, 3) });
    const error = await loadGeneratorProof('claude-code', '9.9.9', dir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RouterError);
    expect((error as RouterError).message).toContain('header');
  });

  test('a method other than dd, an unparseable idPattern and a missing binaryPath are all errors', async () => {
    for (const patch of [{ method: 'eyeballed' }, { idPattern: '^a[0-9a-f' }, { binaryPath: '' }]) {
      await writeSyntheticGeneratorProof(dir, { binaryPath, patch });
      const error = await loadGeneratorProof('claude-code', '9.9.9', dir).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RouterError);
    }
  });
});

describe('verifyGeneratorProofAgainstBinary', () => {
  test('every site matches when each literal really sits at its declared offset', async () => {
    await writeSyntheticGeneratorProof(dir, { binaryPath });
    const proof = await loadOrThrow('claude-code', '9.9.9', dir);

    const verification = await verifyGeneratorProofAgainstBinary(proof);
    expect(verification.binaryPresent).toBe(true);
    expect(verification.sitesTotal).toBe(4);
    expect(verification.sitesVerified).toBe(4);
    expect(verification.mismatchedSites).toEqual([]);
  });

  test('a site whose offset is off by one byte is reported mismatched by name', async () => {
    const shifted = SYNTHETIC_SITES.map((site) => (site.name === 'spawn' ? { ...site, offset: site.offset + 1 } : site));
    await writeSyntheticGeneratorProof(dir, { binaryPath, sites: shifted });
    const proof = await loadOrThrow('claude-code', '9.9.9', dir);

    const verification = await verifyGeneratorProofAgainstBinary(proof);
    expect(verification.binaryPresent).toBe(true);
    expect(verification.mismatchedSites).toEqual(['spawn']);
    expect(verification.sitesVerified).toBe(3);
  });

  test('an offset past the end of the binary is a mismatch, not a crash', async () => {
    const beyond = SYNTHETIC_SITES.map((site) => (site.name === 'header' ? { ...site, offset: 10_000_000 } : site));
    await writeSyntheticGeneratorProof(dir, { binaryPath, sites: beyond });
    const proof = await loadOrThrow('claude-code', '9.9.9', dir);

    const verification = await verifyGeneratorProofAgainstBinary(proof);
    expect(verification.mismatchedSites).toEqual(['header']);
  });

  test('an absent binary verifies nothing rather than silently reporting success', async () => {
    await writeSyntheticGeneratorProof(dir, { binaryPath: join(dir, 'no-such-binary') });
    const proof = await loadOrThrow('claude-code', '9.9.9', dir);

    const verification = await verifyGeneratorProofAgainstBinary(proof);
    expect(verification.binaryPresent).toBe(false);
    expect(verification.sitesVerified).toBe(0);
    expect(verification.sitesTotal).toBe(4);
  });
});
