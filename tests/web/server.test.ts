// Exercises the web console's HTTP surface: the request handler directly (no port bind) plus real
// loopback listeners for the checks that only mean something over a socket. deps.fetch always
// rejects here, which is the positive control for the console's central claim: no endpoint on a
// read path ever dials the network.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedArgs } from '../../src/cli/args';
import { createSession, createWebHandler, resolveWebOptions, startWebServer } from '../../src/web';
import type { CliDeps } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

const SECRET_VALUE = 'super-secret-gateway-token';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-web-'));
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

function webArgs(overrides: Record<string, string | boolean> = {}): ParsedArgs {
  return { command: ['web'], options: { config: join(dir, 'subagent-router.json'), ...overrides }, positionals: [], additionalRoots: [] };
}

function handler(options: { readOnly?: boolean } = {}): (request: Request) => Promise<Response> {
  const deps = testDeps();
  const session = createSession(deps, join(dir, 'subagent-router.json'));
  return createWebHandler({
    deps,
    parsed: webArgs(),
    session,
    boundHost: '127.0.0.1',
    console: { url: 'http://127.0.0.1:8788', host: '127.0.0.1', port: 8788, readOnly: options.readOnly ?? false },
  });
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

interface Body {
  command?: string;
  code?: number;
  payload?: unknown;
  error?: { code: string; message: string };
}

async function get(path: string, fetcher = handler()): Promise<{ status: number; body: Body }> {
  const response = await fetcher(new Request(`http://127.0.0.1${path}`));
  return { status: response.status, body: (await response.json()) as Body };
}

async function post(
  path: string,
  body: unknown,
  fetcher = handler(),
  init: RequestInit = {},
): Promise<{ status: number; body: Body }> {
  const response = await fetcher(
    new Request(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...((init.headers ?? {}) as Record<string, string>) },
      body: JSON.stringify(body),
      ...init,
    }),
  );
  return { status: response.status, body: (await response.json()) as Body };
}

async function currentGeneration(fetcher: (request: Request) => Promise<Response>): Promise<string> {
  const { body } = await get('/api/config/show', fetcher);
  return (body.payload as { generation: string }).generation;
}

describe('web: document', () => {
  test('serves an explanatory page under the lockdown content-security-policy when no bundle is built', async () => {
    const response = await handler()(new Request('http://127.0.0.1/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const text = await response.text();
    expect(text).toContain('subagent-router');
    // Either the real bundle or the fallback page; both must be script-src 'self' clean, which
    // means no inline script body in the document the server hands out.
    for (const tag of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      expect((tag[1] ?? '').trim()).toBe('');
    }
  });
});

describe('web: read endpoints', () => {
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

  test('system status reports config health, snapshot, env names and router state', async () => {
    const { status, body } = await get('/api/system/status');
    expect(status).toBe(200);
    const payload = body.payload as {
      configPath: string;
      configHealth: string;
      generation: string;
      snapshot: { present: boolean; fetchedAt: string | null; modelCount: number | null };
      env: Array<{ name: string; present: boolean }>;
      router: { owner: string; running: boolean };
      console: { readOnly: boolean };
    };
    expect(payload.configPath).toBe(join(dir, 'subagent-router.json'));
    expect(payload.configHealth).toBe('ok');
    expect(payload.generation.length).toBeGreaterThan(0);
    expect(payload.snapshot.present).toBe(true);
    expect(payload.snapshot.modelCount).toBe(1);
    expect(typeof payload.snapshot.fetchedAt).toBe('string');
    expect(payload.env.map((entry) => entry.name)).toContain('ROUTER_SECRET');
    expect(payload.router.running).toBe(false);
    expect(payload.console.readOnly).toBe(false);
  });

  // The whole point of the env report: names and a presence flag, never a value. deps.env holds a
  // real-looking secret above, so this fails the moment a value reaches a payload.
  test('no read endpoint ever renders a resolved environment value', async () => {
    const fetcher = handler();
    for (const path of ['/api/system/status', '/api/config/show', '/api/detect', '/api/doctor']) {
      const response = await fetcher(new Request(`http://127.0.0.1${path}`));
      const text = await response.text();
      expect(text).not.toContain(SECRET_VALUE);
    }
    const status = await (await fetcher(new Request('http://127.0.0.1/api/system/status'))).text();
    expect(status).toContain('ROUTER_SECRET');
  });

  test('detect reports the config and the installed clients without probing', async () => {
    const { status, body } = await get('/api/detect');
    expect(status).toBe(200);
    const payload = body.payload as { clients: unknown[]; gateways: unknown; config: { exists: boolean; health: string } };
    expect(payload.clients.length).toBe(3);
    // Probing is opt-in; without ?probe=1 nothing is dialed, which matters because deps.fetch
    // rejects and a probe would otherwise have to swallow the failure to keep this green.
    expect(payload.gateways).toBeNull();
    expect(payload.config).toMatchObject({ exists: true, health: 'ok' });
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

  test('reports config-check findings with HTTP 200 and the CLI exit code', async () => {
    const broken = configFixture();
    broken.roles['claude-code:ghost'] = { routeOverride: FIXTURE_MODEL_ID };
    await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(broken));

    const { status, body } = await get('/api/config/check');
    expect(status).toBe(200);
    expect(body.code).toBe(2);
    expect((body.payload as { problems: string[] }).problems.join('\n')).toContain('claude-code:ghost');
  });

  test('picks up a config edit made after the console started', async () => {
    const fetcher = handler();
    const before = await get('/api/models', fetcher);
    expect((before.body.payload as { models: Array<{ alias: string }> }).models[0]?.alias).toBe('fast');

    const changed = configFixture();
    changed.modelOverrides[FIXTURE_MODEL_ID] = { alias: 'quick' };
    await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(changed));

    const after = await get('/api/models', fetcher);
    expect((after.body.payload as { models: Array<{ alias: string }> }).models[0]?.alias).toBe('quick');
  });
});

describe('web: config mutations', () => {
  test('writes a model override and returns the new generation', async () => {
    const fetcher = handler();
    const generation = await currentGeneration(fetcher);

    const { status, body } = await post(
      '/api/config/models/override',
      { expectedGeneration: generation, reference: FIXTURE_MODEL_ID, alias: 'turbo' },
      fetcher,
    );
    expect(status).toBe(200);
    const payload = body.payload as { generation: string; config: { modelOverrides: Record<string, { alias?: string }> } };
    expect(payload.config.modelOverrides[FIXTURE_MODEL_ID]?.alias).toBe('turbo');
    expect(payload.generation).not.toBe(generation);

    const reread = await get('/api/models', fetcher);
    expect((reread.body.payload as { models: Array<{ alias: string }> }).models[0]?.alias).toBe('turbo');
  });

  test('refuses a write made against a generation that has moved on', async () => {
    const fetcher = handler();
    const stale = await currentGeneration(fetcher);
    await post('/api/config/roles', { expectedGeneration: stale, client: 'claude-code', agent: 'explorer', routeOverride: null }, fetcher);

    const { status, body } = await post(
      '/api/config/roles',
      { expectedGeneration: stale, client: 'claude-code', agent: 'explorer', routeOverride: FIXTURE_MODEL_ID },
      fetcher,
    );
    expect(status).toBe(409);
    expect(body.error?.code).toBe('config-generation-conflict');
  });

  test('rejects a malformed body before it reaches a write', async () => {
    const fetcher = handler();
    const generation = await currentGeneration(fetcher);
    const cases: Array<[string, unknown]> = [
      ['/api/config/roles', { expectedGeneration: generation, client: 'not-a-client', agent: 'explorer', routeOverride: null }],
      ['/api/config/roles', { expectedGeneration: generation, client: 'claude-code', routeOverride: null }],
      ['/api/config/defaults', { expectedGeneration: generation, unmarkedSubagent: 'maybe' }],
      ['/api/config/source', { expectedGeneration: generation, timeoutMs: 'soon' }],
      ['/api/config/agent-root', { client: 'codex', configRoot: null }],
    ];
    for (const [path, body] of cases) {
      const response = await post(path, body, fetcher);
      expect(response.status).toBe(400);
      expect(response.body.error?.code).toBe('web-bad-request');
    }
    // The config survived every rejected write.
    expect(await currentGeneration(fetcher)).toBe(generation);
  });

  test('creates a config on a machine that has none, and keeps reading the file it created', async () => {
    const deps = testDeps();
    const configPath = join(dir, 'fresh', 'subagent-router.json');
    const session = createSession(deps, configPath);
    const fetcher = createWebHandler({
      deps,
      parsed: { command: ['web'], options: { config: configPath }, positionals: [], additionalRoots: [] },
      session,
      boundHost: '127.0.0.1',
      console: { url: 'http://127.0.0.1:8788', host: '127.0.0.1', port: 8788, readOnly: false },
    });

    const before = await get('/api/system/status', fetcher);
    expect((before.body.payload as { configHealth: string }).configHealth).toBe('missing');

    const created = await post(
      '/api/config/init',
      {
        scope: 'project',
        sourceId: 'test-gateway',
        endpointPath: '/v1/models',
        gatewayUrlEnv: 'GATEWAY_URL',
        gatewayHeadersEnv: ['GATEWAY_HEADERS'],
        modelsBaseUrlEnv: 'GATEWAY_URL',
        modelsHeadersEnv: [],
        correlationSecretEnv: 'ROUTER_SECRET',
      },
      fetcher,
    );
    expect(created.status).toBe(200);
    expect((created.body.payload as { configPath: string }).configPath).toBe(configPath);

    const after = await get('/api/system/status', fetcher);
    const payload = after.body.payload as { configHealth: string; configPath: string };
    expect(payload.configHealth).toBe('ok');
    expect(payload.configPath).toBe(configPath);
  });

  test('refuses to overwrite an existing config without force', async () => {
    const { status, body } = await post('/api/config/init', {
      scope: 'project',
      sourceId: 'test-gateway',
      endpointPath: '/v1/models',
      gatewayUrlEnv: 'GATEWAY_URL',
      gatewayHeadersEnv: [],
      modelsBaseUrlEnv: 'GATEWAY_URL',
      modelsHeadersEnv: [],
      correlationSecretEnv: 'ROUTER_SECRET',
    });
    expect(status).toBe(409);
    expect(body.error?.code).toBe('config-exists');
  });
});

describe('web: events', () => {
  test('records every successful write and reports it in order', async () => {
    const fetcher = handler();
    const generation = await currentGeneration(fetcher);
    await post('/api/config/models/override', { expectedGeneration: generation, reference: FIXTURE_MODEL_ID, alias: 'turbo' }, fetcher);

    const { status, body } = await get('/api/events?after=0', fetcher);
    expect(status).toBe(200);
    const payload = body.payload as { events: Array<{ seq: number; kind: string; message: string }>; latestSeq: number };
    expect(payload.events.some((event) => event.kind === 'console-action' && event.message.includes('models override'))).toBe(true);
    expect(payload.latestSeq).toBe(payload.events[payload.events.length - 1]?.seq ?? -1);
  });

  test('records a failed write with its error code and no error text', async () => {
    const fetcher = handler();
    await post('/api/config/roles', { expectedGeneration: 'not-the-generation', client: 'claude-code', agent: 'explorer', routeOverride: null }, fetcher);
    const { body } = await get('/api/events?after=0', fetcher);
    const messages = (body.payload as { events: Array<{ message: string }> }).events.map((event) => event.message);
    expect(messages.join('\n')).toContain('config-generation-conflict');
  });

  test('streams events as server-sent events', async () => {
    const deps = testDeps();
    const server = await startWebServer(deps, webArgs(), { port: 0, host: '127.0.0.1', readOnly: false });
    try {
      const response = await fetch(`${server.url}/api/events/stream?after=0`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const first = await reader?.read();
      const text = new TextDecoder().decode(first?.value);
      // The backlog already holds the console's own start line, so a reader sees data at once.
      expect(text).toContain('data: ');
      expect(text).toContain('console listening on');
      await reader?.cancel();
    } finally {
      await server.stop();
    }
  });
});

describe('web: refusals', () => {
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
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('web-host-not-allowed');
  });

  test('refuses a write carrying another origin', async () => {
    const fetcher = handler();
    const generation = await currentGeneration(fetcher);
    const { status, body } = await post(
      '/api/config/roles',
      { expectedGeneration: generation, client: 'claude-code', agent: 'explorer', routeOverride: null },
      fetcher,
      { headers: { origin: 'http://evil.example' } },
    );
    expect(status).toBe(403);
    expect(body.error?.code).toBe('web-origin-not-allowed');
    expect(await currentGeneration(fetcher)).toBe(generation);
  });

  // An HTML form can only send three content types and application/json is not one of them, so
  // requiring the header is itself the CSRF guard that keeps a cross-site form off a write route.
  test('refuses a write that is not application/json', async () => {
    const response = await handler()(
      new Request('http://127.0.0.1/api/config/roles', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'expectedGeneration=x',
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('web-bad-content-type');
  });

  test('refuses every write in read-only mode and still answers reads', async () => {
    const readOnly = handler({ readOnly: true });
    const generation = await currentGeneration(readOnly);
    for (const path of ['/api/config/roles', '/api/config/init', '/api/models/sync', '/api/router/start', '/api/install']) {
      const response = await post(path, { expectedGeneration: generation }, readOnly);
      expect(response.status).toBe(403);
      expect(response.body.error?.code).toBe('web-read-only');
    }
    expect((await get('/api/models', readOnly)).status).toBe(200);
  });

  test('refuses a GET on a write route and a POST on a read route', async () => {
    const fetcher = handler();
    const write = await fetcher(new Request('http://127.0.0.1/api/router/start'));
    expect(write.status).toBe(405);
    expect(write.headers.get('allow')).toBe('POST');

    const read = await fetcher(new Request('http://127.0.0.1/api/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    expect(read.status).toBe(405);
    expect(read.headers.get('allow')).toBe('GET');
  });

  test('answers 404 on an unknown endpoint', async () => {
    const { status, body } = await get('/api/does-not-exist');
    expect(status).toBe(404);
    expect(body.error?.code).toBe('web-not-found');
  });
});

describe('web: options and listener', () => {
  test('defaults to a writable loopback console on 8788 and rejects an invalid port', () => {
    expect(resolveWebOptions({ command: ['web'], options: {}, positionals: [], additionalRoots: [] })).toEqual({
      port: 8788,
      host: '127.0.0.1',
      readOnly: false,
    });
    expect(resolveWebOptions({ command: ['web'], options: { 'read-only': true }, positionals: [], additionalRoots: [] }).readOnly).toBe(true);
    // No authentication exists, so a non-loopback bind can never be a writable console.
    expect(resolveWebOptions({ command: ['web'], options: { host: '0.0.0.0' }, positionals: [], additionalRoots: [] }).readOnly).toBe(true);
    expect(() => resolveWebOptions({ command: ['web'], options: { port: '70000' }, positionals: [], additionalRoots: [] })).toThrow(/--port/);
  });

  test('serves over a real loopback socket', async () => {
    const server = await startWebServer(testDeps(), webArgs(), { port: 0, host: '127.0.0.1', readOnly: false });
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
    const server = await startWebServer(testDeps(), webArgs(), { port: 0, host: '127.0.0.1', readOnly: false });
    try {
      const response = await fetch(`${server.url}/api/config/show`, { headers: { host: 'router.evil.example' } });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('web-host-not-allowed');
    } finally {
      await server.stop();
    }
  });

  // A raw client can put a value in Host that URL refuses to parse. Before the handler guarded the
  // parse, that throw reached Bun's own error page, which carries the path and the source lines of
  // the module it happened in.
  test('answers a malformed Host header with a JSON refusal, not a source-bearing error page', async () => {
    const server = await startWebServer(testDeps(), webArgs(), { port: 0, host: '127.0.0.1', readOnly: false });
    try {
      const raw = await rawRequest(Number(new URL(server.url).port), 'GET /api/models HTTP/1.1\r\nHost: bad host\r\nConnection: close\r\n\r\n');
      expect(raw).toContain('400');
      expect(raw).toContain('web-bad-request');
      expect(raw).not.toContain('src/web/server.ts');
    } finally {
      await server.stop();
    }
  });

  test('warns on stderr when the console is bound off loopback', async () => {
    const written: string[] = [];
    const deps: CliDeps = { ...testDeps(), stderr: (text) => { written.push(text); } };
    const server = await startWebServer(deps, webArgs(), { port: 0, host: '0.0.0.0', readOnly: true });
    try {
      expect(written.join('')).toContain('no authentication');
    } finally {
      await server.stop();
    }

    const quiet: string[] = [];
    const loopback: CliDeps = { ...testDeps(), stderr: (text) => { quiet.push(text); } };
    const local = await startWebServer(loopback, webArgs(), { port: 0, host: '127.0.0.1', readOnly: false });
    await local.stop();
    expect(quiet).toEqual([]);
  });

  // The old read-only console refused to start without a config. That is exactly the machine the
  // setup view exists for, so a missing file has to be a reported state, not a startup failure.
  test('starts with no config at all and reports it as a state', async () => {
    const missing: ParsedArgs = { command: ['web'], options: { config: join(dir, 'absent.json') }, positionals: [], additionalRoots: [] };
    const server = await startWebServer(testDeps(), missing, { port: 0, host: '127.0.0.1', readOnly: false });
    try {
      const response = await fetch(`${server.url}/api/system/status`);
      expect(response.status).toBe(200);
      const payload = ((await response.json()) as { payload: { configHealth: string; configError: string } }).payload;
      expect(payload.configHealth).toBe('missing');
      expect(payload.configError).toBe('config-missing');
    } finally {
      await server.stop();
    }
  });
});
