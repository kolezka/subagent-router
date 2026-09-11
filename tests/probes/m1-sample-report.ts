// Cheap, hermetic report over already-saved probe run directories. Never spawns a native client
// and never sets RUN_NATIVE_PROBES -- it only reads capture/*.json files some earlier run wrote
// to disk (see collectAgentIds in evidence-m1.ts). Prints the M1 sample analysis as JSON with
// every raw id string omitted: only aggregate counts, the character alphabet inventory, and
// per-position entropy figures are printed, matching the "structural reads only" posture of the
// rest of this directory's probe evidence modules.
//
// Usage: bun run tests/probes/m1-sample-report.ts <run-dir-glob> [<run-dir-glob> ...]
import { analyzeIdSample, buildEntropyProof, collectAgentIds, judgeM1Sample } from './evidence-m1';

function expandGlobs(patterns: readonly string[], cwd: string): string[] {
  const dirs = new Set<string>();
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    for (const match of glob.scanSync({ cwd, onlyFiles: false })) {
      dirs.add(match);
    }
  }
  return [...dirs].sort();
}

export interface M1SampleReport {
  runsMatched: number;
  runIds: string[];
  idsPerRunCount: Record<string, number>;
  sampleCount: number;
  distinctCount: number;
  collisions: number;
  minSampleForClaim: number;
  lengthHistogram: Record<number, number>;
  alphabetSize: number;
  alphabet: string[];
  positionEntropyBits: number[];
  totalEntropyBitsEstimate: number;
  proof: ReturnType<typeof buildEntropyProof>;
  verdict: ReturnType<typeof judgeM1Sample>;
}

/**
 * Expands the given run-dir glob patterns (relative to cwd), reads every matching run's
 * captured agent ids, and returns the M1 sample report. Never returns the raw ids themselves --
 * only idsPerRunCount (a count per run, not the id strings) and the aggregate analysis.
 */
export async function buildM1SampleReport(patterns: readonly string[], cwd: string = process.cwd()): Promise<M1SampleReport> {
  const runDirs = expandGlobs(patterns, cwd);
  const { ids, perRun } = await collectAgentIds(runDirs);
  const analysis = analyzeIdSample(ids);
  const proof = buildEntropyProof(analysis);
  const verdict = judgeM1Sample(analysis, proof);

  const idsPerRunCount: Record<string, number> = {};
  for (const [runId, runIds] of Object.entries(perRun)) idsPerRunCount[runId] = runIds.length;

  return {
    runsMatched: runDirs.length,
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

if (import.meta.main) {
  const patterns = process.argv.slice(2);
  buildM1SampleReport(patterns)
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = 0;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
