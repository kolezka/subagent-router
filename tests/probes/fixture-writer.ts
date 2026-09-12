// Narrows a capability fixture's probe/lifecycle keys from 'pending' toward a measured judged
// result, from a real M3-A probe run. Never writes anything else: not headers, not prompts, not
// context, not auth-shaped fields, not any fixture key outside probes/lifecycle/diagnostics.
// Refuses outright when the run's scaffold overrides were not declared (see evidence-m3a.ts),
// so an unproven or synthetic trial can never narrow a fixture toward 'passed'.
import { open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RouterError } from '../../src/core/errors';
import { runWithCleanup } from '../../src/io/cleanup';
import type { ClientId, LifecyclePhase, ProbeResult } from '../../src/core/types';

const PROBE_RESULTS: readonly ProbeResult[] = ['passed', 'failed', 'pending'];
function isProbeResult(value: unknown): value is ProbeResult {
  return typeof value === 'string' && (PROBE_RESULTS as readonly string[]).includes(value);
}

export interface JudgedFixtureUpdate {
  // Identifies the probe run this narrowing came from, folded into the appended diagnostics
  // string so a fixture's provenance stays traceable.
  runId: string;
  // Must be true (evidence-m3a.ts's extractM3AEvidence output) or the write is refused outright.
  scaffoldDeclared: boolean;
  // The dotted profile paths the run declared it scaffolded (extractM3AEvidence's
  // declaredScaffoldPaths). Only consulted by the correlation-gate guard below; a run that
  // supplies nothing here is treated as having scaffolded no correlation path.
  scaffoldedPaths?: readonly string[];
  probes?: Readonly<Record<string, ProbeResult>>;
  lifecycle?: Readonly<Partial<Record<LifecyclePhase, ProbeResult>>>;
}

const JUDGED_ALLOWED_KEYS = new Set<string>(['runId', 'scaffoldDeclared', 'scaffoldedPaths', 'probes', 'lifecycle']);

// The three profile fields that together open the router's correlation channel
// (src/adapters/capabilities.ts's claude-correlation gate). A run that scaffolded any of them
// routed its children through correlation, which the real fixture does not claim.
const CORRELATION_GATE_PATHS = new Set<string>(['probes.M1', 'correlation', 'correlationEntropy']);

// judged arrives typed, but a caller can still smuggle an extra field past the type checker (a
// spread from a larger, less-trusted object). This is the runtime backstop: any key outside the
// allowed set is refused before anything is read or written, so a foreign field (headers,
// context, prompt text) can never reach the fixture file even indirectly.
function assertNoForeignKeys(judged: Record<string, unknown>): void {
  for (const key of Object.keys(judged)) {
    if (!JUDGED_ALLOWED_KEYS.has(key)) {
      throw new RouterError('fixture-writer-forbidden-key', `refusing to write judged.${key}: only runId, scaffoldDeclared, scaffoldedPaths, probes and lifecycle may be supplied`);
    }
  }
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function assertSafeIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(value) || value.includes('..')) {
    throw new RouterError('fixture-writer-invalid-identifier', `${label} is not a valid identifier`);
  }
}

// Creates `temp` exclusively and writes `payload` into it, same split-from-rename shape as
// src/io/store.ts's writeTempPayload: a failure between create and a complete write leaves the
// half-written file at `temp`, not at the real fixture path.
async function writeTempPayload(temp: string, payload: string): Promise<void> {
  const handle = await open(temp, 'wx');
  try {
    await handle.writeFile(payload);
  } finally {
    await handle.close();
  }
}

export interface WriteCapabilityFixtureOptions {
  now?: () => Date;
  // Test seam only: replaces the temp-file write to simulate a failure after the file exists.
  writePayload?: (temp: string, payload: string) => Promise<void>;
}

/**
 * Narrows exactly the probe keys present in judged.probes and the lifecycle keys present in
 * judged.lifecycle on `<client>-<version>.json`, appends one diagnostics line per narrowed key
 * (`measured:<probe>=<result>;run=<runId>;at=<ISO date>`, or `measured:lifecycle.<phase>=...` for
 * a lifecycle phase), and writes atomically via a temp file + rename. Every other field on the
 * fixture -- status, client, version, correlation, adapterMarkerPosition, every probe/lifecycle
 * key not named in `judged` -- is carried over byte-for-byte unchanged.
 */
export async function writeCapabilityFixture(
  client: ClientId,
  version: string,
  judged: JudgedFixtureUpdate,
  fixturesDir: string,
  options: WriteCapabilityFixtureOptions = {},
): Promise<void> {
  assertSafeIdentifier(version, 'version');
  assertNoForeignKeys(judged as unknown as Record<string, unknown>);

  if (judged.scaffoldDeclared !== true) {
    throw new RouterError(
      'fixture-writer-scaffold-not-declared',
      'refusing to narrow a capability fixture from a run whose scaffold overrides were not declared (judged.scaffoldDeclared !== true)',
    );
  }

  const probeKeys = Object.keys(judged.probes ?? {});
  for (const key of probeKeys) {
    const result = judged.probes?.[key];
    if (!isProbeResult(result)) {
      throw new RouterError('fixture-writer-invalid-probe-result', `judged.probes.${key} is not a valid ProbeResult`);
    }
  }
  const lifecycleKeys = Object.keys(judged.lifecycle ?? {});
  for (const key of lifecycleKeys) {
    const result = judged.lifecycle?.[key as LifecyclePhase];
    if (!isProbeResult(result)) {
      throw new RouterError('fixture-writer-invalid-lifecycle-result', `judged.lifecycle.${key} is not a valid ProbeResult`);
    }
  }
  if (probeKeys.length === 0 && lifecycleKeys.length === 0) {
    throw new RouterError('fixture-writer-nothing-to-write', 'judged.probes and judged.lifecycle are both empty; nothing to narrow');
  }

  // A scaffolded correlation gate changes routing itself: the child that survived the phase was
  // carried by correlation, not by what this fixture describes, so the pass is conditional on M1
  // and may never land on disk. 'failed' and 'pending' still may, since a phase that broke even
  // with correlation open broke for real.
  const scaffoldedCorrelationPaths = (judged.scaffoldedPaths ?? []).filter((path) => CORRELATION_GATE_PATHS.has(path));
  if (scaffoldedCorrelationPaths.length > 0) {
    const passedPhases = lifecycleKeys.filter((key) => judged.lifecycle?.[key as LifecyclePhase] === 'passed');
    if (passedPhases.length > 0) {
      throw new RouterError(
        'fixture-writer-correlation-scaffold',
        `refusing to narrow lifecycle ${passedPhases.join(', ')} to passed: this run scaffolded ${scaffoldedCorrelationPaths.join(', ')}, so the pass is conditional on M1`,
      );
    }
  }

  const fixtureName = `${client}-${version}.json`;
  const fixturePath = join(fixturesDir, fixtureName);

  let originalText: string;
  try {
    originalText = await readFile(fixturePath, 'utf8');
  } catch (error) {
    throw new RouterError('fixture-writer-fixture-read-failed', `failed to read ${fixtureName}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(originalText);
  } catch {
    throw new RouterError('fixture-writer-fixture-invalid-json', `${fixtureName} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RouterError('fixture-writer-fixture-invalid-json', `${fixtureName} does not parse to an object`);
  }
  const fixture = parsed as Record<string, unknown>;

  const currentProbes = (fixture.probes as Record<string, ProbeResult> | undefined) ?? {};
  const nextProbes: Record<string, ProbeResult> = { ...currentProbes };
  for (const key of probeKeys) {
    nextProbes[key] = judged.probes?.[key] as ProbeResult;
  }

  const currentLifecycle = (fixture.lifecycle as Record<string, ProbeResult> | undefined) ?? {};
  const nextLifecycle: Record<string, ProbeResult> = { ...currentLifecycle };
  for (const key of lifecycleKeys) {
    nextLifecycle[key] = judged.lifecycle?.[key as LifecyclePhase] as ProbeResult;
  }

  const now = options.now ?? (() => new Date());
  const at = now().toISOString();
  const existingDiagnostics = Array.isArray(fixture.diagnostics)
    ? (fixture.diagnostics as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : [];
  const newDiagnostics: string[] = [
    ...probeKeys.map((key) => `measured:${key}=${String(judged.probes?.[key])};run=${judged.runId};at=${at}`),
    ...lifecycleKeys.map((key) => `measured:lifecycle.${key}=${String(judged.lifecycle?.[key as LifecyclePhase])};run=${judged.runId};at=${at}`),
  ];

  // Only these four keys ever change; every other key on `fixture` is carried over untouched by
  // the spread below (client, version, status, correlation, correlationEntropy, fork,
  // adapterMarkerPosition, parentPromptPosition and anything else the fixture happens to carry).
  const nextFixture: Record<string, unknown> = {
    ...fixture,
    probes: nextProbes,
    lifecycle: nextLifecycle,
    diagnostics: [...existingDiagnostics, ...newDiagnostics],
  };
  const payload = `${JSON.stringify(nextFixture, null, 2)}\n`;

  const temp = `${fixturePath}.${process.pid}.tmp`;
  // Only a temp file this call created is removed on failure, same reasoning as
  // src/io/store.ts's commitState: a create refused with EEXIST means the file belongs to
  // someone else and must not be deleted.
  let tempCreated = false;
  const writePayload = options.writePayload ?? writeTempPayload;
  await runWithCleanup(
    async () => {
      try {
        await writePayload(temp, payload);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') tempCreated = true;
        throw error;
      }
      tempCreated = true;
      await rename(temp, fixturePath);
    },
    async () => {
      if (tempCreated) await rm(temp, { force: true });
    },
  );
}
