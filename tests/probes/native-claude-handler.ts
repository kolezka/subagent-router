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
import { loadCapabilityProfile } from '../../src/adapters/capabilities';
import type { CapabilityProfile, FetchLike, ParentPromptPosition } from '../../src/core/types';
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

// The layout both profile builders below declare unless the caller names another one. Stays v1
// so every existing run is byte-identical to before the v2 layout existed.
const DEFAULT_LAYOUT_POSITION: ParentPromptPosition = 'after-native-context-v1';

// Stage 2a layout amendment: the real 2.1.266 client puts its own context into text block 0
// and the delegation prompt into block 1, so the legacy first-text slot never sees the marker.
// This variant opens the measured alternate slot for ONE exact client version, the one the
// launcher actually observed via `claude --version` and passed in. 'M3-A' here is synthetic
// scaffolding so the handler trial can run at all; a real M3-A pass is what that trial is
// meant to produce, never something this fixture asserts.
export function syntheticLayoutProfile(observedClientVersion: string, layout: ParentPromptPosition = DEFAULT_LAYOUT_POSITION): CapabilityProfile {
  return {
    ...SYNTHETIC_PROFILE,
    version: observedClientVersion,
    parentPromptPosition: layout,
    probes: { ...SYNTHETIC_PROFILE.probes, 'M3-A': 'passed' },
  };
}

// Real-base variant of syntheticLayoutProfile(): applies exactly the SAME channel-A overrides
// (status, M10, M3-A, all five lifecycle phases, parentPromptPosition) on top of a REAL measured
// claude-code-<version>.json fixture instead of the wholly-synthetic SYNTHETIC_PROFILE. Every
// field this does NOT explicitly override -- M1, M2, M3, M3-B2, M4, M10-freshness, correlation,
// correlationEntropy, fork, adapterMarkerPosition -- carries over from `realFixture` untouched, so
// a run using this profile makes a judgeable claim (the fixture it diverges from is real, not a
// measurement-only stand-in) while still declaring every path it overrode via
// SCAFFOLD_OVERRIDDEN_PATHS below. Opt-in via PROBE_PROFILE_BASE=real; never the default.
export function realLayoutProfile(realFixture: CapabilityProfile, layout: ParentPromptPosition = DEFAULT_LAYOUT_POSITION): CapabilityProfile {
  return {
    ...realFixture,
    status: 'supported',
    probes: { ...realFixture.probes, M10: 'passed', 'M3-A': 'passed' },
    lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' },
    parentPromptPosition: layout,
  };
}

// The scaffold manifest for BOTH syntheticLayoutProfile() and realLayoutProfile(): exactly the
// dotted paths each one's spread actually overrides relative to the real
// claude-code-<version>.json fixture -- status, the two probes they set (M10, M3-A), all five
// lifecycle phases (via the wildcard), and the alternate-layout position flag. Consumed by
// tests/probes/evidence-m3a.ts's extractM3AEvidence: a run capture without this manifest (or with
// one that omits a path that actually diverges) can never judge M3-A past 'pending', however clean
// its request/response pairs look.
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
  // Opt-in: when set, a routed child's FIRST request is answered with a tool_use for the
  // harmless `Read` tool (input file_path = this path) instead of the immediate echo, forcing
  // the real CLI to make a SECOND request once it has executed that tool and can reply with a
  // tool_result. Only the SECOND request (carrying a tool_result for the id this fixture itself
  // issued) gets the real echo. Absent (the default), behavior is byte-identical to before this
  // option existed: one request, immediate echo -- every existing hermetic test relies on that.
  // Real native-claude-run.sh runs pass a path inside the CLI's own sandboxed WORK directory that
  // the launcher actually created, since the real client's own Read tool executes for real
  // against it; hermetic tests never execute a real Read tool (they drive `handler` directly), so
  // any string works for them.
  childReadFilePath?: string;
  // Opt-in (the launcher's `compaction` mode only, and only alongside childReadFilePath): how many
  // forced Read rounds a routed child is driven through before it finally gets the echo. Each
  // answered tool_use issues the next one, so N rounds means N+1 requests from that child. Absent
  // or 1 (the default) is byte-identical to before this option existed: one round, echo on the
  // second request. compaction mode needs more than one so the child still has a turn left AFTER
  // its own conversation has grown past the auto-compaction threshold, which is what puts a
  // compact_boundary in a later request's history.
  childReadRounds?: number;
  // Opt-in (the launcher's `compaction` mode only): the input_tokens a ROUTED CHILD's own
  // message_start reports. The client never estimates context size from the transcript: it anchors
  // on the last assistant message carrying `usage` and sums that usage, so a child whose replies
  // report single-digit input_tokens looks like a tiny context no matter how long its history has
  // grown, and auto-compaction never fires. Absent (the default) every response keeps the usage it
  // has always reported, byte-identical for every existing mode. Applies ONLY to requests carrying
  // x-claude-code-agent-id: the parent keeps its current usage, because a parent compaction could
  // disturb the final echo this probe reads, and the phase being measured is the child's. Only
  // message_start's input_tokens changes; every other usage field is left alone.
  childUsageInputTokens?: number;
  // Opt-in (the launcher's `compaction` mode only, and only alongside childUsageInputTokens): how
  // many forced Read rounds a routed child must have COMPLETED before its replies start reporting
  // the large usage. Reporting it from the first reply makes the client decide to compact while
  // that child's conversation is still two messages long, and the client's reactive compactor then
  // bails with "fewer than 2 groups, nothing to compact" -- the decision fires but there is nothing
  // older to summarize, so no compact_boundary is ever produced. Ramping means the conversation has
  // several real assistant turns behind it by the time the threshold trips. Absent (the default)
  // the large usage applies from the first reply, byte-identical to before this option existed.
  // Counted per agent id from the same map childReadRounds uses, never by request order.
  childUsageRampAfterRounds?: number;
  // Opt-in (the launcher's `resume` mode only): when a parent turn arrives whose tool_results
  // are all for ids this fixture already finalized, treat it as a resumed session replaying the
  // prior round's history and force a FRESH Agent delegation (new tool_use ids) instead of ending
  // the turn. This is what makes a second, resumed CLI invocation actually re-delegate so the
  // same child can issue a second routed request across the resume boundary. Absent (the default),
  // behavior is byte-identical to before this option existed. Never fakes continuity: whether the
  // child reuses its x-claude-code-agent-id across the boundary is the real client's behavior to
  // prove, never something this fixture synthesizes.
  resumeReDelegate?: boolean;
  // Opt-in (the launcher's `nested` mode only): names the ONE child agent that is allowed to
  // delegate. When set, the FIRST routed request from that child (identified by its forwarded
  // model landing on that agent's own upstream model, keyed by x-claude-code-agent-id, never by
  // request order) is answered with a scripted Agent tool_use delegating exactly once to the
  // OTHER channel-A agent (the grandchild), instead of the immediate echo. The delegating child's
  // SECOND request, carrying the tool_result for the nested id this fixture issued, gets the
  // normal echo. Absent (the default), behavior is byte-identical to before this option existed.
  // Never fakes the header: whether the grandchild request carries x-claude-code-parent-agent-id
  // is the real client's behavior to prove, never something this fixture synthesizes.
  nestedDelegatingAgent?: string;
}

export interface HandlerFixture {
  handler: (request: Request) => Promise<Response>;
  seen: RecordedUpstreamRequest[];
}

const KNOWN_UPSTREAM_MODELS = new Set<string>(CHANNEL_A_AGENTS.map((a) => a.upstreamModel));

interface PendingToolUse {
  upstreamModel: string;
}

interface PendingChildToolUse {
  toolUseId: string;
}

function sseFrom(events: ReadonlyArray<readonly [string, Record<string, unknown>]>): string {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

// inputTokens defaults to the value this builder has always reported, so an omitted argument is
// byte-identical to before the childUsageInputTokens option existed.
function textSse(model: unknown, text: string, inputTokens = 5): string {
  const id = `msg_probe_${Math.random().toString(36).slice(2, 10)}`;
  return sseFrom([
    ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } } }],
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
// match instead of trusted blindly. The map is cleared first so each delegation
// round owns its ids (a resumed round gets a distinct prefix, never stale ids).
function agentToolUseSse(model: unknown, pendingToolUses: Map<string, PendingToolUse>, idPrefix = 'toolu_probe'): string {
  const id = `msg_probe_${Math.random().toString(36).slice(2, 10)}`;
  const events: Array<readonly [string, Record<string, unknown>]> = [
    ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ];
  pendingToolUses.clear();
  CHANNEL_A_AGENTS.forEach((agent, i) => {
    const toolUseId = `${idPrefix}_${i}`;
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

// Scripts a real Anthropic tool-use response for the harmless `Read` tool, streamed the same
// single-chunk way agentToolUseSse streams its Agent tool_use blocks. Forces the real CLI to make
// a SECOND request for this same child once it has actually executed Read and can reply with a
// tool_result -- the only way to make a child issue two upstream requests (a text reply with
// stop_reason 'end_turn' would end the child's turn after just one).
function childToolUseSse(model: unknown, toolUseId: string, filePath: string, inputTokens = 8): string {
  const id = `msg_probe_${Math.random().toString(36).slice(2, 10)}`;
  const input = { file_path: filePath };
  return sseFrom([
    ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolUseId, name: 'Read', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

// Scripts exactly ONE Agent tool_use for the nested delegation: the delegating child is told to
// delegate to `targetAgent` (the grandchild), with a first-line marker selecting that agent's
// alias. Same single-chunk streaming shape as agentToolUseSse/childToolUseSse. Forces the real
// delegating child to execute the Agent tool and send a SECOND request once it can reply with a
// tool_result, and -- the thing being measured -- whether that grandchild request carries
// x-claude-code-parent-agent-id naming the delegating child.
function nestedAgentToolUseSse(model: unknown, toolUseId: string, targetAgent: (typeof CHANNEL_A_AGENTS)[number], inputTokens = 8): string {
  const id = `msg_probe_${Math.random().toString(36).slice(2, 10)}`;
  const input = {
    description: `nested probe ${targetAgent.name}`,
    prompt: `${markerLine(targetAgent.alias)}\ndo the nested ${targetAgent.name} task`,
    subagent_type: targetAgent.name,
    run_in_background: false,
  };
  return sseFrom([
    ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolUseId, name: AGENT_TOOL_NAME, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
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

interface ExtractedToolResultWithIndex {
  result: ExtractedToolResult;
  // Index into body.messages of the user message this tool_result block lived in. Lets a judge
  // tell "the conversation continued past this round" from "this is the same final turn resent".
  messageIndex: number;
}

// Parses REAL structured tool_result blocks (tool_use_id + content, scoped to
// user-role messages, the only role the protocol ever carries them in) out of a
// parent request -- never a JSON-substring guess like
// `JSON.stringify(...).includes('tool_result')`, which cannot tell a genuine
// result from an unrelated string that happens to contain that text anywhere.
function extractToolResults(body: Record<string, unknown>): ExtractedToolResult[] {
  return extractToolResultsWithIndex(body).map((entry) => entry.result);
}

function extractToolResultsWithIndex(body: Record<string, unknown>): ExtractedToolResultWithIndex[] {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const results: ExtractedToolResultWithIndex[] = [];
  messages.forEach((message, messageIndex) => {
    if (!isRecord(message) || message.role !== 'user') return;
    const content = message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_result') continue;
      const toolUseId = block.tool_use_id;
      if (typeof toolUseId !== 'string') continue;
      results.push({ result: { toolUseId, textBlocks: textBlocksOfToolResultContent(block.content), isError: block.is_error === true }, messageIndex });
    }
  });
  return results;
}

// True when a user-role message (a genuine new turn, not another tool_result) follows the given
// message index. This is the resume signal: a retried final request ends at its tool_results,
// while a resumed session replays those tool_results and then sends a fresh user turn.
function hasUserTurnAfter(messages: readonly unknown[], afterIndex: number): boolean {
  for (let i = afterIndex + 1; i < messages.length; i += 1) {
    const message = messages[i];
    if (isRecord(message) && message.role === 'user') return true;
  }
  return false;
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
function parentFinalText(
  body: Record<string, unknown>,
  pendingToolUses: Map<string, PendingToolUse>,
  finalizedToolUses: Set<string>,
  resumeReDelegate: boolean,
  hasReDelegated: () => boolean,
  markReDelegated: () => void,
): { text: string; reDelegate: boolean } | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const entries = extractToolResultsWithIndex(body);
  if (entries.length === 0) return undefined;

  // Resume detection: only when the opt-in is on, the handler has not yet re-delegated, every
  // tool_result names an already-finalized id, AND the conversation continued past that round
  // (a new user turn follows the tool_results). The "new turn follows" condition is what tells a
  // genuine resumed session apart from a retry of the same final request, which the handler may
  // legitimately receive when the client lost the first response and resends the identical body.
  const lastResultIndex = entries[entries.length - 1]!.messageIndex;
  const allFinalized = entries.every((entry) => finalizedToolUses.has(entry.result.toolUseId));
  if (resumeReDelegate && !hasReDelegated() && allFinalized && hasUserTurnAfter(messages, lastResultIndex)) {
    markReDelegated();
    return { text: 'PARENT_RESUMED_REDELEGATE', reDelegate: true };
  }

  const results = entries.map((entry) => entry.result);
  // A resumed request can carry BOTH the finalized prior round's tool_results and the current
  // round's. Only the current pending round's ids count: filtering to pending ids first keeps the
  // default single-round path byte-identical (there, every result id IS a pending id) while a
  // resumed round's stale ids never break the count or the match.
  const pendingResults = results.filter((result) => pendingToolUses.has(result.toolUseId));
  const seenIds = new Set<string>();
  let matched = pendingResults.length === pendingToolUses.size;
  for (const result of pendingResults) {
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
  if (matched) {
    for (const result of pendingResults) finalizedToolUses.add(result.toolUseId);
    return { text: 'PARENT_FINAL_OK', reDelegate: false };
  }
  return { text: 'PARENT_MISMATCH', reDelegate: false };
}

// Creates the measurement fixture: the real production createHandler wired to a
// scripted mock upstream. Never opens a socket; callers drive `handler` directly
// (hermetic tests) or the opt-in front server below wraps it for a real CLI.
export async function createHandlerFixture(options: HandlerFixtureOptions = {}): Promise<HandlerFixture> {
  const seen: RecordedUpstreamRequest[] = [];
  const pendingToolUses = new Map<string, PendingToolUse>();
  const pendingChildToolUseByAgent = new Map<string, PendingChildToolUse>();
  // Forced Read rounds each agent has actually completed (a tool_use this fixture issued, answered
  // by a matching tool_result). Keyed by agent id, never by request order.
  const childReadRoundsDoneByAgent = new Map<string, number>();
  const childReadRounds = options.childReadRounds !== undefined && options.childReadRounds > 1 ? options.childReadRounds : 1;
  const childUsageRampAfterRounds = options.childUsageRampAfterRounds !== undefined && options.childUsageRampAfterRounds > 0 ? options.childUsageRampAfterRounds : undefined;
  // The input_tokens a routed child's reply should report right now. undefined means "leave the
  // builder's own default alone", which is what every non-child request and every pre-ramp reply
  // gets. Without the ramp the large value applies from the first reply, exactly as before.
  const childUsageFor = (agentId: string | undefined): number | undefined => {
    if (agentId === undefined || options.childUsageInputTokens === undefined) return undefined;
    if (childUsageRampAfterRounds === undefined) return options.childUsageInputTokens;
    return (childReadRoundsDoneByAgent.get(agentId) ?? 0) >= childUsageRampAfterRounds ? options.childUsageInputTokens : undefined;
  };
  // Nested-delegation state, keyed by x-claude-code-agent-id (never by request order): the
  // deterministic tool_use id this fixture issued to the delegating child on its first request,
  // so only a SECOND request from that SAME agent carrying the matching tool_result gets the echo.
  const nestedToolUseByAgent = new Map<string, string>();
  // Tool_use ids whose parent final turn has already consumed them. A resumed invocation replays
  // the prior round's tool_results verbatim against the SAME handler process, so those ids arrive
  // again without being pending; that is the one signal that distinguishes a genuine resumed
  // session from the current round's final turn.
  const finalizedToolUses = new Set<string>();
  // One-shot guard for the resume opt-in: re-delegate exactly once per handler process, the first
  // time a resumed turn arrives carrying finalized tool_results. Because agentToolUseSse issues
  // deterministic ids (toolu_probe_0/1), every completed round's results are already finalized, so
  // a purely shape-based check would re-delegate forever. A resumed session makes exactly one new
  // delegation, then its round completes normally.
  let resumeReDelegated = false;

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
      // Gated on the header, not just on isRoutedChild: only a request the client itself marked as
      // a child may get the inflated usage. undefined leaves every builder on its own default.
      const childAgentId = record.headers['x-claude-code-agent-id'];
      // Read at response-build time, not once per request, so a reply issued after the round
      // counter was bumped below already counts as being past the ramp point.
      const childInputTokens = () => childUsageFor(childAgentId);
      const childEcho = () =>
        new Response(textSse(body.model, `CHILD_SAW_MODEL=${String(body.model)}`, childInputTokens()), { status: 200, headers: { 'content-type': 'text/event-stream' } });

      // Nested delegation (nestedDelegatingAgent set, the launcher's `nested` mode only): the
      // FIRST routed request from the delegating child (matched by its forwarded model, keyed by
      // x-claude-code-agent-id, never by request order) is answered with exactly ONE Agent
      // tool_use delegating to the OTHER channel-A agent (the grandchild), instead of the echo.
      // The delegating child's SECOND request carrying the matching tool_result gets the echo.
      // Anything else falls back to the existing behaviour. Whether the grandchild request then
      // carries x-claude-code-parent-agent-id is the real client's behavior, never synthesized
      // here. Absent the option, this branch is never taken and the echo path is byte-identical.
      const nestedDelegating = options.nestedDelegatingAgent !== undefined ? CHANNEL_A_AGENTS.find((a) => a.name === options.nestedDelegatingAgent) : undefined;
      if (nestedDelegating !== undefined && body.model === nestedDelegating.upstreamModel) {
        const agentId = record.headers['x-claude-code-agent-id'];
        const pendingNested = agentId !== undefined ? nestedToolUseByAgent.get(agentId) : undefined;
        if (pendingNested !== undefined) {
          const answered = extractToolResults(body).some((result) => result.toolUseId === pendingNested);
          if (answered) {
            nestedToolUseByAgent.delete(agentId as string);
            return childEcho();
          }
          return childEcho(); // a retry or foreign-result request: fall back to the existing echo
        }
        const toolUseId = 'toolu_nested_0';
        if (agentId !== undefined) nestedToolUseByAgent.set(agentId, toolUseId);
        const target = CHANNEL_A_AGENTS.find((a) => a.name !== nestedDelegating.name) ?? CHANNEL_A_AGENTS[1]!;
        return new Response(nestedAgentToolUseSse(body.model, toolUseId, target, childInputTokens()), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }

      // Default (childReadFilePath absent): unchanged from before this option existed -- one
      // request, immediate echo. Every existing hermetic test relies on exactly this.
      if (options.childReadFilePath === undefined) return childEcho();

      // Opt-in second-request flow, keyed by x-claude-code-agent-id (never by request order or
      // count): the FIRST request from this agent gets a tool_use forcing a real second request;
      // only a SECOND request carrying a tool_result for the id this fixture itself issued gets
      // the echo. Anything else (no header, or a tool_result for a stale/foreign id) is treated
      // as a fresh first request, never a way to skip straight to the echo.
      const agentId = record.headers['x-claude-code-agent-id'];
      const pendingChildToolUse = agentId !== undefined ? pendingChildToolUseByAgent.get(agentId) : undefined;
      if (pendingChildToolUse !== undefined) {
        const answered = extractToolResults(body).some((result) => result.toolUseId === pendingChildToolUse.toolUseId);
        if (answered) {
          pendingChildToolUseByAgent.delete(agentId as string);
          const done = (childReadRoundsDoneByAgent.get(agentId as string) ?? 0) + 1;
          childReadRoundsDoneByAgent.set(agentId as string, done);
          // With the default single round this is always the echo, exactly as before. Only the
          // multi-round opt-in falls through to issue the next tool_use below.
          if (done >= childReadRounds) return childEcho();
        }
      }
      const toolUseId = `toolu_child_${agentId ?? 'unknown'}_${Math.random().toString(36).slice(2, 8)}`;
      if (agentId !== undefined) pendingChildToolUseByAgent.set(agentId, { toolUseId });
      return new Response(childToolUseSse(body.model, toolUseId, options.childReadFilePath, childInputTokens()), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }

    // A parent turn that already carries its children's tool_results must end
    // the turn here (text, never tool_use) or a real client would loop forever
    // re-delegating the same work every turn. Under the resume opt-in, a turn
    // whose results are ALL for already-finalized ids is a resumed session
    // replaying prior history, so it is answered with a FRESH delegation
    // instead (new tool_use ids) so a second invocation can re-delegate.
    const final = parentFinalText(
      body,
      pendingToolUses,
      finalizedToolUses,
      options.resumeReDelegate === true,
      () => resumeReDelegated,
      () => {
        resumeReDelegated = true;
      },
    );
    if (final !== undefined) {
      if (final.reDelegate) {
        return new Response(agentToolUseSse(body.model, pendingToolUses, 'toolu_probe_r1'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(textSse(body.model, final.text), { status: 200, headers: { 'content-type': 'text/event-stream' } });
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

export const CONTROL_URL_PREFIX = '/subagent-router/control/';

/** Whether a request URL is a control-plane endpoint (instance/delegations), never a v1/messages request. */
export function isControlPlaneUrl(url: string | undefined): boolean {
  return url !== undefined && url.startsWith(CONTROL_URL_PREFIX);
}

/**
 * Records the generic pre-handler capture for every request EXCEPT control-plane ones.
 * Control-plane request bodies are FreshDelegationEnvelope-shaped: a plaintext `nonce` and an
 * HMAC `proof` (see src/core/types.ts's FreshDelegationEnvelope). The dedicated instance-fetch
 * / delegation-register / delegation-replay records already capture the redacted form
 * (nonceHash only, via hashNonce in evidence-freshness.ts -- see its own comment quoting
 * docs/superpowers/specs/2026-09-06-subagent-model-routing-design.md:358, "proof nie trafia do
 * diagnostyki"). Recording the raw body here too would put both secrets in plaintext into
 * NNN-pre-handler.json, defeating that redaction.
 */
export function recordPreHandlerIfNotControlPlane(rec: (kind: string, o: unknown) => void, url: string | undefined, headers: unknown, body: unknown): void {
  if (isControlPlaneUrl(url)) return;
  rec('pre-handler', { url, headers, body });
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
  // Opt-in: PROBE_PROFILE_BASE=real bases the injected profile on the REAL measured
  // claude-code-<version>.json fixture (via loadCapabilityProfile) instead of the wholly-synthetic
  // SYNTHETIC_PROFILE, so a run using it produces a judgeable M3-A claim (extractM3AEvidence can
  // load and diff against a real fixture). Absent (the default), behavior is byte-identical to
  // before this variable existed.
  // Opt-in: PROBE_LAYOUT=v2 makes the injected profile declare the three-text-block layout
  // measured on Claude Code 2.1.268 instead of the two-block v1 layout. Absent, empty or any
  // other value means v1, so behavior is byte-identical to before this variable existed.
  const layoutPosition: ParentPromptPosition = process.env.PROBE_LAYOUT === 'v2' ? 'after-native-context-v2' : 'after-native-context-v1';
  const profile =
    process.env.PROBE_PROFILE_BASE === 'real'
      ? realLayoutProfile(await loadCapabilityProfile('claude-code', observedClientVersion, `${import.meta.dir}/../fixtures/capabilities`), layoutPosition)
      : syntheticLayoutProfile(observedClientVersion, layoutPosition);
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

  // Opt-in (the launcher's next-turn mode only, empty/unset for handler mode): forces every
  // routed child to make a second upstream request. Empty string is treated the same as unset
  // (native-claude-run.sh always passes this env var for the shared handler/next-turn dispatch
  // branch, blank for handler mode, so a blank value is never a deliberate request for the
  // two-request behavior).
  const childReadFilePath = process.env.PROBE_CHILD_READ_FILE || undefined;

  // Opt-in (the launcher's compaction mode only): how many forced Read rounds each routed child is
  // driven through. Unset, blank or unparseable means 1, the single round every other mode has
  // always had. See HandlerFixtureOptions.childReadRounds.
  const parsedChildReadRounds = Number.parseInt(process.env.PROBE_CHILD_READ_ROUNDS ?? '', 10);
  const childReadRounds = Number.isInteger(parsedChildReadRounds) && parsedChildReadRounds > 1 ? parsedChildReadRounds : undefined;

  // Opt-in (the launcher's compaction mode only): the input_tokens a routed child's own
  // message_start reports, so the client's context estimate for that child can cross its
  // compaction threshold. Unset, blank or unparseable leaves every response's usage untouched.
  // See HandlerFixtureOptions.childUsageInputTokens.
  const parsedChildUsageInputTokens = Number.parseInt(process.env.PROBE_CHILD_USAGE_INPUT_TOKENS ?? '', 10);
  const childUsageInputTokens = Number.isInteger(parsedChildUsageInputTokens) && parsedChildUsageInputTokens > 0 ? parsedChildUsageInputTokens : undefined;

  // Opt-in (the launcher's compaction mode only): how many forced Read rounds a child must have
  // completed before the large usage above starts being reported. Unset, blank or unparseable
  // means no ramp, so the large value applies from the first reply as it did before.
  // See HandlerFixtureOptions.childUsageRampAfterRounds.
  const parsedChildUsageRampAfterRounds = Number.parseInt(process.env.PROBE_CHILD_USAGE_RAMP_AFTER_ROUNDS ?? '', 10);
  const childUsageRampAfterRounds = Number.isInteger(parsedChildUsageRampAfterRounds) && parsedChildUsageRampAfterRounds > 0 ? parsedChildUsageRampAfterRounds : undefined;

  // Opt-in (the launcher's resume mode only): lets a resumed parent turn re-delegate instead of
  // ending. See HandlerFixtureOptions.resumeReDelegate for why this must never be inferred from
  // request shape. Empty/unset for every other mode.
  const resumeReDelegate = process.env.PROBE_RESUME === '1';

  // Opt-in (the launcher's nested mode only): names the one child allowed to delegate. See
  // HandlerFixtureOptions.nestedDelegatingAgent for why this must never be inferred from request
  // shape. Empty/unset for every other mode.
  const nestedDelegatingAgent = process.env.PROBE_NESTED_AGENT || undefined;

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
    ...(childReadFilePath !== undefined ? { childReadFilePath } : {}),
    ...(childReadRounds !== undefined ? { childReadRounds } : {}),
    ...(childUsageInputTokens !== undefined ? { childUsageInputTokens } : {}),
    ...(childUsageRampAfterRounds !== undefined ? { childUsageRampAfterRounds } : {}),
    ...(resumeReDelegate ? { resumeReDelegate: true } : {}),
    ...(nestedDelegatingAgent !== undefined ? { nestedDelegatingAgent } : {}),
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
      recordPreHandlerIfNotControlPlane(rec, req.url, req.headers, parsed);
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
