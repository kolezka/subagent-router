import { resolveModel } from './catalog';
import { RouterError } from './errors';
import type { EffectiveCatalog, OperatorConfig, ResolvedModel, RouteDecision, RouteInput } from './types';

type RouteSource = 'explicit' | 'role-default' | 'global-default' | 'correlated';

function lookup(id: string, catalog: EffectiveCatalog): ResolvedModel | 'unknown' {
  try {
    return resolveModel(id, catalog);
  } catch (error) {
    if (error instanceof RouterError && error.code === 'unknown-model') return 'unknown';
    throw error;
  }
}

function inheritIsAllowed(config: OperatorConfig): boolean {
  return config.defaults.unmarkedSubagent === 'inherit' && config.defaults.unmarkedSubagentAcknowledged === true;
}

export function resolveRoute(input: RouteInput, config: OperatorConfig, catalog: EffectiveCatalog): RouteDecision {
  const ignoredMarkers = input.ignoredMarkers;
  if (input.scope === 'parent') return { kind: 'pass-through', reason: 'parent', ignoredMarkers };
  if (input.markerError) return { kind: 'error', code: input.markerError, ignoredMarkers };
  if (input.explicitError) return { kind: 'error', code: input.explicitError, ignoredMarkers };

  const explicit = [...new Set(input.explicitIds)];
  if (explicit.length > 1) return { kind: 'error', code: 'conflicting-markers', ignoredMarkers };

  const candidates: Array<[string, RouteSource]> = [];
  if (explicit[0] !== undefined) candidates.push([explicit[0], 'explicit']);
  else if (input.correlatedId !== undefined) candidates.push([input.correlatedId, 'correlated']);
  else if (input.freshDelegation !== true) {
    if (inheritIsAllowed(config)) return { kind: 'pass-through', reason: 'inherit-allowed', ignoredMarkers };
    return { kind: 'error', code: 'missing-selection', ignoredMarkers };
  } else if (input.roleDefaultId !== undefined) candidates.push([input.roleDefaultId, 'role-default']);
  else if (config.defaults.child !== null) candidates.push([config.defaults.child, 'global-default']);

  if (explicit[0] !== undefined && input.correlatedId !== undefined && input.correlatedId !== explicit[0]) {
    return { kind: 'error', code: 'correlation-conflict', ignoredMarkers };
  }

  const candidate = candidates[0];
  if (candidate === undefined) {
    if (inheritIsAllowed(config)) return { kind: 'pass-through', reason: 'inherit-allowed', ignoredMarkers };
    return { kind: 'error', code: 'missing-selection', ignoredMarkers };
  }

  const model = lookup(candidate[0], catalog);
  if (model === 'unknown') return { kind: 'error', code: 'unknown-model', ignoredMarkers };
  if (!model.enabled) return { kind: 'error', code: 'model-not-allowed', ignoredMarkers };

  return {
    kind: 'route',
    upstreamModel: model.id,
    ...(model.clientModel !== undefined ? { clientModel: model.clientModel } : {}),
    source: candidate[1],
    ignoredMarkers,
  };
}
