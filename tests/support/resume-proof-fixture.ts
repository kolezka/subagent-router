// Synthetic stand-ins for a resume-inspection proof and the client binary it cites, so the
// site-verification path can be exercised without ever touching a real ~200MB claude binary.
// Same shape and the same few-hundred-byte stand-in binary generator-proof-fixture.ts writes:
// each declared literal sits at its declared offset, everything else is filler.
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { writeSyntheticGeneratorBinary } from './generator-proof-fixture';
import type { SyntheticProofSite } from './generator-proof-fixture';

// The claim the real 2.1.268 record carries, and the only one the resume judge accepts.
export const SYNTHETIC_RESUME_CLAIM = 'ordinary-resume-never-continues-a-child';

// Same five site names the real proof records, with short stand-in literals at small offsets.
export const SYNTHETIC_RESUME_SITES: readonly SyntheticProofSite[] = [
  { name: 'restore-on-mount', offset: 16, literal: 'restoreOnMount(){let{initialMessages:w}=this' },
  { name: 'adopt-gate', offset: 96, literal: 'if(!pl()||LM()!==ee){t("[adopt] skipped");return}' },
  { name: 'orphan-gate', offset: 176, literal: 'if(!pl()||LM()!==P){t("[orphan-resume] skipped");return}' },
  { name: 'orphan-continue', offset: 256, literal: '$3({agentId:ke.agentId,continueInterruptedTurn:!0' },
  { name: 'resume-override', offset: 336, literal: 'agentId:ro(q.agentId),replHydration:{kind:"resume"}' },
];

/** Writes the small stand-in binary the synthetic resume sites are read out of. */
export async function writeSyntheticResumeBinary(path: string, sites: readonly SyntheticProofSite[] = SYNTHETIC_RESUME_SITES): Promise<void> {
  await writeSyntheticGeneratorBinary(path, sites);
}

export interface SyntheticResumeProofOptions {
  client?: string;
  version?: string;
  binaryPath: string;
  sites?: readonly SyntheticProofSite[];
  // Shallow-merged over the built proof object last, so a test can corrupt exactly one field.
  patch?: Record<string, unknown>;
  // Overrides the file name, for the "declared identity disagrees with the file name" case.
  fileName?: string;
}

/** Writes one resume-proof JSON into `dir` and returns its full path. */
export async function writeSyntheticResumeProof(dir: string, options: SyntheticResumeProofOptions): Promise<string> {
  const client = options.client ?? 'claude-code';
  const version = options.version ?? '9.9.9';
  const proof: Record<string, unknown> = {
    client,
    version,
    method: 'dd',
    binaryPath: options.binaryPath,
    inspectedAt: '2026-09-12T00:00:00.000Z',
    claim: SYNTHETIC_RESUME_CLAIM,
    continuationPath: 'takeover-handoff',
    continuationPathMeasured: false,
    sites: options.sites ?? SYNTHETIC_RESUME_SITES,
    ...options.patch,
  };
  const path = join(dir, options.fileName ?? `${client}-${version}.json`);
  await writeFile(path, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  return path;
}
