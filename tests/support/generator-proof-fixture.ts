// Synthetic stand-ins for a generator-inspection proof and the client binary it cites, so the
// site-verification path can be exercised without ever touching a real ~200MB claude binary.
// The binary written here is a few hundred filler bytes with each declared literal placed at its
// declared offset: exactly the shape verifyGeneratorProofAgainstBinary reads, nothing else.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SyntheticProofSite {
  name: string;
  offset: number;
  literal: string;
}

// The unlabelled id shape the real 2.1.268 generator produces: 'a' plus 16 lowercase hex chars.
export const SYNTHETIC_ID_PATTERN = '^a[0-9a-f]{16}$';

// Same four site names the real proof records, with short stand-in literals at small offsets.
export const SYNTHETIC_SITES: readonly SyntheticProofSite[] = [
  { name: 'generator', offset: 16, literal: 'let t=rb(8).toString("hex")' },
  { name: 'import', offset: 64, literal: 'randomBytes as rb}from"crypto"' },
  { name: 'spawn', offset: 128, literal: 'X=U?.agentId?U.agentId:mint()' },
  { name: 'header', offset: 192, literal: '"x-claude-code-agent-id":hdr(L.agentId)' },
];

const FILLER_BYTE = 0x2e; // '.', so a mismatch shows up as readable text in a failure message

/**
 * Writes a small binary whose bytes at each site's offset are exactly that site's literal.
 * Everything else is filler, so a read at the right offset matches and a read one byte off does
 * not.
 */
export async function writeSyntheticGeneratorBinary(path: string, sites: readonly SyntheticProofSite[] = SYNTHETIC_SITES): Promise<void> {
  let size = 0;
  for (const site of sites) {
    size = Math.max(size, site.offset + Buffer.byteLength(site.literal, 'utf8'));
  }
  const buffer = Buffer.alloc(size + 16, FILLER_BYTE);
  for (const site of sites) buffer.write(site.literal, site.offset, 'utf8');
  await writeFile(path, buffer);
}

export interface SyntheticProofOptions {
  client?: string;
  version?: string;
  binaryPath: string;
  sites?: readonly SyntheticProofSite[];
  // Shallow-merged over the built proof object last, so a test can corrupt exactly one field.
  patch?: Record<string, unknown>;
  // Overrides the file name, for the "declared identity disagrees with the file name" case.
  fileName?: string;
}

/** Writes one generator-proof JSON into `dir` and returns its full path. */
export async function writeSyntheticGeneratorProof(dir: string, options: SyntheticProofOptions): Promise<string> {
  const client = options.client ?? 'claude-code';
  const version = options.version ?? '9.9.9';
  const proof: Record<string, unknown> = {
    client,
    version,
    method: 'dd',
    binaryPath: options.binaryPath,
    inspectedAt: '2026-09-12T00:00:00.000Z',
    randomBytes: 8,
    bits: 64,
    entropySource: 'crypto.randomBytes',
    idPattern: SYNTHETIC_ID_PATTERN,
    sites: options.sites ?? SYNTHETIC_SITES,
    ...options.patch,
  };
  const path = join(dir, options.fileName ?? `${client}-${version}.json`);
  await writeFile(path, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  return path;
}

/** Sixteen-hex-char ids in the shape the real generator emits, deterministic per index. */
export function syntheticAgentIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `a${(index + 1).toString(16).padStart(16, '0')}`);
}
