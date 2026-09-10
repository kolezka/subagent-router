import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeIdSample, buildEntropyProof, collectAgentIds, judgeM1Sample } from './evidence-m1';
import type { IdSampleAnalysis } from './evidence-m1';
import { judgeM1, summarizeEvidence } from './run';
import type { CapturedRequest } from '../support/capture-gateway';
import { writeSyntheticRunCapture } from '../support/native-run-capture';

function capturedRequest(patch: Partial<CapturedRequest>): CapturedRequest {
  return { method: 'POST', path: '/v1/messages', headers: {}, rawRequestBody: new Uint8Array(), body: {}, ...patch };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// Hand-built delegate-mode child capture: same { url, headers, body } shape native-claude-run.sh
// produces via native-claude-gateway.mjs's record('child', ...) helper, filed as NNN-child.json.
async function writeDelegateChildCapture(captureDir: string, seq: number, agentId: string): Promise<void> {
  await writeJson(join(captureDir, `${String(seq).padStart(3, '0')}-child.json`), {
    url: '/v1/messages',
    headers: { 'user-agent': 'claude-cli/2.1.266 (external, sdk-cli)', 'x-claude-code-agent-id': agentId },
    body: { model: 'probe-parent-model', messages: [] },
  });
}

async function writeHookRecord(captureDir: string, pid: number, agentId: string, agentType = 'native-probe-alpha'): Promise<void> {
  await writeJson(join(captureDir, `hook-subagentstart-${pid}.json`), {
    session_id: 'synthetic-session',
    transcript_path: '/tmp/synthetic/synthetic.jsonl',
    cwd: '/tmp/synthetic/work',
    prompt_id: 'synthetic-prompt',
    agent_id: agentId,
    agent_type: agentType,
    hook_event_name: 'SubagentStart',
  });
}

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-m1-evidence-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('collectAgentIds', () => {
  test('collects-ids-from-handler-and-delegate-run-shapes', async () => {
    const handlerRunDir = join(dir, 'handler-run');
    await writeSyntheticRunCapture(handlerRunDir); // default agentId 'agent-synthetic-1', with a matching hook record

    const delegateRunDir = join(dir, 'delegate-run');
    const delegateCaptureDir = join(delegateRunDir, 'capture');
    await mkdir(delegateCaptureDir, { recursive: true });
    await writeDelegateChildCapture(delegateCaptureDir, 3, 'agent-delegate-a');
    await writeDelegateChildCapture(delegateCaptureDir, 4, 'agent-delegate-b');
    await writeHookRecord(delegateCaptureDir, 1, 'agent-delegate-a');
    await writeHookRecord(delegateCaptureDir, 2, 'agent-delegate-b');

    const { ids, perRun } = await collectAgentIds([handlerRunDir, delegateRunDir]);

    expect(ids.slice().sort()).toEqual(['agent-delegate-a', 'agent-delegate-b', 'agent-synthetic-1'].sort());
    expect(perRun['handler-run']).toEqual(['agent-synthetic-1']);
    expect(perRun['delegate-run']?.slice().sort()).toEqual(['agent-delegate-a', 'agent-delegate-b']);
  });

  test('dedupes-repeated-id-within-one-run-but-not-across-runs', async () => {
    // Same agent id appearing in both the pre-handler and hook record of one run must count
    // once for that run; the SAME id string reappearing in a second, independent run must NOT
    // be silently collapsed away -- that repetition is itself a fact analyzeIdSample needs.
    const runA = join(dir, 'run-a');
    await writeSyntheticRunCapture(runA, { agentId: 'agent-shared' });
    const runB = join(dir, 'run-b');
    await writeSyntheticRunCapture(runB, { agentId: 'agent-shared' });

    const { ids, perRun } = await collectAgentIds([runA, runB]);
    expect(perRun['run-a']).toEqual(['agent-shared']);
    expect(perRun['run-b']).toEqual(['agent-shared']);
    expect(ids).toEqual(['agent-shared', 'agent-shared']);
  });

  test('run-dir-with-no-capture-directory-contributes-no-ids', async () => {
    const emptyRunDir = join(dir, 'no-capture-here');
    await mkdir(emptyRunDir, { recursive: true });
    const { ids, perRun } = await collectAgentIds([emptyRunDir]);
    expect(ids).toEqual([]);
    expect(perRun['no-capture-here']).toEqual([]);
  });

  test('collects-agent-id-from-a-header-capture-with-no-hook-record-at-all', async () => {
    // Isolates the header-reading path: no hook-subagentstart file exists in this run at all,
    // so the id can only come from the child capture's x-claude-code-agent-id header.
    const runDir = join(dir, 'header-only-run');
    const captureDir = join(runDir, 'capture');
    await mkdir(captureDir, { recursive: true });
    await writeDelegateChildCapture(captureDir, 3, 'agent-header-only');
    const { ids, perRun } = await collectAgentIds([runDir]);
    expect(ids).toEqual(['agent-header-only']);
    expect(perRun['header-only-run']).toEqual(['agent-header-only']);
  });

  test('collects-agent-id-from-a-hook-record-with-no-header-capture-at-all', async () => {
    // Isolates the hook-reading path: no pre-handler/child capture file exists in this run at
    // all, so the id can only come from the SubagentStart hook record's agent_id field.
    const runDir = join(dir, 'hook-only-run');
    const captureDir = join(runDir, 'capture');
    await mkdir(captureDir, { recursive: true });
    await writeHookRecord(captureDir, 1, 'agent-hook-only');
    const { ids, perRun } = await collectAgentIds([runDir]);
    expect(ids).toEqual(['agent-hook-only']);
    expect(perRun['hook-only-run']).toEqual(['agent-hook-only']);
  });

  test('never-reads-post-handler-upstream-agent-id-separately-from-its-pre-handler-pair', async () => {
    // writeSyntheticRunCapture writes one pre-handler + one post-handler-upstream file sharing
    // the same agent id; only the pre-handler contributes, so the run yields exactly one id,
    // not two, even though two header-carrying files exist on disk.
    const runDir = join(dir, 'pair-run');
    await writeSyntheticRunCapture(runDir, { agentId: 'agent-pair' });
    const { perRun } = await collectAgentIds([runDir]);
    expect(perRun['pair-run']).toEqual(['agent-pair']);
  });
});

describe('analyzeIdSample', () => {
  // All 8 length-3 strings over {a,b} in binary-counting order: every position is exactly
  // 4-a/4-b, so each position's Shannon entropy is exactly 1 bit and the 3-bit sum exactly
  // equals the 2-symbol, length-3 ceiling (3 * log2(2) = 3) -- a hand-verifiable case.
  const BALANCED_BINARY_IDS = ['aaa', 'aab', 'aba', 'abb', 'baa', 'bab', 'bba', 'bbb'];

  test('analysis-is-deterministic-and-caps-entropy-by-alphabet', () => {
    const first = analyzeIdSample(BALANCED_BINARY_IDS);
    const second = analyzeIdSample(BALANCED_BINARY_IDS);

    // Determinism: every field matches across two independent calls on the same input.
    expect(first.sampleCount).toBe(second.sampleCount);
    expect(first.distinctCount).toBe(second.distinctCount);
    expect(first.lengthHistogram).toEqual(second.lengthHistogram);
    expect([...first.alphabet].sort()).toEqual([...second.alphabet].sort());
    expect(first.positionEntropyBits).toEqual(second.positionEntropyBits);
    expect(first.totalEntropyBitsEstimate).toBe(second.totalEntropyBitsEstimate);
    expect(first.collisions).toBe(second.collisions);

    expect(first.sampleCount).toBe(8);
    expect(first.distinctCount).toBe(8);
    expect(first.collisions).toBe(0);
    expect(first.lengthHistogram).toEqual({ 3: 8 });
    expect([...first.alphabet].sort()).toEqual(['a', 'b']);
    expect(first.positionEntropyBits).toHaveLength(3);
    for (const bits of first.positionEntropyBits) expect(bits).toBeCloseTo(1, 10);

    // Cap invariant: the total can never exceed length * log2(alphabetSize), the
    // information-theoretic ceiling for this alphabet and length -- here it lands exactly on
    // the ceiling (3 * log2(2) = 3), the tightest case the cap ever needs to hold.
    const ceiling = first.positionEntropyBits.length * Math.log2(first.alphabet.size);
    expect(first.totalEntropyBitsEstimate).toBeLessThanOrEqual(ceiling + 1e-9);
    expect(first.totalEntropyBitsEstimate).toBeCloseTo(3, 9);
  });

  test('caps-entropy-invariant-holds-across-an-unbalanced-alphabet-too', () => {
    // A three-symbol alphabet with an uneven split at every position (not a clean power of
    // two) -- still must never exceed length * log2(alphabetSize).
    const ids = ['xxy', 'xyx', 'yxx', 'xyy', 'yxy', 'yyx', 'zzz', 'xxz', 'yyz', 'zzy'];
    const analysis = analyzeIdSample(ids);
    const ceiling = analysis.positionEntropyBits.length * Math.log2(analysis.alphabet.size);
    expect(analysis.totalEntropyBitsEstimate).toBeLessThanOrEqual(ceiling + 1e-9);
  });

  test('empty-sample-analyzes-to-all-zero-fields-without-throwing', () => {
    const analysis = analyzeIdSample([]);
    expect(analysis).toEqual({
      sampleCount: 0,
      distinctCount: 0,
      lengthHistogram: {},
      alphabet: new Set(),
      positionEntropyBits: [],
      totalEntropyBitsEstimate: 0,
      collisions: 0,
      minSampleForClaim: 100,
    });
  });

  test('mixed-length-ids-use-the-modal-length-for-position-entropy-but-still-count-in-the-histogram', () => {
    const ids = ['aa', 'ab', 'ba', 'bb', 'ccccccccc']; // four length-2, one length-9 outlier
    const analysis = analyzeIdSample(ids);
    expect(analysis.lengthHistogram).toEqual({ 2: 4, 9: 1 });
    expect(analysis.positionEntropyBits).toHaveLength(2); // modal length is 2, not 9
    expect(analysis.sampleCount).toBe(5);
    expect(analysis.distinctCount).toBe(5);
    expect(analysis.collisions).toBe(0);
  });
});

describe('buildEntropyProof', () => {
  test('always-declares-source-statistical-sample-and-generator-not-inspected', () => {
    const analysis = analyzeIdSample(['abc', 'def', 'ghi']);
    const proof = buildEntropyProof(analysis);
    expect(proof.source).toBe('statistical-sample');
    expect(proof.sampleCount).toBe(3);
    expect(proof.distinctCount).toBe(3);
    expect(proof.generatorInspected).toBe(false);
    expect(proof.limitation).toBe('sample-based-variety-is-not-generator-proof');
  });
});

describe('judgeM1Sample', () => {
  test('fails-on-collision', () => {
    const analysis = analyzeIdSample(['agent-shared', 'agent-shared', 'agent-other']);
    expect(analysis.collisions).toBe(1);
    const verdict = judgeM1Sample(analysis, buildEntropyProof(analysis));
    expect(verdict.result).toBe('failed');
    expect(verdict.diagnostic).toContain('collision');
  });

  test('fails-on-large-low-entropy-sample', () => {
    // 100 distinct 2-digit ids drawn from a 10-symbol alphabet: sampleCount (100) meets
    // minSampleForClaim, distinctCount equals sampleCount (no collisions), but the id FORMAT
    // itself can only carry ~6.6 bits -- nowhere near the required 64, so this fails even
    // though the sample is clean and large.
    const ids = Array.from({ length: 100 }, (_, i) => String(i).padStart(2, '0'));
    const analysis = analyzeIdSample(ids);
    expect(analysis.sampleCount).toBe(100);
    expect(analysis.distinctCount).toBe(100);
    expect(analysis.collisions).toBe(0);
    expect(analysis.totalEntropyBitsEstimate).toBeLessThan(64);

    const verdict = judgeM1Sample(analysis, buildEntropyProof(analysis));
    expect(verdict.result).toBe('failed');
    expect(verdict.diagnostic).toContain('low-entropy-at-scale');
  });

  test('pending-on-small-clean-sample-with-generator-not-inspected', () => {
    // Only 10 ids: below minSampleForClaim (100), so a large-sample low-entropy verdict never
    // fires regardless of how low the measured entropy actually is. No collisions either.
    const ids = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8', 'i9', 'j0'];
    const analysis = analyzeIdSample(ids);
    expect(analysis.sampleCount).toBe(10);
    expect(analysis.collisions).toBe(0);

    const proof = buildEntropyProof(analysis);
    expect(proof.generatorInspected).toBe(false);
    const verdict = judgeM1Sample(analysis, proof);
    expect(verdict.result).toBe('pending');
    expect(verdict.diagnostic).toContain('generator');
    expect(verdict.diagnostic).toContain('10');
  });

  test('never-passes-from-sample-alone', () => {
    // Hand-built "best possible" analysis: a huge, collision-free sample with an entropy
    // estimate well over 64 bits. Even here judgeM1Sample has no branch that returns 'passed'
    // -- sample variety, however large and clean, is never generator-entropy proof.
    const bestCaseAnalysis: IdSampleAnalysis = {
      sampleCount: 1000,
      distinctCount: 1000,
      lengthHistogram: { 32: 1000 },
      alphabet: new Set('0123456789abcdef'),
      positionEntropyBits: Array.from({ length: 32 }, () => 4),
      totalEntropyBitsEstimate: 128,
      collisions: 0,
      minSampleForClaim: 100,
    };
    const honestProof = buildEntropyProof(bestCaseAnalysis);
    expect(judgeM1Sample(bestCaseAnalysis, honestProof).result).not.toBe('passed');
    expect(judgeM1Sample(bestCaseAnalysis, honestProof).result).toBe('pending');

    // Even a proof that (incorrectly) claims the generator WAS inspected changes nothing:
    // judgeM1Sample only ever looks at the sample's own math, never trusts that claim.
    const claimsInspected = { ...honestProof, generatorInspected: true as const };
    expect(judgeM1Sample(bestCaseAnalysis, claimsInspected).result).not.toBe('passed');
  });
});

describe('judgeM1 (run.ts) rejects an uninspected-generator sample proof', () => {
  test('judge-m1-rejects-uninspected-generator-proof', () => {
    const evidence = summarizeEvidence([capturedRequest({ agentId: 'agent-1', isChild: true })]);
    expect(evidence.distinctAgentIds).toBe(1);

    const analysis = analyzeIdSample(['agent-1']);
    const proof = buildEntropyProof(analysis);
    expect(proof.sampleCount).toBeGreaterThanOrEqual(evidence.distinctAgentIds); // would not hit the 'failed' branch
    expect(proof.generatorInspected).toBe(false);

    // Locks the intent: a sample-based proof, however internally consistent with the observed
    // evidence, can never move M1 past 'pending' while it declares the generator uninspected.
    expect(judgeM1(evidence, proof)).toBe('pending');
    expect(judgeM1(evidence, proof)).not.toBe('passed');
  });
});
