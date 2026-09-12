// M10 lifecycle evidence extractor + judges. Reads the same RunCapture shape
// evidence-m3a.ts's readRunCapture produces -- never the reader itself, since lifecycle
// judging only needs capture.pairs (nothing scaffold- or block0-specific) -- and turns it
// into a per-agent, ordered request timeline plus a phase-by-phase verdict. A run's own
// declaration of which lifecycle phases it exercised (capture/000-run-manifest.json, read by
// readRunManifest below) gates every phase closed until the run says it was tried; nothing
// here infers a phase from request shape, count, or history length alone.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunCapture } from './evidence-m3a';
import type { LifecyclePhase, ProbeResult } from '../../src/core/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ---------- run manifest ----------

export interface RunManifest {
  mode: string;
  phasesExercised: readonly string[];
  freshnessHook: 'production' | 'fake' | 'none';
  // Whether the run scaffolded the router's correlation gate open (PROBE_CORRELATION_SCAFFOLD).
  // Anything but a literal true reads as false: a lifecycle pass under that scaffold is
  // conditional on M1 and must never narrow an on-disk fixture (see fixture-writer.ts).
  correlationScaffold: boolean;
}

const FRESHNESS_HOOK_VALUES = new Set(['production', 'fake', 'none']);

/**
 * Reads capture/000-run-manifest.json next to a run's other numbered capture files. Absent or
 * unparseable is never an error here -- it just means the run declares nothing, so every judge
 * in this file (and evidence-freshness.ts) treats `undefined` the same as an empty declaration
 * and fails closed to 'pending'. Sequence number 0 is deliberate: it sits before every other
 * capture file (001-profile.json onward) without consuming one of their seq numbers.
 */
export async function readRunManifest(runDir: string): Promise<RunManifest | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(runDir, 'capture', '000-run-manifest.json'), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const mode = typeof parsed.mode === 'string' ? parsed.mode : '';
  const phasesExercised =
    Array.isArray(parsed.phasesExercised) && parsed.phasesExercised.every((p) => typeof p === 'string')
      ? (parsed.phasesExercised as string[])
      : [];
  const freshnessHook =
    typeof parsed.freshnessHook === 'string' && FRESHNESS_HOOK_VALUES.has(parsed.freshnessHook)
      ? (parsed.freshnessHook as RunManifest['freshnessHook'])
      : 'none';
  return { mode, phasesExercised, freshnessHook, correlationScaffold: parsed.correlationScaffold === true };
}

// ---------- per-request evidence ----------

export interface LifecycleRequestEvidence {
  seq: number;
  clientModel?: string;
  upstreamModel?: string;
  // True when this request's own body carries the client's post-compaction continuation
  // wrapper (see COMPACTION_SUMMARY_PREFIX). The name is kept from the earlier transcript-marker
  // predicate so the compaction diagnostic string stays consistent with it.
  hasCompactBoundary: boolean;
  // The x-claude-code-parent-agent-id header on this request, when present. Only ever
  // consulted for the 'nested' phase. See
  // docs/superpowers/specs/2026-09-06-subagent-model-routing-design.md:59 (the binary-string
  // measurement that found this exact header name alongside x-claude-code-agent-id).
  parentAgentId?: string;
}

export type LifecycleEvidenceByAgent = ReadonlyMap<string, readonly LifecycleRequestEvidence[]>;

/**
 * The wrapper Claude Code 2.1.268 puts in front of a compaction summary, observed on the wire:
 * after a compaction the child's next /v1/messages request opens with a `user` message whose text
 * starts with this sentence. The transcript-only `compact_boundary` marker is NOT usable here: it
 * is a `type:"system"` transcript line with no `message` field, and the client's API-facing
 * readers skip those, so it never reaches a request body at all.
 */
export const COMPACTION_SUMMARY_PREFIX =
  'This session is being continued from a previous conversation that ran out of context.';

function startsWithCompactionSummary(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(COMPACTION_SUMMARY_PREFIX);
}

// Matches only a `user` message whose text BEGINS with the wrapper. Content is a plain string on
// the measured client, but an array of blocks is accepted too, in which case any `text` block
// opening with the wrapper counts. The wrapper quoted mid-text is deliberately not a match.
function hasCompactionContinuationMessage(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    if (!isRecord(message) || message.role !== 'user') return false;
    const content = message.content;
    if (typeof content === 'string') return startsWithCompactionSummary(content);
    if (!Array.isArray(content)) return false;
    return content.some((block) => isRecord(block) && block.type === 'text' && startsWithCompactionSummary(block.text));
  });
}

/**
 * Groups every routed child pair (agentId present) by agent, in ascending seq order. Reads
 * clientModel from the pre-handler request body and upstreamModel from the paired
 * post-handler-upstream body -- never the other way around: the model the client asked for and
 * the model the router actually forwarded are two different facts this evidence must keep
 * separate, exactly as RouteInput.clientModel and RouteDecision.upstreamModel are kept separate
 * in src/core/types.ts.
 *
 * The capture's unforwarded requests are merged into the same per-agent timeline, with no
 * upstreamModel, because that absence IS the evidence: a request the handler refused was never
 * forwarded, and without it a lost child looks identical to a child that simply stopped talking.
 */
export function extractLifecycleEvidence(capture: RunCapture): LifecycleEvidenceByAgent {
  const byAgent = new Map<string, LifecycleRequestEvidence[]>();
  for (const pair of capture.pairs) {
    if (pair.agentId === undefined) continue;
    const clientModel = typeof pair.pre.body.model === 'string' ? pair.pre.body.model : undefined;
    const upstreamModel = typeof pair.post.body.model === 'string' ? pair.post.body.model : undefined;
    const parentAgentId = pair.pre.headers['x-claude-code-parent-agent-id'];
    const entry: LifecycleRequestEvidence = {
      seq: pair.seq,
      hasCompactBoundary: hasCompactionContinuationMessage(pair.pre.body),
      ...(clientModel !== undefined ? { clientModel } : {}),
      ...(upstreamModel !== undefined ? { upstreamModel } : {}),
      ...(parentAgentId !== undefined ? { parentAgentId } : {}),
    };
    const list = byAgent.get(pair.agentId);
    if (list === undefined) byAgent.set(pair.agentId, [entry]);
    else list.push(entry);
  }
  for (const request of capture.unforwarded) {
    if (request.agentId === undefined) continue;
    const clientModel = typeof request.pre.body.model === 'string' ? request.pre.body.model : undefined;
    const parentAgentId = request.pre.headers['x-claude-code-parent-agent-id'];
    const entry: LifecycleRequestEvidence = {
      seq: request.seq,
      hasCompactBoundary: hasCompactionContinuationMessage(request.pre.body),
      ...(clientModel !== undefined ? { clientModel } : {}),
      ...(parentAgentId !== undefined ? { parentAgentId } : {}),
    };
    const list = byAgent.get(request.agentId);
    if (list === undefined) byAgent.set(request.agentId, [entry]);
    else list.push(entry);
  }
  for (const list of byAgent.values()) list.sort((a, b) => a.seq - b.seq);
  return byAgent;
}

// ---------- phase judge ----------

export interface LifecycleJudgement {
  result: ProbeResult;
  diagnostic?: string;
}

function agentUpstreamDrifted(list: readonly LifecycleRequestEvidence[]): boolean {
  const models = new Set(list.map((e) => e.upstreamModel).filter((m): m is string => m !== undefined));
  return models.size > 1;
}

// "A later request of a routed child is not forwarded": the first request in an agent's
// ordered list is expected to establish routing (upstreamModel present); any request AFTER
// that one lacking an upstreamModel is the failure this checks for. The first entry's own
// upstreamModel is never checked here -- an agent whose very first observed request already
// carries no upstreamModel was simply never routed at all, a different (pending) condition.
function laterRequestNotForwarded(list: readonly LifecycleRequestEvidence[]): boolean {
  return list.slice(1).some((e) => e.upstreamModel === undefined);
}

function agentsWithAtLeastTwoRequests(evidence: LifecycleEvidenceByAgent): string[] {
  return [...evidence.entries()].filter(([, list]) => list.length >= 2).map(([agentId]) => agentId);
}

// A pure block pattern (all of agent A's requests, then all of agent B's) has exactly
// (distinctAgents - 1) agent-to-agent transitions when the merged, seq-sorted stream is
// scanned. True interleaving produces strictly more transitions than that minimum.
function isSequenceInterleaved(evidence: LifecycleEvidenceByAgent): boolean {
  const merged: Array<{ seq: number; agentId: string }> = [];
  for (const [agentId, list] of evidence) {
    for (const entry of list) merged.push({ seq: entry.seq, agentId });
  }
  merged.sort((a, b) => a.seq - b.seq);
  const distinctAgents = new Set(merged.map((m) => m.agentId));
  if (distinctAgents.size < 2) return false;
  let transitions = 0;
  for (let i = 1; i < merged.length; i += 1) {
    if (merged[i]!.agentId !== merged[i - 1]!.agentId) transitions += 1;
  }
  return transitions > distinctAgents.size - 1;
}

// Returns the set of agent ids actually involved in an observed nested relationship (a child
// whose x-claude-code-parent-agent-id names another routed child in this same evidence map),
// or undefined when no such relationship was ever captured. Restricting drift/forwarding
// checks to just these agents means an unrelated third agent's own problems never cloud the
// 'nested' verdict.
function nestedInvolvedAgents(evidence: LifecycleEvidenceByAgent): Set<string> | undefined {
  const agentIds = new Set(evidence.keys());
  const involved = new Set<string>();
  for (const [agentId, list] of evidence) {
    for (const entry of list) {
      if (entry.parentAgentId !== undefined && entry.parentAgentId !== agentId && agentIds.has(entry.parentAgentId)) {
        involved.add(agentId);
        involved.add(entry.parentAgentId);
      }
    }
  }
  return involved.size > 0 ? involved : undefined;
}

// Shared by every phase whose only distinguishing signal is the run's own declaration. Kept as
// one helper so the wording of the diagnostic cannot drift between call sites.
function checkDeclaredMode(phase: LifecyclePhase, runMetadata: RunManifest | undefined): LifecycleJudgement | undefined {
  if (runMetadata?.mode === phase) return undefined;
  return { result: 'pending', diagnostic: `${phase}-requires-declared-mode: the run manifest's mode must equal '${phase}', got ${JSON.stringify(runMetadata?.mode)}` };
}

function checkDriftAndForwarding(agentIds: readonly string[], evidence: LifecycleEvidenceByAgent, phase: LifecyclePhase): LifecycleJudgement | undefined {
  for (const agentId of agentIds) {
    const list = evidence.get(agentId) ?? [];
    if (agentUpstreamDrifted(list)) {
      return { result: 'failed', diagnostic: `${phase}-upstream-model-drifted: agent ${agentId} was forwarded to more than one upstream model within this phase` };
    }
    if (laterRequestNotForwarded(list)) {
      return { result: 'failed', diagnostic: `${phase}-later-request-not-forwarded: a later request of routed child ${agentId} was not forwarded to any upstream model` };
    }
  }
  return undefined;
}

/**
 * Judges one M10 lifecycle phase against a run's declared phasesExercised and the extracted
 * per-agent request evidence. Every phase fails closed to 'pending' when the run itself never
 * declares the phase was tried: aggregate request shape, history length, or the mere presence
 * of a request are never treated as proof a phase happened (per the design doc's M10-freshness
 * language, applied here to every phase, not only freshness).
 */
export function judgeLifecyclePhase(phase: LifecyclePhase, evidence: LifecycleEvidenceByAgent, runMetadata: RunManifest | undefined): LifecycleJudgement {
  const phasesExercised = runMetadata?.phasesExercised ?? [];
  if (!phasesExercised.includes(phase)) {
    return { result: 'pending', diagnostic: `${phase}-not-declared: the run manifest does not declare ${phase} as an exercised phase` };
  }

  if (phase === 'parallel') {
    const distinctAgents = new Set(evidence.keys());
    if (distinctAgents.size < 2) {
      return { result: 'pending', diagnostic: 'parallel-requires-at-least-two-distinct-agents' };
    }
    if (!isSequenceInterleaved(evidence)) {
      return { result: 'pending', diagnostic: 'parallel-requires-interleaved-sequence-numbers' };
    }
    return checkDriftAndForwarding([...distinctAgents], evidence, phase) ?? { result: 'passed' };
  }

  if (phase === 'nested') {
    const involved = nestedInvolvedAgents(evidence);
    if (involved === undefined) {
      return {
        result: 'pending',
        diagnostic:
          "nested-requires-observed-parent-agent-id-header: no captured request carried x-claude-code-parent-agent-id equal to another routed child's agent id",
      };
    }
    return checkDriftAndForwarding([...involved], evidence, phase) ?? { result: 'passed' };
  }

  if (phase === 'compaction') {
    // A continuation wrapper can ride along in the history of any multi-turn run, so the wrapper
    // alone never proves this run drove a compaction: the declared mode must agree too.
    const declared = checkDeclaredMode(phase, runMetadata);
    if (declared !== undefined) return declared;
    const withBoundary = [...evidence.entries()]
      .filter(([, list]) => list.length >= 2 && list.slice(1).some((e) => e.hasCompactBoundary))
      .map(([agentId]) => agentId);
    if (withBoundary.length === 0) {
      return { result: 'pending', diagnostic: 'compaction-requires-observed-compact-boundary' };
    }
    return checkDriftAndForwarding(withBoundary, evidence, phase) ?? { result: 'passed' };
  }

  // 'next-turn' | 'resume': no structural signal in the request itself distinguishes these
  // from any other multi-turn request, so the ONLY thing that can tell them apart is the run's
  // own declared mode -- never inferred from request count or history length.
  const declared = checkDeclaredMode(phase, runMetadata);
  if (declared !== undefined) return declared;
  const qualifying = agentsWithAtLeastTwoRequests(evidence);
  if (qualifying.length === 0) {
    return { result: 'pending', diagnostic: `${phase}-insufficient-requests: no agent has two routed requests spanning the declared boundary` };
  }
  return checkDriftAndForwarding(qualifying, evidence, phase) ?? { result: 'passed' };
}

const LIFECYCLE_PHASES: readonly LifecyclePhase[] = ['next-turn', 'resume', 'compaction', 'nested', 'parallel'];

/** Fills every unreported phase with 'pending'. A pass proven for one phase never spreads to another. */
export function summarizeM10(phases: Partial<Record<LifecyclePhase, ProbeResult>>): Record<LifecyclePhase, ProbeResult> {
  const summary = {} as Record<LifecyclePhase, ProbeResult>;
  for (const phase of LIFECYCLE_PHASES) {
    summary[phase] = phases[phase] ?? 'pending';
  }
  return summary;
}
