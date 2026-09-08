import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RouterError } from '../core/errors';
import type {
  CapabilityGate,
  CapabilityProfile,
  ClientId,
  LifecyclePhase,
  ProbeResult,
  TransportCapabilityProfile,
  TrustedLifecycleContext,
} from '../core/types';

const REQUIRED_LIFECYCLE_PHASES: readonly LifecyclePhase[] = ['next-turn', 'resume', 'compaction', 'nested', 'parallel'];

const PENDING_LIFECYCLE: CapabilityProfile['lifecycle'] = {
  'next-turn': 'pending',
  resume: 'pending',
  compaction: 'pending',
  nested: 'pending',
  parallel: 'pending',
};

// Which client a gate applies to. A profile for a different client always fails the gate,
// regardless of what its probes say.
const GATE_CLIENT: Readonly<Record<CapabilityGate, ClientId>> = {
  'claude-marker': 'claude-code',
  'claude-correlation': 'claude-code',
  'claude-fork': 'claude-code',
  'opencode-native-runtime': 'opencode',
  'codex-native-runtime': 'codex',
  'codex-explicit-over-role': 'codex',
};

function lifecycleSatisfied(profile: CapabilityProfile, context: TrustedLifecycleContext): boolean {
  if (context.lifecyclePhase !== undefined) {
    return profile.lifecycle[context.lifecyclePhase] === 'passed';
  }
  // Phase unknown: only a profile with every lifecycle phase proven lets the path through.
  return REQUIRED_LIFECYCLE_PHASES.every((phase) => profile.lifecycle[phase] === 'passed');
}

// The bar each gate must clear beyond client + status + lifecycle. This is only the shared M-probe
// gate; channel B/B2 marker-source, HMAC and freshness-receipt checks are per-request and live in
// the Task 9 handler, which has access to data assertCapability never receives.
function gateProbesSatisfied(profile: CapabilityProfile, gate: CapabilityGate): boolean {
  const passed = (name: string): boolean => profile.probes[name] === 'passed';
  switch (gate) {
    case 'claude-marker':
      return passed('M10');
    case 'claude-correlation':
      return passed('M1') && profile.correlation === true && profile.correlationEntropy === 'passed';
    case 'claude-fork':
      return passed('M4') && profile.fork === true;
    case 'opencode-native-runtime':
      return passed('M6') && passed('M6-runtime') && passed('M10');
    case 'codex-native-runtime':
      return passed('M7') && passed('M10');
    case 'codex-explicit-over-role':
      return passed('M9');
  }
}

export function assertCapability(profile: CapabilityProfile, gate: CapabilityGate, context: TrustedLifecycleContext): void {
  if (profile.client !== GATE_CLIENT[gate]) {
    throw new RouterError('unsupported-path', `gate ${gate} does not apply to client ${profile.client}`);
  }
  if (profile.status !== 'supported') {
    throw new RouterError('unsupported-path', `capability profile ${profile.client} ${profile.version} is ${profile.status}, not supported`);
  }
  if (!lifecycleSatisfied(profile, context)) {
    throw new RouterError('unsupported-path', `lifecycle phase not proven passed for ${profile.client} ${profile.version}`);
  }
  if (!gateProbesSatisfied(profile, gate)) {
    throw new RouterError('unsupported-path', `gate ${gate} probes not passed for ${profile.client} ${profile.version}`);
  }
}

// Fixture identifiers are interpolated into a filesystem path. Rejecting anything but a plain
// token up front means a hostile or malformed version/adapterId string can never influence which
// file gets opened, on top of node:path's own join() normalization.
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(value) || value.includes('..')) {
    throw new RouterError('capability-invalid-identifier', `${label} is not a valid identifier`);
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

type ReadFixtureResult = { found: true; value: unknown } | { found: false };

/**
 * Reads and JSON-parses a fixture file, distinguishing "file does not exist" (ENOENT, the only
 * case callers may treat as absence) from every other failure (permission errors, a directory
 * where a file was expected, malformed JSON), which are surfaced as an explicit RouterError
 * instead of silently collapsing into "not found". Error messages are redacted to the fixture's
 * own name, never the fixturesDir's absolute filesystem path.
 */
async function readFixtureFile(path: string, fixtureName: string): Promise<ReadFixtureResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return { found: false };
    throw new RouterError('capability-fixture-read-failed', `failed to read capability fixture ${fixtureName}`);
  }
  try {
    return { found: true, value: JSON.parse(text) };
  } catch {
    throw new RouterError('capability-fixture-invalid-json', `capability fixture ${fixtureName} is not valid JSON`);
  }
}

const PROBE_RESULTS: readonly ProbeResult[] = ['passed', 'failed', 'pending'];
const PROFILE_STATUSES: readonly CapabilityProfile['status'][] = ['pending', 'supported', 'unsupported'];
const MARKER_POSITIONS: readonly CapabilityProfile['adapterMarkerPosition'][] = ['system', 'first-user', 'b2', 'unknown'];

function isProbeResult(value: unknown): value is ProbeResult {
  return typeof value === 'string' && (PROBE_RESULTS as readonly string[]).includes(value);
}

function schemaError(fixtureName: string, detail: string): RouterError {
  return new RouterError('capability-fixture-invalid-schema', `capability fixture ${fixtureName}: ${detail}`);
}

/**
 * Validates an untyped parsed JSON value against the CapabilityProfile shape and confirms its
 * declared client/version match what was requested. A schema violation or an identity mismatch
 * (fixture at claude-code-2.1.263.json actually declaring a different client or version) is a
 * data-integrity bug and must be a loud, explicit error, never silently accepted via `as
 * CapabilityProfile` or mistaken for a missing fixture.
 */
function validateCapabilityProfile(value: unknown, client: ClientId, version: string, fixtureName: string): CapabilityProfile {
  if (typeof value !== 'object' || value === null) {
    throw schemaError(fixtureName, 'not an object');
  }
  const record = value as Record<string, unknown>;

  if (record.client !== client) {
    throw schemaError(fixtureName, `declares client ${JSON.stringify(record.client)}, expected ${client}`);
  }
  if (record.version !== version) {
    throw schemaError(fixtureName, `declares version ${JSON.stringify(record.version)}, expected ${version}`);
  }
  if (typeof record.status !== 'string' || !PROFILE_STATUSES.includes(record.status as CapabilityProfile['status'])) {
    throw schemaError(fixtureName, 'status is missing or invalid');
  }
  if (typeof record.correlation !== 'boolean') {
    throw schemaError(fixtureName, 'correlation must be a boolean');
  }
  if (!isProbeResult(record.correlationEntropy)) {
    throw schemaError(fixtureName, 'correlationEntropy is missing or invalid');
  }
  if (typeof record.fork !== 'boolean') {
    throw schemaError(fixtureName, 'fork must be a boolean');
  }
  if (typeof record.adapterMarkerPosition !== 'string' || !MARKER_POSITIONS.includes(record.adapterMarkerPosition as CapabilityProfile['adapterMarkerPosition'])) {
    throw schemaError(fixtureName, 'adapterMarkerPosition is missing or invalid');
  }
  if (typeof record.probes !== 'object' || record.probes === null) {
    throw schemaError(fixtureName, 'probes is missing or not an object');
  }
  const probesRecord = record.probes as Record<string, unknown>;
  const probes: Record<string, ProbeResult> = {};
  for (const [probeName, probeValue] of Object.entries(probesRecord)) {
    if (!isProbeResult(probeValue)) {
      throw schemaError(fixtureName, `probe ${probeName} has invalid result ${JSON.stringify(probeValue)}`);
    }
    probes[probeName] = probeValue;
  }
  if (typeof record.lifecycle !== 'object' || record.lifecycle === null) {
    throw schemaError(fixtureName, 'lifecycle is missing or not an object');
  }
  const lifecycleRecord = record.lifecycle as Record<string, unknown>;
  const lifecycle = {} as Record<LifecyclePhase, ProbeResult>;
  for (const phase of REQUIRED_LIFECYCLE_PHASES) {
    const phaseValue = lifecycleRecord[phase];
    if (!isProbeResult(phaseValue)) {
      throw schemaError(fixtureName, `lifecycle phase ${phase} is missing or invalid`);
    }
    lifecycle[phase] = phaseValue;
  }
  let diagnostics: readonly string[] | undefined;
  if (record.diagnostics !== undefined) {
    if (!Array.isArray(record.diagnostics) || !record.diagnostics.every((entry) => typeof entry === 'string')) {
      throw schemaError(fixtureName, 'diagnostics must be an array of strings');
    }
    diagnostics = record.diagnostics as readonly string[];
  }

  return {
    client,
    version,
    status: record.status as CapabilityProfile['status'],
    correlation: record.correlation,
    correlationEntropy: record.correlationEntropy,
    fork: record.fork,
    adapterMarkerPosition: record.adapterMarkerPosition as CapabilityProfile['adapterMarkerPosition'],
    probes,
    lifecycle,
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  };
}

/**
 * Validates an untyped parsed JSON value against the TransportCapabilityProfile shape and confirms
 * its declared adapterId/runtimeVersion match what was requested, for the same reason as
 * validateCapabilityProfile above.
 */
function validateTransportCapabilityProfile(value: unknown, adapterId: string, runtimeVersion: string, fixtureName: string): TransportCapabilityProfile {
  if (typeof value !== 'object' || value === null) {
    throw schemaError(fixtureName, 'not an object');
  }
  const record = value as Record<string, unknown>;

  if (record.adapterId !== adapterId) {
    throw schemaError(fixtureName, `declares adapterId ${JSON.stringify(record.adapterId)}, expected ${adapterId}`);
  }
  if (record.runtimeVersion !== runtimeVersion) {
    throw schemaError(fixtureName, `declares runtimeVersion ${JSON.stringify(record.runtimeVersion)}, expected ${runtimeVersion}`);
  }
  if (!isProbeResult(record.status)) {
    throw schemaError(fixtureName, 'status is missing or invalid');
  }
  if (!isProbeResult(record.gzipBytes)) {
    throw schemaError(fixtureName, 'gzipBytes is missing or invalid');
  }
  if (!isProbeResult(record.responseHeaders)) {
    throw schemaError(fixtureName, 'responseHeaders is missing or invalid');
  }

  return {
    adapterId,
    runtimeVersion,
    status: record.status,
    gzipBytes: record.gzipBytes,
    responseHeaders: record.responseHeaders,
  };
}

function parseVersionParts(version: string): number[] | undefined {
  const parts = version.split('.');
  if (parts.length === 0) return undefined;
  const numeric = parts.map((part) => Number(part));
  if (numeric.some((part) => !Number.isInteger(part) || part < 0)) return undefined;
  return numeric;
}

function compareVersionParts(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function highestKnownVersion(client: ClientId, fixturesDir: string): Promise<number[] | undefined> {
  let entries: string[];
  try {
    entries = await readdir(fixturesDir);
  } catch {
    return undefined;
  }
  const prefix = `${client}-`;
  let highest: number[] | undefined;
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.json')) continue;
    const version = entry.slice(prefix.length, -'.json'.length);
    const parts = parseVersionParts(version);
    if (parts === undefined) continue;
    if (highest === undefined || compareVersionParts(parts, highest) > 0) highest = parts;
  }
  return highest;
}

/**
 * Reads a capability profile fixture literally by `<client>-<version>.json`, validating its shape
 * and its declared client/version identity. A version that matches no fixture but is numerically
 * newer than every known fixture for this client gets a synthetic pending profile (unmeasured, not
 * a pass) instead of inheriting anything from an older version. A version that is not newer than
 * the known baseline, or that does not parse as a version at all, is unknown and fails closed.
 */
export async function loadCapabilityProfile(client: ClientId, version: string, fixturesDir: string): Promise<CapabilityProfile> {
  assertSafeIdentifier(version, 'version');

  const fixtureName = `${client}-${version}.json`;
  const result = await readFixtureFile(join(fixturesDir, fixtureName), fixtureName);
  if (result.found) return validateCapabilityProfile(result.value, client, version, fixtureName);

  const requestedParts = parseVersionParts(version);
  const highest = requestedParts === undefined ? undefined : await highestKnownVersion(client, fixturesDir);
  if (requestedParts === undefined || highest === undefined || compareVersionParts(requestedParts, highest) <= 0) {
    throw new RouterError('capability-unknown-version', `no capability fixture for ${client} ${version}`);
  }

  return {
    client,
    version,
    status: 'pending',
    correlation: false,
    correlationEntropy: 'pending',
    fork: false,
    adapterMarkerPosition: 'unknown',
    diagnostics: ['capability-newer-version-unmeasured'],
    probes: {},
    lifecycle: PENDING_LIFECYCLE,
  };
}

/**
 * Reads the transport capability profile for one exact (adapter, runtime version) pair, validating
 * its shape and declared identity. There is no newer-version grace period here: a missing or
 * mismatched pair fails closed rather than assuming pass-through behavior.
 */
export async function loadTransportCapabilityProfile(adapterId: string, runtimeVersion: string, fixturesDir: string): Promise<TransportCapabilityProfile> {
  assertSafeIdentifier(adapterId, 'adapterId');
  assertSafeIdentifier(runtimeVersion, 'runtimeVersion');

  const fixtureName = `transport-${adapterId}-${runtimeVersion}.json`;
  const result = await readFixtureFile(join(fixturesDir, fixtureName), fixtureName);
  if (!result.found) {
    throw new RouterError('capability-unknown-version', `no transport capability fixture for ${adapterId} ${runtimeVersion}`);
  }
  return validateTransportCapabilityProfile(result.value, adapterId, runtimeVersion, fixtureName);
}
