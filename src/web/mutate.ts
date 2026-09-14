// Config write operations the web console exposes over HTTP. Each function mirrors
// src/cli/write.ts's describeModel: load state, resolve/validate, apply a pure change to a
// cloned config, commit. commitState already runs parseOperatorConfig and its own hash guard;
// this file adds nothing on top of that except the generation check, which must run first.
import { access, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { buildCatalog, resolveModel } from '../core/catalog';
import { parseOperatorConfig } from '../core/config';
import { RouterError } from '../core/errors';
import type { LoadedState, ModelOverride, OperatorConfig } from '../core/types';
import { runWithCleanup } from '../io/cleanup';
import { commitState, loadState } from '../io/store';
import type {
  AgentRootRequest,
  ConfigInitResult,
  DefaultsRequest,
  ModelOverrideRequest,
  MutationResult,
  RoleRequest,
  SourceRequest,
} from './api-types';

// Every mutation checks this before building the next config, so a stale edit is refused before
// any work happens on it. commitState's own hash guard stays as the second line of defence.
function requireCurrentGeneration(state: LoadedState, expectedGeneration: string): void {
  if (state.generation !== expectedGeneration) {
    throw new RouterError('config-generation-conflict', 'the config changed since it was read; reload and try again');
  }
}

async function commitAndReport(configPath: string, state: LoadedState, nextConfig: OperatorConfig): Promise<MutationResult> {
  await commitState(configPath, state, { config: nextConfig });
  const after = await loadState(configPath);
  return { generation: after.generation, config: after.config };
}

// undefined leaves the field untouched, null clears it, a value sets it. Shared by every
// ModelOverride field below.
function patchField<T>(current: T | undefined, patch: T | null | undefined): T | undefined {
  if (patch === undefined) return current;
  if (patch === null) return undefined;
  return patch;
}

/** Every mutation resolves the config, applies a pure change, and commits it under the generation guard. */
export async function setModelOverride(configPath: string, request: ModelOverrideRequest): Promise<MutationResult> {
  const state = await loadState(configPath);
  requireCurrentGeneration(state, request.expectedGeneration);
  if (state.snapshot === undefined) {
    throw new RouterError('snapshot-missing', 'model overrides require a models.lock.json snapshot; run `models sync` to create one');
  }
  const catalog = buildCatalog(state.config, state.snapshot);
  const model = resolveModel(request.reference, catalog); // throws RouterError('unknown-model', ...)

  const nextConfig: OperatorConfig = structuredClone(state.config);
  const existing = nextConfig.modelOverrides[model.id];
  const alias = patchField(existing?.alias, request.alias);
  const description = patchField(existing?.description, request.description);
  const enabled = patchField(existing?.enabled, request.enabled);
  const clientModel = patchField(existing?.clientModel, request.clientModel);
  const merged: ModelOverride = {
    ...(alias !== undefined ? { alias } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(clientModel !== undefined ? { clientModel } : {}),
  };

  // Same rule describeModel already applies to the description field alone, generalized to all
  // four: an override with no fields left is not written as `{}`, the entry is removed.
  if (Object.keys(merged).length === 0) {
    delete nextConfig.modelOverrides[model.id];
  } else {
    nextConfig.modelOverrides[model.id] = merged;
  }

  return commitAndReport(configPath, state, nextConfig);
}

export async function setRole(configPath: string, request: RoleRequest): Promise<MutationResult> {
  const state = await loadState(configPath);
  requireCurrentGeneration(state, request.expectedGeneration);

  const nextConfig: OperatorConfig = structuredClone(state.config);
  const key = `${request.client}:${request.agent}`;
  if (request.routeOverride === null) {
    delete nextConfig.roles[key];
  } else {
    // No snapshot yet is not an error here: the operator may be wiring roles before the first
    // `models sync`, and `config check` already flags an override that never resolves.
    if (state.snapshot !== undefined) {
      resolveModel(request.routeOverride, buildCatalog(state.config, state.snapshot)); // throws unknown-model
    }
    nextConfig.roles[key] = { routeOverride: request.routeOverride };
  }

  return commitAndReport(configPath, state, nextConfig);
}

export async function setDefaults(configPath: string, request: DefaultsRequest): Promise<MutationResult> {
  const state = await loadState(configPath);
  requireCurrentGeneration(state, request.expectedGeneration);

  const nextConfig: OperatorConfig = structuredClone(state.config);
  nextConfig.defaults = {
    ...nextConfig.defaults,
    // child is string | null, never optional on the config itself, so "not supplied" (undefined)
    // has to be distinguished from "set to null" (no global default) here, not folded together.
    ...(request.child !== undefined ? { child: request.child } : {}),
    ...(request.unmarkedSubagent !== undefined ? { unmarkedSubagent: request.unmarkedSubagent } : {}),
    ...(request.unmarkedSubagentAcknowledged !== undefined ? { unmarkedSubagentAcknowledged: request.unmarkedSubagentAcknowledged } : {}),
  };
  // parseOperatorConfig (run inside commitState) is the one that raises
  // config-inherit-unacknowledged; this function does not duplicate that rule.
  return commitAndReport(configPath, state, nextConfig);
}

export async function setSource(configPath: string, request: SourceRequest): Promise<MutationResult> {
  const state = await loadState(configPath);
  requireCurrentGeneration(state, request.expectedGeneration);

  const nextConfig: OperatorConfig = structuredClone(state.config);
  nextConfig.modelSource = {
    ...nextConfig.modelSource,
    ...(request.sourceId !== undefined ? { sourceId: request.sourceId } : {}),
    ...(request.endpointPath !== undefined ? { endpointPath: request.endpointPath } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    ...(request.fetchLimit !== undefined ? { fetchLimit: request.fetchLimit } : {}),
    ...(request.staleAfterSeconds !== undefined ? { staleAfterSeconds: request.staleAfterSeconds } : {}),
    ...(request.modelsBaseUrlEnv !== undefined ? { baseUrlEnv: request.modelsBaseUrlEnv } : {}),
    ...(request.modelsHeadersEnv !== undefined ? { headersEnv: request.modelsHeadersEnv } : {}),
  };
  if (request.modelsAuthEnv !== undefined) {
    if (request.modelsAuthEnv === null) delete nextConfig.modelSource.authEnv;
    else nextConfig.modelSource.authEnv = request.modelsAuthEnv;
  }

  nextConfig.gateway = {
    ...nextConfig.gateway,
    ...(request.gatewayUrlEnv !== undefined ? { urlEnv: request.gatewayUrlEnv } : {}),
    ...(request.gatewayHeadersEnv !== undefined ? { headersEnv: request.gatewayHeadersEnv } : {}),
  };

  nextConfig.harness = {
    ...nextConfig.harness,
    claudeCode: {
      ...nextConfig.harness.claudeCode,
      ...(request.correlationSecretEnv !== undefined ? { secretEnv: request.correlationSecretEnv } : {}),
      ...(request.correlation !== undefined ? { correlation: request.correlation } : {}),
    },
  };

  return commitAndReport(configPath, state, nextConfig);
}

export async function setAgentRoot(configPath: string, request: AgentRootRequest): Promise<MutationResult> {
  const state = await loadState(configPath);
  requireCurrentGeneration(state, request.expectedGeneration);

  const nextConfig: OperatorConfig = structuredClone(state.config);
  nextConfig.agentRoots[request.client] = { configRoot: request.configRoot };

  return commitAndReport(configPath, state, nextConfig);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

// Mirrors io/store.ts's atomic temp-file + rename write (exclusive create, write, rename, clean
// up only a temp file this call created). That helper is private to store.ts and this task treats
// store.ts as read-only, so the same steps are duplicated here instead of exported.
async function writeNewFile(target: string, payload: string): Promise<void> {
  const temp = `${target}.${process.pid}.tmp`;
  let tempCreated = false;
  await runWithCleanup(
    async () => {
      try {
        const handle = await open(temp, 'wx');
        try {
          await handle.writeFile(payload);
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') tempCreated = true;
        throw error;
      }
      tempCreated = true;
      await rename(temp, target);
    },
    async () => {
      if (tempCreated) await rm(temp, { force: true });
    },
  );
}

/** Writes a brand new config file. Refuses to overwrite unless `force`. */
export async function initConfig(options: { configPath: string; config: OperatorConfig; force: boolean }): Promise<ConfigInitResult> {
  const configPath = resolve(options.configPath);
  if (!options.force && (await fileExists(configPath))) {
    throw new RouterError('config-exists', `config already exists at ${configPath}; pass force to overwrite`);
  }

  const validated = parseOperatorConfig(options.config);
  await mkdir(dirname(configPath), { recursive: true });
  await writeNewFile(configPath, `${JSON.stringify(validated, null, 2)}\n`);

  return { configPath, created: true };
}
