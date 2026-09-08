import { assertCapability } from '../adapters/capabilities';
import { RouterError } from '../core/errors';
import { signFreshDelegation } from './handler';
import { createClaudeStartOutput } from './hooks';
import type { CapabilityProfile, FetchLike, FreshDelegationEnvelope, OperatorConfig, TrustedLifecycleContext } from '../core/types';

export interface ClaudeHookDeps {
  controlBaseUrl: string;
  secret: string;
  roles: OperatorConfig['roles'];
  profile: CapabilityProfile;
  fetch: FetchLike;
  now: () => number;
  nonce: () => string;
  // Separate, injected adapter for the trusted native lifecycle event. Production
  // implementations stay unsupported until a real M10-freshness measurement confirms the
  // producer; only a hermetic test may inject freshDelegation: true, and only as an explicit
  // 'synthetic-trusted-start' stand-in, never derived from event name, prompt or stdin fields.
  resolveTrustedStart: (input: Record<string, unknown>) => TrustedLifecycleContext;
  // Mirrors OperatorConfig.harness.claudeCode.correlation. Only 'auto' makes channel B2
  // registration eligible here; omitted or 'off' fails closed, exactly like the handler's own
  // b2Eligible check.
  correlation?: 'auto' | 'off';
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

async function writeAll(stream: WritableStream<Uint8Array>, text: string): Promise<void> {
  const writer = stream.getWriter();
  await writer.write(new TextEncoder().encode(text));
  await writer.close();
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A fixed, safe message: a caught fetch/network error's own .message can carry hostnames,
// ports or other environment detail and must never be interpolated into a thrown error.
const REGISTRATION_FAILURE_MESSAGE = 'subagent-router freshness registration failed';

function registrationFailure(): RouterError {
  return new RouterError('freshness-registration-failed', REGISTRATION_FAILURE_MESSAGE);
}

const INVALID_HOOK_INPUT_MESSAGE = 'subagent-router received invalid hook input';

function invalidHookInput(): RouterError {
  return new RouterError('invalid-hook-input', INVALID_HOOK_INPUT_MESSAGE);
}

// Mirrors handler.ts's MAX_IDENTIFIER_LENGTH bound on freshness-envelope identifiers: an
// unbounded agent id is not a routing decision, it is an opaque token that must not be allowed
// to grow without limit before it ever reaches the store.
const MAX_AGENT_ID_LENGTH = 256;

/**
 * Entry point for Claude Code's SubagentStart hook. Trust comes only from
 * `deps.resolveTrustedStart`, never from the event name, prompt text or any other stdin field:
 * the event being literally named "SubagentStart" is a necessary precondition, checked up front,
 * but never sufficient proof of freshness by itself.
 *
 * Unparseable or non-object stdin is rejected up front with `RouterError('invalid-hook-input')`,
 * never a silent `{}` success. The event name, a bounded agent id, a non-empty agent_type, and a
 * configured role for that agent_type are all required before anything else runs; any of these
 * being missing or unmapped is a soft no-op (`{}`, no network call), not a thrown error.
 *
 * Registration is gated closed before any control-endpoint network call: beyond a trusted fresh
 * start, the profile must clear the same `claude-marker` capability gate the handler enforces
 * (client/status/lifecycle/M10) and a passed M10-freshness probe, AND be shaped for a channel
 * that could actually consume the receipt (channel B: M3 passed at a system/first-user position,
 * or channel B2: `deps.correlation === 'auto'` plus `profile.correlation === true` plus
 * M1/correlationEntropy/M3-B2 all passed, mirroring the handler's own b2Eligible check).
 *
 * When capable, this registers a one-shot freshness envelope with the running handler (fetching
 * its instance id first, then signing and POSTing the envelope) before ever writing to stdout.
 * A failure at any step is a hook error carrying a fixed, safe message (never an interpolated
 * underlying error message, which could carry secrets or internal URLs): it never degrades into
 * a default marker or a silent success, so channel B and B2 both stay closed until registration
 * actually lands.
 */
export async function runClaudeSubagentStartHook(
  stdin: ReadableStream<Uint8Array>,
  stdout: WritableStream<Uint8Array>,
  deps: ClaudeHookDeps,
): Promise<void> {
  const raw = await readAll(stdin);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidHookInput();
  }
  // Malformed or non-object stdin is a hook error, never a silent {} success: a caller that
  // cannot parse its own input must not be told registration was skipped cleanly.
  if (!isPlainObject(parsed)) {
    throw invalidHookInput();
  }
  const input = parsed;

  const agentId = typeof input.agent_id === 'string' ? input.agent_id : '';
  const agentType = typeof input.agent_type === 'string' ? input.agent_type : '';
  const agentIdBounded = agentId.length > 0 && agentId.length <= MAX_AGENT_ID_LENGTH;
  // Necessary, never sufficient: the event literally being "SubagentStart" proves nothing about
  // freshness by itself (see the function docstring), but its absence must still close the gate.
  const eventIsSubagentStart = input.hook_event_name === 'SubagentStart';

  const roleKnown = agentType !== '' && deps.roles[`claude-code:${agentType}`] !== undefined;

  if (!agentIdBounded || !eventIsSubagentStart || !roleKnown) {
    await writeAll(stdout, JSON.stringify({}));
    return;
  }

  const context = deps.resolveTrustedStart(input);

  let claudeMarkerGateOk = true;
  try {
    assertCapability(deps.profile, 'claude-marker', context);
  } catch {
    claudeMarkerGateOk = false;
  }

  const freshnessProbeOk = deps.profile.probes['M10-freshness'] === 'passed';

  const channelBPossible =
    deps.profile.probes.M3 === 'passed' &&
    (deps.profile.adapterMarkerPosition === 'system' || deps.profile.adapterMarkerPosition === 'first-user');
  const channelB2Possible =
    deps.correlation === 'auto' &&
    deps.profile.correlation === true &&
    deps.profile.adapterMarkerPosition === 'b2' &&
    deps.profile.probes.M1 === 'passed' &&
    deps.profile.correlationEntropy === 'passed' &&
    deps.profile.probes['M3-B2'] === 'passed';

  const capable = context.freshDelegation === true && claudeMarkerGateOk && freshnessProbeOk && (channelBPossible || channelB2Possible);

  if (!capable) {
    await writeAll(stdout, JSON.stringify({}));
    return;
  }

  const base = trimTrailingSlash(deps.controlBaseUrl);

  let instanceResponse: Response;
  try {
    instanceResponse = await deps.fetch(new Request(`${base}/subagent-router/control/instance`));
  } catch {
    throw registrationFailure();
  }
  if (!instanceResponse.ok) {
    throw registrationFailure();
  }

  let instanceBody: unknown;
  try {
    instanceBody = await instanceResponse.json();
  } catch {
    throw registrationFailure();
  }
  const handlerInstanceId =
    isPlainObject(instanceBody) && typeof instanceBody.handlerInstanceId === 'string' && instanceBody.handlerInstanceId !== ''
      ? instanceBody.handlerInstanceId
      : undefined;
  if (handlerInstanceId === undefined) {
    throw registrationFailure();
  }

  const unsigned = {
    version: 1 as const,
    handlerInstanceId,
    agentId,
    role: agentType,
    nonce: deps.nonce(),
    issuedAtMs: deps.now(),
  };
  const proof = await signFreshDelegation(deps.secret, unsigned);
  const envelope: FreshDelegationEnvelope = { ...unsigned, proof };

  let registerResponse: Response;
  try {
    registerResponse = await deps.fetch(
      new Request(`${base}/subagent-router/control/delegations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      }),
    );
  } catch {
    throw registrationFailure();
  }
  if (registerResponse.status !== 204) {
    throw registrationFailure();
  }

  const output = await createClaudeStartOutput(
    { agent_id: agentId, agent_type: agentType },
    { secret: deps.secret, roles: deps.roles, profile: deps.profile, fresh: true },
  );
  await writeAll(stdout, JSON.stringify(output));
}
