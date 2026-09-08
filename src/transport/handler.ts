import { assertCapability } from '../adapters/capabilities';
import { CorrelationStore } from '../adapters/correlation';
import { enrichParentTools, normalizeClaudeRequest } from '../adapters/claude-code';
import { buildCatalog } from '../core/catalog';
import { RouterError } from '../core/errors';
import { resolveRoute } from '../core/route';
import type {
  CapabilityProfile,
  CatalogSnapshot,
  EffectiveCatalog,
  FetchLike,
  FreshDelegationEnvelope,
  FreshDelegationReceipt,
  HeaderMap,
  OperatorConfig,
  RouteInput,
  SourceContext,
  TransportCapabilityProfile,
  TrustedLifecycleContext,
} from '../core/types';

// Re-exported so the published `./handler` entrypoint exposes both halves of the transport
// contract from one module: the request handler and the SubagentStart hook output builder that
// feeds it. Consumers of the package import `createClaudeStartOutput` from here rather than
// reaching into an unexported internal path.
export { createClaudeStartOutput } from './hooks';
export type { CreateClaudeStartOutputInput, CreateClaudeStartOutputOptions } from './hooks';

// Freshness receipts prove a subagent-start hook ran recently, not forever. This TTL is not
// exposed as config anywhere in the brief or shared types, so it is an internal, undocumented
// default rather than a spec value.
const FRESHNESS_WINDOW_MS = 30_000;

const encoder = new TextEncoder();

async function importHmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Freshness HMAC is a separate domain from the marker HMAC (`v=1|role=<role>|agent=<agent>` in
// src/adapters/markers.ts). A valid or replayed marker token must never be usable as a freshness
// proof, so the canonical message here is a distinct, versioned, structurally different string.
function freshnessCanonicalJson(envelope: Omit<FreshDelegationEnvelope, 'proof'>): string {
  return JSON.stringify([
    'subagent-router:freshness:v1',
    envelope.version,
    envelope.handlerInstanceId,
    envelope.agentId,
    envelope.role,
    envelope.nonce,
    envelope.issuedAtMs,
  ]);
}

export async function signFreshDelegation(secret: string, envelope: Omit<FreshDelegationEnvelope, 'proof'>): Promise<string> {
  const key = await importHmacKey(secret, 'sign');
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(freshnessCanonicalJson(envelope)));
  return toHex(signature);
}

async function verifyFreshDelegationProof(secret: string, envelope: FreshDelegationEnvelope): Promise<boolean> {
  const proofBytes = fromHex(envelope.proof);
  if (proofBytes === undefined) return false;
  const key = await importHmacKey(secret, 'verify');
  return crypto.subtle.verify('HMAC', key, proofBytes, encoder.encode(freshnessCanonicalJson(envelope)));
}

// Bounds every identifier field of an incoming envelope. These are opaque tokens, not free text:
// an unbounded length would let a caller stuff arbitrarily large strings into in-memory maps
// keyed by them.
const MAX_IDENTIFIER_LENGTH = 256;

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

function isFreshDelegationEnvelopeShape(value: unknown): value is FreshDelegationEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    isBoundedIdentifier(v.handlerInstanceId) &&
    isBoundedIdentifier(v.agentId) &&
    isBoundedIdentifier(v.role) &&
    isBoundedIdentifier(v.nonce) &&
    typeof v.issuedAtMs === 'number' &&
    Number.isFinite(v.issuedAtMs) &&
    typeof v.proof === 'string'
  );
}

interface NonceRecord {
  expiresAt: number;
}

/**
 * Holds freshness receipts registered via the control endpoint. Ephemeral, in-memory, one
 * instance per handler: everything is lost on restart by design (this is not a database or a
 * lifecycle manager). An entry is bound to this exact handlerInstanceId and is consumed exactly
 * once, atomically, by consumeFreshDelegation. Used nonces are retained until they individually
 * expire so a replay of an old envelope is rejected even after the original entry was consumed.
 */
export class FreshDelegationStore {
  private readonly entries = new Map<string, { role: string; nonce: string; expiresAt: number }>();
  private readonly usedNonces = new Map<string, NonceRecord>();

  constructor(
    readonly handlerInstanceId: string,
    private readonly now: () => number,
    private readonly ttlMs: number,
  ) {}

  private sweepExpiredNonces(nowMs: number): void {
    for (const [nonce, record] of this.usedNonces) {
      if (record.expiresAt <= nowMs) this.usedNonces.delete(nonce);
    }
  }

  async register(envelope: FreshDelegationEnvelope): Promise<void> {
    const nowMs = this.now();
    this.sweepExpiredNonces(nowMs);

    if (envelope.handlerInstanceId !== this.handlerInstanceId) {
      throw new RouterError('stale-instance', 'freshness envelope targets a different handler instance');
    }
    // Expiry is pegged to the envelope's own issuedAtMs, never to registration wall-clock time.
    // Pegging to `nowMs + ttlMs` let a nonce get swept (and the same envelope replayed) at
    // now = registrationTime + ttl even though, measured from its own issuedAtMs, the envelope
    // was still meant to be valid until issuedAtMs + ttl.
    const expiresAt = envelope.issuedAtMs + this.ttlMs;
    if (nowMs >= expiresAt) {
      throw new RouterError('freshness-expired', 'freshness envelope is outside the allowed time window');
    }
    if (envelope.issuedAtMs - nowMs > this.ttlMs) {
      throw new RouterError('freshness-expired', 'freshness envelope is issued too far in the future');
    }
    if (this.usedNonces.has(envelope.nonce)) {
      throw new RouterError('freshness-replay', 'freshness nonce was already used');
    }
    // A still-live, unconsumed entry for this agent must never be silently overwritten by a
    // second registration (a new nonce or a different role): that would let a later, possibly
    // attacker-controlled envelope replace a legitimate pending receipt underneath the agent it
    // was issued for. Reject instead; the caller may retry once the existing entry is consumed or
    // has expired.
    const existing = this.entries.get(envelope.agentId);
    if (existing !== undefined && existing.expiresAt > nowMs) {
      throw new RouterError('freshness-conflict', 'agent already has a pending freshness receipt');
    }

    this.usedNonces.set(envelope.nonce, { expiresAt });
    this.entries.set(envelope.agentId, { role: envelope.role, nonce: envelope.nonce, expiresAt });
  }

  consumeFreshDelegation(agentId: string): FreshDelegationReceipt | undefined {
    const entry = this.entries.get(agentId);
    if (entry === undefined) return undefined;
    this.entries.delete(agentId);
    if (entry.expiresAt <= this.now()) return undefined;
    return { agentId, role: entry.role, nonce: entry.nonce };
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function errorResponse(status: number, code: string): Response {
  return jsonResponse(status, { error: { code } });
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

// The destination host/scheme come only from the configured gateway base, never from the
// incoming request path. Building the target via string-relative resolution (`new URL(relative,
// base)`) is unsafe here: WHATWG URL parsing treats a `relative` argument that itself parses as
// an absolute URL (has a scheme, e.g. a path like "/v1/https://other.invalid/x") as an
// absolute-URL-in-relative-position and silently discards `base` entirely, letting an incoming
// path pick an arbitrary upstream host. Instead we always start from a URL built from the trusted
// base and only ever mutate `.pathname`/`.search` on it, which never reinterprets scheme or host.
function buildUpstreamUrl(pathname: string, search: string, gatewayBase: string): URL {
  const suffix = pathname.startsWith('/v1/') ? pathname.slice('/v1/'.length) : pathname.replace(/^\//, '');
  const url = new URL(ensureTrailingSlash(gatewayBase));
  url.pathname = `${ensureTrailingSlash(url.pathname)}${suffix}`;
  url.search = search;
  return url;
}

// RFC 7230 section 6.1 hop-by-hop headers describe a single transport hop and must never be
// proxied to the next one. A header named as a value of the incoming Connection header is also
// hop-by-hop for this specific forward, even though its name is not on the standard list.
const HOP_BY_HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function buildUpstreamHeaders(request: Request, sourceHeaders: HeaderMap): Headers {
  const headers = new Headers(request.headers);
  const connectionValue = headers.get('connection');
  headers.delete('host');
  headers.delete('content-length');
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  if (connectionValue !== null) {
    for (const named of connectionValue.split(',')) {
      const trimmed = named.trim().toLowerCase();
      if (trimmed) headers.delete(trimmed);
    }
  }
  for (const [key, value] of Object.entries(sourceHeaders)) headers.set(key, value);
  return headers;
}

// Links the client-facing response body to the exact AbortSignal passed to the upstream fetch:
// canceling the returned Response's body (reader.cancel(), or the client disconnecting) must
// deterministically abort the upstream request, not merely release a shared stream object. A
// bare `new Response(upstreamResponse.body, ...)` shares the object but a downstream .cancel()
// on it does not reliably propagate to `upstreamRequest.signal`, so we wrap the upstream body in
// an explicit bounded pass-through ReadableStream (one chunk per pull -> reader.read(), no
// decoding or buffering) whose cancel() aborts the linked controller.
function boundedPassThrough(upstreamBody: ReadableStream<Uint8Array> | null, controller: AbortController): ReadableStream<Uint8Array> | null {
  if (upstreamBody === null) return null;
  const reader = upstreamBody.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(streamController) {
      const { done, value } = await reader.read();
      if (done) {
        streamController.close();
        return;
      }
      streamController.enqueue(value);
    },
    cancel(reason) {
      controller.abort(reason);
      return reader.cancel(reason);
    },
  });
}

function linkedAbortController(requestSignal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (requestSignal.aborted) {
    controller.abort(requestSignal.reason);
  } else {
    requestSignal.addEventListener('abort', () => controller.abort(requestSignal.reason), { once: true });
  }
  return controller;
}

async function forwardRaw(request: Request, targetUrl: URL, sourceHeaders: HeaderMap, fetchFn: FetchLike): Promise<Response> {
  const headers = buildUpstreamHeaders(request, sourceHeaders);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const controller = linkedAbortController(request.signal);
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: 'manual',
    signal: controller.signal,
    ...(hasBody ? { body: request.body, duplex: 'half' as const } : {}),
  };
  const upstreamRequest = new Request(targetUrl, init);
  const upstreamResponse = await fetchFn(upstreamRequest);
  return new Response(boundedPassThrough(upstreamResponse.body, controller), {
    status: upstreamResponse.status,
    headers: upstreamResponse.headers,
  });
}

async function forwardJson(
  request: Request,
  targetUrl: URL,
  sourceHeaders: HeaderMap,
  fetchFn: FetchLike,
  body: Record<string, unknown>,
): Promise<Response> {
  const headers = buildUpstreamHeaders(request, sourceHeaders);
  headers.set('content-type', 'application/json');
  headers.delete('content-encoding');
  const controller = linkedAbortController(request.signal);
  const upstreamRequest = new Request(targetUrl, {
    method: request.method,
    headers,
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: controller.signal,
  });
  const upstreamResponse = await fetchFn(upstreamRequest);
  return new Response(boundedPassThrough(upstreamResponse.body, controller), {
    status: upstreamResponse.status,
    headers: upstreamResponse.headers,
  });
}

export interface CreateHandlerOptions {
  config: OperatorConfig;
  snapshot: CatalogSnapshot;
  source: SourceContext;
  profile: CapabilityProfile;
  transportProfile: TransportCapabilityProfile;
  secret?: string;
  fetch: FetchLike;
  fetchAdapter: { id: string; runtimeVersion: string };
  trustedContext: (request: Request) => TrustedLifecycleContext;
  now: () => number;
  nonce: () => string;
  instanceId: () => string;
}

function assertTransportProfileReady(transportProfile: TransportCapabilityProfile, fetchAdapter: { id: string; runtimeVersion: string }): void {
  if (transportProfile.adapterId !== fetchAdapter.id || transportProfile.runtimeVersion !== fetchAdapter.runtimeVersion) {
    throw new RouterError('unsupported-path', `transport profile ${transportProfile.adapterId} ${transportProfile.runtimeVersion} does not match fetch adapter ${fetchAdapter.id} ${fetchAdapter.runtimeVersion}`);
  }
  if (transportProfile.status !== 'passed' || transportProfile.gzipBytes !== 'passed' || transportProfile.responseHeaders !== 'passed') {
    throw new RouterError('unsupported-path', `transport profile ${transportProfile.adapterId} ${transportProfile.runtimeVersion} is not fully measured`);
  }
}

function correlationStoreFor(config: OperatorConfig, profile: CapabilityProfile, now: () => number): CorrelationStore | undefined {
  if (config.harness.claudeCode.correlation !== 'auto') return undefined;
  try {
    assertCapability(profile, 'claude-correlation', { freshDelegation: false });
  } catch {
    return undefined;
  }
  return new CorrelationStore(now, FRESHNESS_WINDOW_MS);
}

async function handleDelegationRegistration(request: Request, ctx: { store: FreshDelegationStore; secret?: string; roles: OperatorConfig['roles'] }): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(422, 'invalid-envelope');
  }

  if (!isFreshDelegationEnvelopeShape(payload)) return errorResponse(422, 'invalid-envelope');
  const envelope = payload;

  if (ctx.roles[`claude-code:${envelope.role}`] === undefined) return errorResponse(422, 'unknown-role');
  if (ctx.secret === undefined) return errorResponse(401, 'missing-secret');

  const validProof = await verifyFreshDelegationProof(ctx.secret, envelope);
  if (!validProof) return errorResponse(401, 'invalid-proof');

  try {
    await ctx.store.register(envelope);
  } catch (error) {
    if (error instanceof RouterError) return new Response(null, { status: 409 });
    throw error;
  }

  return new Response(null, { status: 204 });
}

interface RoutableContext {
  config: OperatorConfig;
  catalog: EffectiveCatalog;
  source: SourceContext;
  secret?: string;
  profile: CapabilityProfile;
  correlationStore?: CorrelationStore;
  freshStore: FreshDelegationStore;
  fetch: FetchLike;
  trustedContext: (request: Request) => TrustedLifecycleContext;
  gatewayBase: string;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function handleRoutable(request: Request, url: URL, ctx: RoutableContext): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return errorResponse(400, 'invalid-json');
  }
  // Valid JSON that is not a plain object (null, an array, or a bare scalar) has no properties
  // to route on. Rejecting it here with 400 keeps later `body.system`/`body.model` style property
  // access from throwing an uncaught TypeError on a non-object value.
  if (!isPlainJsonObject(parsed)) return errorResponse(400, 'invalid-json');
  const body = parsed;

  const normalized = await normalizeClaudeRequest(body, request.headers, {
    ...(ctx.secret !== undefined ? { secret: ctx.secret } : {}),
    profile: ctx.profile,
    ...(ctx.correlationStore !== undefined ? { correlation: ctx.correlationStore } : {}),
    catalog: ctx.catalog,
    roles: ctx.config.roles,
  });

  const targetUrl = buildUpstreamUrl(url.pathname, url.search, ctx.gatewayBase);

  if (normalized.input.scope === 'parent') {
    const enriched = enrichParentTools(normalized.forwardBody, ctx.catalog);
    return forwardJson(request, targetUrl, ctx.source.gatewayHeaders, ctx.fetch, enriched);
  }

  const context = ctx.trustedContext(request);
  try {
    assertCapability(ctx.profile, 'claude-marker', context);
  } catch (error) {
    if (error instanceof RouterError) return errorResponse(422, error.code);
    throw error;
  }

  const agentId = normalized.agentId;
  const receipt = agentId !== undefined ? ctx.freshStore.consumeFreshDelegation(agentId) : undefined;

  let freshDelegation = false;
  let roleDefaultId = normalized.input.roleDefaultId;

  if (receipt !== undefined && ctx.profile.probes['M10-freshness'] === 'passed') {
    const channelBRole = normalized.adapterRole;
    if (channelBRole !== undefined) {
      if (receipt.role === channelBRole) {
        freshDelegation = true;
      } else {
        return errorResponse(422, 'conflicting-markers');
      }
    } else {
      // B2 carries no in-body marker, so role attribution rests entirely on the freshness
      // receipt plus a real, constructed correlation store: probe/entropy values describe a
      // measured capability, not a running one. Requiring `ctx.correlationStore !== undefined`
      // (the same store createHandler actually built) and `ctx.profile.correlation === true`
      // (the profile's own boolean claim of correlation support) closes the gap where B2 could be
      // granted on probe values alone with no store ever created to back it.
      const b2Eligible =
        ctx.config.harness.claudeCode.correlation === 'auto' &&
        ctx.correlationStore !== undefined &&
        ctx.profile.correlation === true &&
        ctx.profile.adapterMarkerPosition === 'b2' &&
        ctx.profile.probes.M1 === 'passed' &&
        ctx.profile.correlationEntropy === 'passed' &&
        ctx.profile.probes['M3-B2'] === 'passed';
      if (b2Eligible) {
        freshDelegation = true;
        roleDefaultId = ctx.config.roles[`claude-code:${receipt.role}`]?.routeOverride;
      }
    }
  }

  const { roleDefaultId: _originalRoleDefaultId, ...restInput } = normalized.input;
  const routeInput: RouteInput = {
    ...restInput,
    freshDelegation,
    ...(roleDefaultId !== undefined ? { roleDefaultId } : {}),
  };

  const decision = resolveRoute(routeInput, ctx.config, ctx.catalog);

  if (decision.kind === 'error') return errorResponse(422, decision.code);

  if (decision.kind === 'pass-through') {
    return forwardJson(request, targetUrl, ctx.source.gatewayHeaders, ctx.fetch, normalized.forwardBody);
  }

  if (ctx.correlationStore !== undefined && agentId !== undefined) {
    try {
      ctx.correlationStore.bind(agentId, decision.upstreamModel);
    } catch (error) {
      if (error instanceof RouterError) return errorResponse(422, error.code);
      throw error;
    }
  }

  const forwardBody = { ...normalized.forwardBody, model: decision.upstreamModel };
  return forwardJson(request, targetUrl, ctx.source.gatewayHeaders, ctx.fetch, forwardBody);
}

const ROUTABLE_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens']);

export function createHandler(options: CreateHandlerOptions): (request: Request) => Promise<Response> {
  assertTransportProfileReady(options.transportProfile, options.fetchAdapter);

  // Snapshot config/profile/source at creation time. Holding a live reference to the caller's
  // objects would let a caller-side mutation after createHandler() returns silently change
  // routing behavior for every request the returned closure serves; a deep clone severs that.
  const config = structuredClone(options.config);
  const profile = structuredClone(options.profile);
  const source = structuredClone(options.source);
  const secret = options.secret;

  const catalog = buildCatalog(config, options.snapshot);
  const handlerInstanceId = options.instanceId();
  const freshStore = new FreshDelegationStore(handlerInstanceId, options.now, FRESHNESS_WINDOW_MS);
  const correlationStore = correlationStoreFor(config, profile, options.now);
  const gatewayBase = source.effectiveGatewayUrl;

  const routableCtx: RoutableContext = {
    config,
    catalog,
    source,
    ...(secret !== undefined ? { secret } : {}),
    profile,
    ...(correlationStore !== undefined ? { correlationStore } : {}),
    freshStore,
    fetch: options.fetch,
    trustedContext: options.trustedContext,
    gatewayBase,
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    // Every path under the control namespace is handled locally, never forwarded upstream: an
    // unknown control path or a method mismatch on a known one must fail closed here rather than
    // falling through to forwardRaw, which would otherwise leak control-plane traffic upstream.
    if (url.pathname === '/subagent-router/control/instance') {
      if (request.method !== 'GET') return errorResponse(405, 'method-not-allowed');
      return jsonResponse(200, { handlerInstanceId });
    }

    if (url.pathname === '/subagent-router/control/delegations') {
      if (request.method !== 'POST') return errorResponse(405, 'method-not-allowed');
      return handleDelegationRegistration(request, { store: freshStore, ...(secret !== undefined ? { secret } : {}), roles: config.roles });
    }

    if (url.pathname.startsWith('/subagent-router/control/')) {
      return errorResponse(404, 'unknown-control-path');
    }

    if (request.method === 'POST' && ROUTABLE_PATHS.has(url.pathname)) {
      return handleRoutable(request, url, routableCtx);
    }

    return forwardRaw(request, buildUpstreamUrl(url.pathname, url.search, gatewayBase), source.gatewayHeaders, options.fetch);
  };
}
