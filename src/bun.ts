/**
 * Public `./bun` entrypoint and the `subagent-router` executable.
 *
 * Importing this module is inert: it wires up Bun-specific dependencies and re-exports them, but
 * only runs the CLI when executed directly (`import.meta.main`). A consumer that imports
 * `runCli` or `startServer` never binds a port, never reads argv and never writes to stdout.
 */
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCapabilityProfile, loadTransportCapabilityProfile } from './adapters/capabilities';
import { runCli } from './cli/main';
import { BUN_RAW_FETCH_ADAPTER, bunRawFetch } from './transport/bun-fetch';
import type { CliDeps } from './core/types';

export { runCli } from './cli/main';
export { detectClientVersion, VERSION_PROBE_TIMEOUT_MS } from './cli/version-probe';
export { startServer } from './cli/serve';
export type { ServeHandle } from './cli/serve';
export { readAgentInventory, getAgent } from './agents/inventory';
export { createOpenCodePlugin } from './adapters/opencode-plugin';
export { runCodexPreToolUseHook } from './adapters/codex-hook';
export { runClaudeSubagentStartHook } from './transport/claude-hook';
export { BUN_RAW_FETCH_ADAPTER, bunRawFetch } from './transport/bun-fetch';

/**
 * Capability profiles ship inside the package next to the built entrypoints
 * (`dist/capabilities/`), so an installed copy resolves the same measured profiles no matter
 * what happens to sit in the consumer's working directory. During development the bundle runs
 * from `src/`, so the repository's own profile directory is used instead.
 */
function capabilitiesDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return basename(here.replace(/[/\\]+$/, '')) === 'dist'
    ? join(here, 'capabilities')
    : join(here, '..', 'tests', 'fixtures', 'capabilities');
}

/**
 * Real dependencies for the executable.
 *
 * Client versions are NOT discovered here and NOT guessed. `loadProfile` is handed whatever
 * version the caller resolved (an explicit `--claude-version`-style option, or a value read from
 * the operator's config) and looks it up literally in the shipped profile directory. A version
 * with no measured profile fails closed inside `loadCapabilityProfile`
 * (`RouterError('capability-unknown-version')`); nothing here can promote a profile to
 * `supported`, and no secret from `env` is ever written to stdout or stderr by these deps.
 */
export function realDeps(): CliDeps {
  const dir = capabilitiesDir();
  return {
    cwd: process.cwd(),
    home: process.env.HOME ?? '',
    env: process.env,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    isTTY: process.stdout.isTTY === true,
    fetch: bunRawFetch,
    fetchAdapter: BUN_RAW_FETCH_ADAPTER,
    loadProfile: (client, version) => loadCapabilityProfile(client, version, dir),
    loadTransportProfile: (adapterId, runtimeVersion) => loadTransportCapabilityProfile(adapterId, runtimeVersion, dir),
    now: () => new Date(),
  };
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2), realDeps());
}
