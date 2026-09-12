// Hermetic tests for evidence-m10.ts's lifecycle judge. Builds a synthetic RunCapture/pairs
// shape directly (never reads a real run directory off disk) so 'parallel' and 'next-turn' can
// be judged in isolation from the real native-claude-run.sh pipeline. This file did not exist
// before: judgeLifecyclePhase had zero direct test coverage until now.
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractLifecycleEvidence, judgeLifecyclePhase, readInvocationBoundary, readRunManifest } from './evidence-m10';
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
  return { runDir: '/synthetic', profileRaw: {}, pairs, unforwarded: [], hookAgentIds: new Set() };
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
  return { mode, phasesExercised, freshnessHook: 'fake', correlationScaffold: false };
}

describe('readRunManifest: correlationScaffold', () => {
  async function manifestDir(body: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'subagent-router-run-manifest-'));
    await mkdir(join(dir, 'capture'), { recursive: true });
    await writeFile(join(dir, 'capture', '000-run-manifest.json'), JSON.stringify(body), 'utf8');
    return dir;
  }

  test('reads true only from a literal true, and defaults to false for absent, non-boolean or unwritten manifests', async () => {
    // The flag decides whether a lifecycle pass may ever reach an on-disk fixture, so anything
    // short of an explicit true has to read as "not scaffolded, judge it normally".
    const cases: ReadonlyArray<{ label: string; body: Record<string, unknown>; expected: boolean }> = [
      { label: 'true', body: { mode: 'compaction', phasesExercised: ['compaction'], freshnessHook: 'fake', correlationScaffold: true }, expected: true },
      { label: 'false', body: { mode: 'compaction', phasesExercised: [], freshnessHook: 'fake', correlationScaffold: false }, expected: false },
      { label: 'absent', body: { mode: 'compaction', phasesExercised: [], freshnessHook: 'fake' }, expected: false },
      { label: 'string "true"', body: { mode: 'compaction', phasesExercised: [], freshnessHook: 'fake', correlationScaffold: 'true' }, expected: false },
    ];

    for (const { label, body, expected } of cases) {
      const dir = await manifestDir(body);
      try {
        expect({ label, correlationScaffold: (await readRunManifest(dir))?.correlationScaffold }).toEqual({ label, correlationScaffold: expected });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test('the rest of the manifest still parses unchanged alongside the new flag', async () => {
    const dir = await manifestDir({ mode: 'compaction', phasesExercised: ['compaction'], freshnessHook: 'production', correlationScaffold: true });
    try {
      expect(await readRunManifest(dir)).toEqual({ mode: 'compaction', phasesExercised: ['compaction'], freshnessHook: 'production', correlationScaffold: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('readInvocationBoundary', () => {
  async function boundaryDir(contents?: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'subagent-router-invocation-boundary-'));
    await mkdir(join(dir, 'capture'), { recursive: true });
    if (contents !== undefined) await writeFile(join(dir, 'capture', 'invocation-boundary.json'), contents, 'utf8');
    return dir;
  }

  test('reads afterSeq from the file the resume launcher writes between its two invocations', async () => {
    const dir = await boundaryDir('{ "afterSeq": 12 }\n');
    try {
      expect(await readInvocationBoundary(dir)).toEqual({ afterSeq: 12 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('zero is a real boundary, not an absent one: it means invocation 1 wrote no numbered capture', async () => {
    const dir = await boundaryDir('{ "afterSeq": 0 }\n');
    try {
      expect(await readInvocationBoundary(dir)).toEqual({ afterSeq: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('an absent, unparseable or non-integer boundary reads as undefined, never as a guessed split', async () => {
    const cases: ReadonlyArray<{ label: string; contents?: string }> = [
      { label: 'absent' },
      { label: 'not json', contents: 'not json at all' },
      { label: 'missing field', contents: '{}' },
      { label: 'string', contents: '{ "afterSeq": "12" }' },
      { label: 'fractional', contents: '{ "afterSeq": 1.5 }' },
      { label: 'negative', contents: '{ "afterSeq": -1 }' },
    ];
    for (const { label, contents } of cases) {
      const dir = await boundaryDir(contents);
      try {
        expect({ label, boundary: await readInvocationBoundary(dir) }).toEqual({ label, boundary: undefined });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});

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

describe('judgeLifecyclePhase: nested', () => {
  // A nested pair: the grandchild's pre headers carry x-claude-code-parent-agent-id equal to
  // another routed child's agent id (the delegating parent-child). Mirrors the synthetic pairs
  // above, plus the one header the nested judge actually reads.
  function nestedPair(seq: number, agentId: string, upstreamModel: string, parentAgentId?: string): CapturedPair {
    const base = pair(seq, agentId, upstreamModel);
    if (parentAgentId === undefined) return base;
    return {
      ...base,
      pre: { ...base.pre, headers: { ...base.pre.headers, 'x-claude-code-parent-agent-id': parentAgentId } },
    };
  }

  test('passes when a grandchild request names another routed agent as its parent, with no drift among the involved agents', () => {
    const pairs: readonly CapturedPair[] = [
      pair(1, 'agent-alpha', 'gateway/fast-worker'), // delegating parent-child
      pair(2, 'agent-beta', 'gateway/smart-worker'), // beta as the parent's direct child
      nestedPair(3, 'agent-beta-grandchild', 'gateway/smart-worker', 'agent-alpha'), // grandchild under alpha
    ];
    const evidence = extractLifecycleEvidence(runCapture(pairs));
    const judgement = judgeLifecyclePhase('nested', evidence, manifest('nested', ['nested']));
    expect(judgement.result).toBe('passed');
  });

  test('stays pending when the parent-agent-id header is absent, however many requests were captured', () => {
    const evidence = extractLifecycleEvidence(runCapture(TWO_AGENTS_TWO_REQUESTS_INTERLEAVED));
    const judgement = judgeLifecyclePhase('nested', evidence, manifest('nested', ['nested']));
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toBe(
      "nested-requires-observed-parent-agent-id-header: no captured request carried x-claude-code-parent-agent-id equal to another routed child's agent id",
    );
  });

  test('stays pending when the run never declares nested as exercised, even when a nested pair is present', () => {
    const pairs: readonly CapturedPair[] = [
      pair(1, 'agent-alpha', 'gateway/fast-worker'),
      nestedPair(2, 'agent-beta-grandchild', 'gateway/smart-worker', 'agent-alpha'),
    ];
    const evidence = extractLifecycleEvidence(runCapture(pairs));
    const judgement = judgeLifecyclePhase('nested', evidence, manifest('nested', []));
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toBe('nested-not-declared: the run manifest does not declare nested as an exercised phase');
  });

  test('fails on upstream drift among the involved agents', () => {
    const pairs: readonly CapturedPair[] = [
      pair(1, 'agent-alpha', 'gateway/fast-worker'),
      pair(2, 'agent-alpha', 'gateway/DIFFERENT-worker'), // the delegating parent-child drifts
      nestedPair(3, 'agent-beta-grandchild', 'gateway/smart-worker', 'agent-alpha'),
    ];
    const evidence = extractLifecycleEvidence(runCapture(pairs));
    const judgement = judgeLifecyclePhase('nested', evidence, manifest('nested', ['nested']));
    expect(judgement.result).toBe('failed');
    expect(judgement.diagnostic).toContain('nested-upstream-model-drifted');
  });
});

describe('judgeLifecyclePhase: resume', () => {
  test('passes under mode resume when an agent carries its id across the invocation boundary', () => {
    // Both agents have one request on each side of seq 2, so both really were continued. That is
    // the direct measurement, and it settles the phase without any recorded proof.
    const evidence = extractLifecycleEvidence(runCapture(TWO_AGENTS_TWO_REQUESTS_INTERLEAVED));
    const judgement = judgeLifecyclePhase('resume', evidence, manifest('resume', ['resume']), { invocationBoundary: { afterSeq: 2 } });
    expect(judgement.result).toBe('passed');
  });

  test('the same two-request evidence is pending without the boundary file, however it is declared', () => {
    const evidence = extractLifecycleEvidence(runCapture(TWO_AGENTS_TWO_REQUESTS_INTERLEAVED));
    const judgement = judgeLifecyclePhase('resume', evidence, manifest('resume', ['resume']));
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toContain('resume-requires-invocation-boundary');
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

  test('two requests per agent entirely before the boundary is not a resume, however many there are', () => {
    // The regression this branch exists for. Counting requests cannot distinguish "two turns
    // across a resume" from "two turns inside invocation 1", and the old predicate passed the
    // second on the strength of the declared mode alone. With every request at or below the
    // boundary, the resumed invocation delegated nothing and there is nothing to judge.
    const evidence = extractLifecycleEvidence(runCapture(TWO_AGENTS_TWO_REQUESTS_INTERLEAVED));
    const judgement = judgeLifecyclePhase('resume', evidence, manifest('resume', ['resume']), { invocationBoundary: { afterSeq: 4 } });
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toContain('resume-no-post-boundary-children');
  });

  test('a fresh child after the boundary needs the recorded proof: routing alone never certifies it', () => {
    const freshOnly: readonly CapturedPair[] = [pair(1, 'agent-alpha', 'gateway/fast-worker'), pair(2, 'agent-beta', 'gateway/smart-worker')];
    const evidence = extractLifecycleEvidence(runCapture(freshOnly));
    const judgement = judgeLifecyclePhase('resume', evidence, manifest('resume', ['resume']), { invocationBoundary: { afterSeq: 1 }, observedVersion: '2.1.268' });
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toContain('resume-no-continuation-proof-for-2.1.268');
  });
});
