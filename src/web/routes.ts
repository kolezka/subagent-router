// The console's endpoint table. Every entry either mirrors a CLI command exactly (so the console
// can never report something `subagent-router` itself would not) or drives one of the console-only
// modules: detect, mutate, supervisor, events.
//
// Request bodies arrive as untrusted JSON, so each write endpoint decodes its body field by field
// through the small readers below. The types in api-types.ts are a compile-time contract with the
// Svelte app, not a runtime guarantee about what a client sent.
import { join, resolve } from 'node:path';
import type { ParsedArgs } from '../cli/args';
import { installCommand } from '../cli/install';
import { agentsList, configCheck, configShow, doctor, modelsList, resolveConfigPath, routePreview, type CommandResult } from '../cli/read';
import { modelsSync } from '../cli/write';
import { RouterError } from '../core/errors';
import type { CliDeps, ClientId } from '../core/types';
import type { SystemStatus } from './api-types';
import { detect, suggestConfig } from './detect';
import type { EventLog } from './events';
import { initConfig, setAgentRoot, setDefaults, setModelOverride, setRole, setSource } from './mutate';
import { systemStatus } from './status';
import type { RouterSupervisor } from './supervisor';

const CLIENT_IDS: readonly ClientId[] = ['claude-code', 'opencode', 'codex'];

/**
 * What a route handler is given. `configPath` and `supervisor` are functions rather than values
 * because `config/init` can point the console at a file that did not exist when it started; a
 * captured string would leave every later request reading the old path.
 */
export interface RouteContext {
  deps: CliDeps;
  /** The ParsedArgs the console was started with. Carries --agents-dir through to read commands. */
  base: ParsedArgs;
  log: EventLog;
  readOnly: boolean;
  console: SystemStatus['console'];
  configPath: () => string;
  supervisor: () => RouterSupervisor;
  retarget: (configPath: string) => Promise<void>;
}

export interface RouteInput {
  url: URL;
  /** Parsed JSON body for a POST, `undefined` for a GET. */
  body: unknown;
}

export interface RouteOutcome {
  code: 0 | 1 | 2;
  payload: unknown;
}

export interface Route {
  method: 'GET' | 'POST';
  /** Echoed in the response envelope so the console can label a result. */
  command: string;
  /** True for anything that writes a file, starts a process or dials out. Refused in read-only mode. */
  write?: boolean;
  handler: (ctx: RouteContext, input: RouteInput) => Promise<RouteOutcome>;
}

// ---------------------------------------------------------------------------
// Body readers
// ---------------------------------------------------------------------------

function bad(message: string): never {
  throw new RouterError('web-bad-request', message);
}

function fields(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) bad('the request body must be a JSON object');
  return body as Record<string, unknown>;
}

function requiredString(source: Record<string, unknown>, name: string): string {
  const value = source[name];
  if (typeof value !== 'string' || value.length === 0) bad(`${name} must be a non-empty string`);
  return value as string;
}

function optionalString(source: Record<string, unknown>, name: string): string | undefined {
  const value = source[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') bad(`${name} must be a string`);
  return value as string;
}

/** Absent stays absent, `null` means "clear this field", a string sets it. */
function patchString(source: Record<string, unknown>, name: string): string | null | undefined {
  const value = source[name];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') bad(`${name} must be a string or null`);
  return value as string;
}

function requiredPatchString(source: Record<string, unknown>, name: string): string | null {
  const value = patchString(source, name);
  if (value === undefined) bad(`${name} is required and must be a string or null`);
  return value as string | null;
}

function optionalBoolean(source: Record<string, unknown>, name: string): boolean | undefined {
  const value = source[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') bad(`${name} must be a boolean`);
  return value;
}

function patchBoolean(source: Record<string, unknown>, name: string): boolean | null | undefined {
  const value = source[name];
  if (value === undefined || value === null) return value as null | undefined;
  if (typeof value !== 'boolean') bad(`${name} must be a boolean or null`);
  return value;
}

function optionalInteger(source: Record<string, unknown>, name: string): number | undefined {
  const value = source[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) bad(`${name} must be a non-negative integer`);
  return value as number;
}

function optionalStringArray(source: Record<string, unknown>, name: string): string[] | undefined {
  const value = source[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) bad(`${name} must be an array of strings`);
  return [...(value as string[])];
}

function requiredStringArray(source: Record<string, unknown>, name: string): string[] {
  return optionalStringArray(source, name) ?? bad(`${name} must be an array of strings`);
}

function requiredClient(source: Record<string, unknown>, name: string): ClientId {
  const value = requiredString(source, name);
  if (!(CLIENT_IDS as readonly string[]).includes(value)) bad(`${name} must be one of ${CLIENT_IDS.join(', ')}`);
  return value as ClientId;
}

function requiredGeneration(source: Record<string, unknown>): string {
  return requiredString(source, 'expectedGeneration');
}

// ---------------------------------------------------------------------------
// CLI bridging
// ---------------------------------------------------------------------------

/**
 * Builds the ParsedArgs a CLI command expects. The console's own `--config` and `--agents-dir` are
 * always carried through, so an endpoint inspects exactly the installation the console was pointed
 * at. Only the named parameters are copied; anything else in the query string is dropped rather
 * than handed to a command that never asked for it.
 */
function argsFor(ctx: RouteContext, values: Record<string, string | boolean | undefined>): ParsedArgs {
  const options: Record<string, string | boolean> = { config: ctx.configPath() };
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) options[name] = value;
  }
  return { command: [], options, positionals: [], additionalRoots: ctx.base.additionalRoots };
}

function fromQuery(ctx: RouteContext, url: URL, names: readonly string[]): ParsedArgs {
  const values: Record<string, string | undefined> = {};
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value !== null) values[name] = value;
  }
  return argsFor(ctx, values);
}

function asOutcome(result: CommandResult): RouteOutcome {
  // `code` is the CLI's own exit code and is reported as data: a config check that found problems
  // (code 2) is a successful inspection, not a failed request.
  return { code: result.code, payload: result.payload };
}

// ---------------------------------------------------------------------------
// Handlers that are not a straight CLI command
// ---------------------------------------------------------------------------

async function handleStatus(ctx: RouteContext): Promise<RouteOutcome> {
  const payload = await systemStatus({
    deps: ctx.deps,
    parsed: argsFor(ctx, {}),
    configPath: ctx.configPath(),
    supervisor: ctx.supervisor(),
    console: ctx.console,
  });
  return { code: 0, payload };
}

async function handleDetect(ctx: RouteContext, { url }: RouteInput): Promise<RouteOutcome> {
  // Probing is opt-in: it dials loopback ports, which is a side effect an operator should ask for
  // rather than get from every page load.
  const probe = url.searchParams.get('probe') === '1';
  const payload = await detect({
    deps: ctx.deps,
    configPath: ctx.configPath(),
    additionalRoots: ctx.base.additionalRoots,
    probeGateways: probe,
  });
  return { code: 0, payload };
}

async function handleConfigInit(ctx: RouteContext, { body }: RouteInput): Promise<RouteOutcome> {
  const source = fields(body);
  const scope = requiredString(source, 'scope');
  if (scope !== 'project' && scope !== 'home') bad('scope must be "project" or "home"');

  const modelsAuthEnv = optionalString(source, 'modelsAuthEnv');
  const config = suggestConfig({
    sourceId: requiredString(source, 'sourceId'),
    endpointPath: requiredString(source, 'endpointPath'),
    gatewayUrlEnv: requiredString(source, 'gatewayUrlEnv'),
    gatewayHeadersEnv: requiredStringArray(source, 'gatewayHeadersEnv'),
    modelsBaseUrlEnv: requiredString(source, 'modelsBaseUrlEnv'),
    ...(modelsAuthEnv !== undefined ? { modelsAuthEnv } : {}),
    modelsHeadersEnv: requiredStringArray(source, 'modelsHeadersEnv'),
    correlationSecretEnv: requiredString(source, 'correlationSecretEnv'),
  });

  // 'project' honours the --config the console was started with; only 'home' picks its own path.
  const target = scope === 'home' ? join(ctx.deps.home, '.subagent-router', 'subagent-router.json') : ctx.configPath();
  const payload = await initConfig({ configPath: target, config, force: optionalBoolean(source, 'force') === true });
  await ctx.retarget(payload.configPath);
  return { code: 0, payload };
}

async function handleModelOverride(ctx: RouteContext, { body }: RouteInput): Promise<RouteOutcome> {
  const source = fields(body);
  const alias = patchString(source, 'alias');
  const description = patchString(source, 'description');
  const clientModel = patchString(source, 'clientModel');
  const enabled = patchBoolean(source, 'enabled');
  const payload = await setModelOverride(ctx.configPath(), {
    expectedGeneration: requiredGeneration(source),
    reference: requiredString(source, 'reference'),
    ...(alias !== undefined ? { alias } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(clientModel !== undefined ? { clientModel } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  });
  return { code: 0, payload };
}

async function handleRole(ctx: RouteContext, { body }: RouteInput): Promise<RouteOutcome> {
  const source = fields(body);
  const payload = await setRole(ctx.configPath(), {
    expectedGeneration: requiredGeneration(source),
    client: requiredClient(source, 'client'),
    agent: requiredString(source, 'agent'),
    routeOverride: requiredPatchString(source, 'routeOverride'),
  });
  return { code: 0, payload };
}

async function handleDefaults(ctx: RouteContext, { body }: RouteInput): Promise<RouteOutcome> {
  const source = fields(body);
  const child = patchString(source, 'child');
  const unmarked = optionalString(source, 'unmarkedSubagent');
  if (unmarked !== undefined && unmarked !== 'error' && unmarked !== 'inherit') bad('unmarkedSubagent must be "error" or "inherit"');
  const acknowledged = optionalBoolean(source, 'unmarkedSubagentAcknowledged');
  const payload = await setDefaults(ctx.configPath(), {
    expectedGeneration: requiredGeneration(source),
    ...(child !== undefined ? { child } : {}),
    ...(unmarked !== undefined ? { unmarkedSubagent: unmarked } : {}),
    ...(acknowledged !== undefined ? { unmarkedSubagentAcknowledged: acknowledged } : {}),
  });
  return { code: 0, payload };
}

async function handleSource(ctx: RouteContext, { body }: RouteInput): Promise<RouteOutcome> {
  const source = fields(body);
  const sourceId = optionalString(source, 'sourceId');
  const endpointPath = optionalString(source, 'endpointPath');
  const timeoutMs = optionalInteger(source, 'timeoutMs');
  const fetchLimit = optionalInteger(source, 'fetchLimit');
  const staleAfterSeconds = optionalInteger(source, 'staleAfterSeconds');
  const gatewayUrlEnv = optionalString(source, 'gatewayUrlEnv');
  const gatewayHeadersEnv = optionalStringArray(source, 'gatewayHeadersEnv');
  const modelsBaseUrlEnv = optionalString(source, 'modelsBaseUrlEnv');
  const modelsAuthEnv = patchString(source, 'modelsAuthEnv');
  const modelsHeadersEnv = optionalStringArray(source, 'modelsHeadersEnv');
  const correlationSecretEnv = optionalString(source, 'correlationSecretEnv');
  const correlation = optionalString(source, 'correlation');
  if (correlation !== undefined && correlation !== 'auto' && correlation !== 'off') bad('correlation must be "auto" or "off"');

  const payload = await setSource(ctx.configPath(), {
    expectedGeneration: requiredGeneration(source),
    ...(sourceId !== undefined ? { sourceId } : {}),
    ...(endpointPath !== undefined ? { endpointPath } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(fetchLimit !== undefined ? { fetchLimit } : {}),
    ...(staleAfterSeconds !== undefined ? { staleAfterSeconds } : {}),
    ...(gatewayUrlEnv !== undefined ? { gatewayUrlEnv } : {}),
    ...(gatewayHeadersEnv !== undefined ? { gatewayHeadersEnv } : {}),
    ...(modelsBaseUrlEnv !== undefined ? { modelsBaseUrlEnv } : {}),
    ...(modelsAuthEnv !== undefined ? { modelsAuthEnv } : {}),
    ...(modelsHeadersEnv !== undefined ? { modelsHeadersEnv } : {}),
    ...(correlationSecretEnv !== undefined ? { correlationSecretEnv } : {}),
    ...(correlation !== undefined ? { correlation } : {}),
  });
  return { code: 0, payload };
}

async function handleAgentRoot(ctx: RouteContext, { body }: RouteInput): Promise<RouteOutcome> {
  const source = fields(body);
  const payload = await setAgentRoot(ctx.configPath(), {
    expectedGeneration: requiredGeneration(source),
    client: requiredClient(source, 'client'),
    configRoot: requiredPatchString(source, 'configRoot'),
  });
  return { code: 0, payload };
}

async function handleModelsSync(ctx: RouteContext, { body }: RouteInput): Promise<RouteOutcome> {
  const source = fields(body);
  return asOutcome(
    await modelsSync(
      ctx.deps,
      argsFor(ctx, {
        ...(optionalBoolean(source, 'dryRun') === true ? { 'dry-run': true } : {}),
        ...(optionalBoolean(source, 'allowEmpty') === true ? { 'allow-empty': true } : {}),
      }),
    ),
  );
}

function startOptions(body: unknown): { port?: number; host?: string; claudeVersion?: string } {
  const source = fields(body);
  const port = optionalInteger(source, 'port');
  const host = optionalString(source, 'host');
  const claudeVersion = optionalString(source, 'claudeVersion');
  return {
    ...(port !== undefined ? { port } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(claudeVersion !== undefined ? { claudeVersion } : {}),
  };
}

async function handleRouterStart(ctx: RouteContext, { body }: RouteInput): Promise<RouteOutcome> {
  return { code: 0, payload: await ctx.supervisor().start(startOptions(body)) };
}

async function handleRouterStop(ctx: RouteContext): Promise<RouteOutcome> {
  return { code: 0, payload: await ctx.supervisor().stop() };
}

async function handleRouterRestart(ctx: RouteContext, { body }: RouteInput): Promise<RouteOutcome> {
  return { code: 0, payload: await ctx.supervisor().restart(startOptions(body)) };
}

async function handleInstall(ctx: RouteContext, { body }: RouteInput): Promise<RouteOutcome> {
  const source = fields(body);
  const port = optionalInteger(source, 'port');
  const host = optionalString(source, 'host');
  const claudeVersion = optionalString(source, 'claudeVersion');
  const parentModel = optionalString(source, 'parentModel');
  const result = await installCommand(
    ctx.deps,
    argsFor(ctx, {
      output: resolve(ctx.deps.cwd, requiredString(source, 'output')),
      ...(port !== undefined ? { port: String(port) } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(claudeVersion !== undefined ? { 'claude-version': claudeVersion } : {}),
      ...(parentModel !== undefined ? { 'parent-model': parentModel } : {}),
      ...(optionalBoolean(source, 'force') === true ? { force: true } : {}),
      ...(optionalBoolean(source, 'dryRun') === true ? { 'dry-run': true } : {}),
    }),
  );
  return asOutcome(result);
}

async function handleEvents(ctx: RouteContext, { url }: RouteInput): Promise<RouteOutcome> {
  const afterRaw = url.searchParams.get('after');
  // Digits only: plain Number() accepts '0x10', '1e3' and ' 5 ', which would silently skip events.
  const after = afterRaw !== null && /^\d{1,15}$/.test(afterRaw) ? Number(afterRaw) : 0;
  return { code: 0, payload: ctx.log.since(after) };
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export const ROUTES: Readonly<Record<string, Route>> = {
  '/api/system/status': { method: 'GET', command: 'status', handler: handleStatus },
  '/api/detect': { method: 'GET', command: 'detect', handler: handleDetect },
  '/api/config/show': { method: 'GET', command: 'config show', handler: (ctx) => configShow(ctx.deps, argsFor(ctx, {})).then(asOutcome) },
  '/api/config/check': { method: 'GET', command: 'config check', handler: (ctx) => configCheck(ctx.deps, argsFor(ctx, {})).then(asOutcome) },
  '/api/models': { method: 'GET', command: 'models list', handler: (ctx) => modelsList(ctx.deps, argsFor(ctx, {})).then(asOutcome) },
  '/api/agents': {
    method: 'GET',
    command: 'agents list',
    handler: (ctx, input) => agentsList(ctx.deps, fromQuery(ctx, input.url, ['client'])).then(asOutcome),
  },
  '/api/route/preview': {
    method: 'GET',
    command: 'route preview',
    handler: (ctx, input) => routePreview(ctx.deps, fromQuery(ctx, input.url, ['client', 'agent', 'model', 'parent-model'])).then(asOutcome),
  },
  '/api/doctor': { method: 'GET', command: 'doctor', handler: (ctx) => doctor(ctx.deps, argsFor(ctx, {})).then(asOutcome) },
  '/api/events': { method: 'GET', command: 'events', handler: handleEvents },

  '/api/config/init': { method: 'POST', command: 'config init', write: true, handler: handleConfigInit },
  '/api/config/models/override': { method: 'POST', command: 'models override', write: true, handler: handleModelOverride },
  '/api/config/roles': { method: 'POST', command: 'config role', write: true, handler: handleRole },
  '/api/config/defaults': { method: 'POST', command: 'config defaults', write: true, handler: handleDefaults },
  '/api/config/source': { method: 'POST', command: 'config source', write: true, handler: handleSource },
  '/api/config/agent-root': { method: 'POST', command: 'config agent-root', write: true, handler: handleAgentRoot },
  '/api/models/sync': { method: 'POST', command: 'models sync', write: true, handler: handleModelsSync },
  '/api/router/start': { method: 'POST', command: 'router start', write: true, handler: handleRouterStart },
  '/api/router/stop': { method: 'POST', command: 'router stop', write: true, handler: handleRouterStop },
  '/api/router/restart': { method: 'POST', command: 'router restart', write: true, handler: handleRouterRestart },
  '/api/install': { method: 'POST', command: 'install', write: true, handler: handleInstall },
};

/** Path of the live event stream. Handled by the server itself: it is not a JSON envelope. */
export const EVENT_STREAM_PATH = '/api/events/stream';

/** Exported so the console's own config path stays the one `resolveConfigPath` would pick. */
export function defaultConfigPath(deps: CliDeps, parsed: ParsedArgs): string {
  return resolveConfigPath(deps, parsed);
}
