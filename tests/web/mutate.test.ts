import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperatorConfig } from '../../src/core/types';
import { loadState } from '../../src/io/store';
import { initConfig, setAgentRoot, setDefaults, setModelOverride, setRole, setSource } from '../../src/web/mutate';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

let dir = '';
let configPath = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-mutate-'));
  configPath = join(dir, 'subagent-router.json');
  await writeFile(configPath, JSON.stringify(configFixture()));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeSnapshot(ids?: string[]): Promise<void> {
  await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture(ids)));
}

async function currentGeneration(): Promise<string> {
  return (await loadState(configPath)).generation;
}

async function onDiskConfig(): Promise<OperatorConfig> {
  return JSON.parse(await readFile(configPath, 'utf8')) as OperatorConfig;
}

describe('setModelOverride', () => {
  test('happy path: sets a field through an alias reference and returns the new generation', async () => {
    await writeSnapshot();
    const expectedGeneration = await currentGeneration();
    const result = await setModelOverride(configPath, { expectedGeneration, reference: 'fast', clientModel: 'sonnet' });
    expect(result.config.modelOverrides[FIXTURE_MODEL_ID]).toEqual({ alias: 'fast', description: 'Szybkie zadania.', enabled: true, clientModel: 'sonnet' });
    expect(result.generation).not.toBe(expectedGeneration);
    expect((await onDiskConfig()).modelOverrides[FIXTURE_MODEL_ID]?.clientModel).toBe('sonnet');
  });

  test('rejects a stale generation before touching the config', async () => {
    await writeSnapshot();
    await expect(setModelOverride(configPath, { expectedGeneration: 'stale', reference: FIXTURE_MODEL_ID, clientModel: 'sonnet' })).rejects.toMatchObject({
      code: 'config-generation-conflict',
    });
    expect((await onDiskConfig()).modelOverrides[FIXTURE_MODEL_ID]?.clientModel).toBe('haiku');
  });

  test('clearing one field leaves the others in place', async () => {
    await writeSnapshot();
    const expectedGeneration = await currentGeneration();
    const result = await setModelOverride(configPath, { expectedGeneration, reference: FIXTURE_MODEL_ID, alias: null });
    expect(result.config.modelOverrides[FIXTURE_MODEL_ID]).toEqual({ description: 'Szybkie zadania.', enabled: true, clientModel: 'haiku' });
  });

  test('clearing every field deletes the whole override entry', async () => {
    await writeSnapshot();
    const expectedGeneration = await currentGeneration();
    const result = await setModelOverride(configPath, {
      expectedGeneration,
      reference: FIXTURE_MODEL_ID,
      alias: null,
      description: null,
      enabled: null,
      clientModel: null,
    });
    expect(result.config.modelOverrides[FIXTURE_MODEL_ID]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result.config.modelOverrides, FIXTURE_MODEL_ID)).toBe(false);
  });

  test('an unknown model reference throws unknown-model and writes nothing', async () => {
    await writeSnapshot();
    const expectedGeneration = await currentGeneration();
    await expect(setModelOverride(configPath, { expectedGeneration, reference: 'gateway/does-not-exist', description: 'x' })).rejects.toMatchObject({
      code: 'unknown-model',
    });
    expect((await onDiskConfig()).modelOverrides[FIXTURE_MODEL_ID]).toEqual({ alias: 'fast', description: 'Szybkie zadania.', enabled: true, clientModel: 'haiku' });
  });

  test('without a snapshot it refuses with snapshot-missing', async () => {
    const expectedGeneration = await currentGeneration();
    await expect(setModelOverride(configPath, { expectedGeneration, reference: FIXTURE_MODEL_ID, description: 'x' })).rejects.toMatchObject({
      code: 'snapshot-missing',
    });
  });

  test('an alias that fails the config grammar surfaces parseOperatorConfig\'s own error, not a second check', async () => {
    await writeSnapshot();
    const expectedGeneration = await currentGeneration();
    await expect(setModelOverride(configPath, { expectedGeneration, reference: FIXTURE_MODEL_ID, alias: 'not valid!' })).rejects.toMatchObject({
      code: 'config-alias-syntax',
    });
  });
});

describe('setRole', () => {
  test('happy path: adds a role entry', async () => {
    const expectedGeneration = await currentGeneration();
    const result = await setRole(configPath, { expectedGeneration, client: 'claude-code', agent: 'reviewer', routeOverride: FIXTURE_MODEL_ID });
    expect(result.config.roles['claude-code:reviewer']).toEqual({ routeOverride: FIXTURE_MODEL_ID });
  });

  test('rejects a stale generation', async () => {
    await expect(setRole(configPath, { expectedGeneration: 'stale', client: 'claude-code', agent: 'reviewer', routeOverride: FIXTURE_MODEL_ID })).rejects.toMatchObject({
      code: 'config-generation-conflict',
    });
  });

  test('routeOverride: null deletes the role', async () => {
    const expectedGeneration = await currentGeneration();
    const result = await setRole(configPath, { expectedGeneration, client: 'claude-code', agent: 'explorer', routeOverride: null });
    expect(result.config.roles['claude-code:explorer']).toBeUndefined();
  });

  test('with a snapshot present, an unresolved routeOverride is rejected as unknown-model', async () => {
    await writeSnapshot();
    const expectedGeneration = await currentGeneration();
    await expect(
      setRole(configPath, { expectedGeneration, client: 'claude-code', agent: 'reviewer', routeOverride: 'gateway/does-not-exist' }),
    ).rejects.toMatchObject({ code: 'unknown-model' });
  });

  test('with no snapshot yet, an unresolved routeOverride is accepted for config check to flag later', async () => {
    const expectedGeneration = await currentGeneration();
    const result = await setRole(configPath, { expectedGeneration, client: 'claude-code', agent: 'reviewer', routeOverride: 'gateway/not-synced-yet' });
    expect(result.config.roles['claude-code:reviewer']).toEqual({ routeOverride: 'gateway/not-synced-yet' });
  });
});

describe('setDefaults', () => {
  test('happy path: sets a global default child', async () => {
    const expectedGeneration = await currentGeneration();
    const result = await setDefaults(configPath, { expectedGeneration, child: FIXTURE_MODEL_ID });
    expect(result.config.defaults.child).toBe(FIXTURE_MODEL_ID);
  });

  test('rejects a stale generation', async () => {
    await expect(setDefaults(configPath, { expectedGeneration: 'stale', child: FIXTURE_MODEL_ID })).rejects.toMatchObject({ code: 'config-generation-conflict' });
  });

  test('child: null is a legitimate value, distinct from not supplied', async () => {
    let expectedGeneration = await currentGeneration();
    let result = await setDefaults(configPath, { expectedGeneration, child: FIXTURE_MODEL_ID });
    expectedGeneration = result.generation;
    result = await setDefaults(configPath, { expectedGeneration, unmarkedSubagent: 'error' });
    expect(result.config.defaults.child).toBe(FIXTURE_MODEL_ID);

    result = await setDefaults(configPath, { expectedGeneration: result.generation, child: null });
    expect(result.config.defaults.child).toBeNull();
  });

  test('inherit without acknowledgement is rejected by parseOperatorConfig, not by this function', async () => {
    const expectedGeneration = await currentGeneration();
    await expect(setDefaults(configPath, { expectedGeneration, unmarkedSubagent: 'inherit' })).rejects.toMatchObject({ code: 'config-inherit-unacknowledged' });
  });

  test('inherit with acknowledgement is accepted', async () => {
    const expectedGeneration = await currentGeneration();
    const result = await setDefaults(configPath, { expectedGeneration, unmarkedSubagent: 'inherit', unmarkedSubagentAcknowledged: true });
    expect(result.config.defaults).toEqual({ child: null, unmarkedSubagent: 'inherit', unmarkedSubagentAcknowledged: true });
  });
});

describe('setSource', () => {
  test('happy path: patches modelSource fields one at a time, leaving others untouched', async () => {
    const expectedGeneration = await currentGeneration();
    const result = await setSource(configPath, { expectedGeneration, sourceId: 'new-gateway', timeoutMs: 5000 });
    expect(result.config.modelSource).toMatchObject({ sourceId: 'new-gateway', timeoutMs: 5000, endpointPath: '/v1/models', baseUrlEnv: 'GATEWAY_URL' });
  });

  test('rejects a stale generation', async () => {
    await expect(setSource(configPath, { expectedGeneration: 'stale', sourceId: 'new-gateway' })).rejects.toMatchObject({ code: 'config-generation-conflict' });
  });

  test('modelsAuthEnv: null removes authEnv', async () => {
    const expectedGeneration = await currentGeneration();
    const result = await setSource(configPath, { expectedGeneration, modelsAuthEnv: null });
    expect(result.config.modelSource.authEnv).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result.config.modelSource, 'authEnv')).toBe(false);
  });

  test('patches gateway and harness.claudeCode fields', async () => {
    const expectedGeneration = await currentGeneration();
    const result = await setSource(configPath, { expectedGeneration, gatewayUrlEnv: 'NEW_GATEWAY_URL', correlationSecretEnv: 'NEW_SECRET', correlation: 'off' });
    expect(result.config.gateway.urlEnv).toBe('NEW_GATEWAY_URL');
    expect(result.config.harness.claudeCode).toEqual({ correlation: 'off', secretEnv: 'NEW_SECRET' });
    // unrelated harness sections stay untouched
    expect(result.config.harness.opencode).toEqual({ providerId: 'gateway' });
  });
});

describe('setAgentRoot', () => {
  test('happy path: sets a client configRoot', async () => {
    const expectedGeneration = await currentGeneration();
    const result = await setAgentRoot(configPath, { expectedGeneration, client: 'opencode', configRoot: '/srv/opencode' });
    expect(result.config.agentRoots.opencode).toEqual({ configRoot: '/srv/opencode' });
  });

  test('rejects a stale generation', async () => {
    await expect(setAgentRoot(configPath, { expectedGeneration: 'stale', client: 'opencode', configRoot: '/srv/opencode' })).rejects.toMatchObject({
      code: 'config-generation-conflict',
    });
  });

  test('configRoot: null restores built-in discovery', async () => {
    let expectedGeneration = await currentGeneration();
    const set = await setAgentRoot(configPath, { expectedGeneration, client: 'codex', configRoot: '/srv/codex' });
    expectedGeneration = set.generation;
    const cleared = await setAgentRoot(configPath, { expectedGeneration, client: 'codex', configRoot: null });
    expect(cleared.config.agentRoots.codex).toEqual({ configRoot: null });
  });
});

describe('initConfig', () => {
  test('creates parent directories and writes a new config file', async () => {
    const target = join(dir, 'nested', 'deeper', 'subagent-router.json');
    const result = await initConfig({ configPath: target, config: configFixture(), force: false });
    expect(result.created).toBe(true);
    expect(result.configPath).toBe(target);
    expect(JSON.parse(await readFile(target, 'utf8')).version).toBe(1);
  });

  test('refuses to overwrite an existing file without force', async () => {
    await expect(initConfig({ configPath, config: configFixture(), force: false })).rejects.toMatchObject({ code: 'config-exists' });
    expect((await onDiskConfig()).modelSource.sourceId).toBe('test-gateway');
  });

  test('accepts force and overwrites the existing file', async () => {
    const result = await initConfig({ configPath, config: configFixture({ modelSource: { ...configFixture().modelSource, sourceId: 'overwritten' } }), force: true });
    expect(result.created).toBe(true);
    expect((await onDiskConfig()).modelSource.sourceId).toBe('overwritten');
  });

  test('validates the config with parseOperatorConfig before writing', async () => {
    const target = join(dir, 'invalid.json');
    const broken = configFixture({ defaults: { child: null, unmarkedSubagent: 'inherit' } });
    await expect(initConfig({ configPath: target, config: broken, force: false })).rejects.toMatchObject({ code: 'config-inherit-unacknowledged' });
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('secret leak control', () => {
  const SECRET_ENV_NAME = 'SUBAGENT_ROUTER_TEST_SECRET';
  const SECRET_VALUE = 'super-secret-gateway-token-do-not-leak';

  beforeEach(() => {
    process.env[SECRET_ENV_NAME] = SECRET_VALUE;
  });

  afterEach(() => {
    delete process.env[SECRET_ENV_NAME];
  });

  // MutationResult.config only ever carries env var NAMES (already true of OperatorConfig); none
  // of the functions in this file read process.env at all. This is the regression test for that
  // invariant: even with a real secret sitting in the process environment, no mutation result
  // JSON may contain its value.
  test('no mutation result JSON contains a secret value present in the process environment', async () => {
    await writeSnapshot();
    let expectedGeneration = await currentGeneration();

    const results = [];
    results.push(await setSource(configPath, { expectedGeneration, correlationSecretEnv: SECRET_ENV_NAME }));
    expectedGeneration = results[0]!.generation;
    results.push(await setModelOverride(configPath, { expectedGeneration, reference: FIXTURE_MODEL_ID, description: 'uses ' + SECRET_ENV_NAME }));
    expectedGeneration = results[1]!.generation;
    results.push(await setRole(configPath, { expectedGeneration, client: 'claude-code', agent: 'reviewer', routeOverride: FIXTURE_MODEL_ID }));
    expectedGeneration = results[2]!.generation;
    results.push(await setDefaults(configPath, { expectedGeneration, child: FIXTURE_MODEL_ID }));
    expectedGeneration = results[3]!.generation;
    results.push(await setAgentRoot(configPath, { expectedGeneration, client: 'opencode', configRoot: '/srv/opencode' }));

    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
    }
  });
});
