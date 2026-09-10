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
// Usage: bun run tests/probes/judge-run.ts <run-dir> <fixtures-dir>
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LifecyclePhase } from '../../src/core/types';
import { extractM3AEvidence, judgeM3A, readRunCapture } from './evidence-m3a';
import type { CapturedPair } from './evidence-m3a';
import { extractLifecycleEvidence, judgeLifecyclePhase, readRunManifest } from './evidence-m10';
import { extractFreshnessEvidence, judgeM10Freshness } from './evidence-freshness';
import type {
  DelegationConsumeRecord,
  DelegationRegisterRecord,
  DelegationReplayRecord,
  FreshnessCapture,
  InstanceFetchRecord,
} from './evidence-freshness';
import { analyzeIdSample, buildEntropyProof, collectAgentIds, judgeM1Sample } from './evidence-m1';
import type { M1SampleReport } from './m1-sample-report';

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
async function buildSingleRunM1Sample(runDir: string): Promise<M1SampleReport> {
  const { ids, perRun } = await collectAgentIds([runDir]);
  const analysis = analyzeIdSample(ids);
  const proof = buildEntropyProof(analysis);
  const verdict = judgeM1Sample(analysis, proof);

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
  };
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
export async function judgeRun(runDir: string, fixturesDir: string): Promise<RunJudgement> {
  const capture = await readRunCapture(runDir);

  const m3aEvidence = await extractM3AEvidence(capture, fixturesDir);
  const pairsTrueCounts = {} as Record<(typeof M3A_PAIR_BOOLEAN_KEYS)[number], number>;
  for (const key of M3A_PAIR_BOOLEAN_KEYS) {
    pairsTrueCounts[key] = m3aEvidence.pairs.filter((pair) => pair[key]).length;
  }

  const runManifest = await readRunManifest(runDir);
  const lifecycleEvidence = extractLifecycleEvidence(capture);
  const lifecycle = {} as Record<LifecyclePhase, { result: string; diagnostic?: string }>;
  for (const phase of LIFECYCLE_PHASES) {
    const judgement = judgeLifecyclePhase(phase, lifecycleEvidence, runManifest);
    lifecycle[phase] = { result: judgement.result, ...(judgement.diagnostic !== undefined ? { diagnostic: judgement.diagnostic } : {}) };
  }
  const freshnessCapture = await readFreshnessCapture(runDir, capture.pairs);
  const freshnessJudgement = judgeM10Freshness(extractFreshnessEvidence(freshnessCapture));

  const m1Sample = await buildSingleRunM1Sample(runDir);

  return {
    runDir,
    m3a: { result: judgeM3A(m3aEvidence), diagnostics: m3aEvidence.diagnostics, pairCount: m3aEvidence.pairs.length, pairsTrueCounts },
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
  const [runDir, fixturesDir] = process.argv.slice(2);
  if (runDir === undefined || fixturesDir === undefined) {
    process.stderr.write('usage: bun run tests/probes/judge-run.ts <run-dir> <fixtures-dir>\n');
    process.exitCode = 2;
  } else {
    judgeRun(runDir, fixturesDir)
      .then((report) => {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      })
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
