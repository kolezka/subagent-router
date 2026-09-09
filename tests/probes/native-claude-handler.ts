// Opt-in PoC: real `claude` CLI -> OUR createHandler -> loopback mock upstream.
//
// Importing this module is inert. `createHandlerFixture()` and the constants below
// can be exercised by hermetic tests with zero side effects (no socket, no fs
// writes) EVEN when RUN_NATIVE_PROBES=1 is set in the environment: the front
// server only starts when this file is ALSO the process entry point
// (import.meta.main), never merely on being imported by something else.
//
// The synthetic profile below is injected EXPLICITLY into the handler purely to
// measure channel A: the explicit `<subagent-router model="ALIAS"/>` marker a
// parent places as the first line of a Task/Agent prompt. It is a measurement
// device for this probe and must NOT be recorded anywhere as a supported profile.
//
// Run: RUN_NATIVE_PROBES=1 bun tests/probes/native-claude-handler.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { CapabilityProfile, FetchLike } from '../../src/core/types';
import { createHandler } from '../../src/transport/handler';
import { configFixture, snapshotFixture } from '../support/fixtures';
import { hashNonce } from './evidence-freshness';

// Two named fixture agents, two distinct opaque upstream model ids/aliases. The
// parent's Task/Agent tool-use response picks between them via a first-line
// channel-A marker; native-claude-run.sh `handler` mode gives both agents
// `model: inherit` so the marker (not the agent frontmatter) is what selects.
export const CHANNEL_A_AGENTS = [
  { name: 'native-probe-alpha', alias: 'fast', upstreamModel: 'gateway/fast-worker' },
  { name: 'native-probe-beta', alias: 'smart', upstreamModel: 'gateway/smart-worker' },
] as const;

export const PARENT_CLIENT_MODEL = 'probe-parent-model';
export const AGENT_TOOL_NAME = 'Agent';

// The real native client attaches this as its own `system` block on every
// subagent turn; the handler strips it before forwarding (src/adapters/claude-code.ts
// findBillingBlockIndex + splice). A fixture that relies on it surviving to the
// upstream mock is testing a block that production code has already removed.
const BILLING_CHILD_TEXT = 'x-anthropic-billing-header: {"cc_is_subagent":true}';

export function markerLine(alias: string): string {
  return `<subagent-router v="1" model="${alias}"/>`;
}

// Real Anthropic-shaped parent request: an Agent tool is present, no billing
// header block, so normalizeClaudeRequest classifies scope='parent'.
export function buildParentRequest(prompt = 'Say hi via two subagents'): Record<string, unknown> {
  return {
    model: PARENT_CLIENT_MODEL,
    max_tokens: 512,
    system: [{ type: 'text', text: 'You are the parent.' }],
    messages: [{ role: 'user', content: prompt }],
    tools: [
      {
        name: AGENT_TOOL_NAME,
        description: 'Delegate work to a subagent.',
        input_schema: { type: 'object', properties: { prompt: { type: 'string', description: 'Task prompt.' } } },
      },
    ],
  };
}

// Real Anthropic-shaped routed-child request: billing header block present (as a
// real native client would send), first line of the first user text block carries
// the channel-A marker.
export function buildChildRequest(alias: string, taskPrompt: string): Record<string, unknown> {
  return {
    model: PARENT_CLIENT_MODEL,
    max_tokens: 512,
    system: [
      { type: 'text', text: 'You are a subagent.' },
      { type: 'text', text: BILLING_CHILD_TEXT },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: `${markerLine(alias)}\n${taskPrompt}` }] }],
  };
}

// Measurement-only synthetic profile. `claude-marker` is the ONE gate every
// child-scope request (any channel, including A) must clear before routing runs
// at all, and it requires M10 passed plus the full lifecycle bar (unavoidable:
// assertCapability enforces both for every gate, and trustedContext below supplies
// no lifecyclePhase, so all five phases must read 'passed'). Everything specific to
// channel B/B2/correlation (M1, M3-B2, M10-freshness, correlation, fork) is left
// unset/false so this fixture implies nothing beyond channel A. NOT a supported
// profile: never persist this as a capability fixture.
export const SYNTHETIC_PROFILE: CapabilityProfile = {
  client: 'claude-code',
  version: 'synthetic-hermetic',
  status: 'supported',
  correlation: false,
  correlationEntropy: 'pending',
  fork: false,
  adapterMarkerPosition: 'unknown',
  probes: { M10: 'passed' },
  lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' },
};

// Stage 2a layout amendment: the real 2.1.266 client puts its own context into text block 0
// and the delegation prompt into block 1, so the legacy first-text slot never sees the marker.
// This variant opens the measured alternate slot for ONE exact client version, the one the
// launcher actually observed via `claude --version` and passed in. 'M3-A' here is synthetic
// scaffolding so the handler trial can run at all; a real M3-A pass is what that trial is
// meant to produce, never something this fixture asserts.
export function syntheticLayoutProfile(observedClientVersion: string): CapabilityProfile {
  return {
    ...SYNTHETIC_PROFILE,
    version: observedClientVersion,
    parentPromptPosition: 'after-native-context-v1',
    probes: { ...SYNTHETIC_PROFILE.probes, 'M3-A': 'passed' },
  };
}

// The scaffold manifest for syntheticLayoutProfile(): exactly the dotted paths its spread
// actually overrides relative to the real claude-code-<version>.json fixture -- status, the two
// probes it sets (M10, M3-A), all five lifecycle phases (via the wildcard), and the alternate-
// layout position flag. Consumed by tests/probes/evidence-m3a.ts's extractM3AEvidence: a run
// capture without this manifest (or with one that omits a path that actually diverges) can never
// judge M3-A past 'pending', however clean its request/response pairs look.
export const SYNTHETIC_LAYOUT_SCAFFOLD_OVERRIDDEN_PATHS: readonly string[] = ['status', 'probes.M10', 'probes.M3-A', 'lifecycle.*', 'parentPromptPosition'];

export interface RecordedUpstreamRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface HandlerFixtureOptions {
  // Invoked synchronously at the moment upstreamFetch is called for a given
  // request, carrying exactly that request's own record. A caller correlating
  // upstream traffic to its own inbound request must use this, never read the
  // last entry of `seen` after an `await`: under concurrent requests (the real
  // front server below) that position can belong to a different, later-started
  // call, or the call that "should" be last may never push at all (a fetch that
  // throws before recording), silently misattributing whatever WAS logged before it.
  onUpstreamRequest?: (record: RecordedUpstreamRequest) => void;
  // Exact profile injected into createHandler. Defaults to the legacy-slot SYNTHETIC_PROFILE.
  profile?: CapabilityProfile;
}

export interface HandlerFixture {
  handler: (request: Request) => Promise<Response>;
  seen: RecordedUpstreamRequest[];
}

const KNOWN_UPSTREAM_MODELS = new Set<string>(CHANNEL_A_AGENTS.map((a) => a.upstreamModel));

interface PendingToolUse {
  upstreamModel: string;
}

function sseFrom(events: ReadonlyArray<readonly [string, Record<string, unknown>]>): string {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function textSse(model: unknown, text: string): string {
  const id = `msg_probe_${Math.random().toString(36).slice(2, 10)}`;
  return sseFrom([
    ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

// Scripts a real Anthropic Agent tool-use response: one tool_use content block per
// fixture agent, each carrying a first-line channel-A marker selecting a distinct
// alias, streamed as a single input_json_delta chunk (the CLI accumulates and
// JSON-parses these; one chunk is a valid, decodable degenerate case of that).
// Records each tool_use id -> expected upstream model in `pendingToolUses` so a
// LATER parent turn (carrying that id's tool_result) can be checked for a real
// match instead of trusted blindly.
function agentToolUseSse(model: unknown, pendingToolUses: Map<string, PendingToolUse>): string {
  const id = `msg_probe_${Math.random().toString(36).slice(2, 10)}`;
  const events: Array<readonly [string, Record<string, unknown>]> = [
    ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ];
  CHANNEL_A_AGENTS.forEach((agent, i) => {
    const toolUseId = `toolu_probe_${i}`;
    pendingToolUses.set(toolUseId, { upstreamModel: agent.upstreamModel });
    const input = { description: `probe ${agent.name}`, prompt: `${markerLine(agent.alias)}\ndo the ${agent.name} task`, subagent_type: agent.name, run_in_background: false };
    events.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: toolUseId, name: AGENT_TOOL_NAME, input: {} } }]);
    events.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }]);
    events.push(['content_block_stop', { type: 'content_block_stop', index: i }]);
  });
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return sseFrom(events);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Real native replies (see tests/probes/.runs/delegate-ELrKLv/capture/005-parent_final.json)
// carry the echo as ONE of several separate text blocks, alongside an
// agentId/<usage> metadata block the real client appends. Preserving them as
// separate strings (never joined into one) is what lets "exact echo block"
// matching below tell a genuine reply from a mangled one, instead of rejecting
// every real reply because the metadata block breaks a whole-string equality.
function textBlocksOfToolResultContent(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: 'text'; text: string } => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text);
  }
  return [];
}

interface ExtractedToolResult {
  toolUseId: string;
  textBlocks: string[];
  isError: boolean;
}

// Parses REAL structured tool_result blocks (tool_use_id + content, scoped to
// user-role messages, the only role the protocol ever carries them in) out of a
// parent request -- never a JSON-substring guess like
// `JSON.stringify(...).includes('tool_result')`, which cannot tell a genuine
// result from an unrelated string that happens to contain that text anywhere.
function extractToolResults(body: Record<string, unknown>): ExtractedToolResult[] {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const results: ExtractedToolResult[] = [];
  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'user') continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_result') continue;
      const toolUseId = block.tool_use_id;
      if (typeof toolUseId !== 'string') continue;
      results.push({ toolUseId, textBlocks: textBlocksOfToolResultContent(block.content), isError: block.is_error === true });
    }
  }
  return results;
}

// A parent turn is "final" (carries the children's answers back) exactly when it
// has real tool_result blocks referencing tool_use ids this fixture itself issued.
// It ends the loop unconditionally -- text, never another tool_use -- because
// whether the results MATCH what was expected is a correctness question, not a
// reason to keep delegating; the response text just says which happened.
//
// A match requires: every pending id answered exactly once (a duplicate id can
// never fill in for a missing one, however correct its own content is), no
// is_error:true result, and the expected echo present as one COMPLETE text
// block (never a substring of a block, and never checked against the blocks
// concatenated together, which the trailing metadata block would break).
function parentFinalText(body: Record<string, unknown>, pendingToolUses: Map<string, PendingToolUse>): string | undefined {
  const results = extractToolResults(body);
  if (results.length === 0) return undefined;

  const seenIds = new Set<string>();
  let matched = results.length === pendingToolUses.size;
  for (const result of results) {
    if (seenIds.has(result.toolUseId)) matched = false; // a repeated id can't also cover the id it left unanswered
    seenIds.add(result.toolUseId);

    if (result.isError) {
      matched = false;
      continue;
    }
    const expected = pendingToolUses.get(result.toolUseId);
    if (expected === undefined) {
      matched = false;
      continue;
    }
    const echo = `CHILD_SAW_MODEL=${expected.upstreamModel}`;
    if (!result.textBlocks.includes(echo)) matched = false;
  }
  return matched ? 'PARENT_FINAL_OK' : 'PARENT_MISMATCH';
}

// Creates the measurement fixture: the real production createHandler wired to a
// scripted mock upstream. Never opens a socket; callers drive `handler` directly
// (hermetic tests) or the opt-in front server below wraps it for a real CLI.
export async function createHandlerFixture(options: HandlerFixtureOptions = {}): Promise<HandlerFixture> {
  const seen: RecordedUpstreamRequest[] = [];
  const pendingToolUses = new Map<string, PendingToolUse>();

  const upstreamFetch: FetchLike = async (request) => {
    const raw = await request.text();
    let body: Record<string, unknown> = {};
    if (raw !== '') {
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Harmless non-message startup ping: nothing to route on, fall through with body={}.
      }
    }
    const record: RecordedUpstreamRequest = { url: request.url, headers: Object.fromEntries(request.headers.entries()), body };
    seen.push(record);
    options.onUpstreamRequest?.(record);

    if (request.url.includes('count_tokens')) {
      return new Response(JSON.stringify({ input_tokens: 100 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (raw === '') {
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    // A routed child is identified by its forwarded model landing on one of the
    // fixture's own known upstream ids. The billing header block that marked it a
    // child on the way IN has already been stripped by the handler before we ever
    // see this request, so that block can never be the signal here.
    const isRoutedChild = typeof body.model === 'string' && KNOWN_UPSTREAM_MODELS.has(body.model);
    if (isRoutedChild) {
      return new Response(textSse(body.model, `CHILD_SAW_MODEL=${String(body.model)}`), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }

    // A parent turn that already carries its children's tool_results must end
    // the turn here (text, never tool_use) or a real client would loop forever
    // re-delegating the same work every turn.
    const finalText = parentFinalText(body, pendingToolUses);
    if (finalText !== undefined) {
      return new Response(textSse(body.model, finalText), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }

    return new Response(agentToolUseSse(body.model, pendingToolUses), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  const handler = createHandler({
    config: configFixture({
      modelOverrides: Object.fromEntries(
        CHANNEL_A_AGENTS.map((agent) => [
          agent.upstreamModel,
          { alias: agent.alias, description: `Probe ${agent.name}.`, enabled: true },
        ]),
      ),
    }),
    snapshot: await snapshotFixture(CHANNEL_A_AGENTS.map((agent) => agent.upstreamModel)),
    source: { sourceId: 'probe', effectiveGatewayUrl: 'http://127.0.0.1:1/v1', effectiveModelsUrl: 'http://127.0.0.1:1/v1/models', headers: {}, gatewayHeaders: {} },
    profile: options.profile ?? SYNTHETIC_PROFILE,
    transportProfile: { adapterId: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic', status: 'passed', gzipBytes: 'passed', responseHeaders: 'passed' },
    secret: 'probe-secret',
    fetch: upstreamFetch,
    fetchAdapter: { id: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic' },
    trustedContext: () => ({ freshDelegation: false }),
    now: () => 0,
    nonce: () => 'probe-nonce',
    instanceId: () => 'probe-instance',
  });

  return { handler, seen };
}

// ---- opt-in CLI entry: real front HTTP server for a real native `claude` CLI ----
// Gated on BOTH the flag AND this file being the process entry point: a bare env
// check would also fire when some other script merely imports this module with
// the flag set in its environment, silently opening a socket nobody asked for.
if (process.env.RUN_NATIVE_PROBES === '1' && import.meta.main) {
  const OUT = process.env.PROBE_OUT ?? `${import.meta.dir}/.runs/handler-${process.pid}`;
  mkdirSync(OUT, { recursive: true });
  let seq = 0;
  const rec = (kind: string, o: unknown) =>
    writeFileSync(`${OUT}/${String(++seq).padStart(3, '0')}-${kind}.json`, JSON.stringify(o, null, 2));

  // Recorded through the callback, fired exactly once per real upstreamFetch call
  // with that call's own data -- never by re-reading `seen`'s last element after
  // an await, which a concurrent request could have already moved past.
  // The launcher observes the real client's version in the same isolated environment and
  // hands it over; the alternate layout is bound to exactly that version. Required so a
  // profile can never be guessed from a stale constant.
  const observedClientVersion = process.env.PROBE_CLIENT_VERSION;
  if (observedClientVersion === undefined || !/^\d+\.\d+\.\d+$/.test(observedClientVersion)) {
    throw new Error('PROBE_CLIENT_VERSION must carry the observed client version (x.y.z)');
  }
  const profile = syntheticLayoutProfile(observedClientVersion);
  rec('profile', profile);
  // Sibling to NNN-profile.json, same sequence number, written directly (not through rec()) so
  // it never consumes a seq number of its own and shifts every later capture file's numbering.
  writeFileSync(
    `${OUT}/${String(seq).padStart(3, '0')}-profile-scaffold.json`,
    JSON.stringify({ overriddenPaths: SYNTHETIC_LAYOUT_SCAFFOLD_OVERRIDDEN_PATHS }, null, 2),
  );

  // Freshness measurement wiring (opt-in, PROBE_FRESHNESS_HOOK=production only). Records
  // instance-fetch/delegation-register/delegation-consume/delegation-replay capture files by
  // wrapping the fixture boundary (the front server's own request handling and the upstream
  // callback below), never by changing createHandler or FreshDelegationStore themselves.
  // Absent this env var (the default), none of this runs and no freshness records are ever
  // written, so evidence-freshness.ts's judgeM10Freshness reports 'pending' -- exactly like
  // every other unmeasured run.
  const freshnessHookMode = process.env.PROBE_FRESHNESS_HOOK === 'production' ? 'production' : 'fake';
  let liveHandler: ((request: Request) => Promise<Response>) | undefined;
  const registeredEnvelopeByAgent = new Map<string, Record<string, unknown>>();
  const consumeInferredForAgent = new Set<string>();

  const { handler } = await createHandlerFixture({
    onUpstreamRequest: (record) => {
      rec('post-handler-upstream', record);
      if (freshnessHookMode !== 'production') return;
      const agentId = record.headers['x-claude-code-agent-id'];
      if (agentId === undefined || consumeInferredForAgent.has(agentId)) return;
      const envelope = registeredEnvelopeByAgent.get(agentId);
      if (envelope === undefined) return;
      consumeInferredForAgent.add(agentId);
      const consumed = KNOWN_UPSTREAM_MODELS.has(String(record.body.model));
      rec('delegation-consume', { agentId, consumed, ...(consumed ? {} : { reason: 'not-routed-to-a-known-upstream-model' }) });
      // Immediately replay the exact envelope this agent registered, purely to measure
      // whether the control endpoint rejects it once already consumed -- never a second
      // legitimate registration attempt.
      if (liveHandler !== undefined) {
        liveHandler(
          new Request('http://router.local/subagent-router/control/delegations', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(envelope),
          }),
        )
          .then((response) => rec('delegation-replay', { agentId, rejected: response.status !== 204 }))
          .catch(() => rec('delegation-replay', { agentId, rejected: true }));
      }
    },
    profile,
  });
  liveHandler = handler;

  const front = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(raw || '{}');
      } catch {
        // recorded raw below regardless
      }
      rec('pre-handler', { url: req.url, headers: req.headers, body: parsed });
      const isInstanceFetch = freshnessHookMode === 'production' && req.url === '/subagent-router/control/instance' && req.method === 'GET';
      const isDelegationRegister = freshnessHookMode === 'production' && req.url === '/subagent-router/control/delegations' && req.method === 'POST';
      if (isInstanceFetch) rec('instance-fetch', {});
      const init: { method?: string; headers: Record<string, string>; body?: string } = {
        headers: req.headers as Record<string, string>,
        ...(req.method !== undefined ? { method: req.method } : {}),
        ...(raw ? { body: raw } : {}),
      };
      const out = await handler(new Request(`http://router.local${req.url}`, init));
      if (isDelegationRegister && isRecord(parsed) && typeof parsed.agentId === 'string' && typeof parsed.role === 'string' && typeof parsed.nonce === 'string') {
        const accepted = out.status === 204;
        rec('delegation-register', { agentId: parsed.agentId, role: parsed.role, accepted, nonceHash: await hashNonce(parsed.nonce) });
        if (accepted) registeredEnvelopeByAgent.set(parsed.agentId, parsed);
      }
      res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
      res.end(Buffer.from(await out.arrayBuffer()));
    });
  });
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', () => resolve()));
  const port = (front.address() as { port: number }).port;
  writeFileSync(`${OUT}/port`, String(port));
  writeFileSync(`${OUT}/front-port`, String(port)); // back-compat with older probe consumers
  console.log(`front(handler) 127.0.0.1:${port}  out=${OUT}`);
  console.log(`channel-A agents: ${CHANNEL_A_AGENTS.map((a) => a.name).join(', ')}`);
  console.log('drive the CLI at ANTHROPIC_BASE_URL=http://127.0.0.1:' + port);
}
