import { describe, expect, test } from 'bun:test';
import { loadTransportCapabilityProfile } from '../../src/adapters/capabilities';
import { signRoleMarker } from '../../src/adapters/markers';
import type { CapabilityProfile, FetchLike, FreshDelegationEnvelope } from '../../src/core/types';
import { BUN_RAW_FETCH_ADAPTER, bunRawFetch } from '../../src/transport/bun-fetch';
import { createHandler, signFreshDelegation } from '../../src/transport/handler';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';
import { nativeContextBlockV1, nativeLayoutUserMessage } from '../support/native-layout';

const CAPABILITY_FIXTURES_DIR = `${import.meta.dir}/../fixtures/capabilities`;

const source = {
  sourceId: 'test-gateway',
  effectiveGatewayUrl: 'http://127.0.0.1:8000/v1',
  effectiveModelsUrl: 'http://127.0.0.1:8000/v1/models',
  // Discovery-only headers (would carry the models-endpoint auth); must never reach the handler's
  // upstream request. gatewayHeaders is a distinct set so a test asserting on one channel proves
  // the other channel was not used, rather than merely re-asserting a header both share.
  headers: { Authorization: 'Bearer discovery-only-token' },
  gatewayHeaders: { 'X-Team': 'router' },
};
const FIXTURE_SUPPORTED_PROFILE: CapabilityProfile = { client: 'claude-code', version: 'synthetic-hermetic', status: 'supported', correlation: true, correlationEntropy: 'passed', fork: false, adapterMarkerPosition: 'b2', probes: { M1: 'passed', 'M3-B2': 'passed', M10: 'passed', 'M10-freshness': 'passed' }, lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' } };
const FIXTURE_TRANSPORT_PROFILE = { adapterId: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic', status: 'passed', gzipBytes: 'passed', responseHeaders: 'passed' } as const;
const CHILD_SYSTEM = [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }];

function upstream(): { fetch: FetchLike; seen: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> } {
  const seen: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  const fetch: FetchLike = async (request) => {
    seen.push({ url: request.url, body: (await request.json()) as Record<string, unknown>, headers: request.headers });
    return new Response(JSON.stringify({ id: 'msg', content: [{ type: 'text', text: 'ok' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, seen };
}

async function handlerWith(fetch: FetchLike, patch: Partial<Parameters<typeof createHandler>[0]> = {}) {
  return createHandler({
    config: configFixture(), snapshot: await snapshotFixture(), source,
    profile: FIXTURE_SUPPORTED_PROFILE,
    transportProfile: FIXTURE_TRANSPORT_PROFILE,
    secret: 'test-secret', fetch, fetchAdapter: { id: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic' },
    trustedContext: () => ({ freshDelegation: false }), now: () => 0,
    nonce: () => 'fixture-nonce', instanceId: () => 'fixture-handler-instance', ...patch,
  });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://router.local${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

describe('createHandler', () => {
  test('dziecko z markerem dostaje upstreamModel, marker znika, rodzic jest przekazywany bez zmian modelu', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch);
    const child = await handler(post('/v1/messages', { model: 'claude-haiku', system: CHILD_SYSTEM, messages: [{ role: 'user', content: '<subagent-router v="1" model="fast"/>\nZadanie' }] }));
    expect(child.status).toBe(200);
    expect(seen[0]?.body.model).toBe(FIXTURE_MODEL_ID);
    expect(JSON.stringify(seen[0]?.body)).not.toContain('subagent-router');
    expect(seen[0]?.headers.get('x-team')).toBe('router');
    expect(seen[0]?.headers.get('authorization')).not.toBe('Bearer discovery-only-token');
    expect(seen[0]?.url).toBe('http://127.0.0.1:8000/v1/messages');
    await handler(post('/v1/messages', { model: 'claude-opus', messages: [{ role: 'user', content: 'rodzic' }] }));
    expect(seen[1]?.body.model).toBe('claude-opus');
  });

  test('dziecko bez wskazania dostaje 422 z kodem missing-selection i brama nie jest wołana', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch);
    const response = await handler(post('/v1/messages', { model: 'x', system: CHILD_SYSTEM, messages: [{ role: 'user', content: 'bez markera' }] }));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('missing-selection');
    expect(seen).toHaveLength(0);
  });

  test('pending i nieznany profil odmawiają child przed upstream', async () => {
    for (const profile of [
      { ...FIXTURE_SUPPORTED_PROFILE, status: 'pending' as const },
      { ...FIXTURE_SUPPORTED_PROFILE, version: 'unmeasured', status: 'pending' as const, diagnostics: ['capability-unknown-version'] },
    ]) {
      const { fetch, seen } = upstream();
      const handler = await handlerWith(fetch, { profile });
      const response = await handler(post('/v1/messages', { model: 'x', system: CHILD_SYSTEM, messages: [{ role: 'user', content: '<subagent-router v="1" model="fast"/>\nZadanie' }] }));
      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('unsupported-path');
      expect(seen).toHaveLength(0);
    }
  });

  test('parent przechodzi i zachowuje model przy pending child profile', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch, { profile: { ...FIXTURE_SUPPORTED_PROFILE, status: 'pending' } });
    await handler(post('/v1/messages', { model: 'claude-opus', messages: [{ role: 'user', content: 'rodzic' }] }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body.model).toBe('claude-opus');
  });

  test('rodzic z cytowanym markerem w tool_result przechodzi bez zmian', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch);
    await handler(post('/v1/messages', { model: 'claude-opus', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '<subagent-router v="1" model="fast"/>' }] }] }));
    expect(seen[0]?.body.model).toBe('claude-opus');
  });

  test('B2 wymaga osobnego one-shot freshness proof i nie przekazuje control upstream', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch);
    const instance = await handler(new Request('http://router.local/subagent-router/control/instance'));
    const handlerInstanceId = ((await instance.json()) as { handlerInstanceId: string }).handlerInstanceId;
    const unsigned = { version: 1, handlerInstanceId, agentId: 'agent-1', role: 'explorer', nonce: 'fresh-1', issuedAtMs: 0 } as const;
    const bad = await handler(post('/subagent-router/control/delegations', { ...unsigned, proof: await signRoleMarker('test-secret', 'explorer', 'agent-1') }));
    expect(bad.status).toBe(401);
    const envelope: FreshDelegationEnvelope = { ...unsigned, proof: await signFreshDelegation('test-secret', unsigned) };
    expect((await handler(post('/subagent-router/control/delegations', envelope))).status).toBe(204);
    await handler(post('/v1/messages', { model: 'x', system: CHILD_SYSTEM, messages: [{ role: 'user', content: 'bez markera' }] }, { 'x-claude-code-agent-id': 'agent-1' }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body.model).toBe(FIXTURE_MODEL_ID);
    expect((await handler(post('/subagent-router/control/delegations', envelope))).status).toBe(409);
    expect(seen).toHaveLength(1);
  });

  test('system B default działa tylko z trusted one-shot freshness receipt tej samej roli', async () => {
    const { fetch, seen } = upstream();
    const systemProfile = { ...FIXTURE_SUPPORTED_PROFILE, adapterMarkerPosition: 'system' as const, probes: { ...FIXTURE_SUPPORTED_PROFILE.probes, M3: 'passed' as const } };
    const handler = await handlerWith(fetch, { profile: systemProfile });
    const instance = await handler(new Request('http://router.local/subagent-router/control/instance'));
    const handlerInstanceId = ((await instance.json()) as { handlerInstanceId: string }).handlerInstanceId;
    const unsigned = { version: 1, handlerInstanceId, agentId: 'agent-b', role: 'explorer', nonce: 'fresh-b', issuedAtMs: 0 } as const;
    const envelope = { ...unsigned, proof: await signFreshDelegation('test-secret', unsigned) };
    expect((await handler(post('/subagent-router/control/delegations', envelope))).status).toBe(204);
    const marker = await signRoleMarker('test-secret', 'explorer', 'agent-b');
    const system = [...CHILD_SYSTEM, { type: 'text', text: `<subagent-router v="1" role="explorer" agent="agent-b" token="${marker}"/>` }];
    expect((await handler(post('/v1/messages', { model: 'x', system, messages: [] }, { 'x-claude-code-agent-id': 'agent-b' }))).status).toBe(200);
    expect(seen[0]?.body.model).toBe(FIXTURE_MODEL_ID);
  });

  test('stary lub sam powtórzony marker B bez fresh receipt nie inicjuje defaultu', async () => {
    const { fetch, seen } = upstream();
    const systemProfile = { ...FIXTURE_SUPPORTED_PROFILE, adapterMarkerPosition: 'system' as const, probes: { ...FIXTURE_SUPPORTED_PROFILE.probes, M3: 'passed' as const } };
    const handler = await handlerWith(fetch, { profile: systemProfile });
    const marker = await signRoleMarker('test-secret', 'explorer', 'agent-stale');
    const system = [...CHILD_SYSTEM, { type: 'text', text: `<subagent-router v="1" role="explorer" agent="agent-stale" token="${marker}"/>` }];
    const response = await handler(post('/v1/messages', { model: 'x', system, messages: [] }, { 'x-claude-code-agent-id': 'agent-stale' }));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('missing-selection');
    expect(seen).toHaveLength(0);
  });

  test('strumień i anulowanie są przekazywane bez buforowania', async () => {
    let aborted = false;
    const fetch: FetchLike = async (request) => {
      request.signal.addEventListener('abort', () => { aborted = true; });
      const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); } });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const handler = await handlerWith(fetch);
    const controller = new AbortController();
    const request = new Request('http://router.local/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-opus', stream: true, messages: [] }), signal: controller.signal });
    const response = await handler(request);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(aborted).toBe(true);
  });

  test('inne ścieżki są przekazywane bez odczytu body', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch);
    await handler(post('/v1/models', {}));
    expect(seen[0]?.url).toBe('http://127.0.0.1:8000/v1/models');
  });

  test('forwards-parent-enrichment-to-upstream-without-changing-parent-model', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch);
    const permissions = { allow: ['Read'], deny: [] };
    const body = {
      model: 'claude-opus',
      system: [{ type: 'text', text: 'jesteś asystentem' }],
      permissions,
      messages: [{ role: 'user', content: 'rodzic' }],
      tools: [
        {
          name: 'Agent',
          description: 'Uruchamia subagenta.',
          input_schema: { properties: { prompt: { description: 'Zadanie dla subagenta.' } } },
        },
      ],
    };
    await handler(post('/v1/messages', body));
    const sentBody = seen[0]?.body as typeof body;
    expect(sentBody.model).toBe('claude-opus');
    expect(sentBody.system).toEqual(body.system);
    expect(sentBody.permissions).toEqual(permissions);
    expect(sentBody.messages).toEqual(body.messages);
    const tool = (sentBody.tools as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(tool.description as string).not.toBe(body.tools[0]?.description);
    expect(tool.description as string).toContain(body.tools[0]?.description as string);
    const schema = tool.input_schema as { properties: { prompt: { description: string } } };
    expect(schema.properties.prompt.description).not.toBe(body.tools[0]?.input_schema.properties.prompt.description);
    expect(schema.properties.prompt.description).toContain(body.tools[0]?.input_schema.properties.prompt.description as string);
  });

  test('passes-raw-request-bytes-on-non-routing-path', async () => {
    const rawBytes = new TextEncoder().encode('{"raw":"bytes-not-json-parsed-by-router","weird":\u0000}');
    let receivedBytes: Uint8Array | undefined;
    const fetch: FetchLike = async (request) => {
      receivedBytes = new Uint8Array(await request.arrayBuffer());
      return new Response(null, { status: 200 });
    };
    const handler = await handlerWith(fetch);
    const request = new Request('http://router.local/v1/models', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: rawBytes });
    await handler(request);
    expect(receivedBytes).toEqual(rawBytes);
  });

  test('passes-through-sse-unknown-events-errors-content-and-usage', async () => {
    const sse = [
      'event: unknown_future_event\ndata: {"foo":"bar"}\n\n',
      'event: content_block_delta\ndata: {"content":"hello"}\n\n',
      'event: error\ndata: {"error":{"type":"overloaded_error","message":"boom"}}\n\n',
      'event: message_delta\ndata: {"usage":{"output_tokens":42}}\n\n',
    ].join('');
    const sseBytes = new TextEncoder().encode(sse);
    const fetch: FetchLike = async () => {
      return new Response(sseBytes, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const handler = await handlerWith(fetch);
    const response = await handler(post('/v1/messages', { model: 'claude-opus', stream: true, messages: [] }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const receivedBytes = new Uint8Array(await response.arrayBuffer());
    expect(receivedBytes).toEqual(sseBytes);
  });

  test('passes-through-error-body-and-headers', async () => {
    const rawErrorBody = 'upstream exploded: not json at all';
    const fetch: FetchLike = async () => {
      return new Response(rawErrorBody, { status: 503, headers: { 'content-type': 'text/plain', 'x-upstream-retry-after': '5' } });
    };
    const handler = await handlerWith(fetch);
    const response = await handler(post('/v1/messages', { model: 'claude-opus', messages: [] }));
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(response.headers.get('x-upstream-retry-after')).toBe('5');
    expect(await response.text()).toBe(rawErrorBody);
  });

  test('preserves-backpressure-with-a-slow-consumer', async () => {
    let pulls = 0;
    const totalChunks = 20;
    const fetch: FetchLike = async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls > totalChunks) {
            controller.close();
            return;
          }
          controller.enqueue(new TextEncoder().encode(`chunk-${pulls}\n`));
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const handler = await handlerWith(fetch);
    const response = await handler(post('/v1/messages', { model: 'claude-opus', stream: true, messages: [] }));
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    // A direct pass-through must not have raced ahead and pulled every chunk before the
    // consumer read even one: that would mean the router buffered the whole upstream body.
    expect(pulls).toBeLessThan(totalChunks);
    let readCount = 1;
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      readCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(readCount).toBe(totalChunks);
    expect(pulls).toBe(totalChunks + 1);
  });

  test('aborts-upstream-on-client-disconnect', async () => {
    let canceled = false;
    let canceledReason: unknown;
    const fetch: FetchLike = async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('event: ping\ndata: {}\n\n'));
        },
        cancel(reason) {
          canceled = true;
          canceledReason = reason;
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const handler = await handlerWith(fetch);
    const response = await handler(post('/v1/messages', { model: 'claude-opus', stream: true, messages: [] }));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel('client-disconnected');
    expect(canceled).toBe(true);
    expect(canceledReason).toBe('client-disconnected');
  });

  test('measures-selected-fetch-compression-contract', async () => {
    // Uses the real bunRawFetch adapter (src/transport/bun-fetch.ts), not a fake, and checks its
    // recorded TransportCapabilityProfile fixture for the exact (adapterId, runtimeVersion) pair
    // actually running here before trusting it to pass gzip bytes through untouched.
    const transportProfile = await loadTransportCapabilityProfile(
      BUN_RAW_FETCH_ADAPTER.id,
      BUN_RAW_FETCH_ADAPTER.runtimeVersion,
      CAPABILITY_FIXTURES_DIR,
    );
    expect(transportProfile.status).toBe('passed');
    expect(transportProfile.gzipBytes).toBe('passed');
    expect(transportProfile.responseHeaders).toBe('passed');

    const payload = JSON.stringify({ id: 'msg', content: [{ type: 'text', text: 'x'.repeat(2048) }] });
    const gzipped = Bun.gzipSync(new TextEncoder().encode(payload));
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(gzipped, { status: 200, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(gzipped.byteLength) } });
      },
    });
    try {
      const upstreamResponse = await bunRawFetch(new Request(`http://127.0.0.1:${server.port}/probe`));
      const receivedBytes = new Uint8Array(await upstreamResponse.arrayBuffer());
      expect(receivedBytes).toEqual(gzipped);
      expect(upstreamResponse.headers.get('content-encoding')).toBe('gzip');
      expect(upstreamResponse.headers.get('content-length')).toBe(String(gzipped.byteLength));
    } finally {
      server.stop(true);
    }
  });

  test('incoming-path-cannot-redirect-destination-host', async () => {
    let capturedUrl: string | undefined;
    const fetch: FetchLike = async (request) => {
      capturedUrl = request.url;
      return new Response(null, { status: 200 });
    };
    const handler = await handlerWith(fetch);
    // A pathname shaped like an absolute URL must never make `new URL(relative, base)` discard
    // the configured gateway host in favor of the attacker-controlled one.
    await handler(new Request('http://router.local/v1/https://other.invalid/x', { method: 'GET' }));
    expect(capturedUrl).toBeDefined();
    // The path may still literally contain the string (as an inert path segment); what must
    // never happen is the HOST becoming attacker-controlled.
    expect(new URL(capturedUrl as string).host).toBe('127.0.0.1:8000');
  });

  test('response-body-cancel-aborts-the-exact-signal-passed-to-upstream-fetch', async () => {
    let capturedRequest: Request | undefined;
    const fetch: FetchLike = async (request) => {
      capturedRequest = request;
      const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); } });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const handler = await handlerWith(fetch);
    const response = await handler(post('/v1/messages', { model: 'claude-opus', stream: true, messages: [] }));
    expect(capturedRequest?.signal.aborted).toBe(false);
    await response.body?.cancel('client-gave-up');
    expect(capturedRequest?.signal.aborted).toBe(true);
  });

  test('mutating-callers-config-profile-source-after-creation-does-not-affect-handler', async () => {
    const { fetch, seen } = upstream();
    const config = configFixture();
    const profile: CapabilityProfile = { ...FIXTURE_SUPPORTED_PROFILE, adapterMarkerPosition: 'system', probes: { ...FIXTURE_SUPPORTED_PROFILE.probes, M3: 'passed' } };
    const src = { ...source, gatewayHeaders: { ...source.gatewayHeaders } };
    const handler = await handlerWith(fetch, { config, profile, source: src });

    config.roles['claude-code:explorer'] = { routeOverride: 'tampered-model' };
    profile.status = 'unsupported';
    src.gatewayHeaders = { 'X-Team': 'tampered' };

    const child = await handler(post('/v1/messages', { model: 'x', system: CHILD_SYSTEM, messages: [{ role: 'user', content: '<subagent-router v="1" model="fast"/>\nZadanie' }] }));
    expect(child.status).toBe(200);
    expect(seen[0]?.body.model).toBe(FIXTURE_MODEL_ID);
    expect(seen[0]?.headers.get('x-team')).toBe('router');
  });

  test('non-object-json-body-on-routable-path-returns-400-not-a-throw', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch);
    for (const payload of [null, [], 'scalar', 42, true]) {
      const response = await handler(post('/v1/messages', payload));
      expect(response.status).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  test('unknown-or-method-mismatched-control-path-never-forwards-upstream', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch);
    const badMethod = await handler(new Request('http://router.local/subagent-router/control/instance', { method: 'POST' }));
    expect(badMethod.status).toBe(405);
    const unknown = await handler(new Request('http://router.local/subagent-router/control/unknown-path'));
    expect(unknown.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  test('b2-eligibility-requires-a-real-correlation-store-not-just-matching-probes', async () => {
    const { fetch, seen } = upstream();
    // claude-marker's gate is satisfied via a request-scoped lifecyclePhase (only that one phase
    // must be 'passed'), while claude-correlation (used to construct the correlationStore) always
    // requires every lifecycle phase passed. A profile with only one phase proven should therefore
    // never get a live correlationStore, and B2 must not grant role-based routing without one.
    const profile: CapabilityProfile = {
      ...FIXTURE_SUPPORTED_PROFILE,
      lifecycle: { 'next-turn': 'passed', resume: 'pending', compaction: 'pending', nested: 'pending', parallel: 'pending' },
    };
    const handler = await handlerWith(fetch, { profile, trustedContext: () => ({ freshDelegation: true, lifecyclePhase: 'next-turn' }) });
    const instance = await handler(new Request('http://router.local/subagent-router/control/instance'));
    const handlerInstanceId = ((await instance.json()) as { handlerInstanceId: string }).handlerInstanceId;
    const unsigned = { version: 1, handlerInstanceId, agentId: 'agent-partial', role: 'explorer', nonce: 'fresh-partial', issuedAtMs: 0 } as const;
    const envelope: FreshDelegationEnvelope = { ...unsigned, proof: await signFreshDelegation('test-secret', unsigned) };
    expect((await handler(post('/subagent-router/control/delegations', envelope))).status).toBe(204);
    const response = await handler(post('/v1/messages', { model: 'x', system: CHILD_SYSTEM, messages: [{ role: 'user', content: 'bez markera' }] }, { 'x-claude-code-agent-id': 'agent-partial' }));
    expect(response.status).toBe(422);
    expect(seen).toHaveLength(0);
  });

  test('fresh-store-rejects-conflicting-registration-for-a-still-pending-agent', async () => {
    const { fetch } = upstream();
    const handler = await handlerWith(fetch);
    const instance = await handler(new Request('http://router.local/subagent-router/control/instance'));
    const handlerInstanceId = ((await instance.json()) as { handlerInstanceId: string }).handlerInstanceId;
    const first = { version: 1, handlerInstanceId, agentId: 'agent-conflict', role: 'explorer', nonce: 'nonce-first', issuedAtMs: 0 } as const;
    const firstEnvelope: FreshDelegationEnvelope = { ...first, proof: await signFreshDelegation('test-secret', first) };
    expect((await handler(post('/subagent-router/control/delegations', firstEnvelope))).status).toBe(204);

    const second = { version: 1, handlerInstanceId, agentId: 'agent-conflict', role: 'explorer', nonce: 'nonce-second', issuedAtMs: 0 } as const;
    const secondEnvelope: FreshDelegationEnvelope = { ...second, proof: await signFreshDelegation('test-secret', second) };
    expect((await handler(post('/subagent-router/control/delegations', secondEnvelope))).status).toBe(409);
  });

  test('fresh-store-envelope-shape-rejects-non-finite-issuedAt-and-overlong-identifiers', async () => {
    const { fetch } = upstream();
    const handler = await handlerWith(fetch);
    const instance = await handler(new Request('http://router.local/subagent-router/control/instance'));
    const handlerInstanceId = ((await instance.json()) as { handlerInstanceId: string }).handlerInstanceId;

    const nonFinite = { version: 1, handlerInstanceId, agentId: 'agent-nf', role: 'explorer', nonce: 'nonce-nf', issuedAtMs: Number.POSITIVE_INFINITY } as const;
    const nonFiniteEnvelope: FreshDelegationEnvelope = { ...nonFinite, proof: await signFreshDelegation('test-secret', nonFinite) };
    expect((await handler(post('/subagent-router/control/delegations', nonFiniteEnvelope))).status).toBe(422);

    const overlong = { version: 1, handlerInstanceId, agentId: 'a'.repeat(1000), role: 'explorer', nonce: 'nonce-ol', issuedAtMs: 0 } as const;
    const overlongEnvelope: FreshDelegationEnvelope = { ...overlong, proof: await signFreshDelegation('test-secret', overlong) };
    expect((await handler(post('/subagent-router/control/delegations', overlongEnvelope))).status).toBe(422);
  });

  test('hop-by-hop-and-connection-named-headers-are-never-forwarded-upstream', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch);
    await handler(post('/v1/models', {}, { connection: 'keep-alive, x-custom-drop', 'keep-alive': 'timeout=5', 'x-custom-drop': 'secret-hop-value' }));
    expect(seen[0]?.headers.get('connection')).toBeNull();
    expect(seen[0]?.headers.get('keep-alive')).toBeNull();
    expect(seen[0]?.headers.get('x-custom-drop')).toBeNull();
  });

  test('freshness-nonce-stays-valid-until-issuedAt-plus-ttl-not-registration-time-plus-ttl', async () => {
    const { fetch, seen } = upstream();
    let currentNow = 0;
    const handler = await handlerWith(fetch, { now: () => currentNow });
    const instance = await handler(new Request('http://router.local/subagent-router/control/instance'));
    const handlerInstanceId = ((await instance.json()) as { handlerInstanceId: string }).handlerInstanceId;

    // Registered at now=0 with issuedAtMs=30000 (right at the edge of the future-tolerance
    // window; ttl is FRESHNESS_WINDOW_MS = 30_000).
    const unsigned = { version: 1, handlerInstanceId, agentId: 'agent-ttl', role: 'explorer', nonce: 'nonce-ttl', issuedAtMs: 30_000 } as const;
    const envelope: FreshDelegationEnvelope = { ...unsigned, proof: await signFreshDelegation('test-secret', unsigned) };
    expect((await handler(post('/subagent-router/control/delegations', envelope))).status).toBe(204);

    // Consume the pending receipt so only the used-nonce record still guards against replay.
    await handler(post('/v1/messages', { model: 'x', system: CHILD_SYSTEM, messages: [{ role: 'user', content: 'bez markera' }] }, { 'x-claude-code-agent-id': 'agent-ttl' }));
    expect(seen).toHaveLength(1);

    // Advance to now = registrationTime + ttl (0 + 30000). A store that pegs nonce expiry to
    // registration time would have swept the nonce by now and accept a replay of the exact same
    // envelope. Expiry must instead be pegged to the envelope's own issuedAtMs + ttlMs
    // (30000 + 30000 = 60000), so the nonce is still recorded as used here.
    currentNow = 30_000;
    const replay = await handler(post('/subagent-router/control/delegations', envelope));
    expect(replay.status).toBe(409);
  });

  test('freshness-registration-rejects-exactly-at-the-ttl-boundary', async () => {
    const { fetch } = upstream();
    let currentNow = 0;
    const handler = await handlerWith(fetch, { now: () => currentNow });
    const instance = await handler(new Request('http://router.local/subagent-router/control/instance'));
    const handlerInstanceId = ((await instance.json()) as { handlerInstanceId: string }).handlerInstanceId;

    const unsigned = { version: 1, handlerInstanceId, agentId: 'agent-boundary', role: 'explorer', nonce: 'nonce-boundary', issuedAtMs: 0 } as const;
    const envelope: FreshDelegationEnvelope = { ...unsigned, proof: await signFreshDelegation('test-secret', unsigned) };

    // now === issuedAtMs + ttlMs exactly (0 + 30000): the boundary is strict and one-sided, so
    // registration at this instant must be rejected as expired, never accepted.
    currentNow = 30_000;
    const atBoundary = await handler(post('/subagent-router/control/delegations', envelope));
    expect(atBoundary.status).toBe(409);
  });

  test('freshness-registration-rejects-a-timestamp-issued-further-in-the-future-than-ttl', async () => {
    const { fetch } = upstream();
    const handler = await handlerWith(fetch);
    const instance = await handler(new Request('http://router.local/subagent-router/control/instance'));
    const handlerInstanceId = ((await instance.json()) as { handlerInstanceId: string }).handlerInstanceId;

    // issuedAtMs is 30001ms ahead of now (0), one millisecond beyond the ttl (30000) window: this
    // is the separate "issued too far in the future" rejection, not the "too old" branch.
    const unsigned = { version: 1, handlerInstanceId, agentId: 'agent-future', role: 'explorer', nonce: 'nonce-future', issuedAtMs: 30_001 } as const;
    const envelope: FreshDelegationEnvelope = { ...unsigned, proof: await signFreshDelegation('test-secret', unsigned) };
    const response = await handler(post('/subagent-router/control/delegations', envelope));
    expect(response.status).toBe(409);
  });

  test('rejects-unmeasured-or-mismatched-transport-profile-before-handler-start', async () => {
    const { fetch } = upstream();
    const cases: Array<Partial<Parameters<typeof createHandler>[0]>> = [
      { transportProfile: { ...FIXTURE_TRANSPORT_PROFILE, status: 'pending' } },
      { transportProfile: { ...FIXTURE_TRANSPORT_PROFILE, gzipBytes: 'failed' } },
      { transportProfile: { ...FIXTURE_TRANSPORT_PROFILE, responseHeaders: 'pending' } },
      { transportProfile: { ...FIXTURE_TRANSPORT_PROFILE, adapterId: 'other-adapter' } },
      { transportProfile: { ...FIXTURE_TRANSPORT_PROFILE, runtimeVersion: 'other-version' } },
    ];
    for (const patch of cases) {
      await expect(handlerWith(fetch, patch)).rejects.toThrow();
    }
  });
});

describe('createHandler: channel-A marker after the measured native context prefix', () => {
  const LAYOUT_PROFILE: CapabilityProfile = { ...FIXTURE_SUPPORTED_PROFILE, version: '2.1.266', correlation: false, correlationEntropy: 'pending', adapterMarkerPosition: 'unknown', parentPromptPosition: 'after-native-context-v1', probes: { M10: 'passed', 'M3-A': 'passed' } };
  const PAYLOAD = '<subagent-router v="1" model="fast"/>\nZadanie';

  test('request w zmierzonym układzie z zgodną wersją klienta jest routowany, blok kontekstu jest przekazany bez zmian, marker znika', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch, { profile: LAYOUT_PROFILE });
    const res = await handler(post('/v1/messages', { model: 'claude-haiku', system: CHILD_SYSTEM, messages: [nativeLayoutUserMessage(PAYLOAD)] }, { 'user-agent': 'claude-cli/2.1.266 (external, sdk-cli)', 'x-claude-code-agent-id': 'agent-1' }));
    expect(res.status).toBe(200);
    expect(seen[0]?.body.model).toBe(FIXTURE_MODEL_ID);
    const content = (seen[0]?.body.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content;
    expect(content?.[0]?.text).toBe(nativeContextBlockV1());
    expect(content?.[1]?.text).toBe('Zadanie');
  });

  test('ten sam układ z inną wersją klienta w requeście kończy się missing-selection bez requestu upstream', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch, { profile: LAYOUT_PROFILE });
    const res = await handler(post('/v1/messages', { model: 'claude-haiku', system: CHILD_SYSTEM, messages: [nativeLayoutUserMessage(PAYLOAD)] }, { 'user-agent': 'claude-cli/2.1.263 (external, sdk-cli)' }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { code: 'missing-selection' } });
    expect(seen).toHaveLength(0);
  });
});
