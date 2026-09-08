// Opt-in PoC: real `claude` CLI -> OUR createHandler -> loopback mock upstream.
//
// The synthetic profile below is injected EXPLICITLY into the handler purely to
// measure channel A. It is a measurement device for this probe and must NOT be
// recorded anywhere as a supported profile.
//
// Opt-in: does nothing unless RUN_NATIVE_PROBES=1, so import/collect is side-effect free.
// Run: RUN_NATIVE_PROBES=1 bun tests/probes/native-claude-handler.ts
// ponytail: single child turn, tools-only fixture. Ceiling: no resume/compaction/
// nested/parallel, so this cannot close M10.

import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { CapabilityProfile, FetchLike } from '../../src/core/types';
import { createHandler } from '../../src/transport/handler';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

if (process.env.RUN_NATIVE_PROBES !== '1') {
  console.log('skip: set RUN_NATIVE_PROBES=1 to run (no side effects on import)');
  process.exit(0);
}

const OUT = `${import.meta.dir}/.runs/handler-${process.pid}`;
mkdirSync(OUT, { recursive: true });
let seq = 0;
const rec = (kind: string, o: unknown) =>
  writeFileSync(`${OUT}/${String(++seq).padStart(3, '0')}-${kind}.json`, JSON.stringify(o, null, 2));

const MARKER = '<subagent-router v="1" model="fast"/>';

// ---- mock upstream: the only network endpoint, records what the handler forwarded
const seen: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
const upstreamFetch: FetchLike = async (request) => {
  const body = (await request.json()) as Record<string, unknown>;
  const headers = Object.fromEntries(request.headers.entries());
  seen.push({ url: request.url, body, headers });
  rec('post-handler-upstream', { url: request.url, headers, body });
  const isChild = JSON.stringify(body.system ?? '').includes('cc_is_subagent=true');
  const text = isChild ? 'CHILD_VIA_HANDLER_OK' : 'PARENT_VIA_HANDLER_OK';
  const sse = [
    ['message_start', { type: 'message_start', message: { id: 'msg_h', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 5, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }],
    ['message_stop', { type: 'message_stop' }],
  ] as const;
  return new Response(sse.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
};

// Measurement-only synthetic profile. NOT a supported profile.
const SYNTHETIC_PROFILE: CapabilityProfile = {
  client: 'claude-code', version: 'synthetic-hermetic', status: 'supported',
  correlation: true, correlationEntropy: 'passed', fork: false, adapterMarkerPosition: 'b2',
  probes: { M1: 'passed', 'M3-B2': 'passed', M10: 'passed', 'M10-freshness': 'passed' },
  lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' },
};

const handler = createHandler({
  config: configFixture(),
  snapshot: await snapshotFixture(),
  source: { sourceId: 'probe', effectiveGatewayUrl: 'http://127.0.0.1:1/v1', effectiveModelsUrl: 'http://127.0.0.1:1/v1/models', headers: {}, gatewayHeaders: {} },
  profile: SYNTHETIC_PROFILE,
  transportProfile: { adapterId: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic', status: 'passed', gzipBytes: 'passed', responseHeaders: 'passed' },
  secret: 'probe-secret',
  fetch: upstreamFetch,
  fetchAdapter: { id: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic' },
  trustedContext: () => ({ freshDelegation: false }),
  now: () => 0, nonce: () => 'probe-nonce', instanceId: () => 'probe-instance',
});

// ---- front server the real CLI talks to
const front = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    let parsed: unknown = {};
    try { parsed = JSON.parse(raw || '{}'); } catch { /* recorded raw */ }
    rec('pre-handler', { url: req.url, headers: req.headers, body: parsed });
    const init: { method?: string; headers: Record<string, string>; body?: string } = {
      headers: req.headers as Record<string, string>,
      ...(req.method !== undefined ? { method: req.method } : {}),
      ...(raw ? { body: raw } : {}),
    };
    const out = await handler(new Request(`http://router.local${req.url}`, init));
    res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
});
await new Promise<void>((r) => front.listen(0, '127.0.0.1', () => r()));
const port = (front.address() as { port: number }).port;
writeFileSync(`${OUT}/front-port`, String(port));
console.log(`front(handler) 127.0.0.1:${port}  out=${OUT}`);
console.log(`MARKER first line = ${MARKER}`);
console.log('drive the CLI at ANTHROPIC_BASE_URL=http://127.0.0.1:' + port);
