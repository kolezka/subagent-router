// Exercises the read-only web console: the request handler directly (no port bind) plus one
// real loopback listener. deps.fetch always rejects here, which is the positive control for the
// console's central claim: none of these endpoints ever dials the network.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedArgs } from '../../src/cli/args';
import { createUiHandler, resolveUiOptions, startUiServer } from '../../src/cli/ui';
import type { CliDeps } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

const SECRET_VALUE = 'super-secret-gateway-token';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-ui-'));
  await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(configFixture()));
  await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
  await mkdir(join(dir, '.claude', 'agents'), { recursive: true });
  await writeFile(join(dir, '.claude', 'agents', 'explorer.md'), '---\nname: explorer\nmodel: inherit\n---\nExplore.\n');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function testDeps(): CliDeps {
  return {
    cwd: dir,
    home: dir,
    env: { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 't', ROUTER_SECRET: SECRET_VALUE },
    stdout: () => {},
    stderr: () => {},
    isTTY: false,
    fetch: () => Promise.reject(new Error('the console must never dial out')),
    fetchAdapter: { id: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic' },
    loadProfile: async (client) => ({
      client,
      version: 'synthetic-hermetic',
      status: 'supported',
      correlation: false,
      correlationEntropy: 'pending',
      fork: false,
      adapterMarkerPosition: 'unknown',
      probes: {},
      lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' },
    }),
    loadTransportProfile: async () => ({ adapterId: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic', status: 'passed', gzipBytes: 'passed', responseHeaders: 'passed' }),
    now: () => new Date(),
  };
}

function uiArgs(): ParsedArgs {
  return { command: ['ui'], options: { config: join(dir, 'subagent-router.json') }, positionals: [], additionalRoots: [] };
}

function handler(): (request: Request) => Promise<Response> {
  return createUiHandler(testDeps(), uiArgs(), '127.0.0.1');
}

/** Sends bytes a fetch client refuses to send (an invalid Host header) and returns the raw reply. */
function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: '127.0.0.1' }, () => socket.write(request));
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      text += chunk;
    });
    socket.on('end', () => resolve(text));
    socket.on('error', reject);
  });
}

async function get(path: string): Promise<{ status: number; body: { command?: string; code?: number; payload?: unknown; error?: { code: string; message: string } } }> {
  const response = await handler()(new Request(`http://127.0.0.1${path}`));
  return { status: response.status, body: (await response.json()) as never };
}

describe('ui: page', () => {
  test('serves the console document with a lockdown content-security-policy', async () => {
    const response = await handler()(new Request('http://127.0.0.1/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toContain('<!doctype html>');
  });

  // Everything the console renders is gateway- or filesystem-controlled text: a model
  // description, an agent name, a config-check message. The page builds its DOM with
  // createElement/textContent only, so a value carrying markup can never become markup. This is
  // a source check, not a browser check: it fails the moment someone reaches for a markup sink.
  test('the page contains no markup-injection sink', async () => {
    const html = await (await handler()(new Request('http://127.0.0.1/'))).text();
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
      expect(html).not.toContain(sink);
    }
  });
});

describe('ui: read-only endpoints', () => {
  test('mirrors models list', async () => {
    const { status, body } = await get('/api/models');
    expect(status).toBe(200);
    expect(body.command).toBe('models list');
    expect(body.code).toBe(0);
    const payload = body.payload as { models: Array<{ id: string; alias: string }> };
    expect(payload.models.map((model) => model.id)).toContain(FIXTURE_MODEL_ID);
  });

  test('mirrors agents list for the requested client', async () => {
    const { status, body } = await get('/api/agents?client=claude-code');
    expect(status).toBe(200);
    const payload = body.payload as { agents: Array<{ name: string; scope: string }> };
    expect(payload.agents.map((agent) => agent.name)).toContain('explorer');
    expect(payload.agents.find((agent) => agent.name === 'explorer')?.scope).toBe('project');
  });

  test('reports status with the loaded generation and snapshot', async () => {
    const { status, body } = await get('/api/status');
    expect(status).toBe(200);
    const payload = body.payload as { generation: string; configPath: string; snapshotModelCount: number | null };
    expect(payload.generation.length).toBeGreaterThan(0);
    expect(payload.configPath).toBe(join(dir, 'subagent-router.json'));
    expect(payload.snapshotModelCount).toBe(1);
  });

  test('simulates a route decision through the same preview the CLI uses', async () => {
    const { status, body } = await get('/api/route/preview?client=claude-code&agent=explorer');
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    const payload = body.payload as { mode: string; decision: { kind: string; upstreamModel?: string; source?: string } };
    expect(payload.mode).toBe('simulation');
    expect(payload.decision.kind).toBe('route');
    expect(payload.decision.upstreamModel).toBe(FIXTURE_MODEL_ID);
    expect(payload.decision.source).toBe('role-default');
  });

  test('reports a failed simulation as data, not as a transport error', async () => {
    const { status, body } = await get('/api/route/preview?client=claude-code&agent=explorer&model=no-such-model');
    expect(status).toBe(200);
    expect(body.code).toBe(2);
    const payload = body.payload as { decision: { kind: string; code?: string } };
    expect(payload.decision.kind).toBe('error');
    expect(payload.decision.code).toBe('unknown-model');
  });

  test('reports config-check findings with HTTP 200 and the CLI exit code', async () => {
    const broken = configFixture();
    broken.roles['claude-code:ghost'] = { routeOverride: FIXTURE_MODEL_ID };
    await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(broken));

    const { status, body } = await get('/api/config/check');
    expect(status).toBe(200);
    expect(body.code).toBe(2);
    const payload = body.payload as { problems: string[] };
    expect(payload.problems.join('\n')).toContain('claude-code:ghost');
  });

  test('config show exposes env variable names and never a resolved secret', async () => {
    const response = await handler()(new Request('http://127.0.0.1/api/config/show'));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('ROUTER_SECRET');
    expect(text).not.toContain(SECRET_VALUE);
  });

  test('doctor reports offline diagnostics without touching the network', async () => {
    const { status, body } = await get('/api/doctor');
    expect(status).toBe(200);
    const payload = body.payload as { network: boolean; clients: Array<{ client: string; status: string }> };
    expect(payload.network).toBe(false);
    expect(payload.clients.length).toBe(3);
  });

  test('picks up a config edit made after the console started', async () => {
    const before = await get('/api/models');
    expect((before.body.payload as { models: Array<{ alias: string }> }).models[0]?.alias).toBe('fast');

    const changed = configFixture();
    changed.modelOverrides[FIXTURE_MODEL_ID] = { alias: 'quick' };
    await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(changed));

    const after = await get('/api/models');
    expect((after.body.payload as { models: Array<{ alias: string }> }).models[0]?.alias).toBe('quick');
  });
});

describe('ui: refusals', () => {
  test('answers 400 with the router error code when the request cannot be satisfied', async () => {
    const { status, body } = await get('/api/route/preview?client=claude-code&agent=no-such-agent');
    expect(status).toBe(400);
    expect(body.error?.code).toBe('agent-unknown');
  });

  test('answers 400 when the snapshot is missing', async () => {
    await rm(join(dir, 'models.lock.json'));
    const { status, body } = await get('/api/models');
    expect(status).toBe(400);
    expect(body.error?.code).toBe('snapshot-missing');
  });

  test('refuses a request addressed to a foreign host name', async () => {
    const response = await handler()(new Request('http://router.evil.example/api/config/show'));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('ui-host-not-allowed');
  });

  test('refuses a non-GET method', async () => {
    const response = await handler()(new Request('http://127.0.0.1/api/models', { method: 'POST' }));
    expect(response.status).toBe(405);
  });

  test('answers 404 on an unknown endpoint', async () => {
    const { status, body } = await get('/api/does-not-exist');
    expect(status).toBe(404);
    expect(body.error?.code).toBe('ui-not-found');
  });
});

describe('ui: options and listener', () => {
  test('defaults to loopback 8788 and rejects an invalid port', () => {
    expect(resolveUiOptions({ command: ['ui'], options: {}, positionals: [], additionalRoots: [] })).toEqual({ port: 8788, host: '127.0.0.1' });
    expect(() => resolveUiOptions({ command: ['ui'], options: { port: '70000' }, positionals: [], additionalRoots: [] })).toThrow(/--port/);
  });

  test('serves over a real loopback socket', async () => {
    const server = await startUiServer(testDeps(), uiArgs(), { port: 0, host: '127.0.0.1' });
    try {
      const page = await fetch(`${server.url}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('subagent-router');

      const models = await fetch(`${server.url}/api/models`);
      expect(models.status).toBe(200);
      expect(((await models.json()) as { payload: { models: unknown[] } }).payload.models.length).toBe(1);
    } finally {
      await server.stop();
    }
  });

  // The synthetic-Request refusal test above only proves the check; this one proves the input it
  // reads is the value a client actually sent, which is what a DNS-rebinding attempt controls.
  test('refuses a spoofed Host header arriving over a real socket', async () => {
    const server = await startUiServer(testDeps(), uiArgs(), { port: 0, host: '127.0.0.1' });
    try {
      const response = await fetch(`${server.url}/api/config/show`, { headers: { host: 'router.evil.example' } });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('ui-host-not-allowed');
    } finally {
      await server.stop();
    }
  });

  // A raw client can put a value in Host that URL refuses to parse. Before the handler guarded the
  // parse, that throw reached Bun's own error page, which carries the path and the source lines of
  // src/cli/ui.ts.
  test('answers a malformed Host header with a JSON refusal, not a source-bearing error page', async () => {
    const server = await startUiServer(testDeps(), uiArgs(), { port: 0, host: '127.0.0.1' });
    try {
      const raw = await rawRequest(Number(new URL(server.url).port), 'GET /api/models HTTP/1.1\r\nHost: bad host\r\nConnection: close\r\n\r\n');
      expect(raw).toContain('400');
      expect(raw).toContain('ui-bad-request');
      expect(raw).not.toContain('src/cli/ui.ts');
    } finally {
      await server.stop();
    }
  });

  test('warns on stderr when the console is bound off loopback', async () => {
    const written: string[] = [];
    const deps: CliDeps = { ...testDeps(), stderr: (text) => { written.push(text); } };
    const server = await startUiServer(deps, uiArgs(), { port: 0, host: '0.0.0.0' });
    try {
      expect(written.join('')).toContain('no authentication');
    } finally {
      await server.stop();
    }

    const quiet: string[] = [];
    const loopback: CliDeps = { ...testDeps(), stderr: (text) => { quiet.push(text); } };
    const local = await startUiServer(loopback, uiArgs(), { port: 0, host: '127.0.0.1' });
    await local.stop();
    expect(quiet).toEqual([]);
  });

  test('fails at startup when the config cannot be loaded', async () => {
    const missing: ParsedArgs = { command: ['ui'], options: { config: join(dir, 'absent.json') }, positionals: [], additionalRoots: [] };
    await expect(startUiServer(testDeps(), missing, { port: 0, host: '127.0.0.1' })).rejects.toThrow(/config-missing|missing file/);
  });
});
