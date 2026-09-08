// Exercises the real startServer against the real createHandler pipeline through a real
// loopback Bun.serve instance and a real fixture gateway (Task 7). Mirrors the Task 13 plan's
// Step 3 test plus two rows requested by the PoC brief (parent passthrough, missing-selection).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/cli/serve';
import { modelAlias, sourceFingerprint } from '../../src/core/hash';
import type { CatalogSnapshot, CliDeps, Env, FetchLike } from '../../src/core/types';
import { resolveSource } from '../../src/io/environment';
import { startCaptureGateway } from '../support/capture-gateway';
import { FIXTURE_FETCHED_AT, FIXTURE_MODEL_ID, configFixture } from '../support/fixtures';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-serve-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// snapshotFixture() from tests/support/fixtures.ts fingerprints a fixed placeholder gateway URL.
// A real gateway here binds an ephemeral port, so the snapshot must be fingerprinted against
// that actual URL (via the real resolveSource) or validateSource rejects it as a mismatch.
async function writeFixtureState(gatewayEnvUrl: string): Promise<void> {
  const config = configFixture();
  await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(config));

  const env: Env = { GATEWAY_URL: gatewayEnvUrl, GATEWAY_HEADERS: '{}', MODELS_AUTH: 't' };
  const source = resolveSource(config, env);
  const snapshot: CatalogSnapshot = {
    version: 1,
    sourceId: source.sourceId,
    sourceFingerprint: await sourceFingerprint(source.sourceId, source.effectiveGatewayUrl, source.effectiveModelsUrl),
    fetchedAt: FIXTURE_FETCHED_AT,
    models: [{ id: FIXTURE_MODEL_ID, alias: await modelAlias(FIXTURE_MODEL_ID), status: 'available', metadata: {} }],
  };
  await writeFile(join(dir, 'models.lock.json'), JSON.stringify(snapshot));
}

function testDeps(gatewayEnvUrl: string): CliDeps {
  const fetchLike: FetchLike = (request) => fetch(request);
  return {
    cwd: dir,
    home: dir,
    env: { GATEWAY_URL: gatewayEnvUrl, GATEWAY_HEADERS: '{}', MODELS_AUTH: 't', ROUTER_SECRET: 's' },
    stdout: () => {},
    stderr: () => {},
    isTTY: false,
    fetch: fetchLike,
    fetchAdapter: { id: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic' },
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
    now: () => new Date(),
  };
}

describe('serve', () => {
  test('uses the generation captured at start time and does not see a later config edit', async () => {
    const gateway = await startCaptureGateway();
    const gatewayEnvUrl = `${gateway.url}/v1`;
    await writeFixtureState(gatewayEnvUrl);
    const deps = testDeps(gatewayEnvUrl);
    const server = await startServer(join(dir, 'subagent-router.json'), deps, { port: 0, host: '127.0.0.1' });
    try {
      const changed = configFixture();
      changed.modelOverrides[FIXTURE_MODEL_ID] = { alias: 'quick', description: 'changed after start' };
      await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(changed));

      const response = await fetch(`${server.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku',
          system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }],
          messages: [{ role: 'user', content: '<subagent-router v="1" model="fast"/>\nTask' }],
        }),
      });

      expect(response.status).toBe(200);
      expect(gateway.requests[0]?.model).toBe(FIXTURE_MODEL_ID);
      expect(typeof server.generation).toBe('string');
    } finally {
      await server.stop();
      await gateway.close();
    }
  });

  test('preserves the client-supplied model on a parent (non-subagent) request', async () => {
    const gateway = await startCaptureGateway();
    const gatewayEnvUrl = `${gateway.url}/v1`;
    await writeFixtureState(gatewayEnvUrl);
    const deps = testDeps(gatewayEnvUrl);
    const server = await startServer(join(dir, 'subagent-router.json'), deps, { port: 0, host: '127.0.0.1' });
    try {
      const response = await fetch(`${server.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-parent-model',
          messages: [{ role: 'user', content: 'plain parent request, no billing marker' }],
        }),
      });

      expect(response.status).toBe(200);
      expect(gateway.requests[0]?.isChild).toBe(false);
      expect(gateway.requests[0]?.model).toBe('claude-parent-model');
    } finally {
      await server.stop();
      await gateway.close();
    }
  });

  test('refuses an unmarked child request and never forwards it upstream', async () => {
    const gateway = await startCaptureGateway();
    const gatewayEnvUrl = `${gateway.url}/v1`;
    await writeFixtureState(gatewayEnvUrl);
    const deps = testDeps(gatewayEnvUrl);
    const server = await startServer(join(dir, 'subagent-router.json'), deps, { port: 0, host: '127.0.0.1' });
    try {
      const response = await fetch(`${server.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-child-default',
          system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }],
          messages: [{ role: 'user', content: 'no marker, no default configured' }],
        }),
      });

      const payload = (await response.json()) as { error?: { code?: string } };
      expect(response.status).toBe(422);
      expect(payload.error?.code).toBe('missing-selection');
      expect(gateway.requests.length).toBe(0);
    } finally {
      await server.stop();
      await gateway.close();
    }
  });
});
