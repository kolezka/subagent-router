// Resume-inspection proofs: what a human read out of one pinned client binary about what an
// ordinary resume does to a delegated child, recorded as byte offsets plus the literals that sit
// at them. Same shape and the same positional re-read as generator-proof.ts (both use
// proof-sites.ts), for a different question.
//
// The question: after `claude -c`, does any pre-boundary child keep its id and send another
// request? On Claude Code 2.1.268 the answer read out of the binary is no. The resumed parent
// re-delegates and every child is minted fresh; the only path that continues an existing child
// with its old id is the takeover handoff, gated on pl() and LM(), which ordinary -c and --resume
// never satisfy. That is a claim about code that was READ, not run, which is why
// continuationPathMeasured exists and is false: the gated path itself stays unexercised, and the
// resume judge says so in its own diagnostic rather than implying the whole space was covered.
//
// This is the evidence judgeLifecyclePhase's 'resume' branch (evidence-m10.ts) needs before a run
// with no continuation at all can be anything but pending. Without it, "no child crossed the
// boundary" is indistinguishable from "the router lost every child".
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RouterError } from '../../src/core/errors';
import { validateProofSite, verifyProofSitesAgainstBinary } from './proof-sites';
import type { ProofSite, ProofSiteVerification } from './proof-sites';

export type ResumeProofSite = ProofSite;

export interface ResumeProof {
  client: string;
  version: string;
  method: 'dd';
  binaryPath: string;
  inspectedAt: string;
  // What the recorded sites are evidence FOR. The judge compares this against the one claim it
  // knows how to act on, so a record making some other claim can never quietly satisfy it.
  claim: string;
  // The one code path that does continue an existing child with its old id.
  continuationPath: string;
  // Whether that path was actually exercised. False means read-only: the judge must keep saying
  // so rather than reporting the whole resume space as measured.
  continuationPathMeasured: boolean;
  sites: readonly ResumeProofSite[];
}

/** The only claim the resume judge acts on. A record asserting anything else is not this evidence. */
export const RESUME_NO_CONTINUATION_CLAIM = 'ordinary-resume-never-continues-a-child';

// All five must be present. Together they trace one resumed session end to end: where a resumed
// parent restores its state, the two gates that guard the continue path, the single call that
// continues an interrupted turn, and the hydration path an ordinary resume actually takes instead.
// A record missing any one of them describes only part of the path.
const REQUIRED_SITE_NAMES: readonly string[] = ['restore-on-mount', 'adopt-gate', 'orphan-gate', 'orphan-continue', 'resume-override'];

// Same identifier guard as generator-proof.ts: client and version are interpolated into a file
// path, so anything but a plain token is refused before a file is opened.
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(value) || value.includes('..')) {
    throw new RouterError('resume-proof-invalid-identifier', `${label} is not a valid identifier`);
  }
}

function schemaError(fixtureName: string, detail: string): RouterError {
  return new RouterError('resume-proof-invalid-schema', `resume proof ${fixtureName}: ${detail}`);
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

function validateResumeProof(value: unknown, client: string, version: string, fixtureName: string): ResumeProof {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw schemaError(fixtureName, 'does not parse to an object');
  }
  const record = value as Record<string, unknown>;

  // Identity first: a record whose declared client/version disagrees with the name it is filed
  // under would bind the resume verdict to the wrong binary, which is the one mistake this file
  // exists to stop.
  if (record.client !== client) {
    throw new RouterError('resume-proof-identity-mismatch', `resume proof ${fixtureName} declares client ${JSON.stringify(record.client)}, expected ${client}`);
  }
  if (record.version !== version) {
    throw new RouterError('resume-proof-identity-mismatch', `resume proof ${fixtureName} declares version ${JSON.stringify(record.version)}, expected ${version}`);
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
  if (typeof record.claim !== 'string' || record.claim.length === 0) {
    throw schemaError(fixtureName, 'claim is missing or empty');
  }
  if (typeof record.continuationPath !== 'string' || record.continuationPath.length === 0) {
    throw schemaError(fixtureName, 'continuationPath is missing or empty');
  }
  // Strictly boolean: a missing field or the string "false" must never read as an unmeasured
  // path, and must never read as a measured one either.
  if (typeof record.continuationPathMeasured !== 'boolean') {
    throw schemaError(fixtureName, 'continuationPathMeasured must be a boolean');
  }
  if (!Array.isArray(record.sites)) {
    throw schemaError(fixtureName, 'sites is missing or not an array');
  }
  const sites = record.sites.map((site, index) => validateProofSite(site, index, (detail) => schemaError(fixtureName, detail)));
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
    claim: record.claim,
    continuationPath: record.continuationPath,
    continuationPathMeasured: record.continuationPathMeasured,
    sites,
  };
}

/**
 * Reads `<client>-<version>.json` out of `dir`. Returns undefined ONLY when that file does not
 * exist, which is the honest "this version was never inspected" case. Every other problem --
 * unreadable file, malformed JSON, a field that fails validation, a declared identity that
 * disagrees with the file name -- is a RouterError, never silent absence.
 */
export async function loadResumeProof(client: string, version: string, dir: string): Promise<ResumeProof | undefined> {
  assertSafeIdentifier(client, 'client');
  assertSafeIdentifier(version, 'version');

  const fixtureName = `${client}-${version}.json`;
  const path = join(dir, fixtureName);

  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw new RouterError('resume-proof-read-failed', `failed to read resume proof ${fixtureName}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RouterError('resume-proof-invalid-json', `resume proof ${fixtureName} is not valid JSON`);
  }
  return validateResumeProof(parsed, client, version, fixtureName);
}

export type ResumeProofSiteVerification = ProofSiteVerification;

/** Re-reads every recorded site out of the binary this proof cites. See verifyProofSitesAgainstBinary. */
export async function verifyResumeProofAgainstBinary(proof: ResumeProof): Promise<ResumeProofSiteVerification> {
  return verifyProofSitesAgainstBinary(proof.sites, proof.binaryPath);
}
