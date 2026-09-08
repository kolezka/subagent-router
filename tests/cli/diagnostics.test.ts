// Review-fix round: two findings.
// 1. runCli/doctorConnect write raw error text to stderr instead of going through the same
//    escapeControl boundary human() output already uses -- a raw ESC byte from user input or a
//    gateway-controlled value (a model ID) reaches the terminal, --json or not.
// 2. doctorConnect rethrows a raw fetch rejection (network unreachable, or the discovery timeout
//    firing), discarding the offline report it already built.
// Fixtures for this file live under tests/tmp, not the OS temp dir, per this round's brief.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main';
import type { CliDeps, FetchLike } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

const TESTS_TMP_ROOT = join(import.meta.dir, '..', 'tmp');
const ESC = '\x1b[31m';

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
  await mkdir(TESTS_TMP_ROOT, { recursive: true });
  dir = await mkdtemp(join(TESTS_TMP_ROOT, 'subagent-router-diagnostics-'));
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

describe('Finding 1: terminal control escaping in CLI diagnostics', () => {
  test('an unknown command containing ESC does not leak the raw byte to stderr', async () => {
    const escCmd = `zzz${ESC}unknown`;
    expect(await runCli([escCmd], deps(listing([])))).toBe(2);
    expect(err.join('')).not.toContain(ESC);
    expect(err.join('')).toContain('unknown command');
  });

  test('models show with an unknown ESC-laden reference does not leak raw ESC, --json or not', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    const escRef = `gateway/${ESC}ghost`;

    expect(await runCli(['models', 'show', escRef, '--json'], deps(listing([])))).toBe(2);
    expect(err.join('')).not.toContain(ESC);
    expect(err.join('')).toContain('unknown-model');
    expect(err.join('')).toContain('\\u001b'); // escaped form present: content is preserved, not stripped

    err = [];
    expect(await runCli(['models', 'show', escRef], deps(listing([])))).toBe(2); // no --json
    expect(err.join('')).not.toContain(ESC);
  });

  test('models sync reports a gateway-controlled duplicate model ID without leaking raw ESC, and publishes no snapshot', async () => {
    const escId = `gateway/dup${ESC}`;
    const malicious: FetchLike = async () => new Response(JSON.stringify({ data: [{ id: escId }, { id: escId }] }), { status: 200 });
    expect(await runCli(['models', 'sync'], deps(malicious))).toBe(1); // discovery-duplicate: operational, not usage/config
    expect(err.join('')).not.toContain(ESC);
    expect(err.join('')).toContain('discovery-duplicate');
    await expect(readFile(join(dir, 'models.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('doctor --connect does not leak raw ESC from a bad --config path either', async () => {
    const escConfigPath = join(dir, `${ESC}missing-subagent-router.json`);
    expect(await runCli(['doctor', '--connect', '--config', escConfigPath], deps(listing(['a'])))).toBe(2); // config-missing
    expect(err.join('')).not.toContain(ESC);
    expect(err.join('')).toContain('config-missing');
  });

  test('a missing --file input for models describe stays exit 1 (operational I/O), and the resolved path is escaped', async () => {
    const escFileName = `${ESC}nonexistent.txt`;
    expect(await runCli(['models', 'describe', 'fast', '--file', escFileName], deps(listing([])))).toBe(1);
    expect(err.join('')).not.toContain(ESC);
  });
});

describe('Finding 2: doctor --connect on an unreachable or slow gateway', () => {
  test('a rejected fetch (unreachable gateway) is exit 1, still decodes the full report, writes nothing, and never echoes the raw error text', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    const configBefore = await readFile(join(dir, 'subagent-router.json'), 'utf8');
    const snapshotBefore = await readFile(join(dir, 'models.lock.json'), 'utf8');
    const secretMarker = 's3cr3t-token-should-never-appear';
    const unreachable: FetchLike = async () => {
      throw new TypeError(`fetch failed: could not connect to http://user:${secretMarker}@127.0.0.1:8000/v1/models`);
    };

    expect(await runCli(['doctor', '--connect', '--json'], deps(unreachable))).toBe(1);
    const report = lastJson();
    expect(report.connectivity).toMatchObject({ ok: false, error: 'discovery-unreachable' });
    expect(report.network).toBe(true);
    expect((report.clients as unknown[]).length).toBe(3); // offline report decoded, not discarded

    expect(out.join('')).not.toContain(secretMarker);
    expect(err.join('')).not.toContain(secretMarker);
    expect(await readFile(join(dir, 'subagent-router.json'), 'utf8')).toBe(configBefore);
    expect(await readFile(join(dir, 'models.lock.json'), 'utf8')).toBe(snapshotBefore);
  });

  test('a timeout (DOMException TimeoutError) is exit 1, reported as discovery-timeout, and still decodes the full report', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    const timedOut: FetchLike = async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    };

    expect(await runCli(['doctor', '--connect', '--json'], deps(timedOut))).toBe(1);
    const report = lastJson();
    expect(report.connectivity).toMatchObject({ ok: false, error: 'discovery-timeout' });
    expect(report.network).toBe(true);
    expect((report.clients as unknown[]).length).toBe(3);
  });

  test('human output says a check was "requested" (not "performed") when config validation fails before any request', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    const noAuthDeps: CliDeps = {
      ...deps(listing(['a'])),
      env: { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', ROUTER_SECRET: 'hook-secret' }, // MODELS_AUTH missing
    };
    expect(await runCli(['doctor', '--connect'], noAuthDeps)).toBe(1); // source-env-missing: operational
    const text = out.join('');
    expect(text).toContain('requested');
    expect(text).not.toContain('connectivity check performed');
  });

  test('human output says "performed" once a request was actually attempted, success or failure', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    expect(await runCli(['doctor', '--connect'], deps(listing(['a'])))).toBe(0);
    expect(out.join('')).toContain('connectivity check performed');
  });
});

// Locks the existing (pre-review) contract this round must not disturb.
describe('unchanged from the previous round', () => {
  test('a successful models describe still round-trips normally', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    expect(await runCli(['models', 'describe', FIXTURE_MODEL_ID, '--text', 'still fine'], deps(listing([])))).toBe(0);
  });
});
