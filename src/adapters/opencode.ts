import { getAgent } from '../agents/inventory';
import { assertCapability } from './capabilities';
import { assertSafePathSegment } from '../core/path-segment';
import { resolveRoute } from '../core/route';
import type {
  AgentInventory,
  CapabilityProfile,
  EffectiveCatalog,
  ExportFile,
  NativeRuntimeContext,
  OperatorConfig,
  RouteDecision,
  RouteInput,
} from '../core/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function roleExists(inventory: AgentInventory, role: string): boolean {
  try {
    return getAgent(inventory, role).client === 'opencode';
  } catch {
    return false;
  }
}

// Splits on the LAST '@' only: an alias is never present without a role, and this must
// never confuse a role name that itself happens to contain '@' with the alias suffix.
// No '@' at all means "bare role, no explicit variant chosen" (alias stays undefined).
function splitVariantName(value: string): { role: string; alias?: string } {
  const at = value.lastIndexOf('@');
  if (at === -1) return { role: value };
  return { role: value.slice(0, at), alias: value.slice(at + 1) };
}

/**
 * Builds one Markdown export per `ROLE@ALIAS` variant for file-backed OpenCode roles, and
 * one combined `opencode.agents.json` fragment for roles declared inline in `opencode.json`
 * (no on-disk file to append a sibling Markdown file next to). A model without a catalog
 * `description` gets no variant at all -- there would be nothing meaningful to show a picker.
 * The variant's native block is the role's own `native` frontmatter with only `name`,
 * `description`, `hidden: true` and `model` overwritten; tools/permissions/mode/body are
 * untouched. The serialized `model` field is `<providerId>/<upstreamModel>` (the two kept as
 * literally concatenated strings, e.g. `gateway/gateway/fast-worker`) -- callers must recover
 * `upstreamModel` by stripping the known `providerId` prefix, never by further splitting.
 */
export function opencodeVariants(
  inventory: AgentInventory,
  config: OperatorConfig,
  catalog: EffectiveCatalog,
  snapshotGeneration: string,
): ExportFile[] {
  const providerId = config.harness.opencode.providerId;
  const mdFiles: ExportFile[] = [];
  const jsonFragment: Record<string, unknown> = {};

  for (const entry of inventory.entries) {
    if (entry.client !== 'opencode' || entry.availability !== 'available' || entry.shadowed) continue;
    // The name comes verbatim from the native file's frontmatter (`name:`), an untrusted input,
    // and becomes a filename below. A name with `..` or a separator once escaped the output
    // directory through export.ts, so it is refused here at its source; export.ts additionally
    // checks containment of every planned path. Deliberately strict: an odd but legitimate name
    // is refused rather than risking a write outside `outputDir`.
    assertSafePathSegment(entry.name, 'opencode agent name');

    for (const model of catalog.byId.values()) {
      if (!model.enabled || model.description === undefined) continue;
      assertSafePathSegment(model.alias, 'model alias');

      const variantName = `${entry.name}@${model.alias}`;
      const variantNative: Record<string, unknown> = {
        ...entry.native,
        name: variantName,
        description: model.description,
        hidden: true,
        model: `${providerId}/${model.id}`,
      };

      if (entry.path !== undefined) {
        const frontmatter = Bun.YAML.stringify(variantNative, null, 2);
        const content = `---\n${frontmatter}---\n${entry.body ?? ''}`;
        mdFiles.push({ relativePath: `opencode/agents/${variantName}.md`, content });
      } else {
        jsonFragment[variantName] = variantNative;
      }
    }
  }

  const files = mdFiles;
  if (Object.keys(jsonFragment).length > 0) {
    files.push({
      relativePath: 'opencode/opencode.agents.json',
      content: JSON.stringify({ agent: jsonFragment, snapshotGeneration }, null, 2),
    });
  }
  return files;
}

function unsupported(ignoredMarkers: number): RouteDecision {
  return { kind: 'error', code: 'unsupported-path', ignoredMarkers };
}

/**
 * Validates a native OpenCode `task` call's chosen model/role against the operator config and
 * catalog, and returns the core routing decision unmodified (never touching `args`). Lifecycle
 * phase and freshness never come from `args` -- they are read exclusively off `context`, supplied
 * by the caller's `resolveNativeRuntimeContext` dependency; a same-named field inside `args` is
 * untrusted and ignored.
 *
 * `subagent_type` presence is checked with `Object.hasOwn` so a present-but-invalid value (null,
 * empty string, non-string, or an unresolvable `ROLE@ALIAS`) can never silently fall back to a
 * role or global default -- only a genuinely ABSENT key, or a bare role name with no `@ALIAS`
 * suffix, is treated as "no explicit selection made" and allowed to fall through to a default.
 * A `ROLE@ALIAS` string is split on the LAST '@'; the role must exist in inventory (an unknown
 * role is `unsupported-path`, since the router cannot reason about a role it cannot see) and the
 * alias is resolved ONLY through `catalog.byAlias` -- an alias that happens to collide with some
 * other model's raw ID is never accepted as a match.
 *
 * A `route` decision additionally requires proof beyond the core decision itself: an inventory
 * built from files alone (`completeness !== 'native'`) is never sufficient, since a file scan
 * proves nothing about what the running client will actually resolve. The supplied
 * `NativeConfigWitness` must self-report `source: 'authoritative-native-resolver'`, the same
 * `providerId` the operator configured, and a literal (non-split, non-normalized) match between
 * `effectiveModel` and the decision's `upstreamModel`. `expectedGeneration`/`actualGeneration`
 * matching each other and a non-empty `artifactHash` are only STRUCTURAL self-consistency checks
 * on the witness itself -- this function has no independently trusted expectation to compare
 * against, so passing this check is not production proof; a stronger comparison against the
 * caller's own locally-trusted expectations belongs in the runtime wrapper around this function
 * (see `createOpenCodePlugin`). A role-default or global-default source additionally requires
 * `context.freshDelegation === true` and a passed `M10-freshness` probe; anything short of that
 * is `unsupported-path`, never a quiet fall-through to some other default.
 */
export function validateOpenCodeTask(
  args: unknown,
  inventory: AgentInventory,
  config: OperatorConfig,
  catalog: EffectiveCatalog,
  profile: CapabilityProfile,
  context: NativeRuntimeContext,
): RouteDecision {
  try {
    assertCapability(profile, 'opencode-native-runtime', context);
  } catch {
    return unsupported(0);
  }

  const record = isRecord(args) ? args : undefined;
  let role: string | undefined;
  let explicitIds: string[] = [];
  let explicitError: 'unknown-model' | undefined;

  if (record !== undefined && Object.hasOwn(record, 'subagent_type')) {
    const raw = record.subagent_type;
    if (typeof raw !== 'string' || raw.length === 0) {
      explicitError = 'unknown-model';
    } else {
      const { role: roleCandidate, alias } = splitVariantName(raw);
      if (!roleExists(inventory, roleCandidate)) {
        return unsupported(0);
      }
      role = roleCandidate;
      if (alias !== undefined) {
        const resolved = catalog.byAlias.get(alias);
        if (resolved === undefined) explicitError = 'unknown-model';
        else explicitIds = [resolved.id];
      }
    }
  }

  const roleDefaultId = role !== undefined ? config.roles[`opencode:${role}`]?.routeOverride : undefined;

  const input: RouteInput = {
    client: 'opencode',
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

  if (inventory.completeness !== 'native') return unsupported(decision.ignoredMarkers);

  const witness = context.nativeConfig;
  const witnessOk =
    witness.source === 'authoritative-native-resolver' &&
    witness.providerId === config.harness.opencode.providerId &&
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
