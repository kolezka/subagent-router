// Hermetic tests for judge-run.ts: never spawns a native client, never sets RUN_NATIVE_PROBES.
// Builds synthetic run capture directories on disk with tests/support/native-run-capture.ts's
// writeSyntheticRunCapture (the same builder tests/probes/evidence-m3a.test.ts uses) and judges
// them with the real production judge code judgeRun wires together.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeRun } from './judge-run';
import { writeSyntheticRunCapture } from '../support/native-run-capture';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'capabilities');

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-judge-run-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('judgeRun', () => {
  test('an all-genuine synthetic run judges m3a passed, lifecycle pending (no manifest declared), and freshness pending with zero counts', async () => {
    await writeSyntheticRunCapture(dir, { agentId: 'agent-judge-run-secret' });

    const report = await judgeRun(dir, FIXTURES);

    expect(report.runDir).toBe(dir);
    expect(report.m3a.result).toBe('passed');
    expect(report.m3a.pairCount).toBe(1);
    expect(report.m3a.pairsTrueCounts).toEqual({
      block0ByteIdentical: 1,
      block0MatchesScaffold: 1,
      markerOnBlock1Line1: 1,
      markerStrippedUpstream: 1,
      versionMatchesProfile: 1,
      agentIdMatchesHook: 1,
    });

    // No 000-run-manifest.json was written by the synthetic builder: every phase must stay
    // pending, never inferred from the mere presence of a routed request.
    for (const phase of ['next-turn', 'resume', 'compaction', 'nested', 'parallel'] as const) {
      expect(report.lifecycle[phase].result).toBe('pending');
    }

    // No instance-fetch/register/consume/replay files were written either: freshness must stay
    // pending with all-zero counts, never inferred from the routed request alone.
    expect(report.freshness.result).toBe('pending');
    expect(report.freshness.counts).toEqual({ instanceFetches: 0, delegationRegisters: 0, delegationConsumes: 0, delegationReplays: 0 });

    expect(report.m1Sample.sampleCount).toBe(1);
    expect(report.m1Sample.verdict.result).toBe('pending');

    // The whole report, serialized, must never carry the raw agent id.
    expect(JSON.stringify(report)).not.toContain('agent-judge-run-secret');
  });

  test('a run without a declared scaffold manifest judges m3a pending, naming the missing manifest', async () => {
    await writeSyntheticRunCapture(dir, { includeScaffoldManifest: false });

    const report = await judgeRun(dir, FIXTURES);

    expect(report.m3a.result).toBe('pending');
    expect(report.m3a.diagnostics.some((d) => d.includes('manifest'))).toBe(true);
  });

  test('a declared lifecycle phase with a real manifest and freshness records is judged from those files, never assumed', async () => {
    await writeSyntheticRunCapture(dir, { agentId: 'agent-a' });
    await mkdir(join(dir, 'capture'), { recursive: true });
    await writeFile(
      join(dir, 'capture', '000-run-manifest.json'),
      JSON.stringify({ mode: 'handler', phasesExercised: ['parallel'], freshnessHook: 'production' }),
      'utf8',
    );
    // A single agent's own request stream can never satisfy 'parallel' (it requires >= 2
    // distinct, interleaved agents), so this is expected to stay pending -- the point of this
    // test is that the manifest's declaration is READ and acted on, not that this exact
    // synthetic shape can pass 'parallel' on its own.
    await writeFile(join(dir, 'capture', '010-instance-fetch.json'), JSON.stringify({}), 'utf8');
    await writeFile(
      join(dir, 'capture', '011-delegation-register.json'),
      JSON.stringify({ agentId: 'agent-a', role: 'explorer', accepted: true, nonceHash: 'deadbeef' }),
      'utf8',
    );

    const report = await judgeRun(dir, FIXTURES);

    expect(report.lifecycle.parallel.result).toBe('pending');
    expect(report.lifecycle.parallel.diagnostic).toContain('parallel-requires-at-least-two-distinct-agents');
    // Every OTHER phase stays pending too: declaring 'parallel' never spreads a declaration to
    // phases the manifest itself did not name.
    for (const phase of ['next-turn', 'resume', 'compaction', 'nested'] as const) {
      expect(report.lifecycle[phase].result).toBe('pending');
    }

    expect(report.freshness.counts).toEqual({ instanceFetches: 1, delegationRegisters: 1, delegationConsumes: 0, delegationReplays: 0 });
    // The register file's own seq (011, after the routed request's 002/003 pair) means it was
    // NOT accepted before the first routed request -- judgeM10Freshness must catch this from the
    // actual seq numbers on disk, never assume a register present anywhere is good enough.
    expect(report.freshness.result).toBe('failed');
    expect(report.freshness.diagnostic).toContain('register-missing-or-late');
  });
});
