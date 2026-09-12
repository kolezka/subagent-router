import { beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRunCapture } from './evidence-m3a';
import { judgeLifecyclePhase, extractLifecycleEvidence } from './evidence-m10';
import { judgeRun } from './judge-run';
import { writeSyntheticRunCapture } from '../support/native-run-capture';
import { writeSyntheticLifecycleRun } from '../support/lifecycle-run';
import { SYNTHETIC_SITES, writeSyntheticGeneratorBinary, writeSyntheticGeneratorProof } from '../support/generator-proof-fixture';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'capabilities');
let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-lifecycle-certification-'));
});

async function writeExpectedProof(runDir: string): Promise<string> {
  const expectedBinary = join(runDir, 'expected-client-binary');
  await writeSyntheticGeneratorBinary(expectedBinary);
  const proofDir = join(runDir, 'proofs');
  await mkdir(proofDir, { recursive: true });
  await writeSyntheticGeneratorProof(proofDir, { binaryPath: expectedBinary, version: '2.1.266', sites: SYNTHETIC_SITES });
  const snapshot = join(runDir, 'client-binary');
  await writeFile(snapshot, await readFile(expectedBinary));
  await writeFile(join(runDir, 'capture', 'client-binary'), snapshot);
  await writeFile(join(runDir, 'capture', 'client-binary.sha256'), createHash('sha256').update(await readFile(snapshot)).digest('hex'));
  return proofDir;
}

describe('lifecycle certification evidence', () => {
  test('legacy adjacent captures stay diagnostic-only and cannot certify lifecycle evidence', async () => {
    await writeSyntheticLifecycleRun(dir, 'next-turn');
    const proofDir = await writeExpectedProof(dir);
    const captureDir = join(dir, 'capture');
    for (const file of ['002-pre-handler.json', '003-post-handler-upstream.json', '004-pre-handler.json', '005-post-handler-upstream.json', '006-pre-handler.json', '007-post-handler-upstream.json', '008-pre-handler.json', '009-post-handler-upstream.json']) {
      const path = join(captureDir, file);
      const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      delete record.captureRequestId;
      await writeFile(path, JSON.stringify(record));
    }

    const report = await judgeRun(dir, FIXTURES, proofDir);
    expect(report.correlationCompleteness.result).toBe('pending');
    expect(report.lifecycle['next-turn'].result).toBe('pending');
  });

  test('run identity requires a run-local snapshot, its recorded digest, and the expected version binary', async () => {
    await writeSyntheticLifecycleRun(dir, 'next-turn');
    const proofDir = await writeExpectedProof(dir);
    expect((await judgeRun(dir, FIXTURES, proofDir)).identity.result).toBe('passed');

    const snapshot = join(dir, 'client-binary');
    const digest = createHash('sha256').update(await readFile(snapshot)).digest('hex');
    await writeFile(join(dir, 'capture', 'client-binary.sha256'), '');
    expect((await judgeRun(dir, FIXTURES, proofDir)).identity.result).toBe('pending');

    await writeFile(join(dir, 'capture', 'client-binary.sha256'), digest);
    await writeFile(snapshot, 'changed after capture');
    expect((await judgeRun(dir, FIXTURES, proofDir)).identity.result).toBe('pending');

    await writeFile(snapshot, await readFile(join(dir, 'expected-client-binary')));
    await writeFile(join(dir, 'capture', 'client-binary'), join(tmpdir(), 'outside-run-snapshot'));
    expect((await judgeRun(dir, FIXTURES, proofDir)).identity.result).toBe('pending');
  });

  test('a valid nonzero CLI status fails before malformed completion output is parsed', async () => {
    await writeSyntheticRunCapture(dir);
    await writeFile(join(dir, 'cli-exit-status'), '124\n');
    await writeFile(join(dir, 'cli-stdout.json'), '');
    expect((await judgeRun(dir, FIXTURES)).completion.result).toBe('failed');
  });

  test('a messages pre paired with count_tokens post is invalid lifecycle evidence', async () => {
    await writeSyntheticRunCapture(dir);
    const postPath = join(dir, 'capture', '003-post-handler-upstream.json');
    const post = JSON.parse(await readFile(postPath, 'utf8')) as { url: string };
    post.url = 'http://127.0.0.1:1/v1/messages/count_tokens';
    await writeFile(postPath, JSON.stringify(post));
    const capture = await readRunCapture(dir);
    expect(capture.invalidEvidence).toContain('capture-endpoint-mismatch:pre=2,post=3');
    expect(capture.pairs).toHaveLength(0);
    expect(extractLifecycleEvidence(capture).size).toBe(0);
  });

  test('a genuine count_tokens pair stays out of lifecycle evidence', async () => {
    await writeSyntheticRunCapture(dir);
    for (const file of ['002-pre-handler.json', '003-post-handler-upstream.json']) {
      const path = join(dir, 'capture', file);
      const record = JSON.parse(await readFile(path, 'utf8')) as { url: string };
      record.url = 'http://127.0.0.1:1/v1/messages/count_tokens';
      await writeFile(path, JSON.stringify(record));
    }
    const capture = await readRunCapture(dir);
    expect(capture.invalidEvidence).toEqual([]);
    expect(capture.pairs).toHaveLength(1);
    expect(extractLifecycleEvidence(capture).size).toBe(0);
  });

  test('same-id re-delegation remains pending, while structured SendMessage targets prove existing-child resume', () => {
    const capture = {
      runDir: dir,
      profileRaw: {},
      pairs: [
        { seq: 1, agentId: 'agent-a', pre: { url: '/v1/messages', headers: {}, body: { model: 'parent' } }, post: { url: '/v1/messages', headers: {}, body: { model: 'worker' } } },
        { seq: 3, agentId: 'agent-a', pre: { url: '/v1/messages', headers: {}, body: { model: 'parent' } }, post: { url: '/v1/messages', headers: {}, body: { model: 'worker' } } },
      ],
      unforwarded: [],
      correlationCompleteness: { result: 'passed' as const },
      hookAgentIds: new Set<string>(),
    };
    const evidence = extractLifecycleEvidence(capture);
    const manifest = { mode: 'resume', phasesExercised: ['resume'], freshnessHook: 'fake' as const, correlationScaffold: false, resumeStrategy: 're-delegate' as const };
    expect(judgeLifecyclePhase('resume', evidence, manifest, { invocationBoundary: { afterSeq: 1 }, resumeMessageTargets: ['agent-a'] }).result).toBe('pending');
    expect(judgeLifecyclePhase('resume', evidence, { ...manifest, resumeStrategy: 'message-existing' }, { invocationBoundary: { afterSeq: 1 }, resumeMessageTargets: ['agent-a'] }).result).toBe('passed');
    expect(judgeLifecyclePhase('resume', evidence, { ...manifest, resumeStrategy: 'message-existing' }, { invocationBoundary: { afterSeq: 1 }, resumeMessageTargets: [] }).result).toBe('pending');
    expect(judgeLifecyclePhase('resume', evidence, { ...manifest, resumeStrategy: 'message-existing' }, { invocationBoundary: { afterSeq: 1 }, resumeMessageTargets: ['agent-other'] }).result).toBe('pending');
  });
});
