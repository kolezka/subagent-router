import { getAgent } from '../agents/inventory';
import { assertCapability } from './capabilities';
import { resolveRoute } from '../core/route';
import type {
  AgentInventory,
  CapabilityProfile,
  EffectiveCatalog,
  NativeRuntimeContext,
  OperatorConfig,
  RouteDecision,
  RouteInput,
} from '../core/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function unsupported(ignoredMarkers: number): RouteDecision {
  return { kind: 'error', code: 'unsupported-path', ignoredMarkers };
}

function roleExists(inventory: AgentInventory, role: string): boolean {
  try {
    return getAgent(inventory, role).client === 'codex';
  } catch {
    return false;
  }
}

// `args.role` wins over `args.agent`; either must be a non-empty string to count as a role
// selection at all. Anything else (missing, wrong type, empty) means "no role given", never a
// malformed-role error -- Codex has no dedicated error code for that, only for an unknown model.
function readRole(record: Record<string, unknown> | undefined): string | undefined {
  if (record === undefined) return undefined;
  if (typeof record.role === 'string' && record.role.length > 0) return record.role;
  if (typeof record.agent === 'string' && record.agent.length > 0) return record.agent;
  return undefined;
}

/**
 * Validates a Codex `spawn_agent` call's chosen model/role against the operator config and
 * catalog, and returns the core routing decision unmodified (never touching `args`). Lifecycle
 * phase and freshness never come from `args` -- they are read exclusively off `context`, supplied
 * by the caller's `resolveNativeRuntimeContext` dependency; a same-named field inside `args` is
 * untrusted and ignored (`assertCapability`'s lifecycle check only ever consults `context`).
 *
 * `model` presence is checked with `Object.hasOwn` so a present-but-invalid value (null, empty
 * string, non-string, an alias, or an exact ID absent from `catalog.byId`) can never silently fall
 * back to a role or global default -- only a genuinely ABSENT `model` key is "no explicit
 * selection made" and allowed to fall through to a default. A model is accepted ONLY as an exact
 * `catalog.byId` hit: an alias (even a valid one for a different model) is never accepted here, so
 * a caller cannot use an alias to dodge the exact-ID requirement.
 *
 * `role` is read from `args.role` or `args.agent`; when given it must exist in the inventory for
 * client `codex` (an unknown role is `unsupported-path`, mirroring the OpenCode adapter, since the
 * router cannot reason about a role it cannot see). A role paired with an explicit `model` field
 * (valid or not) additionally requires the `codex-explicit-over-role` gate (M9) before precedence
 * between the two is even evaluated: an unmet gate is `unsupported-path`, never a quiet
 * fall-through to the role default.
 *
 * A `route` decision additionally requires proof beyond the core decision itself: an inventory
 * built from files alone (`completeness !== 'native'`) is never sufficient, since a file scan
 * proves nothing about what Codex will actually resolve at runtime, the same constraint the
 * OpenCode adapter enforces for its own client. The supplied `NativeConfigWitness` must also
 * self-report `source: 'authoritative-native-resolver'`, and a literal (non-split, non-normalized)
 * match between `effectiveModel` and the decision's `upstreamModel`.
 * `expectedGeneration`/`actualGeneration` matching each other and a non-empty `artifactHash` are
 * only STRUCTURAL self-consistency checks on the witness itself -- this function has no
 * independently trusted expectation to compare against, so passing this check is not production
 * proof; a stronger comparison against the caller's own locally-trusted expectations belongs in
 * the runtime wrapper around this function, same as the OpenCode plugin does for its own adapter.
 * A role-default or global-default source additionally requires `context.freshDelegation === true`
 * and a passed `M10-freshness` probe; anything short of that is `unsupported-path`.
 *
 * The `codex-native-runtime` gate (M7) itself, and where a native resolver hook could even run
 * relative to spawn, remain unmeasured for every shipped Codex profile (see
 * `tests/fixtures/capabilities/codex-pending.json`): `assertCapability` keeps every path on
 * `unsupported-path` until a real M7 measurement lands, so this function's `route` branch is
 * exercised today only by synthetic, explicitly-marked test profiles.
 */
export function validateCodexSpawn(
  args: unknown,
  inventory: AgentInventory,
  config: OperatorConfig,
  catalog: EffectiveCatalog,
  profile: CapabilityProfile,
  context: NativeRuntimeContext,
): RouteDecision {
  try {
    assertCapability(profile, 'codex-native-runtime', context);
  } catch {
    return unsupported(0);
  }

  const record = isRecord(args) ? args : undefined;

  const role = readRole(record);
  if (role !== undefined && !roleExists(inventory, role)) {
    return unsupported(0);
  }

  let explicitIds: string[] = [];
  let explicitError: 'unknown-model' | undefined;
  const hasModelField = record !== undefined && Object.hasOwn(record, 'model');
  if (hasModelField) {
    const raw = record?.model;
    if (typeof raw !== 'string' || raw.length === 0 || !catalog.byId.has(raw)) {
      explicitError = 'unknown-model';
    } else {
      explicitIds = [raw];
    }
  }

  if (role !== undefined && hasModelField) {
    try {
      assertCapability(profile, 'codex-explicit-over-role', context);
    } catch {
      return unsupported(0);
    }
  }

  const roleDefaultId = role !== undefined ? config.roles[`codex:${role}`]?.routeOverride : undefined;

  const input: RouteInput = {
    client: 'codex',
    scope: 'child',
    ...(role !== undefined ? { role } : {}),
    explicitIds,
    ...(roleDefaultId !== undefined ? { roleDefaultId } : {}),
    freshDelegation: context.freshDelegation,
    ...(explicitError !== undefined ? { explicitError } : {}),
    ignoredMarkers: 0,
  };

  const decision = resolveRoute(input, config, catalog);
  if (decision.kind !== 'route') return decision;

  // A files-only scan proves nothing about what Codex will actually resolve at runtime, the same
  // constraint validateOpenCodeTask already enforces for its own client -- checked after explicit
  // route-input errors (so those keep precedence) but before the witness, since an inventory this
  // weak can never be trusted regardless of what the witness claims.
  if (inventory.completeness !== 'native') return unsupported(decision.ignoredMarkers);

  const witness = context.nativeConfig;
  const witnessOk =
    witness.source === 'authoritative-native-resolver' &&
    witness.effectiveModel === decision.upstreamModel &&
    witness.expectedGeneration === witness.actualGeneration &&
    witness.artifactHash.length > 0;
  if (!witnessOk) return unsupported(decision.ignoredMarkers);

  const isDefault = decision.source === 'role-default' || decision.source === 'global-default';
  if (isDefault && (context.freshDelegation !== true || profile.probes['M10-freshness'] !== 'passed')) {
    return unsupported(decision.ignoredMarkers);
  }

  return decision;
}

/**
 * Builds the `PreToolUse` hook output for a Codex spawn decision. An `error` decision denies with
 * a reason carrying the router's error code (never the router's internal message text, which may
 * describe fixture/profile internals). A `route` or `pass-through` decision writes the empty hook
 * object: no explicit `allow`, and never `updatedInput` -- this router does not rewrite the call,
 * it only decides whether Codex may proceed with what was already given.
 */
export function codexHookOutput(decision: RouteDecision): Record<string, unknown> {
  if (decision.kind === 'error') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `subagent-router: ${decision.code}`,
      },
    };
  }
  return {};
}
