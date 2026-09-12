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
import { SYNTHETIC_SITES, syntheticAgentIds, writeSyntheticGeneratorBinary, writeSyntheticGeneratorProof } from '../support/generator-proof-fixture';

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

  test('the report surfaces the run\'s declared scaffold paths and its correlationScaffold flag, so a caller can gate a fixture write on them', async () => {
    // Both are what fixture-writer.ts's guard needs. Reporting them is the only way a caller can
    // pass them through without re-reading the run directory and re-deriving the same facts.
    await writeSyntheticRunCapture(dir, { scaffoldOverriddenPaths: ['status', 'probes.M10', 'probes.M3-A', 'lifecycle.*', 'parentPromptPosition', 'correlation', 'correlationEntropy', 'probes.M1'] });
    await mkdir(join(dir, 'capture'), { recursive: true });
    await writeFile(
      join(dir, 'capture', '000-run-manifest.json'),
      JSON.stringify({ mode: 'compaction', phasesExercised: ['compaction'], freshnessHook: 'fake', correlationScaffold: true }),
      'utf8',
    );

    const report = await judgeRun(dir, FIXTURES);

    expect(report.m3a.declaredScaffoldPaths).toEqual(['status', 'probes.M10', 'probes.M3-A', 'lifecycle.*', 'parentPromptPosition', 'correlation', 'correlationEntropy', 'probes.M1']);
    expect(report.correlationScaffold).toBe(true);
  });

  test('a run that declares no correlation scaffold reports the flag false and only its own declared paths', async () => {
    await writeSyntheticRunCapture(dir);
    const report = await judgeRun(dir, FIXTURES);

    expect(report.correlationScaffold).toBe(false); // no manifest at all: never inferred as scaffolded
    expect(report.m3a.declaredScaffoldPaths).not.toContain('correlation');
    expect(report.m3a.declaredScaffoldPaths).not.toContain('probes.M1');
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

// Every test below passes an explicit generator-proofs directory holding a synthetic proof and a
// few-hundred-byte stand-in binary. Nothing here ever opens the real pinned client binary.
describe('judgeRun: probes.M1 and correlationEntropy', () => {
  // A second child capture, so a run carries two distinct ids rather than the builder's one.
  async function writeExtraChild(runDir: string, agentId: string): Promise<void> {
    await writeFile(
      join(runDir, 'capture', '005-child.json'),
      JSON.stringify({ url: '/v1/messages', headers: { 'x-claude-code-agent-id': agentId }, body: { model: 'probe-parent-model', messages: [] } }),
      'utf8',
    );
  }

  async function setUpProofs(runDir: string, version: string, sites = SYNTHETIC_SITES, binaryName = 'fake-client-binary'): Promise<string> {
    const binaryPath = join(runDir, binaryName);
    await writeSyntheticGeneratorBinary(binaryPath);
    const proofsDir = join(runDir, 'proofs');
    await mkdir(proofsDir, { recursive: true });
    await writeSyntheticGeneratorProof(proofsDir, { binaryPath, version, sites });
    return proofsDir;
  }

  test('M1 stays pending with no generator proof for the observed client version, and correlationEntropy follows it', async () => {
    await writeSyntheticRunCapture(dir, { clientVersion: '2.1.266' });
    const emptyProofs = join(dir, 'proofs');
    await mkdir(emptyProofs, { recursive: true });

    const report = await judgeRun(dir, FIXTURES, emptyProofs);

    expect(report.probes.M1).toBe('pending');
    expect(report.correlationEntropy).toBe('pending');
    expect(report.m1Sample.verdict.diagnostic).toContain('m1-no-generator-proof-for-2.1.266');
    expect(report.m1Sample.proof.source).toBe('statistical-sample');
  });

  test('M1 passes when a verified generator proof for the observed version backs a clean, well-shaped id sample', async () => {
    const [first, second] = syntheticAgentIds(2) as [string, string];
    await writeSyntheticRunCapture(dir, { clientVersion: '2.1.268', agentId: first });
    await writeExtraChild(dir, second);
    const proofsDir = await setUpProofs(dir, '2.1.268');

    const report = await judgeRun(dir, FIXTURES, proofsDir);

    expect(report.probes.M1).toBe('passed');
    expect(report.correlationEntropy).toBe('passed');
    expect(report.m1Sample.sampleCount).toBe(2);
    expect(report.m1Sample.proof.source).toBe('generator-inspection');
    expect(report.m1Sample.proof.generatorInspected).toBe(true);
    expect(report.m1Sample.proof.bits).toBe(64);
    expect(report.m1Sample.proof.version).toBe('2.1.268');
    expect(report.m1Sample.proof.sitesVerified).toBe('4/4');
    // The pass changes nothing about the redaction posture: no raw agent id in the report.
    expect(JSON.stringify(report)).not.toContain(first);
    expect(JSON.stringify(report)).not.toContain(second);
  });

  test('a proof site that no longer matches the binary keeps M1 pending and names the site', async () => {
    const [first, second] = syntheticAgentIds(2) as [string, string];
    await writeSyntheticRunCapture(dir, { clientVersion: '2.1.268', agentId: first });
    await writeExtraChild(dir, second);
    const shifted = SYNTHETIC_SITES.map((site) => (site.name === 'spawn' ? { ...site, offset: site.offset + 1 } : site));
    const proofsDir = await setUpProofs(dir, '2.1.268', shifted);

    const report = await judgeRun(dir, FIXTURES, proofsDir);

    expect(report.probes.M1).toBe('pending');
    expect(report.correlationEntropy).toBe('pending');
    expect(report.m1Sample.verdict.diagnostic).toContain('m1-proof-site-mismatch:spawn');
  });

  test('an id that does not match the proof id pattern keeps M1 pending even with every site verified', async () => {
    // The builder's default id 'agent-synthetic-1' is not the a+16-hex shape the proof declares.
    await writeSyntheticRunCapture(dir, { clientVersion: '2.1.268' });
    await writeExtraChild(dir, syntheticAgentIds(1)[0] as string);
    const proofsDir = await setUpProofs(dir, '2.1.268');

    const report = await judgeRun(dir, FIXTURES, proofsDir);

    expect(report.probes.M1).toBe('pending');
    expect(report.m1Sample.verdict.diagnostic).toContain('m1-id-shape-mismatch');
  });
});
