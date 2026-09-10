// Hermetic tests for evidence-m10.ts's lifecycle judge. Builds a synthetic RunCapture/pairs
// shape directly (never reads a real run directory off disk) so 'parallel' and 'next-turn' can
// be judged in isolation from the real native-claude-run.sh pipeline. This file did not exist
// before: judgeLifecyclePhase had zero direct test coverage until now.
import { describe, expect, test } from 'bun:test';
import { extractLifecycleEvidence, judgeLifecyclePhase } from './evidence-m10';
import type { RunManifest } from './evidence-m10';
import type { CapturedPair, RunCapture } from './evidence-m3a';

function pair(seq: number, agentId: string, upstreamModel: string): CapturedPair {
  return {
    seq,
    agentId,
    pre: { url: '/v1/messages', headers: { 'x-claude-code-agent-id': agentId }, body: { model: 'probe-parent-model' } },
    post: { url: '/v1/messages', headers: { 'x-claude-code-agent-id': agentId }, body: { model: upstreamModel } },
  };
}

function runCapture(pairs: readonly CapturedPair[]): RunCapture {
  return { runDir: '/synthetic', profileRaw: {}, pairs, hookAgentIds: new Set() };
}

// Two agents, two requests each, genuinely interleaved by seq (A, B, A, B rather than A, A, B,
// B): agent-alpha at seq 1 and 3, agent-beta at seq 2 and 4, each forwarded to its own stable
// upstream model on both requests.
const TWO_AGENTS_TWO_REQUESTS_INTERLEAVED: readonly CapturedPair[] = [
  pair(1, 'agent-alpha', 'gateway/fast-worker'),
  pair(2, 'agent-beta', 'gateway/smart-worker'),
  pair(3, 'agent-alpha', 'gateway/fast-worker'),
  pair(4, 'agent-beta', 'gateway/smart-worker'),
];

function manifest(mode: string, phasesExercised: readonly string[]): RunManifest {
  return { mode, phasesExercised, freshnessHook: 'fake' };
}

describe('judgeLifecyclePhase: parallel', () => {
  test('passes when two agents have interleaved sequence numbers and no drift', () => {
    const evidence = extractLifecycleEvidence(runCapture(TWO_AGENTS_TWO_REQUESTS_INTERLEAVED));
    const judgement = judgeLifecyclePhase('parallel', evidence, manifest('next-turn', ['parallel']));
    expect(judgement.result).toBe('passed');
  });

  test('stays pending on a pure block pattern (all of A, then all of B) even with two agents', () => {
    const blockPattern: readonly CapturedPair[] = [
      pair(1, 'agent-alpha', 'gateway/fast-worker'),
      pair(2, 'agent-alpha', 'gateway/fast-worker'),
      pair(3, 'agent-beta', 'gateway/smart-worker'),
      pair(4, 'agent-beta', 'gateway/smart-worker'),
    ];
    const evidence = extractLifecycleEvidence(runCapture(blockPattern));
    const judgement = judgeLifecyclePhase('parallel', evidence, manifest('next-turn', ['parallel']));
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toBe('parallel-requires-interleaved-sequence-numbers');
  });

  test('stays pending when the run never declares parallel as exercised, however the evidence looks', () => {
    const evidence = extractLifecycleEvidence(runCapture(TWO_AGENTS_TWO_REQUESTS_INTERLEAVED));
    const judgement = judgeLifecyclePhase('parallel', evidence, manifest('next-turn', []));
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toBe('parallel-not-declared: the run manifest does not declare parallel as an exercised phase');
  });

  test('fails on upstream model drift within one agent, even with interleaved sequence numbers', () => {
    const drifted: readonly CapturedPair[] = [
      pair(1, 'agent-alpha', 'gateway/fast-worker'),
      pair(2, 'agent-beta', 'gateway/smart-worker'),
      pair(3, 'agent-alpha', 'gateway/DIFFERENT-worker'), // same agent, different upstream model
      pair(4, 'agent-beta', 'gateway/smart-worker'),
    ];
    const evidence = extractLifecycleEvidence(runCapture(drifted));
    const judgement = judgeLifecyclePhase('parallel', evidence, manifest('next-turn', ['parallel']));
    expect(judgement.result).toBe('failed');
  });
});

describe('judgeLifecyclePhase: next-turn', () => {
  test('passes under mode next-turn when an agent has two forwarded requests', () => {
    const evidence = extractLifecycleEvidence(runCapture(TWO_AGENTS_TWO_REQUESTS_INTERLEAVED));
    const judgement = judgeLifecyclePhase('next-turn', evidence, manifest('next-turn', ['parallel', 'next-turn']));
    expect(judgement.result).toBe('passed');
  });

  test('stays pending under mode handler with the exact same evidence -- mode is the only thing distinguishing next-turn from an ordinary multi-turn request', () => {
    const evidence = extractLifecycleEvidence(runCapture(TWO_AGENTS_TWO_REQUESTS_INTERLEAVED));
    const judgement = judgeLifecyclePhase('next-turn', evidence, manifest('handler', ['next-turn']));
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toBe('next-turn-requires-declared-mode: the run manifest\'s mode must equal \'next-turn\', got "handler"');
  });

  test('stays pending when next-turn is not declared as an exercised phase, even under mode next-turn', () => {
    const evidence = extractLifecycleEvidence(runCapture(TWO_AGENTS_TWO_REQUESTS_INTERLEAVED));
    const judgement = judgeLifecyclePhase('next-turn', evidence, manifest('next-turn', ['parallel']));
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toBe('next-turn-not-declared: the run manifest does not declare next-turn as an exercised phase');
  });

  test('stays pending when no agent has two requests, even under a correctly declared mode and phase', () => {
    const oneEach: readonly CapturedPair[] = [pair(1, 'agent-alpha', 'gateway/fast-worker'), pair(2, 'agent-beta', 'gateway/smart-worker')];
    const evidence = extractLifecycleEvidence(runCapture(oneEach));
    const judgement = judgeLifecyclePhase('next-turn', evidence, manifest('next-turn', ['next-turn']));
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toBe('next-turn-insufficient-requests: no agent has two routed requests spanning the declared boundary');
  });
});

describe('judgeLifecyclePhase: resume', () => {
  test('passes under mode resume when an agent has two forwarded requests', () => {
    const evidence = extractLifecycleEvidence(runCapture(TWO_AGENTS_TWO_REQUESTS_INTERLEAVED));
    const judgement = judgeLifecyclePhase('resume', evidence, manifest('resume', ['resume']));
    expect(judgement.result).toBe('passed');
  });

  test('stays pending under mode next-turn with identical evidence -- declared mode is the only thing distinguishing resume from next-turn', () => {
    const evidence = extractLifecycleEvidence(runCapture(TWO_AGENTS_TWO_REQUESTS_INTERLEAVED));
    const judgement = judgeLifecyclePhase('resume', evidence, manifest('next-turn', ['resume']));
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toBe('resume-requires-declared-mode: the run manifest\'s mode must equal \'resume\', got "next-turn"');
  });

  test('stays pending when resume is not declared as an exercised phase, even under mode resume', () => {
    const evidence = extractLifecycleEvidence(runCapture(TWO_AGENTS_TWO_REQUESTS_INTERLEAVED));
    const judgement = judgeLifecyclePhase('resume', evidence, manifest('resume', []));
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toBe('resume-not-declared: the run manifest does not declare resume as an exercised phase');
  });

  test('stays pending when no agent has two requests, even under a correctly declared mode and phase', () => {
    const oneEach: readonly CapturedPair[] = [pair(1, 'agent-alpha', 'gateway/fast-worker'), pair(2, 'agent-beta', 'gateway/smart-worker')];
    const evidence = extractLifecycleEvidence(runCapture(oneEach));
    const judgement = judgeLifecyclePhase('resume', evidence, manifest('resume', ['resume']));
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toBe('resume-insufficient-requests: no agent has two routed requests spanning the declared boundary');
  });
});
