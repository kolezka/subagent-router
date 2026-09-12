// Hermetic tests for judge-run.ts: never spawns a native client, never sets RUN_NATIVE_PROBES.
// Builds synthetic run capture directories on disk with tests/support/native-run-capture.ts's
// writeSyntheticRunCapture (the same builder tests/probes/evidence-m3a.test.ts uses) and judges
// them with the real production judge code judgeRun wires together.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

async function writeCompletion(result = 'PARENT_FINAL_OK', sessionId = 'parent-session', secondSessionId?: string): Promise<void> {
  await writeFile(join(dir, 'cli-exit-status'), '0\n');
  await writeFile(join(dir, 'cli-stdout.json'), JSON.stringify({ subtype: 'success', is_error: false, result, session_id: sessionId }));
  if (secondSessionId !== undefined) {
    await writeFile(join(dir, 'cli2-exit-status'), '0\n');
    await writeFile(join(dir, 'cli2-stdout.json'), JSON.stringify({ subtype: 'success', is_error: false, result, session_id: secondSessionId }));
  }
}

async function writeRoutingIdentity(runDir: string): Promise<string> {
  const binaryPath = join(runDir, 'expected-client-binary');
  await writeSyntheticGeneratorBinary(binaryPath);
  const proofsDir = join(runDir, 'proofs');
  await mkdir(proofsDir, { recursive: true });
  await writeSyntheticGeneratorProof(proofsDir, { binaryPath, version: '2.1.266', sites: SYNTHETIC_SITES });
  const snapshotPath = join(runDir, 'client-binary');
  await writeFile(snapshotPath, await readFile(binaryPath));
  await writeFile(join(runDir, 'capture', 'client-binary'), snapshotPath);
  await writeFile(join(runDir, 'capture', 'client-binary.sha256'), createHash('sha256').update(await readFile(snapshotPath)).digest('hex'));
  return proofsDir;
}

async function writeRoutingRun(includeCompletion = true): Promise<string> {
  await writeSyntheticRunCapture(dir, { agentId: 'agent-a' });
  const captureDir = join(dir, 'capture');
  const pre = JSON.parse(await readFile(join(captureDir, '002-pre-handler.json'), 'utf8'));
  const post = JSON.parse(await readFile(join(captureDir, '003-post-handler-upstream.json'), 'utf8'));
  pre.captureRequestId = 'request-2';
  post.captureRequestId = 'request-2';
  await writeFile(join(captureDir, '002-pre-handler.json'), JSON.stringify(pre));
  await writeFile(join(captureDir, '003-post-handler-upstream.json'), JSON.stringify(post));
  await writeFile(join(captureDir, '004-pre-handler.json'), JSON.stringify({ ...pre, captureRequestId: 'request-4' }));
  await writeFile(join(captureDir, '005-post-handler-upstream.json'), JSON.stringify({ ...post, captureRequestId: 'request-4' }));
  pre.headers['x-claude-code-agent-id'] = 'agent-b';
  post.headers['x-claude-code-agent-id'] = 'agent-b';
  post.body.model = 'gateway/smart-worker';
  for (const seq of [6, 8]) {
    await writeFile(join(captureDir, `${String(seq).padStart(3, '0')}-pre-handler.json`), JSON.stringify({ ...pre, captureRequestId: `request-${seq}` }));
    await writeFile(join(captureDir, `${String(seq + 1).padStart(3, '0')}-post-handler-upstream.json`), JSON.stringify({ ...post, captureRequestId: `request-${seq}` }));
  }
  await writeFile(join(captureDir, 'hook-subagentstart-2.json'), JSON.stringify({ agent_id: 'agent-b', agent_type: 'native-probe-beta', hook_event_name: 'SubagentStart' }));
  const parent = { url: '/v1/messages', headers: {}, captureRequestId: 'parent-request', body: { model: 'probe-parent-model', messages: [{ role: 'user', content: 'parent turn' }] } };
  await writeFile(join(captureDir, '010-pre-handler.json'), JSON.stringify(parent));
  await writeFile(join(captureDir, '011-post-handler-upstream.json'), JSON.stringify(parent));
  await writeFile(join(captureDir, '000-run-manifest.json'), JSON.stringify({ mode: 'next-turn', phasesExercised: ['next-turn'], resumeStrategy: 'unknown' }));
  await writeFile(join(captureDir, 'route-expectations.json'), JSON.stringify({ client: 'claude-code', version: '2.1.266', parentModel: 'probe-parent-model', childModelsByType: { 'native-probe-alpha': 'gateway/fast-worker', 'native-probe-beta': 'gateway/smart-worker' } }));
  if (includeCompletion) await writeCompletion();
  return writeRoutingIdentity(dir);
}


interface ResumeParentMessage {
  preBoundaryUrl: string;
  postBoundaryUrl: string;
  preBoundaryMessages: unknown;
  postBoundaryMessages: unknown;
}

async function writeResumeMessageRun(pairs: ResumeParentMessage): Promise<string> {
  await writeSyntheticRunCapture(dir, { agentId: 'agent-a' });

  const captureDir = join(dir, 'capture');

  const writePair = async (
    seq: number,
    pre: { url: string; agentId?: string; model: string; messages: unknown },
    post: { url: string; model: string; messages: unknown },
  ): Promise<void> => {
    await writeFile(
      join(captureDir, `${String(seq).padStart(3, '0')}-pre-handler.json`),
      JSON.stringify({
        url: pre.url,
        headers: pre.agentId !== undefined ? { 'x-claude-code-agent-id': pre.agentId } : {},
        body: { model: pre.model, messages: pre.messages },
      }),
    );
    await writeFile(
      join(captureDir, `${String(seq + 1).padStart(3, '0')}-post-handler-upstream.json`),
      JSON.stringify({
        url: post.url,
        headers: pre.agentId !== undefined ? { 'x-claude-code-agent-id': pre.agentId } : {},
        body: { model: post.model, messages: post.messages },
      }),
    );
  };

  await writePair(
    4,
    { url: '/v1/messages', agentId: 'agent-b', model: 'probe-parent-model', messages: [{ role: 'user', content: 'fresh child baseline' }] },
    { url: 'http://127.0.0.1:1/v1/messages', model: 'gateway/smart-worker', messages: [{ role: 'user', content: 'fresh child baseline' }] },
  );
  await writePair(
    8,
    { url: '/v1/messages', agentId: 'agent-a', model: 'probe-parent-model', messages: [{ role: 'user', content: 'continuing child request' }] },
    { url: 'http://127.0.0.1:1/v1/messages', model: 'gateway/fast-worker', messages: [{ role: 'user', content: 'continuing child request' }] },
  );
  await writePair(
    6,
    { url: pairs.preBoundaryUrl, model: 'probe-parent-model', messages: pairs.preBoundaryMessages },
    { url: pairs.preBoundaryUrl, model: 'probe-parent-model', messages: pairs.preBoundaryMessages },
  );
  await writePair(
    10,
    { url: pairs.postBoundaryUrl, model: 'probe-parent-model', messages: pairs.postBoundaryMessages },
    { url: pairs.postBoundaryUrl, model: 'probe-parent-model', messages: pairs.postBoundaryMessages },
  );

  for (const seq of [2, 4, 6, 8, 10]) {
    const prePath = join(captureDir, `${String(seq).padStart(3, '0')}-pre-handler.json`);
    const postPath = join(captureDir, `${String(seq + 1).padStart(3, '0')}-post-handler-upstream.json`);
    const pre = JSON.parse(await readFile(prePath, 'utf8')) as { [key: string]: unknown };
    const post = JSON.parse(await readFile(postPath, 'utf8')) as { [key: string]: unknown };
    pre.captureRequestId = `request-${seq}`;
    post.captureRequestId = `request-${seq}`;
    await writeFile(prePath, JSON.stringify(pre));
    await writeFile(postPath, JSON.stringify(post));
  }

  await writeFile(
    join(captureDir, 'hook-subagentstart-2.json'),
    JSON.stringify({ agent_id: 'agent-b', agent_type: 'native-probe-beta', hook_event_name: 'SubagentStart' }),
  );
  await writeFile(
    join(captureDir, '000-run-manifest.json'),
    JSON.stringify({
      mode: 'resume',
      phasesExercised: ['resume'],
      freshnessHook: 'fake',
      resumeStrategy: 'message-existing',
      correlationScaffold: false,
    }),
  );
  await writeFile(join(captureDir, 'invocation-boundary.json'), JSON.stringify({ afterSeq: 7 }));
  await writeFile(
    join(captureDir, 'route-expectations.json'),
    JSON.stringify({
      client: 'claude-code',
      version: '2.1.266',
      parentModel: 'probe-parent-model',
      childModelsByType: {
        'native-probe-alpha': 'gateway/fast-worker',
        'native-probe-beta': 'gateway/smart-worker',
      },
    }),
  );

  await writeCompletion('PARENT_FINAL_OK', 'parent-session', 'parent-session');
  return writeRoutingIdentity(dir);
}


describe('judgeRun routing controls', () => {
  test('positive control: declared child models and unchanged parent are accepted', async () => {
    const proofsDir = await writeRoutingRun();
    expect((await judgeRun(dir, FIXTURES, proofsDir)).lifecycle['next-turn'].result).toBe('passed');
  });

  test('a stable but wrong child model must not certify a lifecycle phase', async () => {
    const proofsDir = await writeRoutingRun();
    for (const name of ['003-post-handler-upstream.json', '005-post-handler-upstream.json']) {
      const file = join(dir, 'capture', name);
      const record = JSON.parse(await readFile(file, 'utf8'));
      record.body.model = 'gateway/smart-worker';
      await writeFile(file, JSON.stringify(record));
    }
    expect((await judgeRun(dir, FIXTURES, proofsDir)).lifecycle['next-turn'].result).toBe('failed');
  });

  test('rewriting the parent model must not certify a lifecycle phase', async () => {
    const proofsDir = await writeRoutingRun();
    const file = join(dir, 'capture', '011-post-handler-upstream.json');
    const record = JSON.parse(await readFile(file, 'utf8'));
    record.body.model = 'gateway/fast-worker';
    await writeFile(file, JSON.stringify(record));
    expect((await judgeRun(dir, FIXTURES, proofsDir)).lifecycle['next-turn'].result).toBe('failed');
  });
});

describe('judgeRun completion evidence', () => {
  test('valid routing cannot promote a parent mismatch', async () => {
    const proofsDir = await writeRoutingRun();
    await writeCompletion('PARENT_MISMATCH');

    const report = await judgeRun(dir, FIXTURES, proofsDir);
    expect(report.completion.result).toBe('failed');
    expect(report.lifecycle['next-turn'].result).toBe('failed');
  });

  test('missing invocation exit status cannot pass a lifecycle phase', async () => {
    await writeRoutingRun(false);
    await writeFile(join(dir, 'cli-stdout.json'), JSON.stringify({ subtype: 'success', is_error: false, result: 'PARENT_FINAL_OK', session_id: 'parent-session' }));

    const report = await judgeRun(dir, FIXTURES);
    expect(report.completion.result).toBe('pending');
    expect(report.lifecycle['next-turn'].result).toBe('pending');
  });

  test('resume requires matching non-empty parent session ids from both successful invocations', async () => {
    await writeRoutingRun();
    await writeFile(join(dir, 'capture', '000-run-manifest.json'), JSON.stringify({ mode: 'resume', phasesExercised: ['resume'] }));
    await writeFile(join(dir, 'capture', 'invocation-boundary.json'), JSON.stringify({ afterSeq: 3 }));
    await writeCompletion('PARENT_FINAL_OK', 'parent-session-one', 'parent-session-two');

    const report = await judgeRun(dir, FIXTURES);
    expect(report.completion.result).toBe('failed');
    expect(report.lifecycle.resume.result).toBe('pending');
  });
});

describe('judgeRun resume message target extraction', () => {
  test('replayed SendMessage tool_use ids do not satisfy continue targets', async () => {
    const proofsDir = await writeResumeMessageRun({
      preBoundaryUrl: '/v1/messages',
      postBoundaryUrl: '/v1/messages',
      preBoundaryMessages: [{
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu-resume-old',
            name: 'SendMessage',
            input: { to: 'agent-a', message: 'resume' },
          },
        ],
      }],
      postBoundaryMessages: [{
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu-resume-old',
            name: 'SendMessage',
            input: { to: 'agent-a', message: 'resume' },
          },
        ],
      }],
    });

    const report = await judgeRun(dir, FIXTURES, proofsDir);
    expect(report.lifecycle['resume'].result).toBe('pending');
    expect(report.lifecycle['resume'].diagnostic).toContain('resume-requires-sendmessage-targets');
  });

  test('a tool-use id already seen in pre-boundary token-count history is not new', async () => {
    const oldMessage = { role: 'assistant', content: [{ type: 'tool_use', id: 'old-in-count-history', name: 'SendMessage', input: { to: 'agent-a', message: 'resume' } }] };
    const proofsDir = await writeResumeMessageRun({
      preBoundaryUrl: '/v1/messages/count_tokens',
      postBoundaryUrl: '/v1/messages',
      preBoundaryMessages: [oldMessage],
      postBoundaryMessages: [oldMessage],
    });
    const report = await judgeRun(dir, FIXTURES, proofsDir);
    expect(report.lifecycle.resume.result).toBe('pending');
  });

  test('count_tokens SendMessage evidence is ignored for resume message continuation', async () => {
    const proofsDir = await writeResumeMessageRun({
      preBoundaryUrl: '/v1/messages',
      postBoundaryUrl: 'http://127.0.0.1:1/v1/messages/count_tokens',
      preBoundaryMessages: [{ role: 'assistant', content: 'parent boundary check' }],
      postBoundaryMessages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu-fresh-boundary',
              name: 'SendMessage',
              input: { to: 'agent-a', message: 'resume' },
            },
          ],
        },
      ],
    });

    const report = await judgeRun(dir, FIXTURES, proofsDir);
    expect(report.lifecycle['resume'].result).toBe('pending');
    expect(report.lifecycle['resume'].diagnostic).toContain('resume-requires-sendmessage-targets');
  });

  test('a new post-boundary SendMessage target allows resume pass', async () => {
    const proofsDir = await writeResumeMessageRun({
      preBoundaryUrl: '/v1/messages',
      postBoundaryUrl: '/v1/messages',
      preBoundaryMessages: [{ role: 'assistant', content: 'parent boundary check' }],
      postBoundaryMessages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu-resume-fresh',
              name: 'SendMessage',
              input: { to: 'agent-a', message: 'resume' },
            },
          ],
        },
      ],
    });

    const report = await judgeRun(dir, FIXTURES, proofsDir);
    expect(report.lifecycle['resume'].result).toBe('passed');
  });
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
    const digest = createHash('sha256').update(await readFile(binaryPath)).digest('hex');
    await writeFile(join(runDir, 'capture', 'client-binary'), binaryPath);
    await writeFile(join(runDir, 'capture', 'client-binary.sha256'), digest);
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

  test('a run cannot borrow another executable\'s matching proof sites', async () => {
    const [first, second] = syntheticAgentIds(2) as [string, string];
    await writeSyntheticRunCapture(dir, { clientVersion: '2.1.268', agentId: first });
    await writeExtraChild(dir, second);
    const proofsDir = await setUpProofs(dir, '2.1.268');
    const otherBinary = join(dir, 'other-executable');
    await writeFile(otherBinary, 'different executable with the same reported version');
    const digest = createHash('sha256').update(await readFile(otherBinary)).digest('hex');
    await writeFile(join(dir, 'capture', 'client-binary'), otherBinary);
    await writeFile(join(dir, 'capture', 'client-binary.sha256'), digest);
    const report = await judgeRun(dir, FIXTURES, proofsDir);
    expect(report.probes.M1).toBe('pending');
    expect(report.m1Sample.verdict.diagnostic).toContain('m1-binary-digest-mismatch');
  });

  test('matching sites do not hide a binary change outside those sites', async () => {
    const [first, second] = syntheticAgentIds(2) as [string, string];
    await writeSyntheticRunCapture(dir, { clientVersion: '2.1.268', agentId: first });
    await writeExtraChild(dir, second);
    const proofsDir = await setUpProofs(dir, '2.1.268');
    const binary = join(dir, 'fake-client-binary');
    await writeFile(binary, Buffer.concat([await readFile(binary), Buffer.from('changed after capture')]));
    const report = await judgeRun(dir, FIXTURES, proofsDir);
    expect(report.probes.M1).toBe('pending');
    expect(report.m1Sample.verdict.diagnostic).toContain('m1-binary-digest-mismatch');
  });

  test('a missing capture-time digest leaves an otherwise matching proof pending', async () => {
    const [first, second] = syntheticAgentIds(2) as [string, string];
    await writeSyntheticRunCapture(dir, { clientVersion: '2.1.268', agentId: first });
    await writeExtraChild(dir, second);
    const proofsDir = await setUpProofs(dir, '2.1.268');
    await writeFile(join(dir, 'capture', 'client-binary.sha256'), '');
    const report = await judgeRun(dir, FIXTURES, proofsDir);
    expect(report.probes.M1).toBe('pending');
    expect(report.m1Sample.verdict.diagnostic).toContain('m1-binary-identity-missing');
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
