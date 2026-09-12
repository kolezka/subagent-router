// Judges one native-claude-handler.ts probe run directory using the REAL production judge code
// in this directory: M3-A (evidence-m3a.ts), per-phase lifecycle (evidence-m10.ts),
// M10-freshness (evidence-freshness.ts), and the M1 statistical id-sample analysis (evidence-m1.ts,
// same functions m1-sample-report.ts's buildM1SampleReport is built from -- see
// buildSingleRunM1Sample below for why this file calls them directly instead of that report's
// glob-based multi-run entry point). Prints one JSON report to stdout.
//
// Never prints the captured native context text, any raw header/body value, or any raw agent id:
// only judged verdicts, static diagnostic strings, and counts. m1Sample already redacts ids (only
// idsPerRunCount, a count, is kept); the m3a/lifecycle/freshness sections here only ever surface
// counts and verdicts, never a per-pair agentId.
//
// M1 is judged from this run's own id sample plus the generator-inspection proof recorded for the
// version the run OBSERVED (tests/fixtures/generator-proofs), whose byte sites are re-checked
// against the binary it cites before any pass is reported.
//
// The 'resume' lifecycle phase is judged the same way, from capture/invocation-boundary.json plus
// the resume-inspection record for the observed version (tests/fixtures/resume-proofs).
//
// Usage: bun run tests/probes/judge-run.ts <run-dir> <fixtures-dir> [<generator-proofs-dir>] [<resume-proofs-dir>]
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LifecyclePhase } from '../../src/core/types';
import { extractM3AEvidence, judgeM3A, readRunCapture } from './evidence-m3a';
import type { CapturedPair } from './evidence-m3a';
import { extractLifecycleEvidence, judgeLifecyclePhase, readInvocationBoundary, readRunManifest } from './evidence-m10';
import { extractFreshnessEvidence, judgeM10Freshness } from './evidence-freshness';
import type {
  DelegationConsumeRecord,
  DelegationRegisterRecord,
  DelegationReplayRecord,
  FreshnessCapture,
  InstanceFetchRecord,
} from './evidence-freshness';
import { analyzeIdSample, collectAgentIds, judgeM1 } from './evidence-m1';
import { loadGeneratorProof, verifyGeneratorProofAgainstBinary } from './generator-proof';
import { loadResumeProof, verifyResumeProofAgainstBinary } from './resume-proof';
import type { M1SampleReport } from './m1-sample-report';
import type { ProbeResult } from '../../src/core/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

const NUMBERED_FILE_RE = /^(\d+)-(.+)\.json$/;

/**
 * Reads the freshness-hook capture files native-claude-handler.ts's PROBE_FRESHNESS_HOOK=production
 * wiring writes (NNN-instance-fetch.json, NNN-delegation-register.json, NNN-delegation-consume.json,
 * NNN-delegation-replay.json) into the in-memory FreshnessCapture shape evidence-freshness.ts's
 * extractFreshnessEvidence expects, and derives firstRoutedRequestSeqByAgent from the already-read
 * RunCapture pairs (the lowest seq at which each agent id appears). None of these files existing at
 * all is not an error: it is exactly the shape of a run that never opted into the production
 * freshness hook, or used the default fake stdin hook.
 */
async function readFreshnessCapture(runDir: string, pairs: readonly CapturedPair[]): Promise<FreshnessCapture> {
  const captureDir = join(runDir, 'capture');
  let entries: string[] = [];
  try {
    entries = await readdir(captureDir);
  } catch {
    entries = [];
  }

  const instanceFetches: InstanceFetchRecord[] = [];
  const delegationRegisters: DelegationRegisterRecord[] = [];
  const delegationConsumes: DelegationConsumeRecord[] = [];
  const delegationReplays: DelegationReplayRecord[] = [];

  for (const entry of entries) {
    const match = NUMBERED_FILE_RE.exec(entry);
    if (match === null) continue;
    const seq = Number(match[1]);
    const kind = match[2];
    let raw: unknown;
    try {
      raw = await readJsonFile(join(captureDir, entry));
    } catch {
      continue;
    }
    if (!isRecord(raw)) continue;

    if (kind === 'instance-fetch') {
      instanceFetches.push({ seq });
    } else if (kind === 'delegation-register') {
      if (typeof raw.agentId === 'string' && typeof raw.role === 'string' && typeof raw.accepted === 'boolean' && typeof raw.nonceHash === 'string') {
        delegationRegisters.push({ seq, agentId: raw.agentId, role: raw.role, accepted: raw.accepted, nonceHash: raw.nonceHash });
      }
    } else if (kind === 'delegation-consume') {
      if (typeof raw.agentId === 'string' && typeof raw.consumed === 'boolean') {
        delegationConsumes.push({ seq, agentId: raw.agentId, consumed: raw.consumed, ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}) });
      }
    } else if (kind === 'delegation-replay') {
      if (typeof raw.agentId === 'string' && typeof raw.rejected === 'boolean') {
        delegationReplays.push({ seq, agentId: raw.agentId, rejected: raw.rejected });
      }
    }
  }

  const firstRoutedRequestSeqByAgent = new Map<string, number>();
  for (const pair of pairs) {
    if (pair.agentId === undefined) continue;
    const existing = firstRoutedRequestSeqByAgent.get(pair.agentId);
    if (existing === undefined || pair.seq < existing) firstRoutedRequestSeqByAgent.set(pair.agentId, pair.seq);
  }

  return { instanceFetches, delegationRegisters, delegationConsumes, delegationReplays, firstRoutedRequestSeqByAgent };
}

/**
 * Builds the same M1SampleReport shape m1-sample-report.ts's buildM1SampleReport produces, but for
 * exactly ONE already-known run directory, via collectAgentIds([runDir]) directly instead of
 * buildM1SampleReport's glob-pattern expansion. That expansion is glob-driven (Bun.Glob) and built
 * for a MULTI-run wildcard pattern; confirmed empirically that `new
 * Bun.Glob(absoluteRunDir).scanSync({ cwd: differentCwd })` matches nothing for a literal path with
 * no wildcard character, so reusing it here for a single exact directory would silently report a
 * zero sample instead of this run's real ids. Never returns a raw id: idsPerRunCount is a count,
 * not the id strings themselves, same redaction as buildM1SampleReport.
 */
async function buildSingleRunM1Sample(runDir: string, observedVersion: string, generatorProofsDir: string): Promise<M1SampleReport> {
  const { ids, perRun } = await collectAgentIds([runDir]);
  const analysis = analyzeIdSample(ids);

  // The proof is looked up by the version the run OBSERVED, never by a version this file picks:
  // a proof for a different build says nothing about the binary that produced these ids. When one
  // exists, its recorded byte sites are re-checked against the binary it cites, this run.
  const generatorProof = await loadGeneratorProof('claude-code', observedVersion, generatorProofsDir);
  const siteVerification = generatorProof === undefined ? undefined : await verifyGeneratorProofAgainstBinary(generatorProof);
  const { proof, ...verdict } = judgeM1({
    analysis,
    ids,
    observedVersion,
    ...(generatorProof !== undefined ? { generatorProof } : {}),
    ...(siteVerification !== undefined ? { siteVerification } : {}),
  });

  const idsPerRunCount: Record<string, number> = {};
  for (const [runId, runIds] of Object.entries(perRun)) idsPerRunCount[runId] = runIds.length;

  return {
    runsMatched: 1,
    runIds: Object.keys(perRun).sort(),
    idsPerRunCount,
    sampleCount: analysis.sampleCount,
    distinctCount: analysis.distinctCount,
    collisions: analysis.collisions,
    minSampleForClaim: analysis.minSampleForClaim,
    lengthHistogram: analysis.lengthHistogram,
    alphabetSize: analysis.alphabet.size,
    alphabet: [...analysis.alphabet].sort(),
    positionEntropyBits: analysis.positionEntropyBits,
    totalEntropyBitsEstimate: analysis.totalEntropyBitsEstimate,
    proof,
    verdict,
  };
}

const LIFECYCLE_PHASES: readonly LifecyclePhase[] = ['next-turn', 'resume', 'compaction', 'nested', 'parallel'];

// Where the generator-inspection proofs live. Overridable per call so tests can point at a
// synthetic proof and a small stand-in binary instead of the real pinned client.
const DEFAULT_GENERATOR_PROOFS_DIR = join(import.meta.dir, '..', 'fixtures', 'generator-proofs');

// Same arrangement for the resume-inspection records the 'resume' lifecycle branch needs.
const DEFAULT_RESUME_PROOFS_DIR = join(import.meta.dir, '..', 'fixtures', 'resume-proofs');

// One boolean field of M3APairEvidence (see evidence-m3a.ts), excluding `seq`/`agentId` -- never
// surfaced per-pair here (that would carry an agentId), only aggregated into a count below.
const M3A_PAIR_BOOLEAN_KEYS = [
  'block0ByteIdentical',
  'block0MatchesScaffold',
  'markerOnBlock1Line1',
  'markerStrippedUpstream',
  'versionMatchesProfile',
  'agentIdMatchesHook',
] as const;

export interface RunJudgement {
  runDir: string;
  m3a: {
    result: ReturnType<typeof judgeM3A>;
    diagnostics: readonly string[];
    pairCount: number;
    // How many of the pairCount pairs have each boolean true -- e.g. { block0ByteIdentical: 2 }
    // with pairCount 2 means every pair passed that one check. Never a raw agentId.
    pairsTrueCounts: Record<(typeof M3A_PAIR_BOOLEAN_KEYS)[number], number>;
    // The run's own declared scaffold paths, verbatim. Static profile field names, never run data.
    declaredScaffoldPaths: readonly string[];
  };
  // The run manifest's own correlation-scaffold declaration. Together with declaredScaffoldPaths
  // this is what a caller passes to writeCapabilityFixture, which refuses a lifecycle pass from a
  // run that scaffolded the correlation gate.
  correlationScaffold: boolean;
  // The judged probe verdicts this run establishes. M1 only: every other probe is judged
  // elsewhere in this report (m3a) or not at all by this file.
  probes: { M1: ProbeResult };
  // The fixture field the correlation gate reads (src/adapters/capabilities.ts). It tracks M1
  // only when a generator-inspection proof drove that verdict; otherwise it stays pending, since
  // a sample-only M1 says nothing about generator entropy.
  correlationEntropy: ProbeResult;
  lifecycle: Record<LifecyclePhase, { result: string; diagnostic?: string }>;
  freshness: {
    result: string;
    diagnostic?: string;
    counts: { instanceFetches: number; delegationRegisters: number; delegationConsumes: number; delegationReplays: number };
  };
  m1Sample: M1SampleReport;
}

/**
 * Judges a single run directory against the real production judge code. Never fabricates a
 * verdict: every field here traces to extractM3AEvidence/judgeM3A, judgeLifecyclePhase,
 * judgeM10Freshness, or buildM1SampleReport, exactly as a human reading this directory's capture/
 * files by hand would conclude.
 */
export async function judgeRun(
  runDir: string,
  fixturesDir: string,
  generatorProofsDir: string = DEFAULT_GENERATOR_PROOFS_DIR,
  resumeProofsDir: string = DEFAULT_RESUME_PROOFS_DIR,
): Promise<RunJudgement> {
  const capture = await readRunCapture(runDir);
  const observedVersion = capture.clientVersionFile ?? 'unknown';

  const m3aEvidence = await extractM3AEvidence(capture, fixturesDir);
  const pairsTrueCounts = {} as Record<(typeof M3A_PAIR_BOOLEAN_KEYS)[number], number>;
  for (const key of M3A_PAIR_BOOLEAN_KEYS) {
    pairsTrueCounts[key] = m3aEvidence.pairs.filter((pair) => pair[key]).length;
  }

  const runManifest = await readRunManifest(runDir);
  const lifecycleEvidence = extractLifecycleEvidence(capture);

  // The 'resume' branch alone needs these. Same rule as the generator proof: the record is looked
  // up by the version the run OBSERVED, and its recorded byte sites are re-checked against the
  // binary it cites, this run, before that record may settle anything.
  const invocationBoundary = await readInvocationBoundary(runDir);
  const resumeProof = await loadResumeProof('claude-code', observedVersion, resumeProofsDir);
  const resumeProofVerification = resumeProof === undefined ? undefined : await verifyResumeProofAgainstBinary(resumeProof);
  const lifecycleOptions = {
    observedVersion,
    ...(invocationBoundary !== undefined ? { invocationBoundary } : {}),
    ...(resumeProof !== undefined ? { resumeProof } : {}),
    ...(resumeProofVerification !== undefined ? { resumeProofVerification } : {}),
  };

  const lifecycle = {} as Record<LifecyclePhase, { result: string; diagnostic?: string }>;
  for (const phase of LIFECYCLE_PHASES) {
    const judgement = judgeLifecyclePhase(phase, lifecycleEvidence, runManifest, lifecycleOptions);
    lifecycle[phase] = { result: judgement.result, ...(judgement.diagnostic !== undefined ? { diagnostic: judgement.diagnostic } : {}) };
  }
  const freshnessCapture = await readFreshnessCapture(runDir, capture.pairs);
  const freshnessJudgement = judgeM10Freshness(extractFreshnessEvidence(freshnessCapture));

  // No client-version file means the run never observed one, so no proof can be matched to it.
  // 'unknown' keeps the missing-proof diagnostic readable rather than naming an empty version.
  const m1Sample = await buildSingleRunM1Sample(runDir, observedVersion, generatorProofsDir);
  const m1Result = m1Sample.verdict.result;
  const proofDroveTheVerdict = m1Sample.proof.source === 'generator-inspection';

  return {
    runDir,
    m3a: {
      result: judgeM3A(m3aEvidence),
      diagnostics: m3aEvidence.diagnostics,
      pairCount: m3aEvidence.pairs.length,
      pairsTrueCounts,
      declaredScaffoldPaths: m3aEvidence.declaredScaffoldPaths,
    },
    correlationScaffold: runManifest?.correlationScaffold ?? false,
    probes: { M1: m1Result },
    correlationEntropy: proofDroveTheVerdict ? m1Result : 'pending',
    lifecycle,
    freshness: {
      result: freshnessJudgement.result,
      ...(freshnessJudgement.diagnostic !== undefined ? { diagnostic: freshnessJudgement.diagnostic } : {}),
      counts: {
        instanceFetches: freshnessCapture.instanceFetches.length,
        delegationRegisters: freshnessCapture.delegationRegisters.length,
        delegationConsumes: freshnessCapture.delegationConsumes.length,
        delegationReplays: freshnessCapture.delegationReplays.length,
      },
    },
    m1Sample,
  };
}

if (import.meta.main) {
  const [runDir, fixturesDir, generatorProofsDir, resumeProofsDir] = process.argv.slice(2);
  if (runDir === undefined || fixturesDir === undefined) {
    process.stderr.write('usage: bun run tests/probes/judge-run.ts <run-dir> <fixtures-dir> [<generator-proofs-dir>] [<resume-proofs-dir>]\n');
    process.exitCode = 2;
  } else {
    judgeRun(runDir, fixturesDir, generatorProofsDir ?? DEFAULT_GENERATOR_PROOFS_DIR, resumeProofsDir ?? DEFAULT_RESUME_PROOFS_DIR)
      .then((report) => {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      })
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
