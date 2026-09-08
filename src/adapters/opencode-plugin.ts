import { RouterError } from '../core/errors';
import { validateOpenCodeTask } from './opencode';
import type {
  AgentInventory,
  CapabilityProfile,
  EffectiveCatalog,
  NativeRuntimeContext,
  OperatorConfig,
  RouteDecision,
} from '../core/types';

/**
 * Locally-trusted expectations for the artifacts this router itself exported.
 *
 * These are the values the CALLER derived from its own validated state (the snapshot generation
 * and the hash of the bytes it actually wrote), never anything read back out of the witness. The
 * witness's own `expectedGeneration === actualGeneration` check is mere self-consistency: a
 * fabricated witness satisfies it trivially by stating the same wrong value twice. Comparing the
 * witness against these independent values is what makes the check meaningful.
 */
export interface TrustedExportExpectations {
  generation: string;
  artifactHash: string;
}

export interface OpenCodePluginDeps {
  inventory: AgentInventory;
  config: OperatorConfig;
  catalog: EffectiveCatalog;
  profile: CapabilityProfile;
  /**
   * Produces the trusted native runtime context for one tool call, or `undefined` when no
   * authoritative resolver is available.
   *
   * The measured production implementation reads OpenCode's own resolved agent list
   * (`PluginInput.client.app.agents()`, i.e. `GET /agent`, whose entries carry a resolved
   * `model: { providerID, modelID }`) and reports it as an
   * `authoritative-native-resolver` witness. Until `M6-runtime` proves that hook runs before
   * spawn for the running version, no production wiring exists and this returns `undefined`,
   * which this plugin turns into a refusal.
   */
  resolveNativeRuntimeContext: (input: unknown) => Promise<NativeRuntimeContext | undefined>;
  /** What the router exported and therefore expects the client to be running. */
  expectations?: TrustedExportExpectations;
}

/** The subset of OpenCode's plugin hook surface this adapter registers. */
export interface OpenCodePlugin {
  'tool.execute.before': (input: unknown, output: unknown) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The native refusal mechanism: OpenCode's `tool.execute.before` hook returns `void`, so the only
 * way to stop a call is to throw. A returned value would be ignored and the spawn would proceed,
 * which is exactly the silent fail-open this router exists to prevent.
 */
function deny(decision: Extract<RouteDecision, { kind: 'error' }>): never {
  throw new RouterError(decision.code, `subagent-router refused the task call: ${decision.code}`);
}

/**
 * Executable OpenCode plugin entrypoint.
 *
 * Registers `tool.execute.before`, filters to the native `task` tool only, obtains a
 * `NativeRuntimeContext` through the injected resolver, and runs `validateOpenCodeTask`. It never
 * rewrites the call: no `updatedInput`, no substituted `subagent_type`. A `route` or
 * `pass-through` decision simply returns, leaving execution entirely to the harness; an `error`
 * decision throws.
 *
 * Fail-closed by construction. With no authoritative resolver (`undefined` context) the plugin
 * refuses instead of proceeding, because a missing witness is indistinguishable from an
 * unmeasured runtime. When the caller supplies its own `expectations`, the witness must match
 * BOTH of them independently — the router's own generation and its own artifact hash — so a
 * self-consistent but fabricated witness is rejected.
 *
 * What this cannot prove: that the callback sits in the path before spawn, and that a refusal
 * actually prevented a child request from reaching the gateway. Only `M6-runtime` against a real
 * client with a capture gateway establishes that. Until then the shipped profile stays `pending`
 * and `assertCapability` inside the validator keeps every route on `unsupported-path`.
 */
export function createOpenCodePlugin(deps: OpenCodePluginDeps): OpenCodePlugin {
  return {
    'tool.execute.before': async (input: unknown): Promise<void> => {
      const record = isRecord(input) ? input : undefined;
      // Only the native task tool is guarded. Every other tool passes through untouched: this
      // router has no opinion about them, and denying them would break the client.
      if (record?.tool !== 'task') return;

      const args = record.args;

      const context = await deps.resolveNativeRuntimeContext(input);
      if (context === undefined) {
        deny({ kind: 'error', code: 'unsupported-path', ignoredMarkers: 0 });
      }

      const decision = validateOpenCodeTask(args, deps.inventory, deps.config, deps.catalog, deps.profile, context);

      if (decision.kind === 'error') deny(decision);

      // A route was accepted by the validator, whose generation/hash checks are only internal
      // self-consistency. If the caller holds its own trusted expectations, the witness must
      // agree with those too before the spawn is allowed through.
      if (decision.kind === 'route' && deps.expectations !== undefined) {
        const witness = context.nativeConfig;
        if (
          witness.actualGeneration !== deps.expectations.generation ||
          witness.expectedGeneration !== deps.expectations.generation ||
          witness.artifactHash !== deps.expectations.artifactHash
        ) {
          deny({ kind: 'error', code: 'unsupported-path', ignoredMarkers: decision.ignoredMarkers });
        }
      }
    },
  };
}
