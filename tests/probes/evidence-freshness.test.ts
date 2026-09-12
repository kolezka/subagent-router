// Combined test file for both new M10 evidence modules: pure judge-logic tests for
// evidence-m10.ts's lifecycle phases (hand-built RunCapture literals, no disk, no live
// server), plus a hermetic end-to-end test for evidence-freshness.ts driving a REAL
// createHandler and a REAL runClaudeSubagentStartHook, wired together in-process (an injected
// fetch that calls the handler directly -- no socket, no real claude/opencode/codex).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaudeSubagentStartHook } from '../../src/transport/claude-hook';
import { createHandler, signFreshDelegation } from '../../src/transport/handler';
import type { CapabilityProfile, FetchLike, FreshDelegationEnvelope } from '../../src/core/types';
import { configFixture, FIXTURE_MODEL_ID, snapshotFixture } from '../support/fixtures';
import type { CapturedHttpMessage, CapturedPair, CapturedUnforwardedRequest, RunCapture } from './evidence-m3a';
import { COMPACTION_SUMMARY_PREFIX, extractLifecycleEvidence, judgeLifecyclePhase, summarizeM10 } from './evidence-m10';
import type { RunManifest } from './evidence-m10';
import { loadResumeProof, verifyResumeProofAgainstBinary } from './resume-proof';
import type { ResumeProof } from './resume-proof';
import type { ProofSiteVerification } from './proof-sites';
import { SYNTHETIC_RESUME_SITES, writeSyntheticResumeBinary, writeSyntheticResumeProof } from '../support/resume-proof-fixture';
import { extractFreshnessEvidence, hashNonce, judgeM10Freshness } from './evidence-freshness';
import type { DelegationConsumeRecord, DelegationRegisterRecord, DelegationReplayRecord, FreshnessCapture, InstanceFetchRecord } from './evidence-freshness';

// ---------- lifecycle: hand-built captures, no disk, no live server ----------

// How pair() spells a compaction signal in the pre-handler body. 'wrapper-string' is what the
// real client sends after a compaction: one user message whose content is a plain string opening
// with COMPACTION_SUMMARY_PREFIX. 'wrapper-blocks' is the same wrapper as a text block. The other
// two are negative controls: the transcript-only 'compact_boundary' literal, which never reaches a
// request body, and the wrapper quoted mid-sentence, which is someone talking about a compaction
// rather than one happening.
type CompactionSignal = 'wrapper-string' | 'wrapper-blocks' | 'legacy-marker' | 'wrapper-mid-text';

const SUMMARY_WRAPPER = `${COMPACTION_SUMMARY_PREFIX} The summary below covers the earlier portion of the conversation.\n\nThe child had read one file and reported back.`;

function applyCompactionSignal(body: Record<string, unknown>, signal: CompactionSignal): void {
  if (signal === 'legacy-marker') {
    body.marker = 'compact_boundary';
    body.messages = [{ role: 'user', content: 'carry on' }];
    return;
  }
  const content =
    signal === 'wrapper-string'
      ? SUMMARY_WRAPPER
      : signal === 'wrapper-blocks'
        ? [{ type: 'text', text: SUMMARY_WRAPPER }]
        : [{ type: 'text', text: `The operator asked what "${SUMMARY_WRAPPER}" means.` }];
  body.messages = [{ role: 'user', content }];
}

interface PreOptions {
  clientModel?: string;
  parentAgentId?: string;
  compactBoundary?: boolean;
  compactionSignal?: CompactionSignal;
}

function pre(agentId: string, opts: PreOptions): CapturedHttpMessage {
  const headers: Record<string, string> = { 'x-claude-code-agent-id': agentId };
  if (opts.parentAgentId !== undefined) headers['x-claude-code-parent-agent-id'] = opts.parentAgentId;
  const body: Record<string, unknown> = { model: opts.clientModel ?? 'probe-parent-model' };
  const signal = opts.compactionSignal ?? (opts.compactBoundary === true ? 'wrapper-string' : undefined);
  if (signal !== undefined) applyCompactionSignal(body, signal);
  return { url: '/v1/messages', headers, body };
}

function pair(seq: number, agentId: string, opts: PreOptions & { upstreamModel: string }): CapturedPair {
  return {
    seq,
    agentId,
    pre: pre(agentId, opts),
    post: {
      url: 'http://127.0.0.1:1/v1/messages',
      headers: { 'x-claude-code-agent-id': agentId },
      body: { model: opts.upstreamModel },
    },
  };
}

// A request the handler refused: the capture holds its pre-handler record and no upstream record
// at all, which is what a 422 missing-selection actually looks like on disk.
function refused(seq: number, agentId: string, opts: PreOptions = {}): CapturedUnforwardedRequest {
  return { seq, agentId, pre: pre(agentId, opts) };
}

function capture(pairs: CapturedPair[], unforwarded: CapturedUnforwardedRequest[] = []): RunCapture {
  return { runDir: 'in-memory', profileRaw: {}, pairs, unforwarded, hookAgentIds: new Set() };
}

function manifest(patch: Partial<RunManifest> = {}): RunManifest {
  return { mode: '', phasesExercised: [], freshnessHook: 'none', correlationScaffold: false, ...patch };
}

describe('evidence-m10: extractLifecycleEvidence + judgeLifecyclePhase', () => {
  test('lifecycle-next-turn-passes-on-stable-upstream-model-across-two-requests', () => {
    const cap = capture([pair(1, 'agent-1', { upstreamModel: 'gateway/fast-worker' }), pair(2, 'agent-1', { upstreamModel: 'gateway/fast-worker' })]);
    const evidence = extractLifecycleEvidence(cap);
    const judgement = judgeLifecyclePhase('next-turn', evidence, manifest({ mode: 'next-turn', phasesExercised: ['next-turn'] }));
    expect(judgement.result).toBe('passed');
  });

  test('lifecycle-fails-on-upstream-model-drift', () => {
    const cap = capture([pair(1, 'agent-1', { upstreamModel: 'gateway/fast-worker' }), pair(2, 'agent-1', { upstreamModel: 'gateway/smart-worker' })]);
    const evidence = extractLifecycleEvidence(cap);
    const judgement = judgeLifecyclePhase('next-turn', evidence, manifest({ mode: 'next-turn', phasesExercised: ['next-turn'] }));
    expect(judgement.result).toBe('failed');
    expect(judgement.diagnostic).toContain('upstream-model-drifted');
  });

  test('lifecycle-parallel-requires-two-interleaved-stable-agents', () => {
    const runMeta = manifest({ mode: 'parallel', phasesExercised: ['parallel'] });

    // Block pattern (agent-a entirely before agent-b): never proves real concurrency.
    const blocky = capture([
      pair(1, 'agent-a', { upstreamModel: 'gateway/fast-worker' }),
      pair(2, 'agent-a', { upstreamModel: 'gateway/fast-worker' }),
      pair(3, 'agent-b', { upstreamModel: 'gateway/smart-worker' }),
      pair(4, 'agent-b', { upstreamModel: 'gateway/smart-worker' }),
    ]);
    expect(judgeLifecyclePhase('parallel', extractLifecycleEvidence(blocky), runMeta).result).toBe('pending');

    // Genuinely interleaved and each agent's own upstream model stable throughout.
    const interleaved = capture([
      pair(1, 'agent-a', { upstreamModel: 'gateway/fast-worker' }),
      pair(2, 'agent-b', { upstreamModel: 'gateway/smart-worker' }),
      pair(3, 'agent-a', { upstreamModel: 'gateway/fast-worker' }),
      pair(4, 'agent-b', { upstreamModel: 'gateway/smart-worker' }),
    ]);
    expect(judgeLifecyclePhase('parallel', extractLifecycleEvidence(interleaved), runMeta).result).toBe('passed');
  });

  test('lifecycle-compaction-pending-without-observed-compact-boundary', () => {
    const cap = capture([pair(1, 'agent-1', { upstreamModel: 'gateway/fast-worker' }), pair(2, 'agent-1', { upstreamModel: 'gateway/fast-worker' })]);
    const judgement = judgeLifecyclePhase('compaction', extractLifecycleEvidence(cap), manifest({ mode: 'compaction', phasesExercised: ['compaction'] }));
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toContain('compaction-requires-observed-compact-boundary');

    const withBoundary = capture([
      pair(1, 'agent-1', { upstreamModel: 'gateway/fast-worker' }),
      pair(2, 'agent-1', { upstreamModel: 'gateway/fast-worker', compactBoundary: true }),
    ]);
    expect(judgeLifecyclePhase('compaction', extractLifecycleEvidence(withBoundary), manifest({ mode: 'compaction', phasesExercised: ['compaction'] })).result).toBe('passed');
  });

  test('lifecycle-compaction-pending-under-a-different-declared-mode', () => {
    // A boundary marker can ride along in the history of any multi-turn run, so on its own it
    // never proves the run drove a compaction. The declared mode must agree, exactly as
    // next-turn and resume already require.
    const withBoundary = capture([
      pair(1, 'agent-1', { upstreamModel: 'gateway/fast-worker' }),
      pair(2, 'agent-1', { upstreamModel: 'gateway/fast-worker', compactBoundary: true }),
    ]);
    const evidence = extractLifecycleEvidence(withBoundary);

    const judgement = judgeLifecyclePhase('compaction', evidence, manifest({ mode: 'next-turn', phasesExercised: ['compaction'] }));
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toBe('compaction-requires-declared-mode: the run manifest\'s mode must equal \'compaction\', got "next-turn"');

    // Positive control: identical evidence, only the declared mode differs.
    expect(judgeLifecyclePhase('compaction', evidence, manifest({ mode: 'compaction', phasesExercised: ['compaction'] })).result).toBe('passed');
  });

  const compactionRun = manifest({ mode: 'compaction', phasesExercised: ['compaction'] });

  test('lifecycle-compaction-passes-on-a-later-continuation-wrapper-in-string-content', () => {
    // The real shape on the wire: after a compaction the child's next request opens with one
    // user message whose content is a plain string, not an array of blocks.
    const cap = capture([
      pair(1, 'agent-1', { upstreamModel: 'gateway/fast-worker' }),
      pair(2, 'agent-1', { upstreamModel: 'gateway/fast-worker', compactionSignal: 'wrapper-string' }),
    ]);
    const preBody = cap.pairs[1]!.pre.body as { messages: Array<{ content: unknown }> };
    expect(typeof preBody.messages[0]!.content).toBe('string');
    expect(judgeLifecyclePhase('compaction', extractLifecycleEvidence(cap), compactionRun).result).toBe('passed');
  });

  test('lifecycle-compaction-passes-on-a-later-continuation-wrapper-in-a-text-block', () => {
    const cap = capture([
      pair(1, 'agent-1', { upstreamModel: 'gateway/fast-worker' }),
      pair(2, 'agent-1', { upstreamModel: 'gateway/fast-worker', compactionSignal: 'wrapper-blocks' }),
    ]);
    expect(judgeLifecyclePhase('compaction', extractLifecycleEvidence(cap), compactionRun).result).toBe('passed');
  });

  test('lifecycle-compaction-pending-on-the-transcript-only-compact-boundary-literal', () => {
    // The literal lives in the transcript, never in a request body, so a body carrying it and
    // nothing else is not evidence that a compaction happened on this wire.
    const cap = capture([
      pair(1, 'agent-1', { upstreamModel: 'gateway/fast-worker' }),
      pair(2, 'agent-1', { upstreamModel: 'gateway/fast-worker', compactionSignal: 'legacy-marker' }),
    ]);
    const judgement = judgeLifecyclePhase('compaction', extractLifecycleEvidence(cap), compactionRun);
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toContain('compaction-requires-observed-compact-boundary');
  });

  test('lifecycle-compaction-pending-when-the-wrapper-is-not-at-the-start-of-the-text', () => {
    // Quoted mid-sentence: someone talking about a compaction, not a compacted history.
    const cap = capture([
      pair(1, 'agent-1', { upstreamModel: 'gateway/fast-worker' }),
      pair(2, 'agent-1', { upstreamModel: 'gateway/fast-worker', compactionSignal: 'wrapper-mid-text' }),
    ]);
    const judgement = judgeLifecyclePhase('compaction', extractLifecycleEvidence(cap), compactionRun);
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toContain('compaction-requires-observed-compact-boundary');
  });

  test('lifecycle-compaction-fails-when-the-post-compaction-request-is-refused', () => {
    // The measured 2.1.268 shape. The compacted history dropped the channel-A marker, the handler
    // refused the child's next request with 422 missing-selection, and a refused request is never
    // forwarded, so the capture holds a pre-handler record with no upstream record beside it.
    const cap = capture(
      [pair(1, 'agent-1', { upstreamModel: 'gateway/fast-worker' })],
      [refused(2, 'agent-1', { compactionSignal: 'wrapper-string' })],
    );
    const evidence = extractLifecycleEvidence(cap);
    expect(evidence.get('agent-1')!.map((e) => e.seq)).toEqual([1, 2]);
    const judgement = judgeLifecyclePhase('compaction', evidence, compactionRun);
    expect(judgement.result).toBe('failed');
    expect(judgement.diagnostic).toContain('compaction-later-request-not-forwarded');
  });

  test('lifecycle-compaction-does-not-count-a-refused-first-request-as-a-later-request', () => {
    // laterRequestNotForwarded deliberately skips entry 0: an agent whose very first observed
    // request was refused was never routed at all, which is not the same failure as losing a
    // child that was already routed.
    const cap = capture(
      [pair(2, 'agent-1', { upstreamModel: 'gateway/fast-worker', compactionSignal: 'wrapper-string' })],
      [refused(1, 'agent-1', { compactionSignal: 'wrapper-string' })],
    );
    const evidence = extractLifecycleEvidence(cap);
    const list = evidence.get('agent-1')!;
    expect(list.map((e) => e.seq)).toEqual([1, 2]);
    expect(list[0]!.upstreamModel).toBeUndefined();
    expect(judgeLifecyclePhase('compaction', evidence, compactionRun).result).toBe('passed');
  });

  test('lifecycle-pending-when-phase-not-declared', () => {
    const cap = capture([pair(1, 'agent-1', { upstreamModel: 'gateway/fast-worker' }), pair(2, 'agent-1', { upstreamModel: 'gateway/fast-worker' })]);
    expect(judgeLifecyclePhase('next-turn', extractLifecycleEvidence(cap), undefined).result).toBe('pending');
    expect(judgeLifecyclePhase('next-turn', extractLifecycleEvidence(cap), manifest({ mode: 'next-turn', phasesExercised: [] })).result).toBe('pending');
  });

  test('summarize-m10-never-spreads-a-pass', () => {
    const summary = summarizeM10({ 'next-turn': 'passed' });
    expect(summary).toEqual({ 'next-turn': 'passed', resume: 'pending', compaction: 'pending', nested: 'pending', parallel: 'pending' });
  });
});

// ---------- resume: the invocation boundary and the no-continuation proof ----------

// On Claude Code 2.1.268 an ordinary `claude -c` resume re-delegates and every child gets a
// fresh id, so no pre-boundary child is ever seen again. That leaves the resume phase with no
// continuation to measure, which is why the fresh-only branch needs the dd-verified record
// before it may pass. The crossing branch stays the direct measurement: if a future client does
// continue a child, that evidence alone decides the verdict and no proof is consulted.
describe('evidence-m10: judgeLifecyclePhase resume across the invocation boundary', () => {
  const RESUME_RUN = manifest({ mode: 'resume', phasesExercised: ['resume'] });
  const VERSION = '9.9.9';

  let proofDir = '';
  let goodProof: ResumeProof;
  let goodVerification: ProofSiteVerification;
  let shiftedProof: ResumeProof;
  let shiftedVerification: ProofSiteVerification;

  beforeAll(async () => {
    proofDir = await mkdtemp(join(tmpdir(), 'subagent-router-resume-judge-'));
    const binaryPath = join(proofDir, 'fake-client-binary');
    await writeSyntheticResumeBinary(binaryPath);

    await writeSyntheticResumeProof(proofDir, { binaryPath, version: VERSION });
    goodProof = (await loadResumeProof('claude-code', VERSION, proofDir))!;
    goodVerification = await verifyResumeProofAgainstBinary(goodProof);

    // Same binary, one site's recorded offset moved a byte: the record no longer describes the
    // binary this run used, which must never read as a verified proof.
    const shifted = SYNTHETIC_RESUME_SITES.map((site) => (site.name === 'adopt-gate' ? { ...site, offset: site.offset + 1 } : site));
    await writeSyntheticResumeProof(proofDir, { binaryPath, version: '9.9.8', sites: shifted });
    shiftedProof = (await loadResumeProof('claude-code', '9.9.8', proofDir))!;
    shiftedVerification = await verifyResumeProofAgainstBinary(shiftedProof);
  });

  afterAll(async () => {
    await rm(proofDir, { recursive: true, force: true });
  });

  // One child talking on both sides of the boundary: a real continuation.
  const crossing = () =>
    extractLifecycleEvidence(
      capture([
        pair(1, 'agent-kept', { upstreamModel: 'gateway/fast-worker' }),
        pair(3, 'agent-kept', { upstreamModel: 'gateway/fast-worker' }),
      ]),
    );

  // The measured 2.1.268 shape: the pre-boundary child never speaks again and the resumed parent
  // delegates to a brand new id.
  const freshOnly = () =>
    extractLifecycleEvidence(
      capture([
        pair(1, 'agent-before', { upstreamModel: 'gateway/fast-worker' }),
        pair(3, 'agent-after', { upstreamModel: 'gateway/smart-worker' }),
      ]),
    );

  test('a child with requests on both sides of the boundary passes on that measurement alone, no proof consulted', () => {
    const judgement = judgeLifecyclePhase('resume', crossing(), RESUME_RUN, { invocationBoundary: { afterSeq: 2 }, observedVersion: VERSION });
    expect(judgement.result).toBe('passed');
  });

  test('fresh delegations only, with no recorded proof for the observed version, is pending', () => {
    const judgement = judgeLifecyclePhase('resume', freshOnly(), RESUME_RUN, { invocationBoundary: { afterSeq: 2 }, observedVersion: VERSION });
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toContain(`resume-no-continuation-proof-for-${VERSION}`);
  });

  test('fresh delegations only, backed by a byte-verified proof, passes and says what was and was not measured', () => {
    const judgement = judgeLifecyclePhase('resume', freshOnly(), RESUME_RUN, {
      invocationBoundary: { afterSeq: 2 },
      observedVersion: VERSION,
      resumeProof: goodProof,
      resumeProofVerification: goodVerification,
    });
    expect(judgement.result).toBe('passed');
    expect(judgement.diagnostic).toBe(
      `resume-fresh-delegations-only: 1 post-boundary children, none continuing a pre-boundary id, per the dd-verified proof for ${VERSION} (5/5 sites re-checked); takeover handoff unmeasured and fail-closed`,
    );
  });

  test('a proof whose recorded bytes are not at those offsets any more is pending, named by site', () => {
    const judgement = judgeLifecyclePhase('resume', freshOnly(), RESUME_RUN, {
      invocationBoundary: { afterSeq: 2 },
      observedVersion: '9.9.8',
      resumeProof: shiftedProof,
      resumeProofVerification: shiftedVerification,
    });
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toContain('resume-proof-site-mismatch:adopt-gate');
  });

  test('a post-boundary child that was never forwarded fails, proof or no proof', () => {
    // The handler refused the fresh child's only request, so the capture holds a pre-handler
    // record with no upstream record beside it. checkDriftAndForwarding alone would skip this
    // one (it never inspects an agent's first request), so the fresh branch checks every request.
    const evidence = extractLifecycleEvidence(
      capture([pair(1, 'agent-before', { upstreamModel: 'gateway/fast-worker' })], [refused(3, 'agent-after')]),
    );
    const judgement = judgeLifecyclePhase('resume', evidence, RESUME_RUN, {
      invocationBoundary: { afterSeq: 2 },
      observedVersion: VERSION,
      resumeProof: goodProof,
      resumeProofVerification: goodVerification,
    });
    expect(judgement.result).toBe('failed');
    expect(judgement.diagnostic).toContain('resume-post-boundary-child-not-forwarded');
  });

  test('without an invocation boundary the phase is pending, even with a crossing child and a verified proof', () => {
    // Nothing in a request says which CLI invocation produced it. Without the file the launcher
    // writes between the two, "spanning the resume" cannot be told from "two turns in one run".
    const judgement = judgeLifecyclePhase('resume', crossing(), RESUME_RUN, {
      observedVersion: VERSION,
      resumeProof: goodProof,
      resumeProofVerification: goodVerification,
    });
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toContain('resume-requires-invocation-boundary');
  });

  test('a boundary after every captured request leaves no post-boundary child to judge', () => {
    const judgement = judgeLifecyclePhase('resume', crossing(), RESUME_RUN, { invocationBoundary: { afterSeq: 99 }, observedVersion: VERSION });
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toContain('resume-no-post-boundary-children');
  });
});

// ---------- freshness: hermetic end-to-end (real createHandler + real hook) ----------

const B2_PROFILE: CapabilityProfile = {
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
const SOURCE = { sourceId: 'test-gateway', effectiveGatewayUrl: 'http://127.0.0.1:8000/v1', effectiveModelsUrl: 'http://127.0.0.1:8000/v1/models', headers: {}, gatewayHeaders: {} };
const CHILD_SYSTEM = [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }];
const SECRET = 'freshness-test-secret';

function upstream(): { fetch: FetchLike; seen: Array<{ url: string; body: Record<string, unknown> }> } {
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch: FetchLike = async (request) => {
    seen.push({ url: request.url, body: (await request.json()) as Record<string, unknown> });
    return new Response(JSON.stringify({ id: 'msg', content: [{ type: 'text', text: 'ok' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, seen };
}

function jsonReadableStream(value: unknown): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function collectingWritableStream(): { stream: WritableStream<Uint8Array>; text: () => string } {
  let text = '';
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      text += new TextDecoder().decode(chunk);
    },
  });
  return { stream, text: () => text };
}

/**
 * Drives a real in-process createHandler through a real runClaudeSubagentStartHook (fake
 * stdin SubagentStart event, injected fetch pointed straight at the handler -- no socket), then
 * a real routed child request, then a replay of the exact registered envelope. Returns a
 * FreshnessCapture assembled from what actually happened, never from the router's internal
 * state.
 */
async function runFreshnessScenario(agentId: string) {
  const config = configFixture();
  const { fetch: upstreamFetch, seen } = upstream();
  const handler = createHandler({
    config,
    snapshot: await snapshotFixture(),
    source: SOURCE,
    profile: B2_PROFILE,
    transportProfile: TRANSPORT_PROFILE,
    secret: SECRET,
    fetch: upstreamFetch,
    fetchAdapter: { id: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic' },
    trustedContext: () => ({ freshDelegation: false }),
    now: () => 0,
    nonce: () => `nonce-${agentId}`,
    instanceId: () => 'freshness-instance',
  });

  let seq = 0;
  const nextSeq = () => (seq += 1);
  const instanceFetches: InstanceFetchRecord[] = [];
  const delegationRegisters: DelegationRegisterRecord[] = [];
  const delegationConsumes: DelegationConsumeRecord[] = [];
  const delegationReplays: DelegationReplayRecord[] = [];
  const firstRoutedRequestSeqByAgent = new Map<string, number>();
  let capturedEnvelope: FreshDelegationEnvelope | undefined;

  const hookFetch: FetchLike = async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/subagent-router/control/instance') {
      const s = nextSeq();
      const response = await handler(request);
      instanceFetches.push({ seq: s });
      return response;
    }
    if (url.pathname === '/subagent-router/control/delegations') {
      const s = nextSeq();
      const bodyText = await request.clone().text();
      const response = await handler(request);
      let envelope: FreshDelegationEnvelope | undefined;
      try {
        envelope = JSON.parse(bodyText) as FreshDelegationEnvelope;
      } catch {
        envelope = undefined;
      }
      if (envelope !== undefined) {
        capturedEnvelope = envelope;
        delegationRegisters.push({ seq: s, agentId: envelope.agentId, role: envelope.role, accepted: response.status === 204, nonceHash: await hashNonce(envelope.nonce) });
      }
      return response;
    }
    return handler(request);
  };

  const stdinEvent = { agent_id: agentId, agent_type: 'explorer', hook_event_name: 'SubagentStart' };
  const stdout = collectingWritableStream();
  await runClaudeSubagentStartHook(jsonReadableStream(stdinEvent), stdout.stream, {
    controlBaseUrl: 'http://router.local',
    secret: SECRET,
    roles: config.roles,
    profile: B2_PROFILE,
    fetch: hookFetch,
    now: () => 0,
    nonce: () => `nonce-${agentId}`,
    resolveTrustedStart: () => ({ freshDelegation: true }),
    correlation: 'auto',
  });

  const firstSeq = nextSeq();
  firstRoutedRequestSeqByAgent.set(agentId, firstSeq);
  const childResponse = await handler(
    new Request('http://router.local/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-agent-id': agentId },
      body: JSON.stringify({ model: 'x', system: CHILD_SYSTEM, messages: [{ role: 'user', content: 'bez markera' }] }),
    }),
  );
  const consumed = childResponse.status === 200 && seen.length > 0 && seen[seen.length - 1]?.body.model === FIXTURE_MODEL_ID;
  delegationConsumes.push({ seq: firstSeq, agentId, consumed, ...(consumed ? {} : { reason: 'not-routed-to-role-default' }) });

  if (capturedEnvelope !== undefined) {
    const replaySeq = nextSeq();
    const replayResponse = await handler(
      new Request('http://router.local/subagent-router/control/delegations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(capturedEnvelope),
      }),
    );
    delegationReplays.push({ seq: replaySeq, agentId, rejected: replayResponse.status !== 204 });
  }

  const freshnessCapture: FreshnessCapture = { instanceFetches, delegationRegisters, delegationConsumes, delegationReplays, firstRoutedRequestSeqByAgent };
  return { freshnessCapture, seen };
}

describe('evidence-freshness: extractFreshnessEvidence + judgeM10Freshness', () => {
  test('freshness-passes-only-with-register-consume-and-rejected-replay', async () => {
    const { freshnessCapture, seen } = await runFreshnessScenario('agent-fresh-1');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body.model).toBe(FIXTURE_MODEL_ID);

    const evidence = extractFreshnessEvidence(freshnessCapture);
    expect(evidence.perAgent).toHaveLength(1);
    expect(evidence.perAgent[0]).toMatchObject({
      registerAcceptedBeforeFirstRequest: true,
      consumeSuccessesOnFirstRequest: 1,
      replayRejected: true,
      consumeSucceededWithoutPriorAcceptedRegister: false,
    });
    expect(judgeM10Freshness(evidence).result).toBe('passed');
  });

  test('freshness-fails-when-consume-succeeds-without-register', () => {
    // Hand-built: a consume succeeded but no register was ever recorded for this agent at all --
    // a contradiction judgeM10Freshness must catch on its own, independent of any live handler.
    const cap: FreshnessCapture = {
      instanceFetches: [{ seq: 1 }],
      delegationRegisters: [],
      delegationConsumes: [{ seq: 5, agentId: 'agent-x', consumed: true }],
      delegationReplays: [{ seq: 6, agentId: 'agent-x', rejected: true }],
      firstRoutedRequestSeqByAgent: new Map([['agent-x', 5]]),
    };
    const judgement = judgeM10Freshness(extractFreshnessEvidence(cap));
    expect(judgement.result).toBe('failed');
    expect(judgement.diagnostic).toContain('consume-without-register');
  });

  test('freshness-fails-when-replay-is-accepted', () => {
    const cap: FreshnessCapture = {
      instanceFetches: [{ seq: 1 }],
      delegationRegisters: [{ seq: 2, agentId: 'agent-y', role: 'explorer', accepted: true, nonceHash: 'deadbeef' }],
      delegationConsumes: [{ seq: 5, agentId: 'agent-y', consumed: true }],
      delegationReplays: [{ seq: 6, agentId: 'agent-y', rejected: false }],
      firstRoutedRequestSeqByAgent: new Map([['agent-y', 5]]),
    };
    const judgement = judgeM10Freshness(extractFreshnessEvidence(cap));
    expect(judgement.result).toBe('failed');
    expect(judgement.diagnostic).toContain('replay-not-rejected');
  });

  test('freshness-pending-without-freshness-records', () => {
    // A run with real routed requests but zero freshness records of any kind -- the shape of
    // the pre-existing saved run tests/probes/.runs/handler-4r0D99, which used the fake stdin
    // hook, never the production one.
    const cap: FreshnessCapture = {
      instanceFetches: [],
      delegationRegisters: [],
      delegationConsumes: [],
      delegationReplays: [],
      firstRoutedRequestSeqByAgent: new Map([['agent-z', 1]]),
    };
    const judgement = judgeM10Freshness(extractFreshnessEvidence(cap));
    expect(judgement.result).toBe('pending');
    expect(judgement.diagnostic).toContain('freshness-no-records');
  });
});
