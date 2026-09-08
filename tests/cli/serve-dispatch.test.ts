// Focused coverage for the `serve` CLI dispatch/argument layer this worktree owns: option
// parsing, defaults and error-code mapping. The full request/response pipeline through a real
// loopback Bun.serve instance is already covered by tests/cli/serve.test.ts (startServer directly,
// not owned here). Two tests here also start a real loopback server to confirm the wiring; both
// stop it in a `finally` block so nothing leaks past the test.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args';
import { runCli } from '../../src/cli/main';
import { resolveServeOptions, startServeCommand } from '../../src/cli/write';
import type { CliDeps, FetchLike } from '../../src/core/types';
import { configFixture, snapshotFixture } from '../support/fixtures';

let dir = '';
let out: string[] = [];
let err: string[] = [];

function deps(patch: Partial<CliDeps> = {}): CliDeps {
  const fetchLike: FetchLike = async () => {
    throw new Error('network forbidden in serve dispatch tests');
  };
  return {
    cwd: dir,
    home: dir,
    env: { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 't', ROUTER_SECRET: 's' },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    isTTY: false,
    fetch: fetchLike,
    fetchAdapter: { id: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic' },
    loadProfile: async () => ({
      client: 'claude-code',
      version: 'synthetic-hermetic',
      status: 'pending',
      correlation: false,
      correlationEntropy: 'pending',
      fork: false,
      adapterMarkerPosition: 'unknown',
      probes: {},
      lifecycle: { 'next-turn': 'pending', resume: 'pending', compaction: 'pending', nested: 'pending', parallel: 'pending' },
    }),
    loadTransportProfile: async () => ({ adapterId: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic', status: 'pending', gzipBytes: 'pending', responseHeaders: 'pending' }),
    now: () => new Date(),
    ...patch,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-serve-cli-'));
  out = [];
  err = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('serve: argument validation (no server ever started)', () => {
  test('a non-numeric --port is a usage error, exit 2', async () => {
    expect(await runCli(['serve', '--port', 'abc'], deps())).toBe(2);
    expect(err.join('')).toContain('usage-invalid-port');
  });

  test('an out-of-range --port is a usage error, exit 2', async () => {
    expect(await runCli(['serve', '--port', '99999'], deps())).toBe(2);
    expect(err.join('')).toContain('usage-invalid-port');
  });

  test('missing config is exit 2 (config-missing)', async () => {
    expect(await runCli(['serve', '--port', '0'], deps())).toBe(2);
    expect(err.join('')).toContain('config-missing');
  });

  test('missing snapshot is exit 2 (snapshot-missing)', async () => {
    await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(configFixture()));
    expect(await runCli(['serve', '--port', '0'], deps())).toBe(2);
    expect(err.join('')).toContain('snapshot-missing');
  });
});

describe('serve: fails on unmeasured profiles, never bypasses', () => {
  test('a pending capability/transport profile refuses to start (unsupported-path), exit 1', async () => {
    await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(configFixture()));
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    expect(await runCli(['serve', '--port', '0'], deps())).toBe(1);
    expect(err.join('')).toContain('unsupported-path');
  });
});

describe('serve: defaults', () => {
  test('defaults to loopback host and the project convention port 8787 when omitted', () => {
    expect(resolveServeOptions(deps(), parseArgs(['serve']))).toEqual({ port: 8787, host: '127.0.0.1' });
  });

  test('an explicit --host and --port override the defaults', () => {
    expect(resolveServeOptions(deps(), parseArgs(['serve', '--port', '0', '--host', '0.0.0.0']))).toEqual({ port: 0, host: '0.0.0.0' });
  });

  test('--claude-version is passed through when given, omitted otherwise', () => {
    expect(resolveServeOptions(deps(), parseArgs(['serve']))).not.toHaveProperty('claudeVersion');
    expect(resolveServeOptions(deps(), parseArgs(['serve', '--claude-version', '2.1.263']))).toMatchObject({ claudeVersion: '2.1.263' });
  });
});

describe('serve: successful start', () => {
  test('starts on an explicit port/host and returns the bound url plus generation', async () => {
    await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(configFixture()));
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    const supported = deps({
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
      expect(result.payload).toMatchObject({ host: '127.0.0.1', port: 0 });
      expect(typeof (result.payload as { url: string }).url).toBe('string');
      expect(typeof server.generation).toBe('string');
    } finally {
      await server.stop();
    }
  });
});
