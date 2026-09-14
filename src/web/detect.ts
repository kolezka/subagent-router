// Auto-detection helpers for the web console: what is installed, what env vars a config expects,
// whether a well-known local gateway answers, and whether a previous `install` bundle exists.
// Every probe here is best-effort: an unreachable binary, a missing directory or a gateway that
// never answers is a normal outcome, never a thrown error. Only a bug in this module itself (a
// broken candidate table, a type mismatch) is allowed to propagate.
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { claudeCodeAgentRoots } from '../agents/claude-code';
import { readAgentInventory } from '../agents/inventory';
import { codexAgentRoots } from '../agents/codex';
import { opencodeAgentRoots } from '../agents/opencode';
import { detectClientVersion } from '../cli/version-probe';
import { RouterError } from '../core/errors';
import type { ClientId, CliDeps, Env, FetchLike, OperatorConfig, ResolverOptions } from '../core/types';
import { loadState } from '../io/store';
import type { ConfigHealth, DetectedClient, DetectedGateway, DetectReport, EnvVarReport } from './api-types';

export interface DetectOptions {
  deps: CliDeps;
  configPath: string;
  additionalRoots?: readonly string[];
  /** When true, probe well-known LOOPBACK gateway ports. Default false. */
  probeGateways?: boolean;
}

const CLIENT_IDS: readonly ClientId[] = ['claude-code', 'opencode', 'codex'];

const CLIENT_BINARIES: Readonly<Record<ClientId, string>> = {
  'claude-code': 'claude',
  opencode: 'opencode',
  codex: 'codex',
};

// Wider than version-probe.ts's own 2000ms default: this runs on a console page load rather than
// a single CLI invocation, so a slightly longer bound per client is worth the better hit rate.
const CLIENT_VERSION_PROBE_TIMEOUT_MS = 3000;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function agentRootsFor(client: ClientId, options: ResolverOptions): Array<{ dir: string; scope: string }> {
  switch (client) {
    case 'claude-code':
      return claudeCodeAgentRoots(options);
    case 'opencode':
      return opencodeAgentRoots(options);
    case 'codex':
      return codexAgentRoots(options);
  }
}

// One inventory scan covers every root for the client; entries are attributed back to a root by
// matching the directory a file was read from, so this never re-derives the *.md/*.toml counting
// logic that already lives in claude-code.ts/opencode.ts/codex.ts.
async function detectAgentRoots(client: ClientId, options: ResolverOptions): Promise<DetectedClient['agentRoots']> {
  const roots = agentRootsFor(client, options);
  const inventory = await readAgentInventory(client, options);

  const result: DetectedClient['agentRoots'] = [];
  for (const root of roots) {
    if (!(await pathExists(root.dir))) continue;
    const agentCount = inventory.entries.filter((entry) => entry.path !== undefined && dirname(entry.path) === root.dir).length;
    result.push({ path: root.dir, scope: root.scope, agentCount });
  }
  return result;
}

function resolverOptionsFor(deps: CliDeps, additionalRoots: readonly string[], config: OperatorConfig | undefined, client: ClientId): ResolverOptions {
  const configRoot = config?.agentRoots[client].configRoot;
  return {
    cwd: deps.cwd,
    home: deps.home,
    env: deps.env,
    ...(configRoot !== null && configRoot !== undefined ? { configRoot } : {}),
    additionalRoots,
  };
}

async function detectClient(client: ClientId, deps: CliDeps, config: OperatorConfig | undefined, additionalRoots: readonly string[]): Promise<DetectedClient> {
  const binary = Bun.which(CLIENT_BINARIES[client]) ?? null;
  const version = binary === null ? null : ((await detectClientVersion(binary, CLIENT_VERSION_PROBE_TIMEOUT_MS)) ?? null);

  let profileStatus: DetectedClient['profileStatus'];
  try {
    profileStatus = (await deps.loadProfile(client, version ?? 'unspecified')).status;
  } catch (error) {
    if (error instanceof RouterError) profileStatus = 'unknown';
    else throw error;
  }

  const agentRoots = await detectAgentRoots(client, resolverOptionsFor(deps, additionalRoots, config, client));
  return { client, binary, version, profileStatus, agentRoots };
}

// Well-known default env var names when no config exists yet, taken from
// examples/minimal-router/subagent-router.json. Hardcoded rather than read from disk at runtime:
// that file ships in the repo, not in the published package, so a real install would find nothing
// to read there.
const DEFAULT_ENV_VARS: readonly { name: string; purpose: EnvVarReport['purpose'] }[] = [
  { name: 'ROUTER_GATEWAY_URL', purpose: 'gateway-url' },
  { name: 'ROUTER_GATEWAY_HEADERS', purpose: 'gateway-headers' },
  { name: 'ROUTER_GATEWAY_URL', purpose: 'models-base-url' },
  { name: 'ROUTER_MODELS_AUTH', purpose: 'models-auth' },
  { name: 'ROUTER_SECRET', purpose: 'correlation-secret' },
];

/** Env var report for a loaded config, or the well-known default names when no config exists. */
export function envReport(config: OperatorConfig | undefined, env: Env): EnvVarReport[] {
  const isPresent = (name: string): boolean => env[name] !== undefined && env[name] !== '';

  if (config === undefined) {
    return DEFAULT_ENV_VARS.map((entry) => ({ name: entry.name, purpose: entry.purpose, present: isPresent(entry.name) }));
  }

  const names: { name: string; purpose: EnvVarReport['purpose'] }[] = [
    { name: config.gateway.urlEnv, purpose: 'gateway-url' },
    ...config.gateway.headersEnv.map((name) => ({ name, purpose: 'gateway-headers' as const })),
    { name: config.modelSource.baseUrlEnv, purpose: 'models-base-url' },
    ...(config.modelSource.authEnv !== undefined ? [{ name: config.modelSource.authEnv, purpose: 'models-auth' as const }] : []),
    ...config.modelSource.headersEnv.map((name) => ({ name, purpose: 'models-headers' as const })),
    { name: config.harness.claudeCode.secretEnv, purpose: 'correlation-secret' },
  ];
  return names.map((entry) => ({ name: entry.name, purpose: entry.purpose, present: isPresent(entry.name) }));
}

const GATEWAY_CANDIDATES: readonly { url: string; label: string }[] = [
  { url: 'http://127.0.0.1:3456/v1', label: 'claude-code-router' },
  { url: 'http://127.0.0.1:8317/v1', label: 'cliproxyapi' },
  { url: 'http://127.0.0.1:4000/v1', label: 'litellm' },
  { url: 'http://127.0.0.1:11434/v1', label: 'ollama' },
  { url: 'http://127.0.0.1:8080/v1', label: 'local-gateway' },
];

const GATEWAY_PROBE_TIMEOUT_MS = 1500;

/**
 * Refuses any URL whose hostname is not a loopback address literal. This guards the hardcoded
 * candidate table above, not user input: a probe list is not allowed to grow a non-loopback entry
 * by accident, since that would make `detect` dial an arbitrary host. A failure here is a bug in
 * this file, not an environment problem, so it is never caught by the per-candidate probe below.
 */
export function assertLoopbackUrl(url: string): void {
  const hostname = new URL(url).hostname.toLowerCase();
  if (hostname !== '127.0.0.1' && hostname !== '::1' && hostname !== '[::1]') {
    throw new RouterError('detect-gateway-not-loopback', `${url} is not a loopback address literal`);
  }
}

async function probeOneGateway(fetchLike: FetchLike, candidate: { url: string; label: string }): Promise<DetectedGateway | null> {
  assertLoopbackUrl(candidate.url);
  try {
    const request = new Request(`${candidate.url}/models`, { method: 'GET', signal: AbortSignal.timeout(GATEWAY_PROBE_TIMEOUT_MS) });
    const response = await fetchLike(request);
    if (response.status !== 200) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;
    const data = (body as Record<string, unknown>).data;
    if (!Array.isArray(data)) return null;
    return { url: candidate.url, label: candidate.label, modelCount: data.length };
  } catch {
    // Any failure (refused connection, timeout, non-JSON body, ...) just means the candidate was
    // not found; it is never surfaced as an error to the caller.
    return null;
  }
}

async function probeGateways(fetchLike: FetchLike): Promise<DetectedGateway[]> {
  const results = await Promise.all(GATEWAY_CANDIDATES.map((candidate) => probeOneGateway(fetchLike, candidate)));
  return results.filter((result): result is DetectedGateway => result !== null);
}

async function readBundleRouterUrl(settingsPath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, 'utf8')) as { env?: { ANTHROPIC_BASE_URL?: unknown } };
    const url = parsed.env?.ANTHROPIC_BASE_URL;
    return typeof url === 'string' ? url : null;
  } catch {
    return null;
  }
}

// The same two-file shape `install` writes (see src/install/claude-code.ts). Checked in three
// places an operator is likely to have run install from: the current directory, a per-user
// location that survives across projects, and next to whichever config `detect` was asked about.
async function detectBundles(deps: CliDeps, configPath: string): Promise<DetectReport['bundles']> {
  const candidateDirs = [join(deps.cwd, 'router-bundle'), join(deps.home, '.subagent-router', 'bundle'), join(dirname(configPath), 'router-bundle')];
  const uniqueDirs = Array.from(new Set(candidateDirs));

  const bundles: DetectReport['bundles'] = [];
  for (const dir of uniqueDirs) {
    const hasSettings = await pathExists(join(dir, 'settings.json'));
    const hasLauncher = await pathExists(join(dir, 'claude-router'));
    if (!hasSettings || !hasLauncher) continue;
    bundles.push({ path: dir, routerUrl: await readBundleRouterUrl(join(dir, 'settings.json')) });
  }
  return bundles;
}

async function detectConfig(configPath: string): Promise<{ config: OperatorConfig | undefined; report: DetectReport['config'] }> {
  const exists = await pathExists(configPath);
  let health: ConfigHealth = 'missing';
  let snapshotPresent = false;
  let config: OperatorConfig | undefined;

  try {
    const state = await loadState(configPath);
    config = state.config;
    health = 'ok';
    snapshotPresent = state.snapshot !== undefined;
  } catch (error) {
    if (error instanceof RouterError) {
      health = error.code === 'config-missing' ? 'missing' : 'invalid';
    } else {
      throw error;
    }
  }

  return { config, report: { path: configPath, exists, health, snapshotPresent } };
}

export async function detect(options: DetectOptions): Promise<DetectReport> {
  const { deps, configPath } = options;
  const additionalRoots = options.additionalRoots ?? [];

  const { config, report: configReport } = await detectConfig(configPath);

  const [clients, gateways, bundles] = await Promise.all([
    Promise.all(CLIENT_IDS.map((client) => detectClient(client, deps, config, additionalRoots))),
    options.probeGateways === true ? probeGateways(deps.fetch) : Promise.resolve(null),
    detectBundles(deps, configPath),
  ]);

  return {
    clients,
    env: envReport(config, deps.env),
    gateways,
    bundles,
    config: configReport,
  };
}

/** A ready-to-write OperatorConfig scaffold. Pure, no IO. */
export function suggestConfig(input: {
  sourceId: string;
  endpointPath: string;
  gatewayUrlEnv: string;
  gatewayHeadersEnv: string[];
  modelsBaseUrlEnv: string;
  modelsAuthEnv?: string;
  modelsHeadersEnv: string[];
  correlationSecretEnv: string;
}): OperatorConfig {
  return {
    version: 1,
    modelSource: {
      sourceId: input.sourceId,
      baseUrlEnv: input.modelsBaseUrlEnv,
      endpointPath: input.endpointPath,
      ...(input.modelsAuthEnv !== undefined ? { authEnv: input.modelsAuthEnv } : {}),
      headersEnv: input.modelsHeadersEnv,
      timeoutMs: 10000,
      fetchLimit: 1000,
      staleAfterSeconds: 86400,
    },
    modelOverrides: {},
    roles: {},
    defaults: { child: null, unmarkedSubagent: 'error' },
    agentRoots: {
      'claude-code': { configRoot: null },
      opencode: { configRoot: null },
      codex: { configRoot: null },
    },
    gateway: { urlEnv: input.gatewayUrlEnv, headersEnv: input.gatewayHeadersEnv },
    harness: {
      claudeCode: { correlation: 'auto', secretEnv: input.correlationSecretEnv },
      // No dedicated providerId input: the source ID doubles as the OpenCode provider ID, same as
      // examples/minimal-router/subagent-router.json does.
      opencode: { providerId: input.sourceId },
      codex: { emitModelCatalog: false },
    },
  };
}
