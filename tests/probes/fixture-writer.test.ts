import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouterError } from '../../src/core/errors';
import { writeCapabilityFixture } from './fixture-writer';

const BASE_FIXTURE = {
  client: 'claude-code',
  version: '2.1.266',
  status: 'pending',
  correlation: false,
  correlationEntropy: 'pending',
  fork: false,
  adapterMarkerPosition: 'unknown',
  probes: { M1: 'pending', M2: 'pending', M3: 'pending', 'M3-B2': 'pending', M4: 'pending', M10: 'pending', 'M10-freshness': 'pending' },
  lifecycle: { 'next-turn': 'pending', resume: 'pending', compaction: 'pending', nested: 'pending', parallel: 'pending' },
} as const;

let dir = '';
let fixturePath = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-fixture-writer-'));
  fixturePath = join(dir, 'claude-code-2.1.266.json');
  await writeFile(fixturePath, `${JSON.stringify(BASE_FIXTURE, null, 2)}\n`, 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('fixture-writer: writeCapabilityFixture', () => {
  test('writer-only-narrows-probed-keys', async () => {
    await writeCapabilityFixture('claude-code', '2.1.266', { runId: 'run-narrow', scaffoldDeclared: true, probes: { 'M3-A': 'passed' } }, dir);

    const after = JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown>;
    expect((after.probes as Record<string, string>)['M3-A']).toBe('passed');
    // Every pre-existing probe key is untouched.
    for (const [name, result] of Object.entries(BASE_FIXTURE.probes)) {
      expect((after.probes as Record<string, string>)[name]).toBe(result);
    }
    // Nothing outside probes/lifecycle/diagnostics changed.
    expect(after.status).toBe(BASE_FIXTURE.status);
    expect(after.correlation).toBe(BASE_FIXTURE.correlation);
    expect(after.correlationEntropy).toBe(BASE_FIXTURE.correlationEntropy);
    expect(after.fork).toBe(BASE_FIXTURE.fork);
    expect(after.adapterMarkerPosition).toBe(BASE_FIXTURE.adapterMarkerPosition);
    expect(after.client).toBe(BASE_FIXTURE.client);
    expect(after.version).toBe(BASE_FIXTURE.version);
    expect(after.lifecycle).toEqual(BASE_FIXTURE.lifecycle);

    const diagnostics = after.diagnostics as string[];
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatch(/^measured:M3-A=passed;run=run-narrow;at=\d{4}-\d{2}-\d{2}T/);
  });

  test('writer narrows lifecycle keys the same way, leaving unlisted phases untouched', async () => {
    await writeCapabilityFixture('claude-code', '2.1.266', { runId: 'run-life', scaffoldDeclared: true, lifecycle: { 'next-turn': 'passed' } }, dir);
    const after = JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown>;
    const lifecycle = after.lifecycle as Record<string, string>;
    expect(lifecycle['next-turn']).toBe('passed');
    expect(lifecycle.resume).toBe('pending');
    expect(lifecycle.compaction).toBe('pending');
    expect(lifecycle.nested).toBe('pending');
    expect(lifecycle.parallel).toBe('pending');
    expect((after.diagnostics as string[])[0]).toMatch(/^measured:lifecycle\.next-turn=passed;run=run-life;at=/);
  });

  test('writer-refuses-undeclared-scaffold', async () => {
    await expect(
      writeCapabilityFixture('claude-code', '2.1.266', { runId: 'run-x', scaffoldDeclared: false, probes: { 'M3-A': 'passed' } }, dir),
    ).rejects.toBeInstanceOf(RouterError);
    // Original untouched.
    expect(await readFile(fixturePath, 'utf8')).toBe(`${JSON.stringify(BASE_FIXTURE, null, 2)}\n`);
  });

  test('writer-never-writes-context-or-header-fields', async () => {
    const judgedWithForeignKey = {
      runId: 'run-y',
      scaffoldDeclared: true,
      probes: { 'M3-A': 'passed' },
      headers: { authorization: 'leaked-secret' },
    } as unknown as Parameters<typeof writeCapabilityFixture>[2];

    await expect(writeCapabilityFixture('claude-code', '2.1.266', judgedWithForeignKey, dir)).rejects.toBeInstanceOf(RouterError);
    const after = await readFile(fixturePath, 'utf8');
    expect(after).toBe(`${JSON.stringify(BASE_FIXTURE, null, 2)}\n`);
    expect(after).not.toContain('leaked-secret');
    expect(after).not.toContain('authorization');
  });

  test('a request naming no probe or lifecycle key is refused rather than writing an empty diagnostic', async () => {
    await expect(writeCapabilityFixture('claude-code', '2.1.266', { runId: 'run-empty', scaffoldDeclared: true }, dir)).rejects.toBeInstanceOf(RouterError);
    expect(await readFile(fixturePath, 'utf8')).toBe(`${JSON.stringify(BASE_FIXTURE, null, 2)}\n`);
  });

  // A run that scaffolds the correlation gate routes children through the correlation channel
  // itself, so whatever lifecycle phase it survived was survived by a router the real fixture
  // does not describe. That pass is conditional on M1 and may never reach the on-disk fixture.
  const CORRELATION_GATE_PATHS = ['probes.M1', 'correlation', 'correlationEntropy'] as const;

  test('a lifecycle pass is refused when the run scaffolded any part of the correlation gate', async () => {
    for (const scaffolded of CORRELATION_GATE_PATHS) {
      const error = await writeCapabilityFixture(
        'claude-code',
        '2.1.266',
        { runId: 'run-corr', scaffoldDeclared: true, scaffoldedPaths: ['status', 'lifecycle.*', scaffolded], lifecycle: { compaction: 'passed' } },
        dir,
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RouterError);
      expect((error as RouterError).code).toBe('fixture-writer-correlation-scaffold');
    }
    expect(await readFile(fixturePath, 'utf8')).toBe(`${JSON.stringify(BASE_FIXTURE, null, 2)}\n`);
  });

  test('failed and pending are still writable under the same scaffolded paths -- only a pass is refused', async () => {
    // The guard exists to stop an over-claim, not to make a scaffolded run unreportable: a phase
    // the run actually broke is real evidence whatever the router was scaffolded into doing.
    const scaffoldedPaths = ['status', ...CORRELATION_GATE_PATHS];

    await writeCapabilityFixture('claude-code', '2.1.266', { runId: 'run-corr-failed', scaffoldDeclared: true, scaffoldedPaths, lifecycle: { compaction: 'failed' } }, dir);
    expect(((JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown>).lifecycle as Record<string, string>).compaction).toBe('failed');

    await writeCapabilityFixture('claude-code', '2.1.266', { runId: 'run-corr-pending', scaffoldDeclared: true, scaffoldedPaths, lifecycle: { resume: 'pending' } }, dir);
    expect(((JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown>).lifecycle as Record<string, string>).resume).toBe('pending');
  });

  test('a lifecycle pass still writes when the declared scaffold names no correlation path, and when scaffoldedPaths is absent', async () => {
    await writeCapabilityFixture(
      'claude-code',
      '2.1.266',
      { runId: 'run-plain-scaffold', scaffoldDeclared: true, scaffoldedPaths: ['status', 'probes.M10', 'lifecycle.*'], lifecycle: { compaction: 'passed' } },
      dir,
    );
    expect(((JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown>).lifecycle as Record<string, string>).compaction).toBe('passed');

    await writeCapabilityFixture('claude-code', '2.1.266', { runId: 'run-no-scaffold-list', scaffoldDeclared: true, lifecycle: { nested: 'passed' } }, dir);
    expect(((JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown>).lifecycle as Record<string, string>).nested).toBe('passed');
  });

  test('writer-keeps-original-on-write-failure', async () => {
    const before = await readFile(fixturePath, 'utf8');
    const failure = new Error('simulated write failure');

    await expect(
      writeCapabilityFixture(
        'claude-code',
        '2.1.266',
        { runId: 'run-fail', scaffoldDeclared: true, probes: { 'M3-A': 'passed' } },
        dir,
        { writePayload: async () => { throw failure; } },
      ),
    ).rejects.toBe(failure);

    expect(await readFile(fixturePath, 'utf8')).toBe(before);
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dir);
    expect(entries.filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});
