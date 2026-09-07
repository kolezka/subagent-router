import { RouterError } from './errors';
import type { CatalogSnapshot, ClientId, OperatorConfig } from './types';

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const ALIAS = /^[A-Za-z][A-Za-z0-9_-]{0,126}$/;
const CLIENTS: readonly ClientId[] = ['claude-code', 'opencode', 'codex'];

function record(value: unknown, path: string, code = 'config-schema'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RouterError(code, `${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, code = 'config-unknown-field'): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new RouterError(code, `${path}.${key} is not a known field`);
    }
  }
}

function requireString(value: unknown, path: string, code = 'config-schema'): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RouterError(code, `${path} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, path);
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new RouterError('config-schema', `${path} must be a positive integer`);
  }
  return value;
}

function envNames(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new RouterError('config-schema', `${path} must be an array`);
  }
  return value.map((item) => {
    if (typeof item !== 'string' || !ENV_NAME.test(item)) {
      throw new RouterError('config-inline-header', `${path} may contain only environment variable names`);
    }
    return item;
  });
}

function parseModelSource(value: unknown): void {
  const source = record(value, 'config.modelSource');
  onlyKeys(source, ['sourceId', 'baseUrlEnv', 'endpointPath', 'authEnv', 'headersEnv', 'timeoutMs', 'fetchLimit', 'staleAfterSeconds'], 'config.modelSource');
  requireString(source.sourceId, 'config.modelSource.sourceId');
  requireString(source.baseUrlEnv, 'config.modelSource.baseUrlEnv');
  requireString(source.endpointPath, 'config.modelSource.endpointPath');
  optionalString(source.authEnv, 'config.modelSource.authEnv');
  envNames(source.headersEnv, 'config.modelSource.headersEnv');
  positiveInteger(source.timeoutMs, 'config.modelSource.timeoutMs');
  positiveInteger(source.fetchLimit, 'config.modelSource.fetchLimit');
  positiveInteger(source.staleAfterSeconds, 'config.modelSource.staleAfterSeconds');
}

function parseOverrides(value: unknown): void {
  const overrides = record(value, 'config.modelOverrides');
  for (const [id, raw] of Object.entries(overrides)) {
    const path = `config.modelOverrides.${id}`;
    const override = record(raw, path);
    onlyKeys(override, ['alias', 'description', 'enabled', 'clientModel'], path);
    if (override.alias !== undefined && (typeof override.alias !== 'string' || !ALIAS.test(override.alias))) {
      throw new RouterError('config-alias-syntax', `model alias for ${id} does not meet marker grammar`);
    }
    optionalString(override.description, `${path}.description`);
    if (override.enabled !== undefined && typeof override.enabled !== 'boolean') {
      throw new RouterError('config-schema', `${path}.enabled must be a boolean`);
    }
    optionalString(override.clientModel, `${path}.clientModel`);
  }
}

function parseRoles(value: unknown): void {
  const roles = record(value, 'config.roles');
  for (const [key, raw] of Object.entries(roles)) {
    const colon = key.indexOf(':');
    const client = key.slice(0, colon);
    if (colon <= 0 || colon === key.length - 1 || !CLIENTS.includes(client as ClientId)) {
      throw new RouterError('config-role-name', `role ${key} must use <client>:<name>`);
    }
    const role = record(raw, `config.roles.${key}`);
    onlyKeys(role, ['routeOverride'], `config.roles.${key}`);
    requireString(role.routeOverride, `config.roles.${key}.routeOverride`);
  }
}

function parseDefaults(value: unknown): void {
  const defaults = record(value, 'config.defaults');
  onlyKeys(defaults, ['child', 'unmarkedSubagent', 'unmarkedSubagentAcknowledged'], 'config.defaults');
  if (defaults.child !== null && (typeof defaults.child !== 'string' || defaults.child.length === 0)) {
    throw new RouterError('config-schema', 'config.defaults.child must be a non-empty string or null');
  }
  if (defaults.unmarkedSubagent !== 'error' && defaults.unmarkedSubagent !== 'inherit') {
    throw new RouterError('config-schema', 'config.defaults.unmarkedSubagent must be error or inherit');
  }
  if (defaults.unmarkedSubagentAcknowledged !== undefined && typeof defaults.unmarkedSubagentAcknowledged !== 'boolean') {
    throw new RouterError('config-schema', 'config.defaults.unmarkedSubagentAcknowledged must be a boolean');
  }
  if (defaults.unmarkedSubagent === 'inherit' && defaults.unmarkedSubagentAcknowledged !== true) {
    throw new RouterError('config-inherit-unacknowledged', 'inherit requires unmarkedSubagentAcknowledged: true');
  }
}

function parseAgentRoots(value: unknown): void {
  const roots = record(value, 'config.agentRoots');
  onlyKeys(roots, CLIENTS, 'config.agentRoots');
  for (const client of CLIENTS) {
    const root = record(roots[client], `config.agentRoots.${client}`);
    onlyKeys(root, ['configRoot'], `config.agentRoots.${client}`);
    if (root.configRoot !== null && (typeof root.configRoot !== 'string' || root.configRoot.length === 0)) {
      throw new RouterError('config-schema', `config.agentRoots.${client}.configRoot must be a non-empty string or null`);
    }
  }
}

function parseGateway(value: unknown): void {
  const gateway = record(value, 'config.gateway');
  onlyKeys(gateway, ['urlEnv', 'headersEnv'], 'config.gateway');
  envNames(gateway.headersEnv, 'config.gateway.headersEnv');
  requireString(gateway.urlEnv, 'config.gateway.urlEnv');
}

function parseHarness(value: unknown): void {
  const harness = record(value, 'config.harness');
  onlyKeys(harness, ['claudeCode', 'opencode', 'codex'], 'config.harness');

  const claudeCode = record(harness.claudeCode, 'config.harness.claudeCode');
  onlyKeys(claudeCode, ['correlation', 'secretEnv'], 'config.harness.claudeCode');
  if (claudeCode.correlation !== 'auto' && claudeCode.correlation !== 'off') {
    throw new RouterError('config-schema', 'config.harness.claudeCode.correlation must be auto or off');
  }
  requireString(claudeCode.secretEnv, 'config.harness.claudeCode.secretEnv');

  const opencode = record(harness.opencode, 'config.harness.opencode');
  onlyKeys(opencode, ['providerId'], 'config.harness.opencode');
  requireString(opencode.providerId, 'config.harness.opencode.providerId');

  const codex = record(harness.codex, 'config.harness.codex');
  onlyKeys(codex, ['emitModelCatalog'], 'config.harness.codex');
  if (typeof codex.emitModelCatalog !== 'boolean') {
    throw new RouterError('config-schema', 'config.harness.codex.emitModelCatalog must be a boolean');
  }
}

export function parseOperatorConfig(value: unknown): OperatorConfig {
  const root = record(value, 'config');
  if (root.version !== 1) {
    throw new RouterError('config-version', 'only version 1 is supported');
  }
  onlyKeys(root, ['version', 'modelSource', 'modelOverrides', 'roles', 'defaults', 'agentRoots', 'gateway', 'harness'], 'config');
  parseModelSource(root.modelSource);
  parseOverrides(root.modelOverrides);
  parseRoles(root.roles);
  parseDefaults(root.defaults);
  parseAgentRoots(root.agentRoots);
  parseGateway(root.gateway);
  parseHarness(root.harness);
  return structuredClone(root) as unknown as OperatorConfig;
}

export function parseSnapshot(value: unknown): CatalogSnapshot {
  const root = record(value, 'snapshot', 'snapshot-schema');
  if (root.version !== 1) {
    throw new RouterError('snapshot-version', 'only version 1 is supported');
  }
  onlyKeys(root, ['version', 'sourceId', 'sourceFingerprint', 'fetchedAt', 'models'], 'snapshot', 'snapshot-schema');
  requireString(root.sourceId, 'snapshot.sourceId', 'snapshot-schema');
  requireString(root.sourceFingerprint, 'snapshot.sourceFingerprint', 'snapshot-schema');
  requireString(root.fetchedAt, 'snapshot.fetchedAt', 'snapshot-schema');
  if (!Array.isArray(root.models)) {
    throw new RouterError('snapshot-schema', 'snapshot.models must be an array');
  }

  const seen = new Set<string>();
  for (const raw of root.models) {
    const model = record(raw, 'snapshot.models[]', 'snapshot-schema');
    onlyKeys(model, ['id', 'alias', 'status', 'metadata'], 'snapshot.models[]', 'snapshot-schema');
    const id = requireString(model.id, 'snapshot.models[].id', 'snapshot-schema');
    requireString(model.alias, `snapshot.models.${id}.alias`, 'snapshot-schema');
    if (model.status !== 'available' && model.status !== 'missing') {
      throw new RouterError('snapshot-schema', `model status for ${id} is unknown`);
    }
    const metadata = record(model.metadata, `snapshot.models.${id}.metadata`, 'snapshot-schema');
    onlyKeys(metadata, ['displayName'], `snapshot.models.${id}.metadata`, 'snapshot-schema');
    if (metadata.displayName !== undefined) {
      requireString(metadata.displayName, `snapshot.models.${id}.metadata.displayName`, 'snapshot-schema');
    }
    if (seen.has(id)) {
      throw new RouterError('snapshot-duplicate-id', `model ${id} occurs twice`);
    }
    seen.add(id);
  }
  return structuredClone(root) as unknown as CatalogSnapshot;
}
