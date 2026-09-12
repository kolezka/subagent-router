// Generator-inspection proofs: what a human read out of one pinned client binary about the agent
// id generator, recorded as byte offsets plus the literals that sit at them. A version string on
// a file proves nothing on its own, so verifyGeneratorProofAgainstBinary re-reads each recorded
// site out of the cited binary and reports which ones still match (proof-sites.ts does the
// reading, shared with resume-proof.ts).
//
// This is the evidence judgeM1 (evidence-m1.ts) needs before M1 can be anything but pending.
// A statistical id sample shows variety; only this shows where the bits come from.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RouterError } from '../../src/core/errors';
import { validateProofSite, verifyProofSitesAgainstBinary } from './proof-sites';
import type { ProofSite, ProofSiteVerification } from './proof-sites';

export type GeneratorProofSite = ProofSite;

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
  return validateProofSite(value, index, (detail) => schemaError(fixtureName, detail));
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

export type GeneratorProofSiteVerification = ProofSiteVerification;

/** Re-reads every recorded site out of the binary this proof cites. See verifyProofSitesAgainstBinary. */
export async function verifyGeneratorProofAgainstBinary(proof: GeneratorProof): Promise<GeneratorProofSiteVerification> {
  return verifyProofSitesAgainstBinary(proof.sites, proof.binaryPath);
}
