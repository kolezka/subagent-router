// M3-A evidence extractor + judge. Reads a native-claude-handler.ts probe run capture directory
// off disk, evaluates the channel-A (alternate-layout marker) claims it makes about itself, and
// produces a pending/failed/passed verdict that a human can hand to fixture-writer.ts. Nothing
// here reads or forwards the captured native context text itself -- only its measured boundaries
// (byte identity, the recognized-scaffold check, marker presence) and header/hook metadata.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { observedClaudeClientVersion } from '../../src/adapters/claude-code';
import { isNativeContextScaffoldV1, isNativeInstructionsBlockV2, parseMarker } from '../../src/adapters/markers';
import { loadCapabilityProfile } from '../../src/adapters/capabilities';
import { RouterError } from '../../src/core/errors';
import type { ClientId, ProbeResult } from '../../src/core/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readJsonFile(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  return JSON.parse(text);
}

// ---------- capture reading ----------

export interface CapturedHttpMessage {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: Record<string, unknown>;
}

export interface CapturedHookRecord {
  agent_id: string;
  agent_type: string;
  hook_event_name: string;
}

export interface CapturedPair {
  seq: number;
  agentId?: string;
  pre: CapturedHttpMessage;
  post: CapturedHttpMessage;
}

export interface RunCapture {
  runDir: string;
  profileRaw: Record<string, unknown>;
  // Present only when a sibling NNN-profile-scaffold.json exists next to the profile file.
  scaffoldOverriddenPaths?: readonly string[];
  clientVersionFile?: string;
  pairs: readonly CapturedPair[];
  hookAgentIds: ReadonlySet<string>;
}

function toHttpMessage(raw: Record<string, unknown>): CapturedHttpMessage {
  const url = typeof raw.url === 'string' ? raw.url : '';
  const headersRaw = isRecord(raw.headers) ? raw.headers : {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(headersRaw)) {
    if (typeof value === 'string') headers[key] = value;
  }
  const body = isRecord(raw.body) ? raw.body : {};
  return { url, headers, body };
}

const NUMBERED_FILE_RE = /^(\d+)-(.+)\.json$/;

/**
 * Reads a native-claude-handler.ts capture directory (runDir/capture/*) into a structured
 * RunCapture: the profile JSON, its optional scaffold-manifest sibling, the client-version file,
 * every NNN-pre-handler.json paired with its (NNN+1)-post-handler-upstream.json (a pair only
 * exists when both files are present AND their x-claude-code-agent-id headers are identical,
 * including both being absent), and the set of agent ids that have a SubagentStart hook record.
 */
export async function readRunCapture(runDir: string): Promise<RunCapture> {
  const captureDir = join(runDir, 'capture');
  let entries: string[];
  try {
    entries = await readdir(captureDir);
  } catch {
    throw new RouterError('m3a-capture-not-found', `no capture directory at ${captureDir}`);
  }
  const entrySet = new Set(entries);

  let profileSeq: number | undefined;
  let profileFile: string | undefined;
  const preBySeq = new Map<number, string>();
  const postBySeq = new Map<number, string>();
  const hookFiles: string[] = [];

  for (const entry of entries) {
    // Hook records are named hook-subagentstart-<pid>.json (no leading NNN- sequence number,
    // unlike every other capture file), so they must be matched before the numbered-file regex.
    if (entry.startsWith('hook-subagentstart-') && entry.endsWith('.json')) {
      hookFiles.push(entry);
      continue;
    }
    const match = NUMBERED_FILE_RE.exec(entry);
    if (match === null) continue;
    const seq = Number(match[1]);
    const kind = match[2] as string;
    if (kind === 'profile') {
      profileSeq = seq;
      profileFile = entry;
    } else if (kind === 'pre-handler') {
      preBySeq.set(seq, entry);
    } else if (kind === 'post-handler-upstream') {
      postBySeq.set(seq, entry);
    }
  }

  if (profileFile === undefined || profileSeq === undefined) {
    throw new RouterError('m3a-capture-missing-profile', `no NNN-profile.json in ${captureDir}`);
  }
  const profileRaw = await readJsonFile(join(captureDir, profileFile));
  if (!isRecord(profileRaw)) {
    throw new RouterError('m3a-capture-invalid-profile', `${profileFile} is not a JSON object`);
  }
  if (typeof profileRaw.client !== 'string' || typeof profileRaw.version !== 'string') {
    throw new RouterError('m3a-capture-invalid-profile', `${profileFile} is missing a string client/version`);
  }

  let scaffoldOverriddenPaths: readonly string[] | undefined;
  const scaffoldFile = `${String(profileSeq).padStart(3, '0')}-profile-scaffold.json`;
  if (entrySet.has(scaffoldFile)) {
    const scaffoldRaw = await readJsonFile(join(captureDir, scaffoldFile));
    if (!isRecord(scaffoldRaw) || !Array.isArray(scaffoldRaw.overriddenPaths) || !scaffoldRaw.overriddenPaths.every((p) => typeof p === 'string')) {
      throw new RouterError('m3a-capture-invalid-scaffold', `${scaffoldFile} is not a valid scaffold manifest ({ overriddenPaths: string[] })`);
    }
    scaffoldOverriddenPaths = scaffoldRaw.overriddenPaths as readonly string[];
  }

  let clientVersionFile: string | undefined;
  if (entrySet.has('client-version')) {
    clientVersionFile = (await readFile(join(captureDir, 'client-version'), 'utf8')).trim();
  }

  const pairs: CapturedPair[] = [];
  for (const [seq, preFile] of preBySeq) {
    const postFile = postBySeq.get(seq + 1);
    if (postFile === undefined) continue;
    const preRaw = await readJsonFile(join(captureDir, preFile));
    const postRaw = await readJsonFile(join(captureDir, postFile));
    if (!isRecord(preRaw) || !isRecord(postRaw)) continue;
    const pre = toHttpMessage(preRaw);
    const post = toHttpMessage(postRaw);
    const preAgentId = pre.headers['x-claude-code-agent-id'];
    const postAgentId = post.headers['x-claude-code-agent-id'];
    if (preAgentId !== postAgentId) continue;
    pairs.push({ seq, ...(preAgentId !== undefined ? { agentId: preAgentId } : {}), pre, post });
  }
  pairs.sort((a, b) => a.seq - b.seq);

  const hookAgentIds = new Set<string>();
  for (const file of hookFiles) {
    const raw = await readJsonFile(join(captureDir, file));
    if (isRecord(raw) && typeof raw.agent_id === 'string' && raw.hook_event_name === 'SubagentStart') {
      hookAgentIds.add(raw.agent_id);
    }
  }

  return {
    runDir,
    profileRaw,
    ...(scaffoldOverriddenPaths !== undefined ? { scaffoldOverriddenPaths } : {}),
    ...(clientVersionFile !== undefined ? { clientVersionFile } : {}),
    pairs,
    hookAgentIds,
  };
}

// ---------- per-pair evidence ----------

export interface M3APairEvidence {
  seq: number;
  agentId?: string;
  block0ByteIdentical: boolean;
  block0MatchesScaffold: boolean;
  markerOnBlock1Line1: boolean;
  markerStrippedUpstream: boolean;
  versionMatchesProfile: boolean;
  agentIdMatchesHook: boolean;
}

function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  return isRecord(block) && block.type === 'text' && typeof block.text === 'string';
}

function firstUserMessage(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (isRecord(message) && message.role === 'user') return message;
  }
  return undefined;
}

// Which measured envelope the run's own profile declares. An unknown or missing value keeps the
// v1 rules, exactly as this extractor behaved before it was layout-aware.
type M3ALayout = 'v1' | 'v2';

function layoutOfProfile(profileRaw: Record<string, unknown>): M3ALayout {
  return profileRaw.parentPromptPosition === 'after-native-context-v2' ? 'v2' : 'v1';
}

function expectedBlockCount(layout: M3ALayout): number {
  return layout === 'v2' ? 3 : 2;
}

// Splits the first user message into the client-owned prefix blocks and the parent's delegation
// prompt, for the DECLARED layout only: v1 is exactly two text blocks [context scaffold, prompt],
// v2 exactly three [operator instructions, context scaffold, prompt]. undefined means the message
// does not carry that envelope at all (missing message, wrong block count, a non-text block) --
// which is an absence of the claim, not evidence against it, and is reported separately as a
// layout mismatch rather than folded into the per-pair booleans.
function layoutBlocks(message: Record<string, unknown> | undefined, layout: M3ALayout): { prefix: string[]; payload: string } | undefined {
  if (message === undefined) return undefined;
  const content = message.content;
  const expected = expectedBlockCount(layout);
  if (!Array.isArray(content) || content.length !== expected) return undefined;
  if (!content.every((block) => isTextBlock(block))) return undefined;
  const texts = (content as Array<{ text: string }>).map((block) => block.text);
  return { prefix: texts.slice(0, expected - 1), payload: texts[expected - 1] as string };
}

function pairCarriesLayoutEnvelope(pair: CapturedPair, layout: M3ALayout): boolean {
  return layoutBlocks(firstUserMessage(pair.pre.body), layout) !== undefined && layoutBlocks(firstUserMessage(pair.post.body), layout) !== undefined;
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx === -1 ? text : text.slice(0, idx);
}

function stripFirstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx === -1 ? '' : text.slice(idx + 1);
}

// The six booleans keep their v1 names under both layouts, but two of them widen under v2:
// `block0ByteIdentical` means blocks 0 AND 1 (every client-owned prefix block) survived byte for
// byte, and `block0MatchesScaffold` means block 0 matches the operator-instructions grammar AND
// block 1 matches the context-scaffold grammar. `markerOnBlock1Line1` and
// `markerStrippedUpstream` read the delegation prompt, which is block 1 under v1 and block 2
// under v2.
function evaluatePair(pair: CapturedPair, profileVersion: string, hookAgentIds: ReadonlySet<string>, layout: M3ALayout): M3APairEvidence {
  const pre = layoutBlocks(firstUserMessage(pair.pre.body), layout);
  const post = layoutBlocks(firstUserMessage(pair.post.body), layout);

  const block0ByteIdentical =
    pre !== undefined && post !== undefined && pre.prefix.length === post.prefix.length && pre.prefix.every((text, i) => text === post.prefix[i]);
  const block0MatchesScaffold =
    pre !== undefined &&
    (layout === 'v2'
      ? isNativeInstructionsBlockV2(pre.prefix[0] as string) && isNativeContextScaffoldV1(pre.prefix[1] as string)
      : isNativeContextScaffoldV1(pre.prefix[0] as string));

  const parsedPreMarker = pre !== undefined ? parseMarker(firstLine(pre.payload)) : null;
  const markerOnBlock1Line1 = parsedPreMarker !== null && parsedPreMarker !== 'invalid' && parsedPreMarker.kind === 'parent';

  let markerStrippedUpstream = false;
  if (pre !== undefined && post !== undefined) {
    const postParsed = parseMarker(firstLine(post.payload));
    const noMarkerLeft = postParsed === null;
    const restMatches = post.payload === stripFirstLine(pre.payload);
    markerStrippedUpstream = noMarkerLeft && restMatches;
  }

  const headerVersion = observedClaudeClientVersion(new Headers(pair.pre.headers));
  const versionMatchesProfile = headerVersion !== undefined && headerVersion === profileVersion;

  const agentIdMatchesHook = pair.agentId !== undefined && hookAgentIds.has(pair.agentId);

  return {
    seq: pair.seq,
    ...(pair.agentId !== undefined ? { agentId: pair.agentId } : {}),
    block0ByteIdentical,
    block0MatchesScaffold,
    markerOnBlock1Line1,
    markerStrippedUpstream,
    versionMatchesProfile,
    agentIdMatchesHook,
  };
}

// ---------- scaffold-manifest diff ----------

// Flattens a JSON-ish object into dotted leaf paths. Arrays are compared as one leaf value
// (never descended into): the only array-shaped field either side carries is `diagnostics`, and
// it is never expected to be part of a legitimate scaffold override.
function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (isRecord(value) && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix === '' ? key : `${prefix}.${key}`, out);
    }
  } else {
    out.set(prefix, value);
  }
}

// Compares only the leaf paths the CAPTURED profile itself declares (i.e. keys it actually has).
// A real-fixture key the captured profile never mentions at all (e.g. probes.M1 when the trial
// profile only ever set probes.M10 and probes['M3-A']) is not a claim the captured profile makes
// and is not counted as a divergence -- the scaffold's job is to declare what it OVERRODE, not to
// re-assert every field the real fixture happens to also carry.
export function diffCapturedAgainstReal(captured: Record<string, unknown>, real: Record<string, unknown>): string[] {
  const capturedFlat = new Map<string, unknown>();
  flatten(captured, '', capturedFlat);
  const realFlat = new Map<string, unknown>();
  flatten(real, '', realFlat);

  const diverged: string[] = [];
  for (const [path, value] of capturedFlat) {
    if (path === 'client' || path === 'version') continue; // never a declarable override; checked separately by construction below.
    // Provenance only: the writer appends a diagnostics line per narrowed key, so a run captured
    // before a later narrowing legitimately carries a shorter list. It states no capability.
    if (path === 'diagnostics') continue;
    if (JSON.stringify(value) !== JSON.stringify(realFlat.get(path))) diverged.push(path);
  }
  return diverged;
}

function pathIsDeclared(path: string, declared: ReadonlySet<string>): boolean {
  if (declared.has(path)) return true;
  for (const entry of declared) {
    if (entry.endsWith('.*') && path.startsWith(entry.slice(0, -1))) return true;
  }
  return false;
}

const CLIENT_IDS: readonly ClientId[] = ['claude-code', 'opencode', 'codex'];
function isClientId(value: unknown): value is ClientId {
  return typeof value === 'string' && (CLIENT_IDS as readonly string[]).includes(value);
}

// ---------- extraction + judge ----------

export interface M3AExtraction {
  pairs: readonly M3APairEvidence[];
  // True only when: the captured profile's version is not the measurement-only
  // 'synthetic-hermetic' sentinel, a scaffold manifest is present, loading the real fixture for
  // this (client, version) succeeded, and every path the captured profile diverges on from that
  // real fixture is covered by the manifest's declared paths (wildcards like "lifecycle.*"
  // allowed). client and version themselves are never a declarable override: they are what
  // selects the real fixture in the first place, so a mismatch there fails the fixture load
  // itself rather than showing up as an undeclared-divergence diagnostic.
  scaffoldDeclared: boolean;
  // The envelope the profile's declared layout requires (v1: exactly two text blocks; v2: exactly
  // three) was present in every child pair, on both sides of the pair. False means this run does
  // not carry the shape the profile claims at all -- a v2 capture judged with a v1 profile, or the
  // reverse -- so nothing about that claim was measured here: 'pending', never 'failed'.
  layoutEnvelopeMatched: boolean;
  profileVersion: string;
  diagnostics: readonly string[];
}

const SYNTHETIC_HERMETIC_VERSION = 'synthetic-hermetic';

export async function extractM3AEvidence(capture: RunCapture, fixturesDir: string): Promise<M3AExtraction> {
  const diagnostics: string[] = [];
  const profileClient = capture.profileRaw.client; // validated string by readRunCapture
  const profileVersion = capture.profileRaw.version as string;

  const layout = layoutOfProfile(capture.profileRaw);
  const childPairs = capture.pairs.filter((pair) => pair.agentId !== undefined);
  const pairs = childPairs.map((pair) => evaluatePair(pair, profileVersion, capture.hookAgentIds, layout));
  if (childPairs.length === 0) {
    diagnostics.push('m3a-no-child-pairs: no channel-A child request/response pairs (a pre/post pair whose x-claude-code-agent-id header is present) found in this run capture');
  }

  const mismatched = childPairs.filter((pair) => !pairCarriesLayoutEnvelope(pair, layout));
  const layoutEnvelopeMatched = mismatched.length === 0;
  if (mismatched.length > 0) {
    diagnostics.push(
      `m3a-layout-envelope-mismatch: ${mismatched.length} of ${childPairs.length} child pairs do not carry the ${expectedBlockCount(layout)}-text-block envelope required by the layout this profile declares (${JSON.stringify(capture.profileRaw.parentPromptPosition)}); this run measures nothing about that layout's claim`,
    );
  }

  let scaffoldDeclared = false;

  if (profileVersion === SYNTHETIC_HERMETIC_VERSION) {
    diagnostics.push(
      "m3a-synthetic-hermetic-rejected: captured profile version is 'synthetic-hermetic', the measurement-only fixture native-claude-handler.ts's SYNTHETIC_PROFILE uses to run the handler trial at all; it is never a real capability measurement and can never certify M3-A",
    );
  } else if (capture.scaffoldOverriddenPaths === undefined) {
    diagnostics.push(
      `m3a-scaffold-manifest-missing: no NNN-profile-scaffold.json declaring which fields the captured profile overrode relative to the real ${String(profileClient)}-${profileVersion}.json fixture`,
    );
  } else if (!isClientId(profileClient)) {
    diagnostics.push(`m3a-invalid-client: captured profile client ${JSON.stringify(profileClient)} is not a recognized client id`);
  } else {
    try {
      const realFixture = await loadCapabilityProfile(profileClient, profileVersion, fixturesDir);
      const diverged = diffCapturedAgainstReal(capture.profileRaw, realFixture as unknown as Record<string, unknown>);
      const declared = new Set(capture.scaffoldOverriddenPaths);
      const undeclared = diverged.filter((path) => !pathIsDeclared(path, declared));
      if (undeclared.length > 0) {
        diagnostics.push(`m3a-undeclared-divergence: ${undeclared.join(', ')} differ from the real fixture but are not declared in the scaffold manifest`);
      } else {
        scaffoldDeclared = true;
      }
    } catch (error) {
      diagnostics.push(`m3a-real-fixture-load-failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { pairs, scaffoldDeclared, layoutEnvelopeMatched, profileVersion, diagnostics };
}

/**
 * Judges M3-A from extracted evidence. Order matters: no child pairs is always 'pending'
 * (nothing was measured), regardless of scaffold state; an undeclared or missing scaffold is
 * always 'pending' (the trial cannot be trusted as evidence, but nothing has been proven false
 * either); a capture that does not carry the declared layout's envelope at all is likewise always
 * 'pending' (the run measured a different shape than the profile claims, which falsifies nothing);
 * only once all three of those clear does any pair boolean get to determine 'failed' vs 'passed'.
 * Aggregate counts (pair counts, diagnostics counts) never by themselves produce 'passed' -- only
 * per-pair booleans, ANDed together, do.
 */
export function judgeM3A(evidence: M3AExtraction): ProbeResult {
  if (evidence.pairs.length === 0) return 'pending';
  if (!evidence.scaffoldDeclared) return 'pending';
  if (!evidence.layoutEnvelopeMatched) return 'pending';
  const allTrue = evidence.pairs.every(
    (pair) =>
      pair.block0ByteIdentical &&
      pair.block0MatchesScaffold &&
      pair.markerOnBlock1Line1 &&
      pair.markerStrippedUpstream &&
      pair.versionMatchesProfile &&
      pair.agentIdMatchesHook,
  );
  return allTrue ? 'passed' : 'failed';
}
