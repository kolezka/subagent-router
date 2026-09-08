// CLIProxyAPI compatibility contract tests.
//
// Scope: Claude Code marker routing through src/transport/handler.ts only. OpenCode and Codex use
// native validation hooks and talk to CLIProxyAPI directly; see docs/gateways/cliproxyapi.md.
//
// These tests run the real resolveSource, synchronize/discovery, createHandler, and the Bun raw
// transport against a loopback fixture. All traffic stays on 127.0.0.1. No real CLIProxyAPI
// process, no provider, and no native client are involved.
//
// The fixture's routes and its Bearer/X-Api-Key auth check are verified 2026-09-08 against
// internal/api/server_routes.go and internal/access/config_access/provider.go on the CLIProxyAPI
// main branch. The /v1/models response shape and every SSE/error body the fixture returns are
// this fixture's own synthetic data, not observed CLIProxyAPI output; these tests do not cover
// every response variant a real deployment might return.
//
// The client capability profile below is a synthetic-hermetic contract fixture, not a measured
// native-client profile (those stay pending; see docs/gateways/cliproxyapi.md).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadTransportCapabilityProfile } from '../../src/adapters/capabilities';
import { synchronize } from '../../src/catalog/sync';
import { buildCatalog } from '../../src/core/catalog';
import { parseOperatorConfig } from '../../src/core/config';
import type { CapabilityProfile, CatalogSnapshot, OperatorConfig } from '../../src/core/types';
import { resolveSource } from '../../src/io/environment';
import { BUN_RAW_FETCH_ADAPTER, bunRawFetch } from '../../src/transport/bun-fetch';
import { createHandler } from '../../src/transport/handler';
import { configFixture } from '../support/fixtures';

const CAPABILITY_FIXTURES_DIR = `${import.meta.dir}/../fixtures/capabilities`;
const EXAMPLE_CONFIG_PATH = join(import.meta.dir, '../../examples/cliproxyapi/subagent-router.json');

// Distinct, obviously-fake literal values (never real credentials) so a cross-channel leak is
// caught by an exact mismatch, not masked by both channels happening to share one value.
const DISCOVERY_KEY = 'cliproxyapi-discovery-only-DO-NOT-FORWARD';
const FORWARD_KEY = 'cliproxyapi-gateway-forward-key';

// Two model IDs differing only by case, plus one CLIProxyAPI still lists as available but whose
// /v1/messages route will report as gone. Real CLIProxyAPI model IDs are exact opaque strings;
// nothing here is a claim about what a real deployment actually serves.
const MODEL_MIXED_CASE = 'openai/GPT-5.1-Codex-Max';
const MODEL_LOWER_CASE = 'openai/gpt-5.1-codex-max';
const MODEL_STALE = 'openai/gpt-5.1-deprecated-preview';

const HANDLER_SECRET = 'cliproxyapi-test-secret';

const CHILD_SYSTEM = [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }];

// synthetic-hermetic: a fully-controlled contract-test profile, not a measured native client.
// Real per-version client fixtures (e.g. claude-code-2.1.263.json) stay status "pending".
const PROFILE: CapabilityProfile = {
  client: 'claude-code',
  version: 'synthetic-hermetic',
  status: 'supported',
  correlation: false,
  correlationEntropy: 'pending',
  fork: false,
  adapterMarkerPosition: 'system',
  diagnostics: ['synthetic-hermetic contract fixture; native claude-code support stays pending'],
  probes: { M10: 'passed' },
  lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' },
};

interface FixtureRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

interface CliProxyApiFixture {
  url: string;
  requests: FixtureRequest[];
  close: () => Promise<void>;
  /** Arms a one-shot gate: the next streamed reply sends FIRST_FRAME, then waits for release. */
  prepareStreamGate: () => void;
  /** Idempotent; releases the gate armed by prepareStreamGate, if any. */
  releaseStreamGate: () => void;
}

function sseFrame(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

// The fixture sends FIRST_FRAME alone, then blocks until the test releases a gate, then sends
// REST_FRAMES in one go. This is the causal proof for the streaming test below: not a timing
// heuristic, and not a chunk-count threshold (TCP may combine chunks either way).
const SSE_FRAMES: readonly string[] = [
  sseFrame('message_start', { type: 'message_start', message: { id: 'msg_cliproxyapi_stream', type: 'message', role: 'assistant', model: MODEL_MIXED_CASE, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } }),
  sseFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
  sseFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Consider the ' } }),
  sseFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'cliproxyapi contract.' } }),
  sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
  sseFrame('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_cliproxyapi_1', name: 'read_fixture', input: {} } }),
  sseFrame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
  sseFrame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"fixture.txt"}' } }),
  sseFrame('content_block_stop', { type: 'content_block_stop', index: 1 }),
  sseFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 21 } }),
  sseFrame('message_stop', { type: 'message_stop' }),
];
const FIRST_FRAME = SSE_FRAMES[0]!;
const REST_FRAMES = SSE_FRAMES.slice(1);

function timeoutRejection(ms: number, message: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

const STREAM_TIMEOUT_MS = 2000;

function authorized(headers: Headers, expectedKey: string): boolean {
  if (headers.get('authorization') === `Bearer ${expectedKey}`) return true;
  return headers.get('x-api-key') === expectedKey;
}

function errorBody(type: string, message: string): string {
  return JSON.stringify({ type: 'error', error: { type, message } });
}

/**
 * A loopback HTTP fixture shaped like CLIProxyAPI's own registered routes: authenticated
 * GET /v1/models, POST /v1/messages, POST /v1/messages/count_tokens, and nothing else. It is not
 * CLIProxyAPI and does not claim to reproduce its exact wire format beyond the routes and auth
 * scheme named in the primary sources; response bodies are this fixture's own, clearly synthetic.
 */
function startCliProxyApiFixture(models: readonly string[]): CliProxyApiFixture {
  const requests: FixtureRequest[] = [];
  let streamGate: { promise: Promise<void>; release: () => void } | undefined;

  function prepareStreamGate(): void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    streamGate = { promise, release };
  }

  function releaseStreamGate(): void {
    streamGate?.release();
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });

      if (request.method === 'GET' && url.pathname === '/v1/models') {
        requests.push({ method: 'GET', path: url.pathname, headers, body: undefined });
        if (!authorized(request.headers, DISCOVERY_KEY)) {
          return new Response(errorBody('authentication_error', 'invalid x-api-key'), { status: 401, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      if (request.method === 'POST' && (url.pathname === '/v1/messages' || url.pathname === '/v1/messages/count_tokens')) {
        const rawText = await request.text();
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(rawText) as Record<string, unknown>;
        } catch {
          body = {};
        }
        requests.push({ method: 'POST', path: url.pathname, headers, body });

        if (!authorized(request.headers, FORWARD_KEY)) {
          return new Response(errorBody('authentication_error', 'invalid x-api-key'), { status: 401, headers: { 'content-type': 'application/json' } });
        }

        if (url.pathname === '/v1/messages/count_tokens') {
          return new Response(JSON.stringify({ input_tokens: 42 }), { status: 200, headers: { 'content-type': 'application/json' } });
        }

        if (body.model === MODEL_STALE) {
          return new Response(errorBody('not_found_error', `model: ${MODEL_STALE} not found`), { status: 404, headers: { 'content-type': 'application/json' } });
        }

        if (body.stream === true) {
          const gate = streamGate;
          if (gate === undefined) {
            return new Response('test bug: stream requested without an armed gate', { status: 500 });
          }
          let sentFirst = false;
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (!sentFirst) {
                sentFirst = true;
                controller.enqueue(new TextEncoder().encode(FIRST_FRAME));
                return;
              }
              // Blocks here until the test calls releaseStreamGate. Nothing past FIRST_FRAME can
              // reach the wire before that call.
              await gate.promise;
              for (const frame of REST_FRAMES) controller.enqueue(new TextEncoder().encode(frame));
              controller.close();
            },
          });
          return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }

        return new Response(
          JSON.stringify({ id: 'msg_cliproxyapi', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'cliproxyapi-fixture-ok' }], stop_reason: 'end_turn' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      requests.push({ method: request.method, path: url.pathname, headers, body: undefined });
      return new Response(
        JSON.stringify({ error: 'route not registered: only GET /v1/models, POST /v1/messages, POST /v1/messages/count_tokens' }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    close: async (): Promise<void> => {
      server.stop(true);
    },
    prepareStreamGate,
    releaseStreamGate,
  };
}

function childRequest(alias: string, path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://router.local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      model: 'client-facing-placeholder',
      system: CHILD_SYSTEM,
      messages: [{ role: 'user', content: `<subagent-router v="1" model="${alias}"/>\nRun the loopback contract task.` }],
    }),
  });
}

function parentRequest(model: string, headers: Record<string, string> = {}, body: Record<string, unknown> = {}): Request {
  return new Request('http://router.local/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'plain parent turn' }], ...body }),
  });
}

function withGateway(base: OperatorConfig, urlEnv: string, headersEnv: readonly string[]): OperatorConfig {
  return structuredClone({ ...base, gateway: { urlEnv, headersEnv: [...headersEnv] } });
}

interface SseFrameDecoded {
  event: string;
  data: Record<string, unknown>;
}

function decodeSse(text: string): SseFrameDecoded[] {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const lines = chunk.split('\n');
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLine = lines.find((line) => line.startsWith('data: '));
      if (eventLine === undefined || dataLine === undefined) {
        throw new Error(`test fixture produced a malformed SSE frame: ${chunk}`);
      }
      return { event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown> };
    });
}

describe('CLIProxyAPI compatibility (real loopback)', () => {
  let fixture: CliProxyApiFixture;
  let dir = '';
  let config: OperatorConfig;
  let env: Record<string, string>;
  let snapshot: CatalogSnapshot;
  let transportProfile: Awaited<ReturnType<typeof loadTransportCapabilityProfile>>;

  beforeAll(async () => {
    fixture = startCliProxyApiFixture([MODEL_MIXED_CASE, MODEL_LOWER_CASE, MODEL_STALE]);
    dir = await mkdtemp(join(tmpdir(), 'subagent-router-cliproxyapi-'));
    const configPath = join(dir, 'subagent-router.json');

    // Per the brief: gateway.urlEnv and modelSource.baseUrlEnv share one env name ending in /v1;
    // discovery and forwarding still use two separate header channels.
    config = configFixture({
      modelSource: {
        sourceId: 'cliproxyapi-loopback',
        baseUrlEnv: 'CLIPROXYAPI_URL',
        endpointPath: '/v1/models',
        authEnv: 'CLIPROXYAPI_MODELS_AUTH',
        headersEnv: [],
        timeoutMs: 10000,
        fetchLimit: 1000,
        staleAfterSeconds: 86400,
      },
      modelOverrides: {
        [MODEL_MIXED_CASE]: { alias: 'fast', description: 'Fast worker.', enabled: true },
        [MODEL_LOWER_CASE]: { alias: 'fast-lower', description: 'Fast worker, lowercase id.', enabled: true },
        [MODEL_STALE]: { alias: 'stale', description: 'Model CLIProxyAPI no longer serves.', enabled: true },
      },
      roles: {},
      gateway: { urlEnv: 'CLIPROXYAPI_URL', headersEnv: ['CLIPROXYAPI_GATEWAY_HEADERS'] },
      harness: {
        claudeCode: { correlation: 'off', secretEnv: 'ROUTER_SECRET' },
        opencode: { providerId: 'cliproxyapi-loopback' },
        codex: { emitModelCatalog: false },
      },
    });
    await writeFile(configPath, JSON.stringify(config));

    env = {
      CLIPROXYAPI_URL: `${fixture.url}/v1`,
      CLIPROXYAPI_MODELS_AUTH: DISCOVERY_KEY,
      CLIPROXYAPI_GATEWAY_HEADERS: JSON.stringify({ Authorization: `Bearer ${FORWARD_KEY}` }),
    };

    // Real discovery over a real loopback socket: GET /v1/models, decode, persist to disk.
    const result = await synchronize(configPath, {
      env,
      fetch: bunRawFetch,
      now: () => new Date('2026-09-08T00:00:00.000Z'),
      allowEmpty: false,
      dryRun: false,
    });
    snapshot = result.snapshot;

    transportProfile = await loadTransportCapabilityProfile(BUN_RAW_FETCH_ADAPTER.id, BUN_RAW_FETCH_ADAPTER.runtimeVersion, CAPABILITY_FIXTURES_DIR);
  });

  afterAll(async () => {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  });

  function buildHandler(cfg: OperatorConfig, requestEnv: Record<string, string>) {
    const source = resolveSource(cfg, requestEnv);
    return createHandler({
      config: cfg,
      snapshot,
      source,
      profile: PROFILE,
      transportProfile,
      secret: HANDLER_SECRET,
      fetch: bunRawFetch,
      fetchAdapter: BUN_RAW_FETCH_ADAPTER,
      trustedContext: () => ({ freshDelegation: false }),
      now: () => 0,
      nonce: () => 'cliproxyapi-nonce',
      instanceId: () => 'cliproxyapi-instance',
    });
  }

  test('discovers the exact /v1/models URL and keeps case-sensitive model IDs distinct through the catalog', async () => {
    const discoveryCalls = fixture.requests.filter((r) => r.method === 'GET' && r.path === '/v1/models');
    expect(discoveryCalls).toHaveLength(1);
    expect(discoveryCalls[0]?.headers.authorization).toBe(`Bearer ${DISCOVERY_KEY}`);

    const ids = snapshot.models.map((m) => m.id).sort();
    expect(ids).toEqual([MODEL_LOWER_CASE, MODEL_MIXED_CASE, MODEL_STALE].sort());

    const catalog = buildCatalog(config, snapshot);
    expect(catalog.byAlias.get('fast')?.id).toBe(MODEL_MIXED_CASE);
    expect(catalog.byAlias.get('fast-lower')?.id).toBe(MODEL_LOWER_CASE);
    expect(catalog.byAlias.get('fast')?.id).not.toBe(catalog.byAlias.get('fast-lower')?.id);
  });

  test('a marked child request rewrites model to the exact upstream id and strips the marker before /v1/messages', async () => {
    const before = fixture.requests.length;
    const handler = buildHandler(config, env);
    const response = await handler(childRequest('fast', '/v1/messages'));
    expect(response.status).toBe(200);

    const forwarded = fixture.requests.slice(before);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.path).toBe('/v1/messages');
    expect(forwarded[0]?.body?.model).toBe(MODEL_MIXED_CASE);
    expect(JSON.stringify(forwarded[0]?.body)).not.toContain('subagent-router');

    const decoded = (await response.json()) as { content: Array<{ text: string }> };
    expect(decoded.content[0]?.text).toBe('cliproxyapi-fixture-ok');
  });

  test('a parent request keeps its declared model unchanged', async () => {
    const before = fixture.requests.length;
    const handler = buildHandler(config, env);
    const response = await handler(parentRequest('claude-native-parent-model'));
    expect(response.status).toBe(200);

    const forwarded = fixture.requests.slice(before);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.body?.model).toBe('claude-native-parent-model');
  });

  test('count_tokens gets the same marker rewrite as messages', async () => {
    const before = fixture.requests.length;
    const handler = buildHandler(config, env);
    const response = await handler(childRequest('fast', '/v1/messages/count_tokens'));
    expect(response.status).toBe(200);

    const forwarded = fixture.requests.slice(before);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.path).toBe('/v1/messages/count_tokens');
    expect(forwarded[0]?.body?.model).toBe(MODEL_MIXED_CASE);

    const decoded = (await response.json()) as { input_tokens: number };
    expect(decoded.input_tokens).toBe(42);
  });

  test('operator gateway Authorization overrides an incoming Authorization, and the discovery-only credential never reaches forwarding', async () => {
    const before = fixture.requests.length;
    const handler = buildHandler(config, env);
    await handler(childRequest('fast', '/v1/messages', { authorization: 'Bearer native-incoming-should-be-overridden' }));

    const forwarded = fixture.requests.slice(before);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.headers.authorization).toBe(`Bearer ${FORWARD_KEY}`);

    const everMessagesRequest = fixture.requests.filter((r) => r.path.startsWith('/v1/messages'));
    for (const request of everMessagesRequest) {
      expect(request.headers.authorization).not.toBe(`Bearer ${DISCOVERY_KEY}`);
    }
  });

  test('X-Api-Key is also accepted for gateway forwarding', async () => {
    const cfg = withGateway(config, 'CLIPROXYAPI_URL', ['CLIPROXYAPI_GATEWAY_HEADERS_XAPIKEY']);
    const requestEnv = { ...env, CLIPROXYAPI_GATEWAY_HEADERS_XAPIKEY: JSON.stringify({ 'X-Api-Key': FORWARD_KEY }) };
    const before = fixture.requests.length;
    const handler = buildHandler(cfg, requestEnv);
    const response = await handler(parentRequest('claude-native-parent-model'));
    expect(response.status).toBe(200);

    const forwarded = fixture.requests.slice(before);
    expect(forwarded[0]?.headers['x-api-key']).toBe(FORWARD_KEY);
  });

  test('a stale upstream model error is forwarded with its exact status and body, no fallback model', async () => {
    const before = fixture.requests.length;
    const handler = buildHandler(config, env);
    const response = await handler(childRequest('stale', '/v1/messages'));
    expect(response.status).toBe(404);

    const forwarded = fixture.requests.slice(before);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.body?.model).toBe(MODEL_STALE);

    const decoded = (await response.json()) as { type: string; error: { type: string; message: string } };
    expect(decoded.type).toBe('error');
    expect(decoded.error.type).toBe('not_found_error');
    expect(decoded.error.message).toContain(MODEL_STALE);
  });

  test('a misconfigured operator gateway key is rejected upstream and passed through unchanged', async () => {
    const cfg = withGateway(config, 'CLIPROXYAPI_URL', ['CLIPROXYAPI_GATEWAY_HEADERS_WRONG']);
    const requestEnv = { ...env, CLIPROXYAPI_GATEWAY_HEADERS_WRONG: JSON.stringify({ Authorization: 'Bearer wrong-operator-key' }) };
    const before = fixture.requests.length;
    const handler = buildHandler(cfg, requestEnv);
    const response = await handler(parentRequest('claude-native-parent-model'));
    expect(response.status).toBe(401);

    const forwarded = fixture.requests.slice(before);
    expect(forwarded).toHaveLength(1);

    const decoded = (await response.json()) as { type: string; error: { type: string } };
    expect(decoded.error.type).toBe('authentication_error');
  });

  test('a bare CLIPROXYAPI_URL (missing /v1) hits /messages on the fixture and gets a real 404, not automatic path correction', async () => {
    const cfg = withGateway(config, 'CLIPROXYAPI_URL_BARE', config.gateway.headersEnv);
    const requestEnv = { ...env, CLIPROXYAPI_URL_BARE: fixture.url };
    const before = fixture.requests.length;
    const handler = buildHandler(cfg, requestEnv);
    const response = await handler(parentRequest('claude-native-parent-model'));
    expect(response.status).toBe(404);

    const forwarded = fixture.requests.slice(before);
    expect(forwarded).toHaveLength(1);
    // The exact wrong path this misconfiguration produces: not /v1/messages.
    expect(forwarded[0]?.path).toBe('/messages');

    const decoded = (await response.json()) as { error: string };
    expect(decoded.error).toContain('route not registered');
    expect(decoded.error).toContain('/v1/messages');
  });

  test('streams thinking, tool_use and message completion, only releasing the remainder after downstream reads the first bytes', async () => {
    fixture.prepareStreamGate();
    const handler = buildHandler(config, env);
    const request = new Request('http://router.local/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'client-facing-placeholder',
        stream: true,
        system: CHILD_SYSTEM,
        messages: [{ role: 'user', content: '<subagent-router v="1" model="fast"/>\nStream the fixture reply.' }],
      }),
    });

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let combined: Uint8Array;
    try {
      // Causal proof, not a chunk-count heuristic: the fixture will not send anything past
      // FIRST_FRAME until releaseStreamGate() runs below, and that only happens after this exact
      // first read already completed. If the router or transport ever buffered the whole reply
      // before returning any bytes, the fixture's gate could never open (it waits on a release
      // that itself waits on bytes that never arrive), so this race rejects on the timeout
      // instead of hanging the suite.
      const firstStage = (async () => {
        const response = await handler(request);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/event-stream');
        const r = response.body!.getReader();
        const first = await r.read();
        return { reader: r, first };
      })();
      const { reader: gotReader, first } = await Promise.race([
        firstStage,
        timeoutRejection(STREAM_TIMEOUT_MS, 'first SSE bytes were not delivered before the timeout; possible buffering regression'),
      ]);
      reader = gotReader;
      if (first.done || first.value === undefined) {
        throw new Error('expected the first SSE read to return bytes, got done/empty');
      }
      expect(new TextDecoder().decode(first.value)).toBe(FIRST_FRAME);

      // Only now, after the first bytes were actually received downstream, let the rest go.
      fixture.releaseStreamGate();

      const chunks: Uint8Array[] = [first.value];
      for (;;) {
        const { value, done } = await Promise.race([
          reader.read(),
          timeoutRejection(STREAM_TIMEOUT_MS, 'remaining SSE bytes were not delivered after releasing the gate'),
        ]);
        if (done) break;
        chunks.push(value);
      }

      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
    } finally {
      // Always release (idempotent) and cancel so a failed race above cannot leave the fixture's
      // pull() or this reader hanging past the end of the test.
      fixture.releaseStreamGate();
      await reader?.cancel().catch(() => {});
    }

    const expectedBytes = new TextEncoder().encode(SSE_FRAMES.join(''));
    expect(combined).toEqual(expectedBytes);

    const frames = decodeSse(new TextDecoder().decode(combined));

    const thinkingText = frames
      .filter((f) => f.event === 'content_block_delta')
      .map((f) => f.data.delta as { type?: string; thinking?: string } | undefined)
      .filter((delta) => delta?.type === 'thinking_delta')
      .map((delta) => delta?.thinking ?? '')
      .join('');
    expect(thinkingText).toBe('Consider the cliproxyapi contract.');

    const toolStart = frames.find((f) => f.event === 'content_block_start' && (f.data.content_block as { type?: string } | undefined)?.type === 'tool_use');
    const toolBlock = toolStart?.data.content_block as { id?: string; name?: string } | undefined;
    expect(toolBlock?.id).toBe('toolu_cliproxyapi_1');
    expect(toolBlock?.name).toBe('read_fixture');

    const toolArgsJson = frames
      .filter((f) => f.event === 'content_block_delta')
      .map((f) => f.data.delta as { type?: string; partial_json?: string } | undefined)
      .filter((delta) => delta?.type === 'input_json_delta')
      .map((delta) => delta?.partial_json ?? '')
      .join('');
    expect(JSON.parse(toolArgsJson)).toEqual({ path: 'fixture.txt' });

    const messageDelta = frames.find((f) => f.event === 'message_delta');
    expect((messageDelta?.data.delta as { stop_reason?: string } | undefined)?.stop_reason).toBe('tool_use');
    expect(frames.some((f) => f.event === 'message_stop')).toBe(true);
  });

  test('the shipped example config, wired to its documented env vars, actually discovers models against a live fixture', async () => {
    const raw = await readFile(EXAMPLE_CONFIG_PATH, 'utf8');
    const parsed = parseOperatorConfig(JSON.parse(raw));
    expect(parsed.gateway.urlEnv).toBe('CLIPROXYAPI_URL');
    expect(parsed.modelSource.baseUrlEnv).toBe('CLIPROXYAPI_URL');
    expect(parsed.modelSource.authEnv).toBe('CLIPROXYAPI_MODELS_AUTH');
    expect(parsed.gateway.headersEnv).toEqual(['CLIPROXYAPI_GATEWAY_HEADERS']);
    // Header channels are env var name lists, never inline header maps: no literal secret can
    // structurally end up in this file.
    expect(raw).not.toContain('Bearer ');

    // Not just parsing: run the exact config file, pointed at the running fixture via the same
    // three env var names the docs use, through a real synchronize() call.
    const exampleDir = await mkdtemp(join(tmpdir(), 'subagent-router-cliproxyapi-example-'));
    try {
      const exampleConfigPath = join(exampleDir, 'subagent-router.json');
      await writeFile(exampleConfigPath, raw);
      const result = await synchronize(exampleConfigPath, {
        env,
        fetch: bunRawFetch,
        now: () => new Date('2026-09-08T00:00:00.000Z'),
        allowEmpty: false,
        dryRun: true,
      });
      expect(result.snapshot.models.map((m) => m.id)).toContain(MODEL_MIXED_CASE);
    } finally {
      await rm(exampleDir, { recursive: true, force: true });
    }
  });
});
