// M1 (identifier entropy): the statistical-sample analyzer and the M1 judge that composes it
// with a generator-inspection proof. The analyzer describes a sample's observed variety --
// length, alphabet, per-position Shannon entropy -- as a PURE function of the id strings, and
// measures the sample only: it never sees the generator's real source of randomness. That is why
// it can fail M1 but never pass it. judgeM1 at the bottom of this file is the single home of the
// verdict, and it passes only when generator-proof.ts's evidence, re-checked against the client
// binary, backs the sample. Nothing here reads or forwards the captured native context text.
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { EntropyProof } from './run';
import type { GeneratorProof, GeneratorProofSiteVerification } from './generator-proof';
import type { ProbeResult } from '../../src/core/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readJsonFile(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  return JSON.parse(text);
}

// Matches both handler-mode NNN-pre-handler.json and delegate-mode NNN-child.json capture
// files (see readRunCapture in evidence-m3a.ts and native-claude-gateway.mjs's record()
// helper): both are the same { url, headers, body } shape. Never post-handler-upstream.json --
// its x-claude-code-agent-id is always the same value as its paired pre-handler request, so
// reading it too would only double-count, never add a new id to the sample.
const HEADER_CAPTURE_RE = /^\d+-(pre-handler|child)\.json$/;
const HOOK_CAPTURE_RE = /^hook-subagentstart-.*\.json$/;
const AGENT_ID_HEADER = 'x-claude-code-agent-id';

export interface CollectedAgentIds {
  ids: string[];
  perRun: Record<string, string[]>;
}

/**
 * Reads x-claude-code-agent-id off every header-carrying capture file and agent_id off every
 * SubagentStart hook record, for each run directory given. Structural reads only: a file name
 * pattern and a couple of top-level fields, never the request body's captured native context.
 *
 * Ids are deduped WITHIN each run (a pre/post pair, or multiple turns from the same child,
 * repeat the same id and must not inflate the sample). Ids are NOT deduped ACROSS runs: the
 * same id reappearing in two independently-started runs is itself a collision analyzeIdSample
 * must be able to see, not noise to hide.
 *
 * A run directory with no capture/ subdirectory, or with capture files that fail to parse,
 * contributes an empty id list rather than throwing -- this is a best-effort survey over
 * however many real saved runs happen to exist, not a strict-mode reader.
 */
export async function collectAgentIds(runDirs: readonly string[]): Promise<CollectedAgentIds> {
  const ids: string[] = [];
  const perRun: Record<string, string[]> = {};

  for (const runDir of runDirs) {
    const runId = basename(runDir);
    const seenInRun = new Set<string>();
    const captureDir = join(runDir, 'capture');

    let entries: string[];
    try {
      entries = await readdir(captureDir);
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (HEADER_CAPTURE_RE.test(entry)) {
        let raw: unknown;
        try {
          raw = await readJsonFile(join(captureDir, entry));
        } catch {
          continue;
        }
        if (!isRecord(raw) || !isRecord(raw.headers)) continue;
        const agentId = raw.headers[AGENT_ID_HEADER];
        if (typeof agentId === 'string' && agentId.length > 0) seenInRun.add(agentId);
      } else if (HOOK_CAPTURE_RE.test(entry)) {
        let raw: unknown;
        try {
          raw = await readJsonFile(join(captureDir, entry));
        } catch {
          continue;
        }
        if (!isRecord(raw)) continue;
        // hook_event_name is only checked when present, matching readRunCapture's tolerance;
        // the filename pattern itself already restricts this branch to SubagentStart records.
        if (raw.hook_event_name !== undefined && raw.hook_event_name !== 'SubagentStart') continue;
        const agentId = raw.agent_id;
        if (typeof agentId === 'string' && agentId.length > 0) seenInRun.add(agentId);
      }
    }

    const runIds = [...seenInRun];
    perRun[runId] = [...(perRun[runId] ?? []), ...runIds];
    ids.push(...runIds);
  }

  return { ids, perRun };
}

// ---------- sample analysis ----------

export interface IdSampleAnalysis {
  sampleCount: number;
  distinctCount: number;
  lengthHistogram: Record<number, number>;
  alphabet: Set<string>;
  positionEntropyBits: number[];
  totalEntropyBitsEstimate: number;
  collisions: number;
  minSampleForClaim: number;
}

const MIN_SAMPLE_FOR_CLAIM = 100;

function log2(value: number): number {
  return Math.log(value) / Math.LN2;
}

function shannonEntropyBits(counts: readonly number[], total: number): number {
  let bits = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const p = count / total;
    bits -= p * log2(p);
  }
  return bits;
}

/**
 * Pure, deterministic statistical description of a sample of ids: how many, how many distinct,
 * their length distribution, the character alphabet they draw from, per-position Shannon
 * entropy computed over the modal (most common) length, and a total-entropy ESTIMATE that is
 * the sum of those per-position figures capped by the information-theoretic ceiling for that
 * alphabet and length (length * log2(alphabetSize)) -- a defensive bound, since per-position
 * entropy can never legitimately exceed it, but floating-point summation could otherwise nudge
 * the raw sum a hair past it.
 *
 * This measures observed variety in the given sample only. It has no access to the generator
 * that produced the ids, so it can never be read as proof of the generator's real entropy
 * source -- see buildEntropyProof, judgeM1Sample and judgeM1 below.
 */
export function analyzeIdSample(ids: readonly string[]): IdSampleAnalysis {
  const sampleCount = ids.length;
  const distinctCount = new Set(ids).size;
  const collisions = sampleCount - distinctCount;

  const lengthHistogram: Record<number, number> = {};
  const alphabet = new Set<string>();
  for (const id of ids) {
    lengthHistogram[id.length] = (lengthHistogram[id.length] ?? 0) + 1;
    for (const ch of id) alphabet.add(ch);
  }

  // Per-position entropy needs a single shared length; ids of any other length still count in
  // lengthHistogram and collisions, but are excluded from this calculation so a handful of
  // odd-length outliers cannot collapse it to nothing. Ties are broken by ascending length,
  // since integer-keyed object iteration order is spec-guaranteed ascending -- deterministic.
  let modalLength = 0;
  let modalLengthCount = -1;
  for (const [lengthKey, count] of Object.entries(lengthHistogram)) {
    if (count > modalLengthCount) {
      modalLengthCount = count;
      modalLength = Number(lengthKey);
    }
  }

  const idsAtModalLength = ids.filter((id) => id.length === modalLength);
  const positionEntropyBits: number[] = [];
  for (let position = 0; position < modalLength; position += 1) {
    const charCounts = new Map<string, number>();
    for (const id of idsAtModalLength) {
      const ch = id[position] as string;
      charCounts.set(ch, (charCounts.get(ch) ?? 0) + 1);
    }
    positionEntropyBits.push(shannonEntropyBits([...charCounts.values()], idsAtModalLength.length));
  }

  const summedEntropyBits = positionEntropyBits.reduce((sum, bits) => sum + bits, 0);
  const alphabetSize = alphabet.size;
  const entropyCeiling = alphabetSize > 1 && modalLength > 0 ? modalLength * log2(alphabetSize) : 0;
  const totalEntropyBitsEstimate = Math.min(summedEntropyBits, entropyCeiling);

  return {
    sampleCount,
    distinctCount,
    lengthHistogram,
    alphabet,
    positionEntropyBits,
    totalEntropyBitsEstimate,
    collisions,
    minSampleForClaim: MIN_SAMPLE_FOR_CLAIM,
  };
}

// ---------- proof + judge ----------

export type SampleEntropyProof = EntropyProof & {
  source: 'statistical-sample';
  distinctCount: number;
  totalEntropyBitsEstimate: number;
  generatorInspected: false;
  limitation: string;
};

/**
 * Turns an IdSampleAnalysis into the EntropyProof shape judgeM1 below accepts, honestly
 * labeled as sample-based and NOT generator-inspected. generatorInspected is hardcoded false
 * here on purpose: no analysis over the sample alone can ever establish it, only a separate,
 * out-of-band review of the id generator's implementation can.
 */
export function buildEntropyProof(analysis: IdSampleAnalysis): SampleEntropyProof {
  return {
    source: 'statistical-sample',
    sampleCount: analysis.sampleCount,
    distinctCount: analysis.distinctCount,
    totalEntropyBitsEstimate: analysis.totalEntropyBitsEstimate,
    generatorInspected: false,
    limitation: 'sample-based-variety-is-not-generator-proof',
  };
}

export interface M1SampleVerdict {
  // This was `Exclude<ProbeResult, 'passed'>`. While a statistical sample was M1's only evidence,
  // no combination of inputs could produce a pass and the type said so at compile time. judgeM1
  // below returns this same shape and now CAN pass, backed by a generator-inspection proof bound
  // to the client binary, so the exclusion had to go. judgeM1Sample itself still has no 'passed'
  // branch -- that is now a runtime invariant a test locks, not a type-level one.
  result: ProbeResult;
  diagnostic: string;
}

/**
 * Judges a statistical id sample. 'failed' when the sample directly contradicts the M1 claim:
 * any collision (the same id observed twice, which real per-child ids must never do), or a
 * sample large enough to trust (>= minSampleForClaim) whose measured entropy is still under the
 * required 64 bits -- a large, collision-free sample that still looks low-entropy means the id
 * FORMAT itself cannot satisfy the requirement, not merely that this sample got unlucky.
 * 'pending' otherwise, naming the still-missing generator proof and the sample size actually
 * measured. Never 'passed': variety in a sample is never generator-entropy proof.
 */
export function judgeM1Sample(analysis: IdSampleAnalysis, proof: EntropyProof): M1SampleVerdict {
  if (analysis.collisions > 0) {
    return {
      result: 'failed',
      diagnostic: `m1-sample-collision: ${analysis.collisions} of ${analysis.sampleCount} sampled ids repeat a value already seen`,
    };
  }
  // Redundant with collisions > 0 above (collisions is defined as sampleCount - distinctCount),
  // kept as an explicit, independent self-consistency check rather than trusting the derived
  // collisions field alone.
  if (analysis.distinctCount < analysis.sampleCount) {
    return {
      result: 'failed',
      diagnostic: `m1-sample-distinct-count-mismatch: distinctCount ${analysis.distinctCount} < sampleCount ${analysis.sampleCount}`,
    };
  }
  if (analysis.totalEntropyBitsEstimate < 64 && analysis.sampleCount >= analysis.minSampleForClaim) {
    return {
      result: 'failed',
      diagnostic: `m1-sample-low-entropy-at-scale: ${analysis.sampleCount} distinct ids (>= minimum ${analysis.minSampleForClaim}) still estimate only ${analysis.totalEntropyBitsEstimate.toFixed(2)} bits of entropy, under the required 64`,
    };
  }
  return {
    result: 'pending',
    diagnostic:
      `m1-sample-pending: ${analysis.sampleCount} sampled ids, ${analysis.distinctCount} distinct, ` +
      `~${analysis.totalEntropyBitsEstimate.toFixed(2)} bits estimated (proof.generatorInspected=${String(proof.generatorInspected)}); ` +
      'no separate generator-entropy proof exists yet -- sample variety alone can never certify M1',
  };
}

// ---------- generator-inspection proof + the M1 judge ----------

export type GeneratorEntropyProof = EntropyProof & {
  source: 'generator-inspection';
  distinctCount: number;
  totalEntropyBitsEstimate: number;
  generatorInspected: true;
  bits: number;
  version: string;
  // 'n/m': how many of the proof's recorded byte sites still matched the cited binary this run.
  sitesVerified: string;
};

export type M1EntropyProof = SampleEntropyProof | GeneratorEntropyProof;

/**
 * The proof M1 can actually be certified from: the generator's own bit count and entropy source,
 * read out of a pinned binary and re-checked against its bytes this run, with the sample's own
 * measurements kept alongside rather than replaced. generatorInspected is true here because a
 * human really did inspect the generator, which is exactly what buildEntropyProof cannot claim.
 */
export function buildGeneratorEntropyProof(
  analysis: IdSampleAnalysis,
  proof: GeneratorProof,
  verification: GeneratorProofSiteVerification,
): GeneratorEntropyProof {
  return {
    source: 'generator-inspection',
    sampleCount: analysis.sampleCount,
    distinctCount: analysis.distinctCount,
    totalEntropyBitsEstimate: analysis.totalEntropyBitsEstimate,
    generatorInspected: true,
    bits: proof.bits,
    version: proof.version,
    sitesVerified: `${verification.sitesVerified}/${verification.sitesTotal}`,
  };
}

export interface JudgeM1Input {
  analysis: IdSampleAnalysis;
  // The same ids the analysis was built from, needed for the id-shape check the analysis does
  // not do (it measures variety per position, not conformance to a declared format).
  ids: readonly string[];
  // The client version the run actually observed (capture/client-version), so a missing proof
  // can name the version nobody has inspected yet.
  observedVersion: string;
  generatorProof?: GeneratorProof;
  siteVerification?: GeneratorProofSiteVerification;
}

export interface M1Verdict extends M1SampleVerdict {
  proof: M1EntropyProof;
}

const REQUIRED_ENTROPY_BITS = 64;
const MIN_SAMPLE_FOR_PASS = 2;

/**
 * The single home of the M1 verdict. Everything a pass needs, in order:
 *
 *  1. the sample must not contradict the claim (no collision, distinctCount === sampleCount, and
 *     no large sample whose format is provably under 64 bits) -- else 'failed';
 *  2. a generator-inspection proof must exist for the version this run observed;
 *  3. every sampled id must match that proof's declared id shape;
 *  4. the proof's recorded byte sites must still match the binary it cites, checked this run;
 *  5. the generator must draw at least 64 bits, and the sample must hold at least two ids.
 *
 * Anything short of all five is 'pending' with a diagnostic naming what is missing. A sample can
 * still 'fail' M1 on its own; it can never pass it on its own. run.ts used to carry a second
 * judgeM1 over capture-gateway aggregate counts; it was removed when this one landed, so there
 * is one M1 judge rather than two that could disagree.
 */
export function judgeM1(input: JudgeM1Input): M1Verdict {
  const { analysis, ids, observedVersion, generatorProof, siteVerification } = input;

  const sampleProof = buildEntropyProof(analysis);
  const sampleVerdict = judgeM1Sample(analysis, sampleProof);
  if (sampleVerdict.result === 'failed') return { ...sampleVerdict, proof: sampleProof };

  if (generatorProof === undefined) {
    return {
      result: 'pending',
      diagnostic:
        `m1-no-generator-proof-for-${observedVersion}: no generator-inspection record exists for this client version, ` +
        `so ${analysis.sampleCount} sampled ids show variety only`,
      proof: sampleProof,
    };
  }

  const idShape = new RegExp(generatorProof.idPattern);
  const offShapeCount = ids.filter((id) => !idShape.test(id)).length;
  if (offShapeCount > 0) {
    return {
      result: 'pending',
      diagnostic:
        `m1-id-shape-mismatch: ${offShapeCount} of ${ids.length} sampled ids do not match the proof id pattern ` +
        `${generatorProof.idPattern}, so the proof does not describe the ids this run actually saw`,
      proof: sampleProof,
    };
  }

  if (siteVerification === undefined || !siteVerification.binaryPresent) {
    return {
      result: 'pending',
      diagnostic:
        'm1-proof-binary-absent: the binary this proof cites could not be read this run, so its ' +
        `${generatorProof.sites.length} recorded sites stay unverified and the proof is a version string only`,
      proof: sampleProof,
    };
  }
  if (siteVerification.mismatchedSites.length > 0) {
    return {
      result: 'pending',
      diagnostic:
        `m1-proof-site-mismatch:${siteVerification.mismatchedSites.join(',')} -- the recorded bytes are not at those ` +
        'offsets in the cited binary, so this proof does not describe the binary this run used',
      proof: sampleProof,
    };
  }

  // Past this point the proof is bound to real bytes, so it is the honest proof to report even
  // for the two remaining pending outcomes below.
  const verifiedProof = buildGeneratorEntropyProof(analysis, generatorProof, siteVerification);

  if (generatorProof.bits < REQUIRED_ENTROPY_BITS) {
    return {
      result: 'pending',
      diagnostic: `m1-generator-proof-under-64-bits: the inspected generator draws ${generatorProof.bits} bits from ${generatorProof.entropySource}, under the required ${REQUIRED_ENTROPY_BITS}`,
      proof: verifiedProof,
    };
  }
  if (analysis.sampleCount < MIN_SAMPLE_FOR_PASS) {
    return {
      result: 'pending',
      diagnostic: `m1-sample-too-small: ${analysis.sampleCount} sampled id(s), under the ${MIN_SAMPLE_FOR_PASS} a distinctness claim needs`,
      proof: verifiedProof,
    };
  }

  return {
    result: 'passed',
    diagnostic:
      `m1-passed: ${analysis.sampleCount} distinct ids all matching ${generatorProof.idPattern}, generated from ` +
      `${generatorProof.bits} bits of ${generatorProof.entropySource} per the ${generatorProof.method}-verified proof for ` +
      `${generatorProof.version} (${verifiedProof.sitesVerified} sites re-checked against the cited binary this run)`,
    proof: verifiedProof,
  };
}
