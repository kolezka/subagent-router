// M3-A evidence extractor + judge. Reads a native-claude-handler.ts probe run capture directory
// off disk, evaluates the channel-A (alternate-layout marker) claims it makes about itself, and
// produces a pending/failed/passed verdict that a human can hand to fixture-writer.ts. Nothing
// here reads or forwards the captured native context text itself -- only its measured boundaries
// (byte identity, the recognized-scaffold check, marker presence) and header/hook metadata.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { observedClaudeClientVersion } from '../../src/adapters/claude-code';
import { isNativeContextScaffoldV1, parseMarker } from '../../src/adapters/markers';
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

// Exactly the measured two-text-block envelope: block 0 the native context, block 1 the
// delegation prompt. Anything else (missing message, wrong block count, non-text blocks) means
// this pair simply does not carry the alternate-layout shape and every boolean below is false.
function twoTextBlocks(message: Record<string, unknown> | undefined): [string, string] | undefined {
  if (message === undefined) return undefined;
  const content = message.content;
  if (!Array.isArray(content) || content.length !== 2) return undefined;
  const [first, second] = content;
  if (!isTextBlock(first) || !isTextBlock(second)) return undefined;
  return [first.text, second.text];
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx === -1 ? text : text.slice(0, idx);
}

function stripFirstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx === -1 ? '' : text.slice(idx + 1);
}

function evaluatePair(pair: CapturedPair, profileVersion: string, hookAgentIds: ReadonlySet<string>): M3APairEvidence {
  const preBlocks = twoTextBlocks(firstUserMessage(pair.pre.body));
  const postBlocks = twoTextBlocks(firstUserMessage(pair.post.body));

  const block0ByteIdentical = preBlocks !== undefined && postBlocks !== undefined && preBlocks[0] === postBlocks[0];
  const block0MatchesScaffold = preBlocks !== undefined && isNativeContextScaffoldV1(preBlocks[0]);

  const parsedPreMarker = preBlocks !== undefined ? parseMarker(firstLine(preBlocks[1])) : null;
  const markerOnBlock1Line1 = parsedPreMarker !== null && parsedPreMarker !== 'invalid' && parsedPreMarker.kind === 'parent';

  let markerStrippedUpstream = false;
  if (preBlocks !== undefined && postBlocks !== undefined) {
    const postParsed = parseMarker(firstLine(postBlocks[1]));
    const noMarkerLeft = postParsed === null;
    const restMatches = postBlocks[1] === stripFirstLine(preBlocks[1]);
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
function diffCapturedAgainstReal(captured: Record<string, unknown>, real: Record<string, unknown>): string[] {
  const capturedFlat = new Map<string, unknown>();
  flatten(captured, '', capturedFlat);
  const realFlat = new Map<string, unknown>();
  flatten(real, '', realFlat);

  const diverged: string[] = [];
  for (const [path, value] of capturedFlat) {
    if (path === 'client' || path === 'version') continue; // never a declarable override; checked separately by construction below.
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
  profileVersion: string;
  diagnostics: readonly string[];
}

const SYNTHETIC_HERMETIC_VERSION = 'synthetic-hermetic';

export async function extractM3AEvidence(capture: RunCapture, fixturesDir: string): Promise<M3AExtraction> {
  const diagnostics: string[] = [];
  const profileClient = capture.profileRaw.client; // validated string by readRunCapture
  const profileVersion = capture.profileRaw.version as string;

  const childPairs = capture.pairs.filter((pair) => pair.agentId !== undefined);
  const pairs = childPairs.map((pair) => evaluatePair(pair, profileVersion, capture.hookAgentIds));
  if (childPairs.length === 0) {
    diagnostics.push('m3a-no-child-pairs: no channel-A child request/response pairs (a pre/post pair whose x-claude-code-agent-id header is present) found in this run capture');
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

  return { pairs, scaffoldDeclared, profileVersion, diagnostics };
}

/**
 * Judges M3-A from extracted evidence. Order matters: no child pairs is always 'pending'
 * (nothing was measured), regardless of scaffold state; an undeclared or missing scaffold is
 * always 'pending' (the trial cannot be trusted as evidence, but nothing has been proven false
 * either); only once both of those clear does any pair boolean get to determine 'failed' vs
 * 'passed'. Aggregate counts (pair counts, diagnostics counts) never by themselves produce
 * 'passed' -- only per-pair booleans, ANDed together, do.
 */
export function judgeM3A(evidence: M3AExtraction): ProbeResult {
  if (evidence.pairs.length === 0) return 'pending';
  if (!evidence.scaffoldDeclared) return 'pending';
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
