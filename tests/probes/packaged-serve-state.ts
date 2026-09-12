import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { modelAlias, sourceFingerprint } from '../../src/core/hash';
import { resolveSource } from '../../src/io/environment';
import { CHANNEL_A_AGENTS } from './native-claude-handler';
import { configFixture, FIXTURE_FETCHED_AT } from '../support/fixtures';

const [outputDir, upstreamUrl] = process.argv.slice(2);
if (outputDir === undefined || upstreamUrl === undefined) {
  throw new Error('usage: packaged-serve-state.ts <output-dir> <upstream-url>');
}

const modelOverrides = Object.fromEntries(
  CHANNEL_A_AGENTS.map((agent) => [agent.upstreamModel, { alias: agent.alias, description: `Probe ${agent.name}.`, enabled: true }]),
);
const config = configFixture({ modelOverrides });
const env = { GATEWAY_URL: `${upstreamUrl}/v1`, GATEWAY_HEADERS: '{}', MODELS_AUTH: 'synthetic-local-auth', ROUTER_SECRET: 'synthetic-local-secret' };
const source = resolveSource(config, env);
const models = await Promise.all(
  CHANNEL_A_AGENTS.map(async (agent) => ({ id: agent.upstreamModel, alias: await modelAlias(agent.upstreamModel), status: 'available' as const, metadata: {} })),
);

await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, 'subagent-router.json'), JSON.stringify(config, null, 2));
await writeFile(
  join(outputDir, 'models.lock.json'),
  JSON.stringify(
    {
      version: 1,
      sourceId: source.sourceId,
      sourceFingerprint: await sourceFingerprint(source.sourceId, source.effectiveGatewayUrl, source.effectiveModelsUrl),
      fetchedAt: FIXTURE_FETCHED_AT,
      models,
    },
    null,
    2,
  ),
);
