import type { CatalogSnapshot, OperatorConfig } from '../../src/core/types';
import { modelAlias, sourceFingerprint } from '../../src/core/hash';

export const FIXTURE_SOURCE_ID = 'test-gateway';
export const FIXTURE_GATEWAY_URL = 'http://127.0.0.1:8000/v1';
export const FIXTURE_MODELS_URL = 'http://127.0.0.1:8000/v1/models';
export const FIXTURE_FETCHED_AT = '2026-09-06T00:00:00.000Z';
export const FIXTURE_MODEL_ID = 'gateway/fast-worker';

export function configFixture(patch: Partial<OperatorConfig> = {}): OperatorConfig {
  const base: OperatorConfig = {
    version: 1,
    modelSource: {
      sourceId: FIXTURE_SOURCE_ID,
      baseUrlEnv: 'GATEWAY_URL',
      endpointPath: '/v1/models',
      authEnv: 'MODELS_AUTH',
      headersEnv: ['GATEWAY_HEADERS'],
      timeoutMs: 10000,
      fetchLimit: 1000,
      staleAfterSeconds: 86400,
    },
    modelOverrides: {
      [FIXTURE_MODEL_ID]: { alias: 'fast', description: 'Szybkie zadania.', enabled: true, clientModel: 'haiku' },
    },
    roles: { 'claude-code:explorer': { routeOverride: FIXTURE_MODEL_ID } },
    defaults: { child: null, unmarkedSubagent: 'error' },
    agentRoots: {
      'claude-code': { configRoot: null },
      opencode: { configRoot: null },
      codex: { configRoot: null },
    },
    gateway: { urlEnv: 'GATEWAY_URL', headersEnv: ['GATEWAY_HEADERS'] },
    harness: {
      claudeCode: { correlation: 'auto', secretEnv: 'ROUTER_SECRET' },
      opencode: { providerId: 'gateway' },
      codex: { emitModelCatalog: false },
    },
  };
  return structuredClone({ ...base, ...patch });
}

export async function snapshotFixture(ids: readonly string[] = [FIXTURE_MODEL_ID]): Promise<CatalogSnapshot> {
  const models = await Promise.all(
    ids.map(async (id) => ({ id, alias: await modelAlias(id), status: 'available' as const, metadata: {} })),
  );
  return {
    version: 1,
    sourceId: FIXTURE_SOURCE_ID,
    sourceFingerprint: await sourceFingerprint(FIXTURE_SOURCE_ID, FIXTURE_GATEWAY_URL, FIXTURE_MODELS_URL),
    fetchedAt: FIXTURE_FETCHED_AT,
    models,
  };
}
