import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
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
    await writeSyntheticRunCapture(dir, { layout: 'v2', clientVersion: '2.1.268' });
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
    await writeSyntheticRunCapture(dir, { layout: 'v2', clientVersion: '2.1.268', profilePatch: { parentPromptPosition: 'after-native-context-v1' } });
    const capture = await readRunCapture(dir);
    const evidence = await extractM3AEvidence(capture, FIXTURES);
    expect(judgeM3A(evidence)).toBe('pending');
    expect(evidence.diagnostics.some((d) => d.includes('layout'))).toBe(true);
  });

  test('a v1 capture judged with a v2 profile is pending, never passed', async () => {
    await writeSyntheticRunCapture(dir, { layout: 'v1', clientVersion: '2.1.268', profilePatch: { parentPromptPosition: 'after-native-context-v2' } });
    const capture = await readRunCapture(dir);
    const evidence = await extractM3AEvidence(capture, FIXTURES);
    expect(judgeM3A(evidence)).toBe('pending');
    expect(evidence.diagnostics.some((d) => d.includes('layout'))).toBe(true);
  });

  test('under v2 both client-owned prefix blocks must be byte identical and match their grammars', async () => {
    await writeSyntheticRunCapture(dir, { layout: 'v2', clientVersion: '2.1.268', mutateBlock0Upstream: true });
    const mutated = await extractM3AEvidence(await readRunCapture(dir), FIXTURES);
    expect(mutated.pairs[0]?.block0ByteIdentical).toBe(false);
    expect(judgeM3A(mutated)).toBe('failed');

    const dir2 = await mkdtemp(join(tmpdir(), 'subagent-router-m3a-evidence-v2-'));
    try {
      await writeSyntheticRunCapture(dir2, { layout: 'v2', clientVersion: '2.1.268', useNonScaffoldBlock0: true });
      const evidence2 = await extractM3AEvidence(await readRunCapture(dir2), FIXTURES);
      expect(evidence2.pairs[0]?.block0MatchesScaffold).toBe(false);
      expect(judgeM3A(evidence2)).toBe('failed');
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });
});
