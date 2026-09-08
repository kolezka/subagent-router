import { RouterError } from './errors';
import type { CatalogSnapshot, EffectiveCatalog, OperatorConfig, ResolvedModel } from './types';

export function buildCatalog(config: OperatorConfig, snapshot: CatalogSnapshot): EffectiveCatalog {
  const byId = new Map<string, ResolvedModel>();
  const byAlias = new Map<string, ResolvedModel>();
  const snapshotIds = new Set(snapshot.models.map((model) => model.id));

  for (const model of snapshot.models) {
    const override = config.modelOverrides[model.id];
    const resolved: ResolvedModel = {
      id: model.id,
      alias: override?.alias ?? model.alias,
      status: model.status,
      enabled: model.status === 'available' && (override?.enabled ?? true),
      ...(override?.description === undefined ? {} : { description: override.description }),
      ...(override?.clientModel === undefined ? {} : { clientModel: override.clientModel }),
    };

    if (snapshotIds.has(resolved.alias)) {
      throw new RouterError('config-alias-collision', `alias ${resolved.alias} collides with a model ID`);
    }
    if (byAlias.has(resolved.alias)) {
      throw new RouterError('config-alias-collision', `alias ${resolved.alias} is assigned more than once`);
    }

    byId.set(resolved.id, resolved);
    byAlias.set(resolved.alias, resolved);
  }

  return { byId, byAlias };
}

export function resolveModel(ref: string, catalog: EffectiveCatalog): ResolvedModel {
  const byId = catalog.byId.get(ref);
  if (byId !== undefined) return byId;

  const byAlias = catalog.byAlias.get(ref);
  if (byAlias !== undefined) return byAlias;

  throw new RouterError('unknown-model', `model ${ref} is unknown`);
}
