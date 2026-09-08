import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main';
import { sha256 } from '../../src/core/hash';
import type { CliDeps, FetchLike } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

let dir = '';
let out: string[] = [];
let err: string[] = [];

function listing(ids: string[]): FetchLike {
  return async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
}

function deps(fetch: FetchLike): CliDeps {
  return {
    cwd: dir,
    home: join(dir, 'home'),
    env: { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 'secret-token', ROUTER_SECRET: 'hook-secret' },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    isTTY: false,
    fetch,
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
    now: () => new Date('2026-09-06T12:00:00.000Z'),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-write-'));
  out = [];
  err = [];
  await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(configFixture()));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function lastJson(): Record<string, unknown> {
  return JSON.parse(out.join('')) as Record<string, unknown>;
}

describe('models sync', () => {
  test('dry-run shows the diff and writes no snapshot', async () => {
    expect(await runCli(['models', 'sync', '--dry-run', '--json'], deps(listing(['a'])))).toBe(0);
    expect(lastJson().added).toEqual(['a']);
    await expect(readFile(join(dir, 'models.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('an empty list without --allow-empty exits 1 and writes no file', async () => {
    expect(await runCli(['models', 'sync'], deps(listing([])))).toBe(1);
    expect(err.join('')).toContain('sync-empty');
    await expect(readFile(join(dir, 'models.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('an empty list with --allow-empty succeeds and writes the snapshot', async () => {
    expect(await runCli(['models', 'sync', '--allow-empty', '--json'], deps(listing([])))).toBe(0);
    expect(lastJson()).toMatchObject({ added: [], changed: [], missing: [] });
    await expect(readFile(join(dir, 'models.lock.json'))).resolves.toBeTruthy();
  });

  test('an auth error never prints the token and keeps the previous snapshot', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    const before = await sha256(await readFile(join(dir, 'models.lock.json'), 'utf8'));
    const unauthorized: FetchLike = async () => new Response('nope', { status: 401 });
    expect(await runCli(['models', 'sync'], deps(unauthorized))).toBe(1);
    expect(err.join('')).not.toContain('secret-token');
    expect(await sha256(await readFile(join(dir, 'models.lock.json'), 'utf8'))).toBe(before);
  });

  // describeModel never calls deps.now(), so it has no safe synchronous hook to force a real
  // store-conflict without a timing race. `synchronize` does call deps.now() synchronously right
  // before commitState, so this reuses that real call to mutate the config file in between sync's
  // own loadState and commitState. Because the mutation is a synchronous writeFileSync inside a
  // synchronous callback, this is deterministic (no timing window), not a race. commitState's own
  // conflict detection is already unit-tested directly against a stale base in
  // tests/io/store.test.ts ("rejects a concurrent config edit..."); this only checks the CLI's
  // error-code-to-exit-code mapping for store-conflict.
  test('a config write racing the commit is reported as store-conflict and exits 1', async () => {
    const racing = deps(listing(['a']));
    racing.now = () => {
      writeFileSync(join(dir, 'subagent-router.json'), `${JSON.stringify(configFixture({ defaults: { child: null, unmarkedSubagent: 'inherit' } }))}\n`);
      return new Date('2026-09-06T12:00:00.000Z');
    };
    expect(await runCli(['models', 'sync'], racing)).toBe(1);
    expect(err.join('')).toContain('store-conflict');
  });
});

describe('models describe', () => {
  test('writes the description into modelOverrides by exact ID, not into the snapshot', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/other'])));
    const snapshotBefore = await readFile(join(dir, 'models.lock.json'), 'utf8');
    expect(await runCli(['models', 'describe', 'gateway/other', '--text', 'Slow but accurate.'], deps(listing([])))).toBe(0);
    const config = JSON.parse(await readFile(join(dir, 'subagent-router.json'), 'utf8'));
    expect(config.modelOverrides['gateway/other']).toEqual({ description: 'Slow but accurate.' });
    expect(await readFile(join(dir, 'models.lock.json'), 'utf8')).toBe(snapshotBefore);
  });

  test('--text, --file and --clear are mutually exclusive, and --clear removes only the description', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    expect(await runCli(['models', 'describe', 'fast', '--text', 'a', '--clear'], deps(listing([])))).toBe(2);
    expect(await runCli(['models', 'describe', 'fast', '--clear'], deps(listing([])))).toBe(0);
    const config = JSON.parse(await readFile(join(dir, 'subagent-router.json'), 'utf8'));
    expect(config.modelOverrides[FIXTURE_MODEL_ID]).toEqual({ alias: 'fast', enabled: true, clientModel: 'haiku' });
  });

  test('neither --text, --file nor --clear given is a usage error, exit 2', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    expect(await runCli(['models', 'describe', 'fast'], deps(listing([])))).toBe(2);
    expect(err.join('')).toContain('usage-describe-mode');
  });

  test('--file reads the description from disk and trims one trailing newline', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    await writeFile(join(dir, 'desc.txt'), 'Reads code carefully.\n');
    expect(await runCli(['models', 'describe', 'fast', '--file', 'desc.txt'], deps(listing([])))).toBe(0);
    const config = JSON.parse(await readFile(join(dir, 'subagent-router.json'), 'utf8'));
    expect(config.modelOverrides[FIXTURE_MODEL_ID].description).toBe('Reads code carefully.');
  });

  test('describing a missing-status model still saves the description; the model stays disabled', async () => {
    const snapshot = await snapshotFixture([FIXTURE_MODEL_ID]);
    (snapshot.models[0] as { status: string }).status = 'missing';
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(snapshot));
    expect(await runCli(['models', 'describe', FIXTURE_MODEL_ID, '--text', 'new'], deps(listing([])))).toBe(0);
    out = [];
    expect(await runCli(['models', 'show', FIXTURE_MODEL_ID, '--json'], deps(listing([])))).toBe(0);
    expect(lastJson()).toMatchObject({ description: 'new', status: 'missing', enabled: false });
  });

  test('an unknown model reference is exit 2, unknown-model, and writes nothing', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    const before = await readFile(join(dir, 'subagent-router.json'), 'utf8');
    expect(await runCli(['models', 'describe', 'gateway/does-not-exist', '--text', 'x'], deps(listing([])))).toBe(2);
    expect(err.join('')).toContain('unknown-model');
    expect(await readFile(join(dir, 'subagent-router.json'), 'utf8')).toBe(before);
  });

  test('missing snapshot is snapshot-missing, exit 2', async () => {
    expect(await runCli(['models', 'describe', 'fast', '--text', 'x'], deps(listing([])))).toBe(2);
    expect(err.join('')).toContain('snapshot-missing');
  });
});

describe('doctor --connect', () => {
  test('connects, reports the model count, and writes nothing', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    expect(await runCli(['doctor', '--connect', '--json'], deps(listing(['a', 'b'])))).toBe(0);
    const report = lastJson();
    expect(report.connectivity).toMatchObject({ ok: true, modelCount: 2 });
    // --connect always performs a real network attempt, success or failure: `network` must say
    // so, not carry over the plain-doctor "never dials out" value of false.
    expect(report.network).toBe(true);
  });

  test('an operational connectivity failure (discovery-auth) exits 1 with a visible stderr diagnostic, and still reports network:true plus the full offline report', async () => {
    const unauthorized: FetchLike = async () => new Response('nope', { status: 401 });
    expect(await runCli(['doctor', '--connect', '--json'], deps(unauthorized))).toBe(1);
    expect(err.join('')).toContain('discovery-auth');
    const report = lastJson();
    expect(report.connectivity).toMatchObject({ ok: false, error: 'discovery-auth' });
    expect(report.network).toBe(true);
    expect((report.clients as unknown[]).length).toBe(3);
  });

  test('a configuration failure surfaced by the connectivity check (config-missing) exits 2, not 1', async () => {
    await rm(join(dir, 'subagent-router.json'));
    expect(await runCli(['doctor', '--connect', '--json'], deps(listing(['a'])))).toBe(2);
    expect(err.join('')).toContain('config-missing');
    const report = lastJson();
    expect(report.connectivity).toMatchObject({ ok: false, error: 'config-missing' });
  });

  test('human-readable output does not claim "offline diagnostics only" once --connect ran a real check', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    expect(await runCli(['doctor', '--connect'], deps(listing(['a'])))).toBe(0);
    const text = out.join('');
    expect(text).not.toContain('offline diagnostics only');
    expect(text).toContain('network: true');
  });

  test('plain doctor (no --connect) never dials out and keeps reporting network:false', async () => {
    const spy: FetchLike = async () => {
      throw new Error('doctor must not fetch without --connect');
    };
    expect(await runCli(['doctor', '--json'], deps(spy))).toBe(0);
    const report = lastJson();
    expect(report.connectivity).toBeUndefined();
    expect(report.network).toBe(false);
  });
});
