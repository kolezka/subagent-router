// Guards the one operator-telemetry seam in createHandler. Every test here is about what the
// observer may NOT do: it may not change a response, it may not touch a body, and it may not
// carry request content. The routing assertions that live in handler.test.ts are not repeated;
// what is repeated is that they still hold with an observer attached.
import { describe, expect, test } from 'bun:test';
import type { CapabilityProfile, FetchLike } from '../../src/core/types';
import { createHandler } from '../../src/transport/handler';
import type { HandlerEvent } from '../../src/transport/handler';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

const GATEWAY_HEADER_SECRET = 'gw-secret-8f21ba';
const PROMPT_SECRET = 'prompt-secret-c40de1';

const source = {
  sourceId: 'test-gateway',
  effectiveGatewayUrl: 'https://operator:url-secret-99aa@gateway.invalid/v1',
  effectiveModelsUrl: 'https://operator:url-secret-99aa@gateway.invalid/v1/models',
  headers: { Authorization: 'Bearer discovery-only-token' },
  gatewayHeaders: { 'X-Gateway-Auth': GATEWAY_HEADER_SECRET },
};

const SUPPORTED_PROFILE: CapabilityProfile = {
  client: 'claude-code',
  version: 'synthetic-hermetic',
  status: 'supported',
  correlation: true,
  correlationEntropy: 'passed',
  fork: false,
  adapterMarkerPosition: 'b2',
  probes: { M1: 'passed', 'M3-B2': 'passed', M10: 'passed', 'M10-freshness': 'passed' },
  lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' },
};
const TRANSPORT_PROFILE = { adapterId: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic', status: 'passed', gzipBytes: 'passed', responseHeaders: 'passed' } as const;
const CHILD_SYSTEM = [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }];

function upstream(): { fetch: FetchLike; seen: Array<{ url: string; body: unknown }> } {
  const seen: Array<{ url: string; body: unknown }> = [];
  const fetch: FetchLike = async (request) => {
    seen.push({ url: request.url, body: await request.json() });
    return new Response(JSON.stringify({ id: 'msg', content: [{ type: 'text', text: 'ok' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, seen };
}

async function handlerWith(fetch: FetchLike, patch: Partial<Parameters<typeof createHandler>[0]> = {}) {
  return createHandler({
    config: configFixture(),
    snapshot: await snapshotFixture(),
    source,
    profile: SUPPORTED_PROFILE,
    transportProfile: TRANSPORT_PROFILE,
    secret: 'test-secret',
    fetch,
    fetchAdapter: { id: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic' },
    trustedContext: () => ({ freshDelegation: false }),
    now: () => 0,
    nonce: () => 'fixture-nonce',
    instanceId: () => 'fixture-handler-instance',
    ...patch,
  });
}

/** Builds a handler whose observer collects into the returned array. */
async function observed(fetch: FetchLike, patch: Partial<Parameters<typeof createHandler>[0]> = {}) {
  const events: HandlerEvent[] = [];
  const handler = await handlerWith(fetch, { onEvent: (event) => events.push(event), ...patch });
  return { handler, events };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://router.local${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

function routedChild(): Request {
  return post('/v1/messages', {
    model: 'claude-haiku',
    system: CHILD_SYSTEM,
    messages: [{ role: 'user', content: `<subagent-router v="1" model="fast"/>\n${PROMPT_SECRET}` }],
  });
}

describe('createHandler observer seam', () => {
  test('an observer that always throws never changes a response', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch, {
      onEvent: () => {
        throw new Error('observer blew up');
      },
    });

    const routed = await handler(routedChild());
    const refused = await handler(post('/v1/messages', { model: 'x', system: CHILD_SYSTEM, messages: [{ role: 'user', content: 'no marker' }] }));
    const parent = await handler(post('/v1/messages', { model: 'claude-opus', messages: [{ role: 'user', content: 'parent' }] }));

    expect(routed.status).toBe(200);
    expect((await routed.json()) as unknown).toEqual({ id: 'msg', content: [{ type: 'text', text: 'ok' }] });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('missing-selection');
    expect(parent.status).toBe(200);
    expect(seen.map((call) => (call.body as { model: string }).model)).toEqual([FIXTURE_MODEL_ID, 'claude-opus']);
  });

  test('emits no prompt text, no header value, no gateway URL and no credential', async () => {
    const { fetch } = upstream();
    const { handler, events } = await observed(fetch);

    await handler(routedChild());
    await handler(post('/v1/messages', { model: 'claude-opus', messages: [{ role: 'user', content: PROMPT_SECRET }] }, { 'x-gateway-auth': GATEWAY_HEADER_SECRET }));
    await handler(post('/v1/messages', { model: 'x', system: CHILD_SYSTEM, messages: [{ role: 'user', content: PROMPT_SECRET }] }));

    expect(events).toHaveLength(3);
    const emitted = JSON.stringify(events);
    expect(emitted).not.toContain(PROMPT_SECRET);
    expect(emitted).not.toContain(GATEWAY_HEADER_SECRET);
    expect(emitted).not.toContain('url-secret-99aa');
    expect(emitted).not.toContain('gateway.invalid');
    expect(emitted).not.toContain('test-secret');
    // The one model id an event does carry is the routing target from the configured catalog,
    // never anything the client sent.
    expect(events[0]?.upstreamModel).toBe(FIXTURE_MODEL_ID);
  });

  test('emits at the parent pass-through, the routed forward and every error return', async () => {
    const { fetch } = upstream();
    const { handler, events } = await observed(fetch);

    await handler(post('/v1/messages', { model: 'claude-opus', messages: [{ role: 'user', content: 'parent' }] }));
    await handler(routedChild());
    await handler(post('/v1/messages', { model: 'x', system: CHILD_SYSTEM, messages: [{ role: 'user', content: 'no marker' }] }));
    await handler(new Request('http://router.local/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' }));
    await handler(post('/v1/messages', [1, 2, 3]));

    expect(events.map((event) => [event.kind, event.scope, event.decision, event.code, event.status])).toEqual([
      ['route-decision', 'parent', 'pass-through', undefined, undefined],
      ['route-decision', 'child', 'route', undefined, undefined],
      ['route-error', 'child', 'error', 'missing-selection', 422],
      ['route-error', 'parent', 'error', 'invalid-json', 400],
      ['route-error', 'parent', 'error', 'invalid-json', 400],
    ]);
    expect(events[1]?.source).toBe('explicit');
    expect(events.every((event) => event.path === '/v1/messages')).toBe(true);
  });

  test('emits for a capability refusal', async () => {
    const { fetch, seen } = upstream();
    const { handler, events } = await observed(fetch, { profile: { ...SUPPORTED_PROFILE, status: 'pending' } });

    const response = await handler(routedChild());

    expect(response.status).toBe(422);
    expect(seen).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('route-error');
    expect(events[0]?.code).toBe('unsupported-path');
    expect(events[0]?.status).toBe(422);
  });

  test('carries the already-normalized role and agent id, nothing else identifying', async () => {
    const { fetch } = upstream();
    const { handler, events } = await observed(fetch);

    await handler(post('/v1/messages', { model: 'claude-haiku', system: CHILD_SYSTEM, messages: [{ role: 'user', content: '<subagent-router v="1" model="fast"/>\nTask' }] }, { 'x-claude-code-agent-id': 'agent-77' }));

    expect(events[0]?.agentId).toBe('agent-77');
    expect(events[0]?.scope).toBe('child');
  });

  test('durationMs is measured from the start of handleRoutable', async () => {
    const { fetch } = upstream();
    let ticks = 0;
    const { handler, events } = await observed(fetch, { now: () => (ticks += 7) });

    await handler(post('/v1/messages', { model: 'claude-opus', messages: [{ role: 'user', content: 'parent' }] }));

    expect(events[0]?.durationMs).toBe(7);
  });

  test('fires at the decision point, before the upstream response exists', async () => {
    let release: (() => void) | undefined;
    const upstreamAnswered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: HandlerEvent[] = [];
    const fetch: FetchLike = async () => {
      // The observer must already have fired by here: nothing it reports depends on an upstream
      // body, so it can never be waiting on one.
      expect(events).toHaveLength(1);
      await upstreamAnswered;
      return new Response('streamed', { status: 200 });
    };
    const handler = await handlerWith(fetch, { onEvent: (event) => events.push(event) });

    const pending = handler(routedChild());
    release?.();
    const response = await pending;

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('streamed');
    expect(events).toHaveLength(1);
  });

  test('never fires for a control path or a raw forward', async () => {
    const rawFetch: FetchLike = async () => new Response('raw', { status: 200 });
    const { handler, events } = await observed(rawFetch);

    await handler(new Request('http://router.local/subagent-router/control/instance'));
    await handler(new Request('http://router.local/subagent-router/control/nope'));
    await handler(new Request('http://router.local/v1/models'));

    expect(events).toHaveLength(0);
  });

  test('a handler built without an observer answers exactly as one built with it', async () => {
    const withoutFetch = upstream();
    const withFetch = upstream();
    const plain = await handlerWith(withoutFetch.fetch);
    const { handler: instrumented } = await observed(withFetch.fetch);

    for (const build of [routedChild, () => post('/v1/messages', { model: 'claude-opus', messages: [{ role: 'user', content: 'parent' }] }), () => post('/v1/messages', { model: 'x', system: CHILD_SYSTEM, messages: [{ role: 'user', content: 'no marker' }] })]) {
      const a = await plain(build());
      const b = await instrumented(build());
      expect(a.status).toBe(b.status);
      expect(await a.text()).toBe(await b.text());
    }

    expect(withoutFetch.seen).toEqual(withFetch.seen);
  });
});
