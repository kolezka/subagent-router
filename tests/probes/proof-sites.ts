// One recorded byte site, and the positional re-read that turns a recorded site back into
// evidence. Shared by generator-proof.ts (what the id generator does) and resume-proof.ts (what
// an ordinary resume does), because both record the same thing about a pinned binary: an offset
// plus the literal a human read there. A version string on a file proves nothing on its own, so
// the reads below happen every run, and they are exactly literal.length bytes wide: the binary is
// ~200MB and is never loaded into memory here.
import { open } from 'node:fs/promises';
import type { RouterError } from '../../src/core/errors';

export interface ProofSite {
  name: string;
  offset: number;
  literal: string;
}

export interface ProofSiteVerification {
  binaryPresent: boolean;
  sitesTotal: number;
  sitesVerified: number;
  // Sites whose declared bytes are NOT what the binary holds at that offset. Empty when the
  // binary is absent: nothing was compared, so nothing may be reported as mismatched either.
  mismatchedSites: readonly string[];
}

/**
 * Validates one `sites[i]` entry off a parsed proof file. The caller supplies its own schema-error
 * factory so each proof kind keeps its own RouterError code and message prefix.
 */
export function validateProofSite(value: unknown, index: number, schemaError: (detail: string) => RouterError): ProofSite {
  if (typeof value !== 'object' || value === null) {
    throw schemaError(`sites[${index}] is not an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string' || record.name.length === 0) {
    throw schemaError(`sites[${index}].name is missing or empty`);
  }
  if (typeof record.offset !== 'number' || !Number.isInteger(record.offset) || record.offset < 0) {
    throw schemaError(`site ${record.name}: offset must be a non-negative integer`);
  }
  // An empty literal would read zero bytes and therefore "match" at every offset in the file,
  // turning site verification into a no-op that always succeeds.
  if (typeof record.literal !== 'string' || record.literal.length === 0) {
    throw schemaError(`site ${record.name}: literal is missing or empty`);
  }
  return { name: record.name, offset: record.offset, literal: record.literal };
}

/**
 * Re-reads every recorded site out of the cited binary and reports which still match. Each read is
 * positional and exactly the literal's byte length, so this costs a handful of bytes regardless of
 * how large the binary is.
 *
 * An absent or unreadable binary returns binaryPresent false with nothing verified. That is not a
 * pass and not a failure: it means this run could not check, which callers must treat as pending.
 */
export async function verifyProofSitesAgainstBinary(sites: readonly ProofSite[], binaryPath: string): Promise<ProofSiteVerification> {
  const sitesTotal = sites.length;

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(binaryPath, 'r');
  } catch {
    return { binaryPresent: false, sitesTotal, sitesVerified: 0, mismatchedSites: [] };
  }

  try {
    const mismatchedSites: string[] = [];
    for (const site of sites) {
      const expected = Buffer.from(site.literal, 'utf8');
      const actual = Buffer.alloc(expected.length);
      // A short read means the offset runs past the end of the file: a mismatch, not a crash.
      const { bytesRead } = await handle.read(actual, 0, expected.length, site.offset);
      if (bytesRead !== expected.length || !actual.equals(expected)) mismatchedSites.push(site.name);
    }
    return { binaryPresent: true, sitesTotal, sitesVerified: sitesTotal - mismatchedSites.length, mismatchedSites };
  } finally {
    await handle.close();
  }
}
