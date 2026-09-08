import { resolve } from 'node:path';
import { getAgent, readAgentInventory } from '../agents/inventory';
import { buildCatalog, resolveModel } from '../core/catalog';
import { RouterError } from '../core/errors';
import { resolveRoute } from '../core/route';
import type {
  AgentInventory,
  CapabilityProfile,
  ClientId,
  CliDeps,
  EffectiveCatalog,
  LoadedState,
  OperatorConfig,
  ResolverOptions,
  RouteDecision,
  RouteInput,
} from '../core/types';
import { loadState } from '../io/store';
import type { ParsedArgs } from './args';
import { escapeControl } from './output';

export interface CommandResult {
  code: 0 | 1 | 2;
  payload: unknown;
  human: () => string;
}

const CLIENT_IDS: readonly ClientId[] = ['claude-code', 'opencode', 'codex'];

function isClientId(value: unknown): value is ClientId {
  return typeof value === 'string' && (CLIENT_IDS as readonly string[]).includes(value);
}

function stringOption(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options[name];
  return typeof value === 'string' ? value : undefined;
}

function requireClient(parsed: ParsedArgs, usage: string): ClientId {
  const value = stringOption(parsed, 'client');
  if (!isClientId(value)) {
    throw new RouterError('usage-missing-client', `${usage}: --client <claude-code|opencode|codex> is required`);
  }
  return value;
}

function requireAgent(parsed: ParsedArgs, usage: string): string {
  const value = stringOption(parsed, 'agent');
  if (value === undefined || value.length === 0) {
    throw new RouterError('usage-missing-agent', `${usage}: --agent <name> is required`);
  }
  return value;
}

function requirePositional(parsed: ParsedArgs, index: number, label: string, usage: string): string {
  const value = parsed.positionals[index];
  if (value === undefined || value.length === 0) {
    throw new RouterError('usage-missing-argument', `${usage}: ${label} is required`);
  }
  return value;
}

/** Default is `<cwd>/subagent-router.json`; `--config` is resolved relative to cwd when not absolute. */
export function resolveConfigPath(deps: CliDeps, parsed: ParsedArgs): string {
  const configOption = stringOption(parsed, 'config');
  return resolve(deps.cwd, configOption ?? 'subagent-router.json');
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

// ---------------------------------------------------------------------------
// models list / models show
// ---------------------------------------------------------------------------

async function requireCatalog(deps: CliDeps, parsed: ParsedArgs, action: string): Promise<{ state: LoadedState; catalog: EffectiveCatalog }> {
  const state = await loadState(resolveConfigPath(deps, parsed));
  if (state.snapshot === undefined) {
    throw new RouterError('snapshot-missing', `${action} requires a models.lock.json snapshot; run \`models sync\` to create one`);
  }
  return { state, catalog: buildCatalog(state.config, state.snapshot) };
}

export async function modelsList(deps: CliDeps, parsed: ParsedArgs): Promise<CommandResult> {
  const { state, catalog } = await requireCatalog(deps, parsed, 'models list');
  // Insertion order in buildCatalog's Map follows snapshot.models order, so this listing is
  // stable and matches the snapshot's own ordering without a separate sort step.
  const models = Array.from(catalog.byId.values());
  const payload = { models, fetchedAt: state.snapshot?.fetchedAt, generation: state.generation };
  const human = () =>
    `${models
      .map((m) => `${m.id}\t${escapeControl(m.alias)}\t${m.status}${m.enabled ? '' : '\t(disabled)'}${m.description !== undefined ? `\t${escapeControl(m.description)}` : ''}`)
      .join('\n')}\n`;
  return { code: 0, payload, human };
}

export async function modelsShow(deps: CliDeps, parsed: ParsedArgs): Promise<CommandResult> {
  const ref = requirePositional(parsed, 0, 'id-or-alias', 'models show <id-or-alias>');
  const { catalog } = await requireCatalog(deps, parsed, 'models show');
  const model = resolveModel(ref, catalog); // throws RouterError('unknown-model', ...) -> exit 2
  const human = () =>
    `${model.id}\t${escapeControl(model.alias)}\t${model.status}${model.enabled ? '' : '\t(disabled)'}${model.description !== undefined ? `\t${escapeControl(model.description)}` : ''}\n`;
  return { code: 0, payload: model, human };
}

// ---------------------------------------------------------------------------
// agents list / agents show
// ---------------------------------------------------------------------------

export async function agentsList(deps: CliDeps, parsed: ParsedArgs): Promise<CommandResult> {
  const client = requireClient(parsed, 'agents list');
  const state = await loadState(resolveConfigPath(deps, parsed));
  // Agent inspection never requires a models.lock.json snapshot: it only reads agent
  // definition files, which exist independently of the model catalog.
  const inventory = await readAgentInventory(client, resolverOptionsFor(deps, parsed, state.config, client));
  // Every entry is shown, including shadowed/hidden/fileless ones: inspection must not hide
  // broken or inactive references behind a single catalog-wide error.
  const agents = inventory.entries.map((entry) => ({
    name: entry.name,
    client: entry.client,
    scope: entry.scope,
    declaredModel: entry.declaredModel ?? 'unknown',
    hidden: entry.hidden,
    availability: entry.availability,
    shadowed: entry.shadowed,
  }));
  const payload = { agents, completeness: inventory.completeness, diagnostics: inventory.diagnostics };
  const human = () =>
    `${agents
      .map((a) => `${escapeControl(a.name)}\t${a.scope}\t${escapeControl(a.declaredModel)}${a.shadowed ? '\t(shadowed)' : ''}${a.hidden ? '\t(hidden)' : ''}`)
      .join('\n')}\n`;
  return { code: 0, payload, human };
}

export async function agentsShow(deps: CliDeps, parsed: ParsedArgs): Promise<CommandResult> {
  const name = requirePositional(parsed, 0, 'name', 'agents show <name>');
  const client = requireClient(parsed, 'agents show');
  const state = await loadState(resolveConfigPath(deps, parsed));
  const inventory = await readAgentInventory(client, resolverOptionsFor(deps, parsed, state.config, client));
  const agent = getAgent(inventory, name); // throws RouterError('agent-unknown', ...) -> exit 2
  const routeOverride = state.config.roles[`${client}:${name}`]?.routeOverride;
  const payload = {
    name: agent.name,
    client: agent.client,
    scope: agent.scope,
    declaredModel: agent.declaredModel ?? 'unknown',
    hidden: agent.hidden,
    availability: agent.availability,
    shadowed: agent.shadowed,
    ...(routeOverride !== undefined ? { routeOverride } : {}),
  };
  const human = () =>
    `${escapeControl(payload.name)}\t${payload.scope}\t${escapeControl(payload.declaredModel)}${routeOverride !== undefined ? `\troute=${routeOverride}` : ''}\n`;
  return { code: 0, payload, human };
}

// ---------------------------------------------------------------------------
// route preview
// ---------------------------------------------------------------------------

export interface PreviewRouteOptions {
  client: ClientId;
  agent: string;
  model?: string;
  parentModel?: string;
}

export interface RoutePreviewResult {
  mode: 'simulation';
  generation: string;
  assumptions: { authenticatedChild: true; freshDelegation: true; runtimeCapabilityNotProven: true };
  decision: RouteDecision;
  agent: { name: string; declaredModel: string; scope: string };
}

/**
 * Simulates a route decision entirely offline: config, snapshot and the agent inventory, never
 * the network or a real agent run. `profile` is accepted for interface symmetry with the runtime
 * handler's capability gate, but is intentionally never consulted here (an offline simulation
 * cannot prove a real capability, so its status, including "pending", is never a reason to accept
 * or reject the preview). `freshDelegation` is always assumed true, `ignoredMarkers` is always 0:
 * this is a stated simulation assumption, not a measurement, which is why it is surfaced in
 * `assumptions` rather than silently folded into the decision.
 */
export function previewRoute(
  options: PreviewRouteOptions,
  state: LoadedState,
  inventory: AgentInventory,
  _profile: CapabilityProfile,
): RoutePreviewResult {
  if (state.snapshot === undefined) {
    throw new RouterError('snapshot-missing', 'route preview requires a models.lock.json snapshot; run `models sync` to create one');
  }
  const agentDefinition = getAgent(inventory, options.agent); // throws RouterError('agent-unknown', ...)
  const catalog = buildCatalog(state.config, state.snapshot);
  const role = `${options.client}:${options.agent}`;
  const roleDefaultId = state.config.roles[role]?.routeOverride;

  const routeInput: RouteInput = {
    client: options.client,
    scope: 'child',
    role,
    explicitIds: options.model !== undefined ? [options.model] : [],
    ...(roleDefaultId !== undefined ? { roleDefaultId } : {}),
    freshDelegation: true,
    ...(options.parentModel !== undefined ? { clientModel: options.parentModel } : {}),
    ignoredMarkers: 0,
  };

  const decision = resolveRoute(routeInput, state.config, catalog);

  return {
    mode: 'simulation',
    generation: state.generation,
    assumptions: { authenticatedChild: true, freshDelegation: true, runtimeCapabilityNotProven: true },
    decision,
    agent: { name: agentDefinition.name, declaredModel: agentDefinition.declaredModel ?? 'unknown', scope: agentDefinition.scope },
  };
}

function humanRoutePreview(preview: RoutePreviewResult): string {
  const lines = [
    `mode: ${preview.mode}`,
    `agent: ${escapeControl(preview.agent.name)} (${preview.agent.scope}, declared ${escapeControl(preview.agent.declaredModel)})`,
    `decision: ${preview.decision.kind}`,
  ];
  if (preview.decision.kind === 'route') {
    // upstreamModel/clientModel are the real routing identifiers, not display text: printed
    // verbatim, never escaped, so the terminal representation never differs from the stored ID.
    lines.push(`upstream: ${preview.decision.upstreamModel} (source: ${preview.decision.source})`);
  } else if (preview.decision.kind === 'error') {
    lines.push(`error: ${preview.decision.code}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function routePreview(deps: CliDeps, parsed: ParsedArgs): Promise<CommandResult> {
  const client = requireClient(parsed, 'route preview');
  const agent = requireAgent(parsed, 'route preview');
  const model = stringOption(parsed, 'model');
  const parentModel = stringOption(parsed, 'parent-model');

  const state = await loadState(resolveConfigPath(deps, parsed));
  const inventory = await readAgentInventory(client, resolverOptionsFor(deps, parsed, state.config, client));
  const profile = await deps.loadProfile(client, 'unspecified');

  const preview = previewRoute(
    { client, agent, ...(model !== undefined ? { model } : {}), ...(parentModel !== undefined ? { parentModel } : {}) },
    state,
    inventory,
    profile,
  );

  // A simulated selection failure (missing/disabled model, conflicting markers, ...) is a
  // "błąd wyboru" (selection error) per the CLI's exit-code contract: code 2, not 0, even though
  // previewRoute itself completed without throwing.
  const code = preview.decision.kind === 'error' ? 2 : 0;
  return { code, payload: preview, human: () => humanRoutePreview(preview) };
}

// ---------------------------------------------------------------------------
// config show / config check
// ---------------------------------------------------------------------------

export async function configShow(deps: CliDeps, parsed: ParsedArgs): Promise<CommandResult> {
  const state = await loadState(resolveConfigPath(deps, parsed));
  const payload = { config: state.config, generation: state.generation };
  // state.config only ever holds env VAR NAMES (authEnv, headersEnv, secretEnv, ...), never
  // resolved values: JSON.stringify-ing it as-is can never leak an actual secret or header value,
  // in JSON or in text mode, and JSON.stringify already escapes any embedded control character.
  const human = () => `${JSON.stringify(state.config, null, 2)}\n`;
  return { code: 0, payload, human };
}

export async function configCheck(deps: CliDeps, parsed: ParsedArgs): Promise<CommandResult> {
  const state = await loadState(resolveConfigPath(deps, parsed));
  const problems: string[] = [];

  let catalog: EffectiveCatalog | undefined;
  if (state.snapshot !== undefined) {
    try {
      catalog = buildCatalog(state.config, state.snapshot);
    } catch (error) {
      if (error instanceof RouterError) problems.push(`${error.code}: ${error.message}`);
      else throw error;
    }
  }

  for (const [roleKey, role] of Object.entries(state.config.roles)) {
    const colon = roleKey.indexOf(':');
    const client = roleKey.slice(0, colon);
    const agentName = roleKey.slice(colon + 1);

    if (!isClientId(client)) {
      problems.push(`role ${roleKey} has an unknown client`);
      continue;
    }

    try {
      const inventory = await readAgentInventory(client, resolverOptionsFor(deps, parsed, state.config, client));
      getAgent(inventory, agentName);
    } catch (error) {
      if (error instanceof RouterError && error.code === 'agent-unknown') {
        problems.push(`role ${roleKey} references unknown agent ${agentName}`);
      } else if (error instanceof RouterError) {
        problems.push(`${error.code}: ${error.message}`);
      } else {
        throw error;
      }
    }

    if (catalog !== undefined) {
      try {
        resolveModel(role.routeOverride, catalog);
      } catch (error) {
        if (error instanceof RouterError && error.code === 'unknown-model') {
          problems.push(`role ${roleKey} routeOverride ${role.routeOverride} is unknown`);
        } else if (error instanceof RouterError) {
          problems.push(`${error.code}: ${error.message}`);
        } else {
          throw error;
        }
      }
    }
  }

  const payload = { problems, generation: state.generation };
  const human = () => (problems.length === 0 ? 'config check: no problems found\n' : `${problems.map((p) => `- ${escapeControl(p)}`).join('\n')}\n`);
  return { code: problems.length === 0 ? 0 : 2, payload, human };
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

interface DoctorClientReport {
  client: ClientId;
  version: string;
  status: CapabilityProfile['status'] | 'unknown';
  diagnostics?: readonly string[];
}

export async function doctor(deps: CliDeps, parsed: ParsedArgs): Promise<CommandResult> {
  const configPath = resolveConfigPath(deps, parsed);

  let configStatus: { ok: true; generation: string } | { ok: false; error: string };
  try {
    const state = await loadState(configPath);
    configStatus = { ok: true, generation: state.generation };
  } catch (error) {
    if (error instanceof RouterError) configStatus = { ok: false, error: error.code };
    else throw error;
  }

  const clients: DoctorClientReport[] = [];
  for (const client of CLIENT_IDS) {
    try {
      const profile = await deps.loadProfile(client, 'unspecified');
      clients.push({
        client,
        version: profile.version,
        status: profile.status,
        ...(profile.diagnostics !== undefined ? { diagnostics: profile.diagnostics } : {}),
      });
    } catch (error) {
      // A capability lookup failing for one client (e.g. no fixture for the detected version)
      // is reported as 'unknown' for that client; it never fails the whole doctor command.
      if (error instanceof RouterError) {
        clients.push({ client, version: 'unspecified', status: 'unknown', diagnostics: [error.message] });
      } else {
        throw error;
      }
    }
  }

  let transport: { adapterId: string; runtimeVersion: string; status: string };
  try {
    const transportProfile = await deps.loadTransportProfile(deps.fetchAdapter.id, deps.fetchAdapter.runtimeVersion);
    transport = { adapterId: transportProfile.adapterId, runtimeVersion: transportProfile.runtimeVersion, status: transportProfile.status };
  } catch (error) {
    if (error instanceof RouterError) {
      transport = { adapterId: deps.fetchAdapter.id, runtimeVersion: deps.fetchAdapter.runtimeVersion, status: 'unknown' };
    } else {
      throw error;
    }
  }

  // doctor never dials out: no deps.fetch call anywhere in this command.
  const payload = { network: false, config: configStatus, clients, transport };
  const human = () =>
    `${[
      'network: false (offline diagnostics only)',
      `config: ${configStatus.ok ? `ok (generation ${configStatus.generation})` : `problem (${configStatus.error})`}`,
      ...clients.map((c) => `${c.client}: ${c.status}`),
      `transport: ${transport.status}`,
    ].join('\n')}\n`;

  return { code: 0, payload, human };
}
