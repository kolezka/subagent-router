// config.modelSource.staleAfterSeconds is schema-validated (src/core/config.ts) but was never
// read back against snapshot.fetchedAt anywhere. This covers the advisory consumers only: doctor
// and config check must report snapshot-stale without changing their exit code; route preview and
// serve must stay entirely unaffected (explicitly out of scope for this gap).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args';
import { runCli } from '../../src/cli/main';
import { startServeCommand } from '../../src/cli/write';
import type { CliDeps } from '../../src/core/types';
import { FIXTURE_FETCHED_AT, FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

let dir = '';
let out: string[] = [];
let err: string[] = [];

function deps(now: Date, patch: Partial<CliDeps> = {}): CliDeps {
  return {
    cwd: dir,
    home: join(dir, 'home'),
    env: { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 't', ROUTER_SECRET: 's' },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    isTTY: false,
    fetch: async () => {
      throw new Error('network forbidden in staleness tests');
    },
    fetchAdapter: { id: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic' },
    loadProfile: async (client, version) => ({
      client,
      version,
      status: 'pending',
      correlation: false,
      correlationEntropy: 'pending',
      fork: false,
      adapterMarkerPosition: 'unknown',
      probes: {},
      lifecycle: { 'next-turn': 'pending', resume: 'pending', compaction: 'pending', nested: 'pending', parallel: 'pending' },
    }),
    loadTransportProfile: async (adapterId, runtimeVersion) => ({ adapterId, runtimeVersion, status: 'pending', gzipBytes: 'pending', responseHeaders: 'pending' }),
    now: () => now,
    ...patch,
  };
}

function lastJson(): Record<string, unknown> {
  return JSON.parse(out.join('')) as Record<string, unknown>;
}

// 1s after fetchedAt: within any staleAfterSeconds window used below.
const FRESH_NOW = new Date(new Date(FIXTURE_FETCHED_AT).getTime() + 1000);
// 200s after fetchedAt: past the 50s (and 1s) windows used below.
const STALE_NOW = new Date(new Date(FIXTURE_FETCHED_AT).getTime() + 200 * 1000);

async function writeState(staleAfterSeconds: number): Promise<void> {
  await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(configFixture({ modelSource: { ...configFixture().modelSource, staleAfterSeconds } })));
  await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-staleness-'));
  out = [];
  err = [];
  await mkdir(join(dir, 'home', '.claude', 'agents'), { recursive: true });
  await writeFile(join(dir, 'home', '.claude', 'agents', 'explorer.md'), '---\nname: explorer\nmodel: inherit\n---\nSzukaj.\n');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('doctor: snapshot-stale advisory', () => {
  test('reports snapshot-stale once now is past fetchedAt + staleAfterSeconds', async () => {
    await writeState(50);
    expect(await runCli(['doctor', '--json'], deps(STALE_NOW))).toBe(0);
    expect(lastJson().snapshotStale).toBe(true);
  });

  test('does not report snapshot-stale for a fresh snapshot', async () => {
    await writeState(50);
    expect(await runCli(['doctor', '--json'], deps(FRESH_NOW))).toBe(0);
    expect(lastJson().snapshotStale).toBe(false);
  });
});

describe('config check: snapshot-stale advisory', () => {
  test('reports snapshot-stale as a warning; the advisory never changes the exit code', async () => {
    await writeState(50);
    expect(await runCli(['config', 'check', '--json'], deps(STALE_NOW))).toBe(0);
    expect(lastJson().warnings).toEqual(['snapshot-stale']);
    expect(lastJson().problems).toEqual([]);
  });

  test('reports no warnings for a fresh snapshot', async () => {
    await writeState(50);
    expect(await runCli(['config', 'check', '--json'], deps(FRESH_NOW))).toBe(0);
    expect(lastJson().warnings).toEqual([]);
  });
});

describe('route preview: unaffected by snapshot staleness (out of scope for this gap)', () => {
  test('a stale snapshot changes neither the payload shape nor the exit code', async () => {
    await writeState(50);
    expect(await runCli(['route', 'preview', '--client', 'claude-code', '--agent', 'explorer', '--json'], deps(STALE_NOW))).toBe(0);
    const payload = lastJson();
    expect(payload).not.toHaveProperty('snapshotStale');
    expect(payload).not.toHaveProperty('warnings');
    expect(payload.decision).toMatchObject({ kind: 'route', upstreamModel: FIXTURE_MODEL_ID, source: 'role-default' });
  });
});

describe('serve: unaffected by snapshot staleness (out of scope for this gap)', () => {
  test('starts successfully even with a badly stale snapshot', async () => {
    await writeState(1);
    const supported = deps(STALE_NOW, {
      loadProfile: async () => ({
        client: 'claude-code',
        version: 'synthetic-hermetic',
        status: 'supported',
        correlation: false,
        correlationEntropy: 'pending',
        fork: false,
        adapterMarkerPosition: 'unknown',
        probes: { M10: 'passed' },
        lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' },
      }),
      loadTransportProfile: async () => ({ adapterId: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic', status: 'passed', gzipBytes: 'passed', responseHeaders: 'passed' }),
    });

    const { result, server } = await startServeCommand(supported, parseArgs(['serve', '--port', '0', '--host', '127.0.0.1']));
    try {
      expect(result.code).toBe(0);
      expect(result.payload).not.toHaveProperty('snapshotStale');
      expect(result.payload).not.toHaveProperty('warnings');
    } finally {
      await server.stop();
    }
  });
});
