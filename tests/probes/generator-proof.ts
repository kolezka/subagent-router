// Generator-inspection proofs: what a human read out of one pinned client binary about the agent
// id generator, recorded as byte offsets plus the literals that sit at them. A version string on
// a file proves nothing on its own, so verifyGeneratorProofAgainstBinary re-reads each recorded
// site out of the cited binary and reports which ones still match. Reads are positional and
// exactly literal.length bytes wide: the binary is ~200MB and is never loaded into memory here.
//
// This is the evidence judgeM1 (evidence-m1.ts) needs before M1 can be anything but pending.
// A statistical id sample shows variety; only this shows where the bits come from.
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RouterError } from '../../src/core/errors';

export interface GeneratorProofSite {
  name: string;
  offset: number;
  literal: string;
}

export interface GeneratorProof {
  client: string;
  version: string;
  method: 'dd';
  binaryPath: string;
  inspectedAt: string;
  randomBytes: number;
  bits: number;
  entropySource: string;
  // Regex source for the id shape the generator produces, e.g. '^a[0-9a-f]{16}$'.
  idPattern: string;
  sites: readonly GeneratorProofSite[];
}

// All four must be present. Together they trace one id end to end: where the randomness is
// imported from, where it becomes an id, where that id is minted per spawn, and where it leaves
// the client as a header. A proof missing any one of them describes only part of the path.
const REQUIRED_SITE_NAMES: readonly string[] = ['generator', 'import', 'spawn', 'header'];

// Same identifier guard as src/adapters/capabilities.ts: client and version are interpolated into
// a file path, so anything but a plain token is refused before a file is opened.
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(value) || value.includes('..')) {
    throw new RouterError('generator-proof-invalid-identifier', `${label} is not a valid identifier`);
  }
}

function schemaError(fixtureName: string, detail: string): RouterError {
  return new RouterError('generator-proof-invalid-schema', `generator proof ${fixtureName}: ${detail}`);
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

function validateSite(value: unknown, index: number, fixtureName: string): GeneratorProofSite {
  if (typeof value !== 'object' || value === null) {
    throw schemaError(fixtureName, `sites[${index}] is not an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string' || record.name.length === 0) {
    throw schemaError(fixtureName, `sites[${index}].name is missing or empty`);
  }
  if (typeof record.offset !== 'number' || !Number.isInteger(record.offset) || record.offset < 0) {
    throw schemaError(fixtureName, `site ${record.name}: offset must be a non-negative integer`);
  }
  // An empty literal would read zero bytes and therefore "match" at every offset in the file,
  // turning site verification into a no-op that always succeeds.
  if (typeof record.literal !== 'string' || record.literal.length === 0) {
    throw schemaError(fixtureName, `site ${record.name}: literal is missing or empty`);
  }
  return { name: record.name, offset: record.offset, literal: record.literal };
}

function validateGeneratorProof(value: unknown, client: string, version: string, fixtureName: string): GeneratorProof {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw schemaError(fixtureName, 'does not parse to an object');
  }
  const record = value as Record<string, unknown>;

  // Identity first: a proof whose declared client/version disagrees with the name it is filed
  // under would bind M1 to the wrong binary, which is the one mistake this file exists to stop.
  if (record.client !== client) {
    throw new RouterError('generator-proof-identity-mismatch', `generator proof ${fixtureName} declares client ${JSON.stringify(record.client)}, expected ${client}`);
  }
  if (record.version !== version) {
    throw new RouterError('generator-proof-identity-mismatch', `generator proof ${fixtureName} declares version ${JSON.stringify(record.version)}, expected ${version}`);
  }
  if (record.method !== 'dd') {
    throw schemaError(fixtureName, `method must be "dd", got ${JSON.stringify(record.method)}`);
  }
  if (typeof record.binaryPath !== 'string' || record.binaryPath.length === 0) {
    throw schemaError(fixtureName, 'binaryPath is missing or empty');
  }
  if (typeof record.inspectedAt !== 'string' || Number.isNaN(Date.parse(record.inspectedAt))) {
    throw schemaError(fixtureName, 'inspectedAt is missing or not an ISO date');
  }
  if (typeof record.randomBytes !== 'number' || !Number.isInteger(record.randomBytes) || record.randomBytes <= 0) {
    throw schemaError(fixtureName, 'randomBytes must be a positive integer');
  }
  if (typeof record.bits !== 'number' || record.bits !== record.randomBytes * 8) {
    throw schemaError(fixtureName, `bits must equal randomBytes * 8 (${record.randomBytes * 8}), got ${JSON.stringify(record.bits)}`);
  }
  if (typeof record.entropySource !== 'string' || record.entropySource.length === 0) {
    throw schemaError(fixtureName, 'entropySource is missing or empty');
  }
  if (typeof record.idPattern !== 'string' || record.idPattern.length === 0) {
    throw schemaError(fixtureName, 'idPattern is missing or empty');
  }
  try {
    new RegExp(record.idPattern);
  } catch {
    throw schemaError(fixtureName, `idPattern ${JSON.stringify(record.idPattern)} is not a valid regular expression`);
  }
  if (!Array.isArray(record.sites)) {
    throw schemaError(fixtureName, 'sites is missing or not an array');
  }
  const sites = record.sites.map((site, index) => validateSite(site, index, fixtureName));
  const names = new Set(sites.map((site) => site.name));
  if (names.size !== sites.length) {
    throw schemaError(fixtureName, 'sites contains a duplicate name');
  }
  for (const required of REQUIRED_SITE_NAMES) {
    if (!names.has(required)) throw schemaError(fixtureName, `sites is missing the required ${required} site`);
  }

  return {
    client,
    version,
    method: 'dd',
    binaryPath: record.binaryPath,
    inspectedAt: record.inspectedAt,
    randomBytes: record.randomBytes,
    bits: record.bits,
    entropySource: record.entropySource,
    idPattern: record.idPattern,
    sites,
  };
}

/**
 * Reads `<client>-<version>.json` out of `dir`. Returns undefined ONLY when that file does not
 * exist, which is the honest "this version was never inspected" case (2.1.267, for one). Every
 * other problem -- unreadable file, malformed JSON, a field that fails validation, a declared
 * identity that disagrees with the file name -- is a RouterError, never silent absence.
 */
export async function loadGeneratorProof(client: string, version: string, dir: string): Promise<GeneratorProof | undefined> {
  assertSafeIdentifier(client, 'client');
  assertSafeIdentifier(version, 'version');

  const fixtureName = `${client}-${version}.json`;
  const path = join(dir, fixtureName);

  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw new RouterError('generator-proof-read-failed', `failed to read generator proof ${fixtureName}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RouterError('generator-proof-invalid-json', `generator proof ${fixtureName} is not valid JSON`);
  }
  return validateGeneratorProof(parsed, client, version, fixtureName);
}

export interface GeneratorProofSiteVerification {
  binaryPresent: boolean;
  sitesTotal: number;
  sitesVerified: number;
  // Sites whose declared bytes are NOT what the binary holds at that offset. Empty when the
  // binary is absent: nothing was compared, so nothing may be reported as mismatched either.
  mismatchedSites: readonly string[];
}

/**
 * Re-reads every recorded site out of the binary the proof cites and reports which still match.
 * Each read is positional and exactly the literal's byte length, so this costs a handful of bytes
 * regardless of how large the binary is.
 *
 * An absent or unreadable binary returns binaryPresent false with nothing verified. That is not a
 * pass and not a failure: it means this run could not check, which callers must treat as pending.
 */
export async function verifyGeneratorProofAgainstBinary(proof: GeneratorProof): Promise<GeneratorProofSiteVerification> {
  const sitesTotal = proof.sites.length;

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(proof.binaryPath, 'r');
  } catch {
    return { binaryPresent: false, sitesTotal, sitesVerified: 0, mismatchedSites: [] };
  }

  try {
    const mismatchedSites: string[] = [];
    for (const site of proof.sites) {
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
