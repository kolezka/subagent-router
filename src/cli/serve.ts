// Task 13 contract. Wires the shared createHandler into Bun.serve; does not reimplement routing.
import { RouterError } from '../core/errors';
import { resolveSource, validateSource } from '../io/environment';
import { loadState } from '../io/store';
import { createHandler } from '../transport/handler';
import type { CliDeps } from '../core/types';

export interface ServeHandle {
  readonly url: string;
  readonly generation: string;
  stop(): Promise<void>;
}

/**
 * Starts an HTTP server that fronts an external gateway with Claude Code marker routing.
 * State is loaded once and frozen into the handler closure: later edits to the config file
 * on disk are not observed by a running instance ("immutable per generation").
 */
export async function startServer(
  configPath: string,
  deps: CliDeps,
  options: { port: number; host: string; claudeVersion?: string },
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
