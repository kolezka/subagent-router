// Task 13 contract. Wires the shared createHandler into Bun.serve; does not reimplement routing.
import { RouterError } from '../core/errors';
import { resolveSource, validateSource } from '../io/environment';
import { loadState } from '../io/store';
import { createHandler } from '../transport/handler';
import type { HandlerEvent } from '../transport/handler';
import type { CapabilityProfile, CliDeps } from '../core/types';

export interface ServeHandle {
  readonly url: string;
  readonly generation: string;
  stop(): Promise<void>;
}

// Standalone `serve` startup preflight, distinct from and in addition to createHandler's own
// per-request capability gates (src/transport/handler.ts's assertCapability, unchanged and still
// the only gate an embedder relying on createHandler directly ever goes through). This function
// exists because a real built CLI's serve command used to bind a port and sit there listening
// even with a client capability profile that has never been measured as 'supported' -- correct
// per createHandler's own contract (per-request gating), but wrong for THIS standalone
// entrypoint: with native support unmeasured, nothing it could route would ever pass a real
// capability gate anyway, so starting it at all is a false invitation, not a working degraded
// mode. Cost of this ruling, accepted deliberately: standalone `serve` can no longer be used as a
// parent-only passthrough proxy while native support is unmeasured, even though createHandler
// itself would have let a plain parent (non-subagent) request through untouched. Mirrors the
// same client+status check `scripts/poc-serve.ts`'s assertProductionCapabilityProfile already
// enforces for its own production entrypoint (that script's additional synthetic-version-string
// rejection is a stricter production-only rule and is intentionally NOT reproduced here: DI
// synthetic 'supported' profiles must keep working for this module's own hermetic tests, and this
// function is not the place to add a production-only override flag).
function assertClientProfileSupported(profile: CapabilityProfile): void {
  if (profile.client !== 'claude-code') {
    throw new RouterError('unsupported-path', `serve only routes claude-code; got a profile for ${profile.client}`);
  }
  if (profile.status !== 'supported') {
    throw new RouterError('unsupported-path', `capability profile ${profile.client} ${profile.version} is ${profile.status}, not supported`);
  }
}

/**
 * Starts an HTTP server that fronts an external gateway with Claude Code marker routing.
 * State is loaded once and frozen into the handler closure: later edits to the config file
 * on disk are not observed by a running instance ("immutable per generation"). Refuses to bind
 * at all (see assertClientProfileSupported above) unless the loaded client capability profile is
 * already 'supported' -- before any transport-profile load, handler construction, or Bun.serve.
 */
export async function startServer(
  configPath: string,
  deps: CliDeps,
  options: { port: number; host: string; claudeVersion?: string; onEvent?: (event: HandlerEvent) => void },
): Promise<ServeHandle> {
  const state = await loadState(configPath);
  if (state.snapshot === undefined) {
    throw new RouterError('snapshot-missing', 'serve requires a models.lock.json snapshot next to the config; none was found');
  }

  const source = resolveSource(state.config, deps.env);
  await validateSource(source, state.snapshot);

  // claudeVersion is caller-supplied, never inferred. The CLI passes the real --claude-version;
  // DI tests may omit it since their loadProfile stub ignores the argument.
  const profile = await deps.loadProfile('claude-code', options.claudeVersion ?? 'unspecified');
  assertClientProfileSupported(profile);
  const transportProfile = await deps.loadTransportProfile(deps.fetchAdapter.id, deps.fetchAdapter.runtimeVersion);

  const secretEnvName = state.config.harness.claudeCode.secretEnv;
  const secret = deps.env[secretEnvName];

  const handler = createHandler({
    config: state.config,
    snapshot: state.snapshot,
    source,
    profile,
    transportProfile,
    ...(secret === undefined ? {} : { secret }),
    fetch: deps.fetch,
    fetchAdapter: deps.fetchAdapter,
    // Trusted lifecycle context always starts unknown/not-fresh. It is never derived from
    // request JSON; only a separately verified native adapter (not present in this PoC) may
    // ever report freshDelegation: true.
    trustedContext: () => ({ freshDelegation: false }),
    now: () => deps.now().getTime(),
    nonce: () => crypto.randomUUID(),
    instanceId: () => crypto.randomUUID(),
    ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
  });

  const server = Bun.serve({
    port: options.port,
    hostname: options.host,
    fetch: handler,
  });

  return {
    url: server.url.toString().replace(/\/$/, ''),
    generation: state.generation,
    async stop() {
      await server.stop(true);
    },
  };
}
