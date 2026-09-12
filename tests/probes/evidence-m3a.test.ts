import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffCapturedAgainstReal, extractM3AEvidence, judgeM3A, readRunCapture } from './evidence-m3a';
import { writeSyntheticRunCapture } from '../support/native-run-capture';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'capabilities');

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-m3a-evidence-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('evidence-m3a: readRunCapture + extractM3AEvidence + judgeM3A', () => {
  test('passes-only-from-declared-scaffold-and-all-true-pairs', async () => {
    await writeSyntheticRunCapture(dir);
    const capture = await readRunCapture(dir);
    expect(capture.pairs).toHaveLength(1);

    const evidence = await extractM3AEvidence(capture, FIXTURES);
    expect(evidence.scaffoldDeclared).toBe(true);
    expect(evidence.pairs).toHaveLength(1);
    expect(evidence.pairs[0]).toMatchObject({
      block0ByteIdentical: true,
      block0MatchesScaffold: true,
      markerOnBlock1Line1: true,
      markerStrippedUpstream: true,
      versionMatchesProfile: true,
      agentIdMatchesHook: true,
    });
    expect(judgeM3A(evidence)).toBe('passed');
  });

  test('startup passthrough may acquire the configured upstream base path', async () => {
    await writeSyntheticRunCapture(dir);
    const startup = { captureRequestId: 'startup', url: '/api/hello', headers: {}, body: {} };
    await writeFile(join(dir, 'capture', '004-pre-handler.json'), JSON.stringify(startup));
    await writeFile(join(dir, 'capture', '005-post-handler-upstream.json'), JSON.stringify({ ...startup, url: 'http://127.0.0.1:1/v1/api/hello' }));
    const capture = await readRunCapture(dir);
    expect(capture.invalidEvidence).toEqual([]);
    expect(capture.pairs).toHaveLength(2);
  });

  test('pairs interleaved captures by request correlation id, not adjacent sequence number', async () => {
    await writeSyntheticRunCapture(dir, { includePair: false });
    const captureDir = join(dir, 'capture');
    const request = (agentId: string, requestId: string, model: string) => ({
      url: '/v1/messages',
      headers: { 'x-claude-code-agent-id': agentId },
      body: { model },
      captureRequestId: requestId,
    });
    await writeFile(join(captureDir, '002-pre-handler.json'), JSON.stringify(request('agent-a', 'request-a', 'probe-parent-model')));
    await writeFile(join(captureDir, '004-pre-handler.json'), JSON.stringify(request('agent-b', 'request-b', 'probe-parent-model')));
    await writeFile(join(captureDir, '005-post-handler-upstream.json'), JSON.stringify(request('agent-b', 'request-b', 'gateway/smart-worker')));
    await writeFile(join(captureDir, '006-post-handler-upstream.json'), JSON.stringify(request('agent-a', 'request-a', 'gateway/fast-worker')));

    const capture = await readRunCapture(dir);
    expect(capture.invalidEvidence).toEqual([]);
    expect(capture.pairs.map((pair) => ({ seq: pair.seq, agentId: pair.agentId, model: pair.post.body.model }))).toEqual([
      { seq: 2, agentId: 'agent-a', model: 'gateway/fast-worker' },
      { seq: 4, agentId: 'agent-b', model: 'gateway/smart-worker' },
    ]);
  });

  test('ambiguous legacy interleaving and duplicate or orphan correlation ids cannot certify M3-A', async () => {
    await writeSyntheticRunCapture(dir);
    const captureDir = join(dir, 'capture');
    const pre = JSON.parse(await readFile(join(captureDir, '002-pre-handler.json'), 'utf8'));
    const post = JSON.parse(await readFile(join(captureDir, '003-post-handler-upstream.json'), 'utf8'));
    pre.captureRequestId = 'request-a';
    post.captureRequestId = 'request-a';
    await writeFile(join(captureDir, '002-pre-handler.json'), JSON.stringify(pre));
    await writeFile(join(captureDir, '003-post-handler-upstream.json'), JSON.stringify(post));
    await writeFile(join(captureDir, '004-post-handler-upstream.json'), JSON.stringify({ ...post, captureRequestId: 'request-a' }));

    const duplicate = await readRunCapture(dir);
    expect(duplicate.invalidEvidence?.length ?? 0).toBeGreaterThan(0);
    expect(judgeM3A(await extractM3AEvidence(duplicate, FIXTURES))).toBe('pending');

    const legacyDir = join(dir, 'legacy');
    const legacyCaptureDir = join(legacyDir, 'capture');
    await writeSyntheticRunCapture(legacyDir, { includePair: false });
    await writeFile(join(legacyCaptureDir, '002-pre-handler.json'), JSON.stringify({ ...pre, captureRequestId: undefined }));
    await writeFile(join(legacyCaptureDir, '003-pre-handler.json'), JSON.stringify({ ...pre, headers: { ...pre.headers, 'x-claude-code-agent-id': 'agent-b' }, captureRequestId: undefined }));
    await writeFile(join(legacyCaptureDir, '004-post-handler-upstream.json'), JSON.stringify({ ...post, captureRequestId: undefined }));
    await writeFile(join(legacyCaptureDir, '005-post-handler-upstream.json'), JSON.stringify({ ...post, headers: { ...post.headers, 'x-claude-code-agent-id': 'agent-b' }, captureRequestId: undefined }));

    const ambiguousLegacy = await readRunCapture(legacyDir);
    expect(ambiguousLegacy.invalidEvidence?.length ?? 0).toBeGreaterThan(0);
    expect(judgeM3A(await extractM3AEvidence(ambiguousLegacy, FIXTURES))).toBe('pending');
  });

  test('rejects-synthetic-hermetic-profile-as-pending', async () => {
    await writeSyntheticRunCapture(dir, { profilePatch: { version: 'synthetic-hermetic' } });
    const capture = await readRunCapture(dir);
    const evidence = await extractM3AEvidence(capture, FIXTURES);
    expect(evidence.scaffoldDeclared).toBe(false);
    expect(evidence.diagnostics.some((d) => d.includes('synthetic-hermetic'))).toBe(true);
    expect(judgeM3A(evidence)).toBe('pending');
  });

  test('pending-when-scaffold-manifest-missing', async () => {
    await writeSyntheticRunCapture(dir, { includeScaffoldManifest: false });
    const capture = await readRunCapture(dir);
    expect(capture.scaffoldOverriddenPaths).toBeUndefined();

    const evidence = await extractM3AEvidence(capture, FIXTURES);
    expect(evidence.scaffoldDeclared).toBe(false);
    expect(evidence.diagnostics.some((d) => d.includes('manifest'))).toBe(true);
    expect(judgeM3A(evidence)).toBe('pending');
  });

  test('handler-4r0D99 saved run (no manifest) judges pending, naming the missing manifest', async () => {
    // A sanitized structural stand-in for the pre-existing tests/probes/.runs/handler-4r0D99
    // saved run: same file shapes (NNN-profile.json with the syntheticLayoutProfile fields,
    // a genuine child pair, a matching hook record), but never that run's own ~27KB captured
    // text and no scaffold manifest -- exactly the gap the real saved run has.
    await writeSyntheticRunCapture(dir, { includeScaffoldManifest: false });
    const capture = await readRunCapture(dir);
    const evidence = await extractM3AEvidence(capture, FIXTURES);
    expect(judgeM3A(evidence)).toBe('pending');
    expect(evidence.diagnostics.some((d) => d.includes('manifest'))).toBe(true);
  });

  test('pending-when-undeclared-field-diverges', async () => {
    // Declares every overridden path except parentPromptPosition.
    await writeSyntheticRunCapture(dir, { scaffoldOverriddenPaths: ['status', 'probes.M10', 'probes.M3-A', 'lifecycle.*'] });
    const capture = await readRunCapture(dir);
    const evidence = await extractM3AEvidence(capture, FIXTURES);
    expect(evidence.scaffoldDeclared).toBe(false);
    expect(evidence.diagnostics.some((d) => d.includes('parentPromptPosition'))).toBe(true);
    expect(judgeM3A(evidence)).toBe('pending');
  });

  test('diagnostics-provenance-never-counts-as-divergence', async () => {
    // After the writer narrows one probe it appends a diagnostics line to the real fixture; a
    // later run of the same version carries the pre-narrowing copy. Provenance must not block
    // every later measurement of that version.
    const captured: Record<string, unknown> = {
      client: 'claude-code',
      version: '2.1.267',
      status: 'pending',
      probes: { 'M3-A': 'passed' },
      parentPromptPosition: 'after-native-context-v1',
      diagnostics: ['measured:M3-A=passed;run=earlier-run;at=2026-09-10T00:00:00.000Z'],
    };
    const realNow: Record<string, unknown> = {
      ...captured,
      parentPromptPosition: 'first-text',
      diagnostics: [...(captured.diagnostics as string[]), 'measured:lifecycle.parallel=passed;run=later-run;at=2026-09-10T01:00:00.000Z'],
    };
    const diverged = diffCapturedAgainstReal(captured, realNow);
    expect(diverged).toContain('parentPromptPosition');
    expect(diverged).not.toContain('diagnostics');
  });

  test('reads-a-refused-request-into-unforwarded-without-disturbing-pairs', async () => {
    // A request the handler refused has a pre-handler record and no upstream record. It must not
    // become a pair (nothing was forwarded), and it must not vanish either: dropping it is what
    // hid the lost-child failure from the lifecycle judge.
    await writeSyntheticRunCapture(dir, { agentId: 'agent-refused', includeRefusedRequest: true });
    const capture = await readRunCapture(dir);
    expect(capture.pairs).toHaveLength(1);
    expect(capture.pairs[0]!.seq).toBe(2);
    expect(capture.unforwarded).toHaveLength(1);
    expect(capture.unforwarded[0]!.seq).toBe(4);
    expect(capture.unforwarded[0]!.agentId).toBe('agent-refused');
    // M3-A reads pairs only, so its verdict is untouched by the refused request.
    expect(judgeM3A(await extractM3AEvidence(capture, FIXTURES))).toBe('passed');
  });

  test('pending-when-no-child-pairs', async () => {
    await writeSyntheticRunCapture(dir, { includePair: false });
    const capture = await readRunCapture(dir);
    expect(capture.pairs).toHaveLength(0);
    const evidence = await extractM3AEvidence(capture, FIXTURES);
    expect(evidence.pairs).toHaveLength(0);
    expect(judgeM3A(evidence)).toBe('pending');
  });

  test('fails-when-block0-mutated-between-pre-and-post', async () => {
    await writeSyntheticRunCapture(dir, { mutateBlock0Upstream: true });
    const capture = await readRunCapture(dir);
    const evidence = await extractM3AEvidence(capture, FIXTURES);
    expect(evidence.pairs[0]?.block0ByteIdentical).toBe(false);
    expect(judgeM3A(evidence)).toBe('failed');
  });

  test('fails-when-marker-survives-upstream', async () => {
    await writeSyntheticRunCapture(dir, { leaveMarkerUpstream: true });
    const capture = await readRunCapture(dir);
    const evidence = await extractM3AEvidence(capture, FIXTURES);
    expect(evidence.pairs[0]?.markerStrippedUpstream).toBe(false);
    expect(judgeM3A(evidence)).toBe('failed');
  });

  test('fails-when-user-agent-version-mismatches-profile', async () => {
    await writeSyntheticRunCapture(dir, { userAgentVersion: '2.1.263' });
    const capture = await readRunCapture(dir);
    const evidence = await extractM3AEvidence(capture, FIXTURES);
    expect(evidence.pairs[0]?.versionMatchesProfile).toBe(false);
    expect(judgeM3A(evidence)).toBe('failed');
  });

  test('fails-when-agent-id-has-no-subagentstart-hook', async () => {
    await writeSyntheticRunCapture(dir, { includeHookRecord: false });
    const capture = await readRunCapture(dir);
    const evidence = await extractM3AEvidence(capture, FIXTURES);
    expect(evidence.pairs[0]?.agentIdMatchesHook).toBe(false);
    expect(judgeM3A(evidence)).toBe('failed');
  });

  test('block0 that does not match the recognized scaffold fails the pair', async () => {
    await writeSyntheticRunCapture(dir, { useNonScaffoldBlock0: true });
    const capture = await readRunCapture(dir);
    const evidence = await extractM3AEvidence(capture, FIXTURES);
    expect(evidence.pairs[0]?.block0MatchesScaffold).toBe(false);
    expect(judgeM3A(evidence)).toBe('failed');
  });

  test('a marker-shaped line that is not a parent marker never counts as markerOnBlock1Line1', async () => {
    await writeSyntheticRunCapture(dir, { omitMarkerOnBlock1: true });
    const capture = await readRunCapture(dir);
    const evidence = await extractM3AEvidence(capture, FIXTURES);
    expect(evidence.pairs[0]?.markerOnBlock1Line1).toBe(false);
    expect(judgeM3A(evidence)).toBe('failed');
  });

  test('aggregate pair count alone never certifies passed: two pairs, one false boolean, still fails', async () => {
    await writeSyntheticRunCapture(dir, { agentId: 'agent-a', includeHookRecord: true });
    const capture = await readRunCapture(dir);
    const evidenceAllGood = await extractM3AEvidence(capture, FIXTURES);
    expect(judgeM3A(evidenceAllGood)).toBe('passed');

    // Same shape again but this time the hook record is missing: a real regression must still
    // fail even though the raw pair count (1) is identical to the passing run above.
    const dir2 = await mkdtemp(join(tmpdir(), 'subagent-router-m3a-evidence-2-'));
    try {
      await writeSyntheticRunCapture(dir2, { agentId: 'agent-a', includeHookRecord: false });
      const capture2 = await readRunCapture(dir2);
      const evidence2 = await extractM3AEvidence(capture2, FIXTURES);
      expect(evidence2.pairs).toHaveLength(1);
      expect(judgeM3A(evidence2)).toBe('failed');
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });
});

describe('evidence-m3a: layout awareness (after-native-context-v2)', () => {
  test('a v2 capture judged with the v2 profile passes on all six booleans', async () => {
    await writeSyntheticRunCapture(dir, { layout: 'v2', clientVersion: '2.1.268', profileBase: 'real' });
    const capture = await readRunCapture(dir);
    expect(capture.profileRaw.parentPromptPosition).toBe('after-native-context-v2');

    const evidence = await extractM3AEvidence(capture, FIXTURES);
    expect(evidence.scaffoldDeclared).toBe(true);
    expect(evidence.pairs).toHaveLength(1);
    expect(evidence.pairs[0]).toMatchObject({
      block0ByteIdentical: true,
      block0MatchesScaffold: true,
      markerOnBlock1Line1: true,
      markerStrippedUpstream: true,
      versionMatchesProfile: true,
      agentIdMatchesHook: true,
    });
    expect(judgeM3A(evidence)).toBe('passed');
  });

  test('the same v2 capture judged with a v1 profile is pending, never passed: nothing about that claim was measured', async () => {
    await writeSyntheticRunCapture(dir, { layout: 'v2', clientVersion: '2.1.268', profileBase: 'real', profilePatch: { parentPromptPosition: 'after-native-context-v1' } });
    const capture = await readRunCapture(dir);
    const evidence = await extractM3AEvidence(capture, FIXTURES);
    expect(judgeM3A(evidence)).toBe('pending');
    expect(evidence.diagnostics.some((d) => d.includes('layout'))).toBe(true);
  });

  test('a v1 capture judged with a v2 profile is pending, never passed', async () => {
    await writeSyntheticRunCapture(dir, { layout: 'v1', clientVersion: '2.1.268', profileBase: 'real', profilePatch: { parentPromptPosition: 'after-native-context-v2' } });
    const capture = await readRunCapture(dir);
    const evidence = await extractM3AEvidence(capture, FIXTURES);
    expect(judgeM3A(evidence)).toBe('pending');
    expect(evidence.diagnostics.some((d) => d.includes('layout'))).toBe(true);
  });

  test('under v2 both client-owned prefix blocks must be byte identical and match their grammars', async () => {
    await writeSyntheticRunCapture(dir, { layout: 'v2', clientVersion: '2.1.268', profileBase: 'real', mutateBlock0Upstream: true });
    const mutated = await extractM3AEvidence(await readRunCapture(dir), FIXTURES);
    expect(mutated.pairs[0]?.block0ByteIdentical).toBe(false);
    expect(judgeM3A(mutated)).toBe('failed');

    const dir2 = await mkdtemp(join(tmpdir(), 'subagent-router-m3a-evidence-v2-'));
    try {
      await writeSyntheticRunCapture(dir2, { layout: 'v2', clientVersion: '2.1.268', profileBase: 'real', useNonScaffoldBlock0: true });
      const evidence2 = await extractM3AEvidence(await readRunCapture(dir2), FIXTURES);
      expect(evidence2.pairs[0]?.block0MatchesScaffold).toBe(false);
      expect(judgeM3A(evidence2)).toBe('failed');
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });
});
