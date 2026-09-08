#!/usr/bin/env bun
// Production-facing PoC entry point. Loads an explicit config and explicit, real capability
// and transport profile fixtures, then starts the real createHandler pipeline via startServer.
// No trust-me bypass: it refuses any profile that is synthetic or not fully "supported"/"passed".
import { RouterError } from '../src/core/errors';
import type { CapabilityProfile, Env, TransportCapabilityProfile } from '../src/core/types';

export interface PocServeArgs {
  configPath: string;
  profileDir: string;
  transportProfileDir: string;
  claudeVersion: string;
  port: number;
}

const DEFAULT_PORT = 8787;
const KNOWN_FLAGS = new Set(['config', 'profile', 'transport-profile', 'claude-version', 'port']);

export function isHelpRequested(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === '--help' || arg === '-h');
}

export function usageText(): string {
  return [
    'Usage: poc:serve --config <path> --profile <dir> --transport-profile <dir> --claude-version <version> [--port <n>]',
    '',
    '  --config              path to subagent-router.json (models.lock.json must sit beside it)',
    '  --profile             directory of capability-profile fixtures',
    '  --transport-profile   directory of transport capability-profile fixtures',
    '  --claude-version      claude-code client version to load a profile for',
    '  --port                loopback port (default 8787)',
    '  --help                print this message and exit',
  ].join('\n');
}

/** Rejects unknown flags, stray positionals, and duplicates so a typo never parses as success. */
export function parsePocServeArgs(argv: readonly string[]): PocServeArgs {
  const values = new Map<string, string>();
  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    if (flag === undefined || !flag.startsWith('--')) {
      throw new RouterError('cli-args', `unexpected argument "${flag ?? ''}"`);
    }
    const name = flag.slice(2);
    if (!KNOWN_FLAGS.has(name)) {
      throw new RouterError('cli-args', `unknown flag --${name}`);
    }
    if (values.has(name)) {
      throw new RouterError('cli-args', `--${name} was specified more than once`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new RouterError('cli-args', `--${name} requires a value`);
    }
    values.set(name, value);
    i += 2;
  }

  const configPath = values.get('config');
  const profileDir = values.get('profile');
  const transportProfileDir = values.get('transport-profile');
  const claudeVersion = values.get('claude-version');
  if (configPath === undefined) throw new RouterError('cli-args', '--config is required');
  if (profileDir === undefined) throw new RouterError('cli-args', '--profile is required (a fixtures directory)');
  if (transportProfileDir === undefined) throw new RouterError('cli-args', '--transport-profile is required (a fixtures directory)');
  if (claudeVersion === undefined) throw new RouterError('cli-args', '--claude-version is required');

  const portText = values.get('port');
  const port = portText === undefined ? DEFAULT_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RouterError('cli-args', '--port must be an integer between 0 and 65535');
  }

  return { configPath, profileDir, transportProfileDir, claudeVersion, port };
}

const SYNTHETIC_MARKER = 'synthetic';

/** Refuses any profile that is not a real, measured, supported native profile. No override. */
export function assertProductionCapabilityProfile(profile: CapabilityProfile): void {
  if (profile.client !== 'claude-code') {
    throw new RouterError('unsupported-path', `poc:serve only routes claude-code; got profile for ${profile.client}`);
  }
  if (profile.version.toLowerCase().includes(SYNTHETIC_MARKER)) {
    throw new RouterError(
      'unsupported-path',
      `poc:serve refuses synthetic/hermetic profile version "${profile.version}"; native support has not been measured`,
    );
  }
  if (profile.status !== 'supported') {
    throw new RouterError(
      'unsupported-path',
      `poc:serve refuses profile status "${profile.status}" for claude-code ${profile.version}; run tests/probes/run.ts against a real client first`,
    );
  }
}

/** Refuses any transport adapter profile that is not real, measured and fully passed. No override. */
export function assertProductionTransportProfile(profile: TransportCapabilityProfile): void {
  if (profile.adapterId.toLowerCase().includes(SYNTHETIC_MARKER) || profile.runtimeVersion.toLowerCase().includes(SYNTHETIC_MARKER)) {
    throw new RouterError(
      'unsupported-path',
      `poc:serve refuses synthetic transport profile ${profile.adapterId}@${profile.runtimeVersion}`,
    );
  }
  if (profile.status !== 'passed' || profile.gzipBytes !== 'passed' || profile.responseHeaders !== 'passed') {
    throw new RouterError(
      'unsupported-path',
      `poc:serve refuses unmeasured transport profile ${profile.adapterId}@${profile.runtimeVersion} (status=${profile.status})`,
    );
  }
}

async function run(argv: readonly string[]): Promise<void> {
  if (isHelpRequested(argv)) {
    process.stdout.write(`${usageText()}\n`);
    return;
  }

  const args = parsePocServeArgs(argv);

  const { loadCapabilityProfile, loadTransportCapabilityProfile } = await import('../src/adapters/capabilities');
  const { bunRawFetch, BUN_RAW_FETCH_ADAPTER } = await import('../src/transport/bun-fetch');
  const { startServer } = await import('../src/cli/serve');

  const profile = await loadCapabilityProfile('claude-code', args.claudeVersion, args.profileDir);
  assertProductionCapabilityProfile(profile);

  const transportProfile = await loadTransportCapabilityProfile(
    BUN_RAW_FETCH_ADAPTER.id,
    BUN_RAW_FETCH_ADAPTER.runtimeVersion,
    args.transportProfileDir,
  );
  assertProductionTransportProfile(transportProfile);

  const env = process.env as Env;
  const server = await startServer(args.configPath, {
    cwd: process.cwd(),
    home: process.env.HOME ?? process.cwd(),
    env,
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    isTTY: process.stdout.isTTY ?? false,
    fetch: bunRawFetch,
    fetchAdapter: BUN_RAW_FETCH_ADAPTER,
    loadProfile: async () => profile,
    loadTransportProfile: async () => transportProfile,
    now: () => new Date(),
  }, { port: args.port, host: '127.0.0.1', claudeVersion: args.claudeVersion });

  process.stdout.write(`subagent-router listening on ${server.url} (generation ${server.generation})\n`);
  process.stdout.write('Loopback only. External gateway must speak the harness-facing HTTP protocol; provider auth and translation are the gateway\'s job.\n');

  const shutdown = async (): Promise<void> => {
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

/** RouterError means bad args/config/an unsupported profile (exit 2); anything else is operational I/O (exit 1). */
export function exitCodeForError(error: unknown): number {
  return error instanceof RouterError ? 2 : 1;
}

if (import.meta.main) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = exitCodeForError(error);
  });
}
