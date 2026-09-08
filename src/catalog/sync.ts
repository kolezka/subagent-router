import { discoverModels } from './discovery';
import { RouterError } from '../core/errors';
import { modelAlias, sourceFingerprint } from '../core/hash';
import type { CatalogSnapshot, Env, FetchLike, SnapshotModel, SyncResult } from '../core/types';
import { resolveSource } from '../io/environment';
import { commitState, loadState } from '../io/store';

export interface SynchronizeDeps {
  env: Env;
  fetch: FetchLike;
  now: () => Date;
  allowEmpty: boolean;
  dryRun: boolean;
}

// Sort order matches the codepoint-order comparison the plan requires (no locale collation).
function compareCodepoints(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function byId(a: { id: string }, b: { id: string }): number {
  return compareCodepoints(a.id, b.id);
}

export async function synchronize(configPath: string, deps: SynchronizeDeps): Promise<SyncResult> {
  const state = await loadState(configPath);
  const source = resolveSource(state.config, deps.env);
  const discovered = await discoverModels(state.config, source, deps.fetch);

  if (discovered.length === 0 && !deps.allowEmpty) {
    throw new RouterError('sync-empty', 'discovery returned no models; pass allowEmpty to accept an empty catalog');
  }

  const fingerprint = await sourceFingerprint(source.sourceId, source.effectiveGatewayUrl, source.effectiveModelsUrl);
  // A prior snapshot only carries forward (models missing this round stay tracked as `missing`)
  // when it was taken from the same source identity. sourceId or the fingerprint (which folds in
  // both effective URLs, so a moved endpoint counts as a source change too) differing means the
  // old gateway's models must not survive into the new base as `missing` entries.
  const previousSnapshot = state.snapshot;
  const sameSource = previousSnapshot !== undefined && previousSnapshot.sourceId === source.sourceId && previousSnapshot.sourceFingerprint === fingerprint;
  const previousById = new Map((sameSource ? previousSnapshot.models : []).map((model) => [model.id, model]));
  const discoveredIds = new Set(discovered.map((model) => model.id));

  const added: string[] = [];
  const changed: string[] = [];
  const missing: string[] = [];

  const nextModels: SnapshotModel[] = [];

  for (const model of discovered) {
    const previous = previousById.get(model.id);
    const alias = previous?.alias ?? (await modelAlias(model.id));
    const metadata = model.displayName === undefined ? {} : { displayName: model.displayName };
    const resolved: SnapshotModel = { id: model.id, alias, status: 'available', metadata };
    nextModels.push(resolved);

    if (previous === undefined) {
      added.push(model.id);
    } else if (previous.status !== 'available' || previous.metadata.displayName !== model.displayName) {
      changed.push(model.id);
    }
  }

  for (const previous of previousById.values()) {
    if (discoveredIds.has(previous.id)) continue;
    nextModels.push({ ...previous, status: 'missing' });
    if (previous.status !== 'missing') missing.push(previous.id);
  }

  added.sort(compareCodepoints);
  changed.sort(compareCodepoints);
  missing.sort(compareCodepoints);
  nextModels.sort(byId);

  const snapshot: CatalogSnapshot = {
    version: 1,
    sourceId: source.sourceId,
    sourceFingerprint: fingerprint,
    fetchedAt: deps.now().toISOString(),
    models: nextModels,
  };

  if (!deps.dryRun) {
    await commitState(configPath, state, { snapshot });
  }

  return { snapshot, added, changed, missing };
}
