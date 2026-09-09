// M10-freshness evidence extractor + judge. Operates on an in-memory record of the
// control-plane events a freshness-capable run must produce (instance fetch, delegation
// register/consume/replay), never on the router's internal FreshDelegationStore state
// directly -- the whole point is to judge from what a human-auditable capture would show, the
// same posture as every other probe module in this directory. No disk reader lives here: a
// real recorded run (native-claude-handler.ts, PROBE_FRESHNESS_HOOK=production) assembles the
// exact same shape before calling extractFreshnessEvidence; this module never depends on how
// the records got assembled, in memory or from disk.
import type { LifecycleJudgement } from './evidence-m10';

export interface InstanceFetchRecord {
  seq: number;
}

export interface DelegationRegisterRecord {
  seq: number;
  agentId: string;
  role: string;
  accepted: boolean;
  // A hash of the nonce only. The signed proof itself must never appear in any capture or
  // diagnostic -- see docs/superpowers/specs/2026-09-06-subagent-model-routing-design.md:358
  // ("Endpointy kontrolne nigdy nie są przekazywane do bramy, a `proof` nie trafia do
  // diagnostyki").
  nonceHash: string;
}

export interface DelegationConsumeRecord {
  seq: number;
  agentId: string;
  consumed: boolean;
  reason?: string;
}

export interface DelegationReplayRecord {
  seq: number;
  agentId: string;
  rejected: boolean;
}

export interface FreshnessCapture {
  instanceFetches: readonly InstanceFetchRecord[];
  delegationRegisters: readonly DelegationRegisterRecord[];
  delegationConsumes: readonly DelegationConsumeRecord[];
  delegationReplays: readonly DelegationReplayRecord[];
  // seq of each routed child's FIRST pre-handler (routed) request -- the moment a register
  // must already have landed and be the one thing the first consume draws from. Uses the same
  // single monotonic ordering scheme as every other record here (whichever event happened
  // first in wall-clock/recording order gets the lowest seq), so register/consume/replay
  // ordering is judged against the exact request timeline, never a separately-kept clock.
  firstRoutedRequestSeqByAgent: ReadonlyMap<string, number>;
}

/** Hex-encoded SHA-256 of a nonce. Used to record that a nonce was seen without ever storing it. */
export async function hashNonce(nonce: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface AgentFreshnessEvidence {
  agentId: string;
  registerAcceptedBeforeFirstRequest: boolean;
  consumeSuccessesOnFirstRequest: number;
  replayRejected: boolean;
  consumeSucceededWithoutPriorAcceptedRegister: boolean;
}

export interface FreshnessExtraction {
  perAgent: readonly AgentFreshnessEvidence[];
  // True iff the capture carries at least one instance-fetch/register/consume/replay record of
  // ANY kind. This, not per-agent emptiness, is what lets a run with real routed requests but
  // zero freshness records (a saved run that used the fake stdin hook, never the production
  // one) judge 'pending' rather than 'failed': nothing here was ever measured, so nothing here
  // has been proven false.
  hasAnyFreshnessRecords: boolean;
}

/**
 * Turns a FreshnessCapture into one AgentFreshnessEvidence per routed child (every agent id
 * `firstRoutedRequestSeqByAgent` names), plus the capture-wide hasAnyFreshnessRecords flag.
 */
export function extractFreshnessEvidence(capture: FreshnessCapture): FreshnessExtraction {
  const hasAnyFreshnessRecords =
    capture.instanceFetches.length > 0 ||
    capture.delegationRegisters.length > 0 ||
    capture.delegationConsumes.length > 0 ||
    capture.delegationReplays.length > 0;

  const perAgent: AgentFreshnessEvidence[] = [];
  for (const [agentId, firstSeq] of capture.firstRoutedRequestSeqByAgent) {
    const registers = capture.delegationRegisters.filter((r) => r.agentId === agentId);
    const registerAcceptedBeforeFirstRequest = registers.some((r) => r.accepted && r.seq < firstSeq);

    const consumes = capture.delegationConsumes.filter((c) => c.agentId === agentId);
    const consumeSuccessesOnFirstRequest = consumes.filter((c) => c.seq === firstSeq && c.consumed).length;

    // Checked across every consume for this agent, not only the first request's: a success
    // anywhere with no accepted register at or before its own seq is the violation.
    const consumeSucceededWithoutPriorAcceptedRegister = consumes.some((c) => c.consumed && !registers.some((r) => r.accepted && r.seq <= c.seq));

    const replays = capture.delegationReplays.filter((r) => r.agentId === agentId);
    const replayRejected = replays.some((r) => r.rejected);

    perAgent.push({ agentId, registerAcceptedBeforeFirstRequest, consumeSuccessesOnFirstRequest, replayRejected, consumeSucceededWithoutPriorAcceptedRegister });
  }

  return { perAgent, hasAnyFreshnessRecords };
}

/**
 * Passes only when every routed child in the extraction independently proves all four
 * freshness facts: a register preceded its first request, exactly one consume succeeded on
 * that first request, a replay of the same envelope was rejected, and no consume ever
 * succeeded without a preceding accepted register. Any single contradiction fails the whole
 * run -- one good agent never masks one bad one. Absent any freshness record at all, the run
 * is 'pending', never 'failed': it was simply never measured (e.g. a saved run that used the
 * fake stdin hook instead of the production one).
 */
export function judgeM10Freshness(evidence: FreshnessExtraction): LifecycleJudgement {
  if (!evidence.hasAnyFreshnessRecords) {
    return { result: 'pending', diagnostic: 'freshness-no-records: this run carries no instance-fetch/register/consume/replay records at all' };
  }
  if (evidence.perAgent.length === 0) {
    return { result: 'pending', diagnostic: 'freshness-no-routed-children-observed' };
  }
  for (const agent of evidence.perAgent) {
    if (agent.consumeSucceededWithoutPriorAcceptedRegister) {
      return { result: 'failed', diagnostic: `freshness-consume-without-register: agent ${agent.agentId} consumed a receipt with no preceding accepted register` };
    }
    if (!agent.registerAcceptedBeforeFirstRequest) {
      return { result: 'failed', diagnostic: `freshness-register-missing-or-late: agent ${agent.agentId} has no accepted register before its first routed request` };
    }
    if (agent.consumeSuccessesOnFirstRequest !== 1) {
      return {
        result: 'failed',
        diagnostic: `freshness-consume-count-mismatch: agent ${agent.agentId} had ${agent.consumeSuccessesOnFirstRequest} successful consumes on its first request, expected exactly 1`,
      };
    }
    if (!agent.replayRejected) {
      return { result: 'failed', diagnostic: `freshness-replay-not-rejected: agent ${agent.agentId} had no rejected replay of its registered envelope` };
    }
  }
  return { result: 'passed' };
}
