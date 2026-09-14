// Exercises the web console's auto-detection helpers. `detect` must never throw for an
// environment problem (missing config, unreachable gateway, absent client binary): every test
// below either drives that contract directly or checks one of the pure helpers around it.
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliDeps } from '../../src/core/types';
import { RouterError } from '../../src/core/errors';
import { assertLoopbackUrl, detect, envReport, suggestConfig } from '../../src/web/detect';
import { configFixture } from '../support/fixtures';

const SECRET_VALUE = 'super-secret-gateway-token-do-not-leak';

let cwd = '';
let home = '';

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'subagent-router-detect-cwd-'));
  home = await mkdtemp(join(tmpdir(), 'subagent-router-detect-home-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

function testDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    cwd,
    home,
    env: {},
    stdout: () => {},
    stderr: () => {},
    isTTY: false,
    fetch: () => Promise.reject(new Error('detect must not dial out unless a test stubs fetch')),
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
      lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' },
    }),
    loadTransportProfile: async () => ({ adapterId: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic', status: 'passed', gzipBytes: 'passed', responseHeaders: 'passed' }),
    now: () => new Date(),
    ...overrides,
  };
}

function assertClientShape(report: Awaited<ReturnType<typeof detect>>): void {
  expect(report.clients.map((c) => c.client)).toEqual(['claude-code', 'opencode', 'codex']);
  for (const client of report.clients) {
    expect(client.binary === null || typeof client.binary === 'string').toBe(true);
    expect(client.version === null || typeof client.version === 'string').toBe(true);
    expect(['supported', 'unsupported', 'pending', 'unknown']).toContain(client.profileStatus);
    expect(Array.isArray(client.agentRoots)).toBe(true);
  }
}

describe('detect: config health', () => {
  test('no config at all: reports missing health and the well-known default env names', async () => {
    const configPath = join(cwd, 'subagent-router.json');
    const report = await detect({ deps: testDeps(), configPath });

    expect(report.config).toEqual({ path: configPath, exists: false, health: 'missing', snapshotPresent: false });
    expect(report.gateways).toBeNull();
    expect(report.bundles).toEqual([]);
    expect(report.env.map((e) => e.name)).toContain('ROUTER_GATEWAY_URL');
    expect(report.env.find((e) => e.purpose === 'correlation-secret')?.name).toBe('ROUTER_SECRET');
    assertClientShape(report);
  });

  test('a valid config: reports ok health and the config-declared env names', async () => {
    const configPath = join(cwd, 'subagent-router.json');
    await writeFile(configPath, JSON.stringify(configFixture()));

    const report = await detect({ deps: testDeps(), configPath });

    expect(report.config.exists).toBe(true);
    expect(report.config.health).toBe('ok');
    expect(report.config.snapshotPresent).toBe(false);
    expect(report.env.find((e) => e.purpose === 'correlation-secret')?.name).toBe('ROUTER_SECRET');
    expect(report.env.find((e) => e.purpose === 'gateway-url')?.name).toBe('GATEWAY_URL');
    assertClientShape(report);
  });

  test('an invalid config: reports invalid health, not a thrown error', async () => {
    const configPath = join(cwd, 'subagent-router.json');
    await writeFile(configPath, '{ this is not json');

    const report = await detect({ deps: testDeps(), configPath });

    expect(report.config.exists).toBe(true);
    expect(report.config.health).toBe('invalid');
  });

  test('reports the snapshot as present once one has been synced', async () => {
    const configPath = join(cwd, 'subagent-router.json');
    await writeFile(configPath, JSON.stringify(configFixture()));
    await writeFile(join(cwd, 'models.lock.json'), JSON.stringify({ version: 1, sourceId: 'test-gateway', sourceFingerprint: 'x', fetchedAt: new Date().toISOString(), models: [] }));

    const report = await detect({ deps: testDeps(), configPath });
    expect(report.config.health).toBe('ok');
    expect(report.config.snapshotPresent).toBe(true);
  });
});

describe('detect: agent roots', () => {
  test('reports only roots that exist, with agent counts from the real inventory scan', async () => {
    await mkdir(join(cwd, '.claude', 'agents'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'agents', 'explorer.md'), '---\nname: explorer\n---\nExplore.\n');
    await writeFile(join(cwd, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nReview.\n');

    const configPath = join(cwd, 'subagent-router.json');
    const report = await detect({ deps: testDeps(), configPath });

    const claudeCode = report.clients.find((c) => c.client === 'claude-code');
    expect(claudeCode?.agentRoots).toEqual([{ path: join(cwd, '.claude', 'agents'), scope: 'project', agentCount: 2 }]);

    // The user-scope root (home/.claude/agents) was never created, so it must not appear at all.
    expect(claudeCode?.agentRoots.some((r) => r.scope === 'user')).toBe(false);
  });

  test('profileStatus reports unknown when loadProfile fails with a RouterError', async () => {
    const configPath = join(cwd, 'subagent-router.json');
    const deps = testDeps({
      loadProfile: async () => {
        throw new RouterError('capability-unknown-version', 'no fixture for this version');
      },
    });

    const report = await detect({ deps, configPath });
    expect(report.clients.every((c) => c.profileStatus === 'unknown')).toBe(true);
  });
});

describe('envReport: secret values never leak', () => {
  test('the JSON of the report never contains a live secret value', () => {
    const config = configFixture();
    const env = { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 'a-token', ROUTER_SECRET: SECRET_VALUE };

    const report = envReport(config, env);

    expect(JSON.stringify(report)).not.toContain(SECRET_VALUE);
    expect(report.find((e) => e.purpose === 'correlation-secret')).toEqual({ name: 'ROUTER_SECRET', present: true, purpose: 'correlation-secret' });
  });

  // This is the positive control for the assertion above: it proves the check would actually
  // fail if a secret leaked. Verified once against a disposable copy of the repo (never against
  // this working tree): envReport's returned objects were edited to carry `value: env[name]`,
  // `bun test tests/web/detect.test.ts` there failed both this test and the one below with the
  // secret text in the diff, and the copy was discarded.
  test('present is a boolean derived from env, never the value itself', () => {
    const config = configFixture();
    const report = envReport(config, { ROUTER_SECRET: SECRET_VALUE });
    const secretReport = report.find((e) => e.purpose === 'correlation-secret');
    expect(secretReport?.present).toBe(true);
    expect(Object.keys(secretReport ?? {}).sort()).toEqual(['name', 'present', 'purpose']);
  });

  test('present is false for an empty or missing variable', () => {
    const config = configFixture();
    const report = envReport(config, { ROUTER_SECRET: '' });
    expect(report.find((e) => e.purpose === 'correlation-secret')?.present).toBe(false);
    expect(report.find((e) => e.purpose === 'gateway-url')?.present).toBe(false);
  });
});

describe('detect: gateway probing', () => {
  test('is off by default', async () => {
    const configPath = join(cwd, 'subagent-router.json');
    const report = await detect({ deps: testDeps(), configPath });
    expect(report.gateways).toBeNull();
  });

  test('probes candidates concurrently: one succeeds, one fails, none of it throws', async () => {
    const configPath = join(cwd, 'subagent-router.json');
    const deps = testDeps({
      fetch: async (request) => {
        if (request.url === 'http://127.0.0.1:3456/v1/models') {
          return new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }), { status: 200 });
        }
        if (request.url === 'http://127.0.0.1:8317/v1/models') {
          throw new Error('connection refused');
        }
        return new Response('not found', { status: 404 });
      },
    });

    const report = await detect({ deps, configPath, probeGateways: true });
    const gateways = report.gateways;
    if (gateways === null) throw new Error('expected a gateway probe result, got null');

    expect(gateways).toEqual([{ url: 'http://127.0.0.1:3456/v1', label: 'claude-code-router', modelCount: 3 }]);
  });

  test('a non-OpenAI-shaped 200 response is treated as not found, not a crash', async () => {
    const configPath = join(cwd, 'subagent-router.json');
    const deps = testDeps({ fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }) });

    const report = await detect({ deps, configPath, probeGateways: true });
    expect(report.gateways).toEqual([]);
  });
});

describe('assertLoopbackUrl: the non-loopback refusal', () => {
  test('accepts loopback address literals', () => {
    expect(() => assertLoopbackUrl('http://127.0.0.1:3456/v1')).not.toThrow();
    expect(() => assertLoopbackUrl('http://[::1]:3456/v1')).not.toThrow();
  });

  test('refuses a named host, even a conventionally loopback one', () => {
    expect(() => assertLoopbackUrl('http://evil.example:3456/v1')).toThrow(RouterError);
    expect(() => assertLoopbackUrl('http://localhost:3456/v1')).toThrow(RouterError);
  });
});

describe('suggestConfig', () => {
  test('produces a scaffold with the operator-chosen env names in the right slots', () => {
    const config = suggestConfig({
      sourceId: 'my-gateway',
      endpointPath: '/v1/models',
      gatewayUrlEnv: 'MY_GATEWAY_URL',
      gatewayHeadersEnv: ['MY_GATEWAY_HEADERS'],
      modelsBaseUrlEnv: 'MY_GATEWAY_URL',
      modelsAuthEnv: 'MY_MODELS_AUTH',
      modelsHeadersEnv: [],
      correlationSecretEnv: 'MY_SECRET',
    });

    expect(config.version).toBe(1);
    expect(config.modelSource.sourceId).toBe('my-gateway');
    expect(config.modelSource.baseUrlEnv).toBe('MY_GATEWAY_URL');
    expect(config.modelSource.authEnv).toBe('MY_MODELS_AUTH');
    expect(config.gateway.urlEnv).toBe('MY_GATEWAY_URL');
    expect(config.gateway.headersEnv).toEqual(['MY_GATEWAY_HEADERS']);
    expect(config.harness.claudeCode.secretEnv).toBe('MY_SECRET');
    expect(config.roles).toEqual({});
    expect(config.modelOverrides).toEqual({});
  });

  test('omits authEnv entirely when the caller does not supply one', () => {
    const config = suggestConfig({
      sourceId: 'my-gateway',
      endpointPath: '/v1/models',
      gatewayUrlEnv: 'MY_GATEWAY_URL',
      gatewayHeadersEnv: [],
      modelsBaseUrlEnv: 'MY_GATEWAY_URL',
      modelsHeadersEnv: [],
      correlationSecretEnv: 'MY_SECRET',
    });
    expect('authEnv' in config.modelSource).toBe(false);
  });
});

describe('detect: install bundles', () => {
  test('finds a bundle written by install next to the config', async () => {
    const configPath = join(cwd, 'subagent-router.json');
    const bundleDir = join(cwd, 'router-bundle');
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' } }));
    await writeFile(join(bundleDir, 'claude-router'), '#!/bin/sh\n');

    const report = await detect({ deps: testDeps(), configPath });
    expect(report.bundles).toEqual([{ path: bundleDir, routerUrl: 'http://127.0.0.1:8787' }]);
  });

  test('ignores a directory that only holds one of the two required files', async () => {
    const configPath = join(cwd, 'subagent-router.json');
    await mkdir(join(cwd, 'router-bundle'), { recursive: true });
    await writeFile(join(cwd, 'router-bundle', 'settings.json'), '{}');

    const report = await detect({ deps: testDeps(), configPath });
    expect(report.bundles).toEqual([]);
  });
});
