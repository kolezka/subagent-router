// Task 13 write/mutation slice: models sync, models describe, doctor --connect, serve and
// config export CLI dispatch. Export itself lives in src/agents/export.ts; this file only wires
// its options and inventory lookup into the CLI.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { exportConfig } from '../agents/export';
import { readAgentInventory } from '../agents/inventory';
import { checkDiscoveryConnectivity } from '../catalog/discovery';
import { synchronize } from '../catalog/sync';
import { buildCatalog, resolveModel } from '../core/catalog';
import { RouterError } from '../core/errors';
import type { CliDeps, ClientId, OperatorConfig, ResolverOptions } from '../core/types';
import { resolveSource } from '../io/environment';
import { commitState, loadState } from '../io/store';
import type { ParsedArgs } from './args';
import { escapeControl, writeDiagnostic } from './output';
import { doctor, resolveConfigPath, type CommandResult } from './read';
import { startServer, type ServeHandle } from './serve';

// read.ts keeps its own copies of these tiny option helpers private (not exported); duplicating
// them here is cheaper and safer than exporting from a file this worktree does not own.
function stringOption(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options[name];
  return typeof value === 'string' ? value : undefined;
}

function requirePositional(parsed: ParsedArgs, index: number, label: string, usage: string): string {
  const value = parsed.positionals[index];
  if (value === undefined || value.length === 0) {
    throw new RouterError('usage-missing-argument', `${usage}: ${label} is required`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// models sync
// ---------------------------------------------------------------------------

export async function modelsSync(deps: CliDeps, parsed: ParsedArgs): Promise<CommandResult> {
  const configPath = resolveConfigPath(deps, parsed);
  const dryRun = parsed.options['dry-run'] === true;
  const allowEmpty = parsed.options['allow-empty'] === true;

  const result = await synchronize(configPath, { env: deps.env, fetch: deps.fetch, now: deps.now, allowEmpty, dryRun });

  const payload = { added: result.added, changed: result.changed, missing: result.missing, dryRun, fetchedAt: result.snapshot.fetchedAt };
  // Discovered IDs are gateway-controlled, opaque strings, same as every other catalogue-derived
  // value this CLI prints -- escaped for the terminal here too. `payload` above (JSON output)
  // still carries the exact, unmodified IDs.
  const escapedList = (ids: readonly string[]): string => (ids.length === 0 ? '(none)' : ids.map((id) => escapeControl(id)).join(', '));
  const human = () =>
    `${[
      `added: ${escapedList(result.added)}`,
      `changed: ${escapedList(result.changed)}`,
      `missing: ${escapedList(result.missing)}`,
      ...(dryRun ? ['dry-run: no snapshot written'] : []),
    ].join('\n')}\n`;
  return { code: 0, payload, human };
}

// ---------------------------------------------------------------------------
// models describe
// ---------------------------------------------------------------------------

/**
 * Sets or clears a model's local description in modelOverrides. `reference` is resolved through
 * the effective catalog (buildCatalog + resolveModel), which already covers a snapshot model
 * with status "missing": it stays in catalog.byId with enabled:false, so describing it works the
 * same as describing an available model. `description: null` clears the field only, leaving any
 * other override (alias, enabled, clientModel) untouched.
 */
export async function describeModel(configPath: string, reference: string, description: string | null): Promise<void> {
  const state = await loadState(configPath);
  if (state.snapshot === undefined) {
    throw new RouterError('snapshot-missing', 'models describe requires a models.lock.json snapshot; run `models sync` to create one');
  }
  const catalog = buildCatalog(state.config, state.snapshot);
  const model = resolveModel(reference, catalog); // throws RouterError('unknown-model', ...) -> exit 2

  const nextConfig: OperatorConfig = structuredClone(state.config);
  const existing = nextConfig.modelOverrides[model.id];

  if (description === null) {
    if (existing !== undefined) {
      const { description: _drop, ...rest } = existing;
      if (Object.keys(rest).length === 0) {
        delete nextConfig.modelOverrides[model.id];
      } else {
        nextConfig.modelOverrides[model.id] = rest;
      }
    }
  } else {
    nextConfig.modelOverrides[model.id] = { ...existing, description };
  }

  await commitState(configPath, state, { config: nextConfig });
}

export async function modelsDescribe(deps: CliDeps, parsed: ParsedArgs): Promise<CommandResult> {
  const reference = requirePositional(parsed, 0, 'id-or-alias', 'models describe <id-or-alias>');
  const text = stringOption(parsed, 'text');
  const file = stringOption(parsed, 'file');
  const clear = parsed.options.clear === true;

  const modeCount = [text !== undefined, file !== undefined, clear].filter(Boolean).length;
  if (modeCount !== 1) {
    throw new RouterError('usage-describe-mode', 'models describe <id-or-alias>: exactly one of --text, --file, --clear is required');
  }

  let description: string | null;
  if (clear) {
    description = null;
  } else if (text !== undefined) {
    description = text;
  } else {
    // --file: read the description from disk. Only a single trailing newline is trimmed (the
    // one an editor or `echo` adds), so meaningful leading/trailing spaces in the text survive.
    const raw = await readFile(resolve(deps.cwd, file as string), 'utf8');
    description = raw.replace(/\r?\n$/, '');
  }

  const configPath = resolveConfigPath(deps, parsed);
  await describeModel(configPath, reference, description);

  const payload = { id: reference, description };
  const human = () => `${description === null ? `cleared description for ${escapeControl(reference)}` : `set description for ${escapeControl(reference)}`}\n`;
  return { code: 0, payload, human };
}

// ---------------------------------------------------------------------------
// doctor --connect
// ---------------------------------------------------------------------------

// Mirrors main.ts's private isUsageOrConfigCode classification. Duplicated here (not exported
// from main.ts) because this fix is scoped to doctorConnect only. A connectivity failure is
// caught and folded into the payload here, so main.ts's own catch block never sees it and never
// gets a chance to classify it; doctorConnect has to do that classification itself.
function isUsageOrConfigCode(code: string): boolean {
  return code.startsWith('config-') || code.startsWith('snapshot-') || code === 'unknown-model' || code === 'agent-unknown' || code.startsWith('usage-');
}

/**
 * Extends the offline `doctor` report with one real connectivity check: a single discovery page,
 * fetched and validated, nothing written. A connectivity failure is reported in the payload, not
 * thrown, so the full report always comes back on stdout -- but it is not silently swallowed
 * either: `network` reflects that a real attempt was made (true, whether it succeeded or failed),
 * a failure still gets a visible `subagent-router: <code>: <message>` line on stderr like every
 * other RouterError in this CLI (through writeDiagnostic, so a gateway- or argument-controlled
 * value in the message can never inject raw terminal control bytes), and the exit code follows
 * the same usage/config-vs-operational split main.ts uses everywhere else (2 for a config/
 * snapshot/usage problem, 1 for anything else, for example an auth or HTTP failure, or the
 * network being unreachable, talking to the gateway).
 *
 * A raw fetch rejection (unreachable gateway, DNS failure, the discovery timeout firing) is not a
 * RouterError. It is handled here, at this command boundary, not inside the shared discovery
 * client: caught, classified as an operational connectivity failure (never rethrown, which would
 * discard the offline `base` report already built above), and reported with a fixed, safe label
 * rather than the raw error text, since depending on the runtime that text can embed connection
 * details or credentials from the configured URL.
 */
export async function doctorConnect(deps: CliDeps, parsed: ParsedArgs): Promise<CommandResult> {
  const base = await doctor(deps, parsed);

  let connectivity: { ok: true; modelCount: number; hasMore: boolean } | { ok: false; error: string };
  let code: 0 | 1 | 2 = 0;
  // Only set once the connectivity check is actually about to call deps.fetch: distinguishes "no
  // request was ever attempted" (a config/usage problem resolved first, e.g. a missing config
  // file or a missing gateway env var) from "a request was attempted", success or failure.
  let attemptedNetwork = false;
  try {
    const configPath = resolveConfigPath(deps, parsed);
    const state = await loadState(configPath);
    const source = resolveSource(state.config, deps.env);
    attemptedNetwork = true;
    const check = await checkDiscoveryConnectivity(state.config, source, deps.fetch);
    connectivity = { ok: true, modelCount: check.modelCount, hasMore: check.hasMore };
  } catch (error) {
    if (error instanceof RouterError) {
      connectivity = { ok: false, error: error.code };
      code = isUsageOrConfigCode(error.code) ? 2 : 1;
      writeDiagnostic(deps, `subagent-router: ${error.code}: ${error.message}`);
    } else {
      const label = error instanceof DOMException && error.name === 'TimeoutError' ? 'discovery-timeout' : 'discovery-unreachable';
      connectivity = { ok: false, error: label };
      code = 1;
      writeDiagnostic(deps, `subagent-router: ${label}: could not reach the configured discovery endpoint`);
    }
  }

  // --connect always makes a real attempt when it gets that far, success or failure: the base
  // doctor report's `network: false` ("never dials out") no longer holds and must not be
  // forwarded as-is.
  const payload = { ...(base.payload as Record<string, unknown>), network: true, connectivity };
  const human = () => {
    // base.human()'s first line is a literal "network: false (offline diagnostics only)" baked
    // into read.ts, which this worktree does not own. Substituting it here (rather than
    // reimplementing the rest of doctor's human-text layout) keeps the fix scoped to this file.
    const networkLine = attemptedNetwork
      ? 'network: true (connectivity check performed)'
      : 'network: true (connectivity check requested, not attempted)';
    const offlineReport = base.human().replace('network: false (offline diagnostics only)', networkLine);
    return `${offlineReport}connectivity: ${
      connectivity.ok ? `ok (${connectivity.modelCount} models${connectivity.hasMore ? ', more available' : ''})` : `problem (${connectivity.error})`
    }\n`;
  };
  return { code, payload, human };
}

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

export interface ServeOptions {
  port: number;
  host: string;
  claudeVersion?: string;
}

// No canonical default port is specified anywhere in the design doc; 8787 matches the existing
// scripts/poc-serve.ts convention in this same repo, so `serve` and the PoC entrypoint agree.
const DEFAULT_SERVE_PORT = 8787;
const DEFAULT_SERVE_HOST = '127.0.0.1';

export function resolveServeOptions(deps: CliDeps, parsed: ParsedArgs): ServeOptions {
  const portRaw = stringOption(parsed, 'port');
  let port = DEFAULT_SERVE_PORT;
  if (portRaw !== undefined) {
    port = Number(portRaw);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new RouterError('usage-invalid-port', `--port must be an integer between 0 and 65535, got ${JSON.stringify(portRaw)}`);
    }
  }
  const host = stringOption(parsed, 'host') ?? DEFAULT_SERVE_HOST;
  const claudeVersion = stringOption(parsed, 'claude-version');
  return { port, host, ...(claudeVersion !== undefined ? { claudeVersion } : {}) };
}

/**
 * Starts the server and also returns the handle, for callers (tests) that need to stop it.
 * `serveCommand` below is the thin CLI-facing wrapper that only returns the CommandResult:
 * `runCli` prints it and returns, and the process stays alive on its own because of the open
 * listener, the same way any other Bun.serve-based CLI does. No process manager, no signal
 * handling and no daemonizing live here; a real executable entrypoint owns that, not this file.
 */
export async function startServeCommand(deps: CliDeps, parsed: ParsedArgs): Promise<{ result: CommandResult; server: ServeHandle }> {
  const configPath = resolveConfigPath(deps, parsed);
  const options = resolveServeOptions(deps, parsed);
  const server = await startServer(configPath, deps, options);
  const payload = { url: server.url, generation: server.generation, host: options.host, port: options.port };
  const human = () => `listening on ${server.url} (generation ${server.generation})\n`;
  return { result: { code: 0, payload, human }, server };
}

export async function serveCommand(deps: CliDeps, parsed: ParsedArgs): Promise<CommandResult> {
  const { result } = await startServeCommand(deps, parsed);
  return result;
}

// ---------------------------------------------------------------------------
// config export
// ---------------------------------------------------------------------------

// Duplicated from read.ts (private there; same reasoning as the option helpers at the top of
// this file): client validation and the resolver-options recipe export's agent inventory needs.
const CLIENT_IDS: readonly ClientId[] = ['claude-code', 'opencode', 'codex'];

function isClientId(value: unknown): value is ClientId {
  return typeof value === 'string' && (CLIENT_IDS as readonly string[]).includes(value);
}

function requireClient(parsed: ParsedArgs, usage: string): ClientId {
  const value = stringOption(parsed, 'client');
  if (!isClientId(value)) {
    throw new RouterError('usage-missing-client', `${usage}: --client <claude-code|opencode|codex> is required`);
  }
  return value;
}

function resolverOptionsFor(deps: CliDeps, parsed: ParsedArgs, config: OperatorConfig, client: ClientId): ResolverOptions {
  const configRoot = config.agentRoots[client].configRoot;
  return {
    cwd: deps.cwd,
    home: deps.home,
    env: deps.env,
    ...(configRoot !== null ? { configRoot } : {}),
    additionalRoots: parsed.additionalRoots,
  };
}

/**
 * Exports one client's config as a read-only artifact tree. `--output` is required and resolved
 * relative to cwd, like every other path option in this CLI. The agent inventory is read for the
 * SAME client being exported, through the same cwd/home/env/configRoot/additionalRoots recipe
 * read.ts's own commands use, so an export never sees a different agent root set than
 * `agents list`/`agents show` would for the same invocation. `catalogRequired` is always false
 * here: exportConfig already forces a catalog for opencode on its own, and no CLI option asks for
 * it on the other two clients.
 */
export async function configExport(deps: CliDeps, parsed: ParsedArgs): Promise<CommandResult> {
  const client = requireClient(parsed, 'config export');
  const outputRaw = stringOption(parsed, 'output');
  if (outputRaw === undefined || outputRaw.length === 0) {
    throw new RouterError('usage-missing-output', 'config export --client <c> --output <dir>: --output <dir> is required');
  }
  const outputDir = resolve(deps.cwd, outputRaw);
  const dryRun = parsed.options['dry-run'] === true;
  const force = parsed.options.force === true;

  const configPath = resolveConfigPath(deps, parsed);
  const state = await loadState(configPath);
  const inventory = await readAgentInventory(client, resolverOptionsFor(deps, parsed, state.config, client));

  const files = await exportConfig(configPath, client, outputDir, {
    dryRun,
    force,
    inventory,
    catalogRequired: false,
    resolverContext: { cwd: deps.cwd, home: deps.home, env: deps.env, additionalRoots: parsed.additionalRoots },
  });

  const payload = { client, output: outputDir, dryRun, force, files: files.map((file) => file.relativePath) };
  const human = () =>
    `${[
      `client: ${client}`,
      `output: ${escapeControl(outputDir)}`,
      ...(dryRun ? ['dry-run: no files written'] : []),
      ...files.map((file) => `  ${escapeControl(file.relativePath)}`),
    ].join('\n')}\n`;
  return { code: 0, payload, human };
}
