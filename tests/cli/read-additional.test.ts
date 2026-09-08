// Focused coverage for read.ts behaviors described in the Task 12 brief and design doc (D11) but
// not exercised by the brief's own tests/cli/read.test.ts fixture: the doctor per-client 'unknown'
// fallback, route preview's selection-error exit code, config check's model-reference validation,
// and the declaredModel 'unknown' fallback when an agent file has no `model:` field.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main';
import { RouterError } from '../../src/core/errors';
import type { CliDeps } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

let dir = '';
let out: string[] = [];
let err: string[] = [];

function deps(patch: Partial<CliDeps> = {}): CliDeps {
  return {
    cwd: dir,
    home: join(dir, 'home'),
    env: { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 'secret-token', ROUTER_SECRET: 'hook-secret' },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    isTTY: false,
    fetch: async () => {
      throw new Error('network forbidden in read-only CLI tests');
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
    now: () => new Date('2026-09-06T12:00:00.000Z'),
    ...patch,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-cli-extra-'));
  out = [];
  err = [];
  await mkdir(join(dir, 'home', '.claude', 'agents'), { recursive: true });
  await writeFile(join(dir, 'home', '.claude', 'agents', 'explorer.md'), '---\nname: explorer\nmodel: inherit\n---\nSzukaj.\n');
  await writeFile(join(dir, 'home', '.claude', 'agents', 'nomodel.md'), '---\nname: nomodel\n---\nBrak deklaracji modelu.\n');
  await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(configFixture()));
  await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/undescribed'])));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function lastJson(): Record<string, unknown> {
  return JSON.parse(out.join('')) as Record<string, unknown>;
}

describe('doctor: per-client capability lookup failure', () => {
  test('a RouterError from loadProfile for one client is reported as that client status "unknown", not a crash', async () => {
    const d = deps({
      loadProfile: async (client, version) => {
        if (client === 'opencode') throw new RouterError('capability-unknown-version', 'no capability fixture for opencode 9.9.9');
        return {
          client,
          version,
          status: 'pending',
          correlation: false,
          correlationEntropy: 'pending',
          fork: false,
          adapterMarkerPosition: 'unknown',
          probes: {},
          lifecycle: { 'next-turn': 'pending', resume: 'pending', compaction: 'pending', nested: 'pending', parallel: 'pending' },
        };
      },
    });
    expect(await runCli(['doctor', '--json'], d)).toBe(0);
    const report = lastJson();
    const clients = report.clients as Array<Record<string, unknown>>;
    expect(clients.find((c) => c.client === 'opencode')?.status).toBe('unknown');
    expect(clients.find((c) => c.client === 'claude-code')?.status).toBe('pending');
    expect(clients.find((c) => c.client === 'codex')?.status).toBe('pending');
  });
});

describe('route preview: selection errors are exit code 2, not 0', () => {
  test('an unknown --model does not crash the command; it is a selection error (kind: error) mapped to exit 2', async () => {
    expect(
      await runCli(['route', 'preview', '--client', 'claude-code', '--agent', 'explorer', '--model', 'gateway/does-not-exist', '--json'], deps()),
    ).toBe(2);
    const preview = lastJson();
    expect(preview.mode).toBe('simulation');
    expect(preview.decision).toMatchObject({ kind: 'error', code: 'unknown-model' });
  });
});

describe('config check: routeOverride referencing an unknown model', () => {
  test('a role whose routeOverride is not in the snapshot is reported as a problem, agent existing or not', async () => {
    const broken = configFixture({ roles: { 'claude-code:explorer': { routeOverride: 'gateway/does-not-exist' } } });
    await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(broken));
    expect(await runCli(['config', 'check', '--json'], deps())).toBe(2);
    const problems = JSON.stringify(lastJson().problems);
    expect(problems).toContain('claude-code:explorer');
    expect(problems).toContain('gateway/does-not-exist');
  });

  test('a config with only valid role references reports zero problems and exit 0', async () => {
    expect(await runCli(['config', 'check', '--json'], deps())).toBe(0);
    expect(lastJson().problems).toEqual([]);
  });
});

describe('route preview: never depends on a capability-profile lookup', () => {
  // Regression for a real built-CLI failure: routePreview used to call deps.loadProfile(client,
  // 'unspecified') even though previewRoute never consumed the result. A real loadProfile (unlike
  // this suite's stub) does a genuine lookup against shipped profiles and throws
  // capability-unknown-version for the literal placeholder version 'unspecified', turning an
  // otherwise fully offline command into one that fails outside tests. If that dead dependency
  // were reintroduced, this loadProfile would make the command fail (exit 1, a RouterError with a
  // code isUsageOrConfigCode does not classify as usage/config), not exit 0.
  test('succeeds even when deps.loadProfile always throws, and every simulation assumption is preserved', async () => {
    const throwing = deps({
      loadProfile: async () => {
        throw new RouterError('capability-unknown-version', 'no capability fixture for this version');
      },
    });
    expect(await runCli(['route', 'preview', '--client', 'claude-code', '--agent', 'explorer', '--json'], throwing)).toBe(0);
    const preview = lastJson();
    expect(preview.mode).toBe('simulation');
    expect(preview.assumptions).toEqual({ authenticatedChild: true, freshDelegation: true, runtimeCapabilityNotProven: true });
    expect(preview.decision).toMatchObject({ kind: 'route', upstreamModel: FIXTURE_MODEL_ID });
  });
});

describe('agents show: declaredModel falls back to "unknown" when the file has no model field', () => {
  test('an agent file without a model: key reports declaredModel "unknown", not undefined or "inherit"', async () => {
    expect(await runCli(['agents', 'show', 'nomodel', '--client', 'claude-code', '--json'], deps())).toBe(0);
    expect(lastJson()).toMatchObject({ name: 'nomodel', declaredModel: 'unknown' });
  });
});
