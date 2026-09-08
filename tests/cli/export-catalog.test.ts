// Reproduction + regression coverage for the missing codex catalog validation: buildCodexFiles
// wrote role.routeOverride straight into TOML without checking it against the effective catalog
// when one was available. These tests exercise exportConfig directly (the real config/snapshot
// loader, toy native codex role files) plus one CLI-level exit-code check.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readAgentInventory } from '../../src/agents/inventory';
import { exportConfig, type ExportOptions } from '../../src/agents/export';
import { runCli } from '../../src/cli/main';
import type { AgentInventory, CliDeps, FetchLike, ResolverOptions } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

const TESTS_TMP_ROOT = join(import.meta.dir, '..', 'tmp');
const UNKNOWN_MODEL_ID = 'gateway/does-not-exist';

let dir = '';

async function codexInventory(cwd: string, home: string): Promise<AgentInventory> {
  const options: ResolverOptions = { cwd, home, env: {}, additionalRoots: [] };
  return readAgentInventory('codex', options);
}

function resolverContext(): ExportOptions['resolverContext'] {
  return { cwd: join(dir, 'project'), home: join(dir, 'home'), env: {}, additionalRoots: [] };
}

beforeEach(async () => {
  await mkdir(TESTS_TMP_ROOT, { recursive: true });
  dir = await mkdtemp(join(TESTS_TMP_ROOT, 'subagent-router-export-catalog-'));
  await mkdir(join(dir, 'project'), { recursive: true });
  await mkdir(join(dir, 'home', '.codex', 'agents'), { recursive: true });
  await writeFile(join(dir, 'home', '.codex', 'agents', 'reviewer.toml'), 'name = "reviewer"\nmodel = "gateway/base"\n');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfigAndSnapshot(routeOverride: string, snapshot: unknown): Promise<void> {
  await writeFile(
    join(dir, 'project', 'subagent-router.json'),
    JSON.stringify(configFixture({ roles: { 'codex:reviewer': { routeOverride } } })),
  );
  await writeFile(join(dir, 'project', 'models.lock.json'), JSON.stringify(snapshot));
}

describe('codex export catalog validation', () => {
  test('an unknown model ID is refused before any file is written (real export)', async () => {
    await writeConfigAndSnapshot(UNKNOWN_MODEL_ID, await snapshotFixture());
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await codexInventory(join(dir, 'project'), join(dir, 'home'));
    const outDir = join(dir, 'out');

    await expect(
      exportConfig(configPath, 'codex', outDir, { dryRun: false, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() }),
    ).rejects.toMatchObject({ code: 'unknown-model' });
    await expect(readdir(outDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('the same unknown model ID is refused in --dry-run too, and no plan is returned', async () => {
    await writeConfigAndSnapshot(UNKNOWN_MODEL_ID, await snapshotFixture());
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await codexInventory(join(dir, 'project'), join(dir, 'home'));

    await expect(
      exportConfig(configPath, 'codex', join(dir, 'out'), { dryRun: true, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() }),
    ).rejects.toMatchObject({ code: 'unknown-model' });
  });

  test('a disabled model (modelOverrides enabled:false) is refused, not silently emitted', async () => {
    await writeFile(
      join(dir, 'project', 'subagent-router.json'),
      JSON.stringify(
        configFixture({
          roles: { 'codex:reviewer': { routeOverride: FIXTURE_MODEL_ID } },
          modelOverrides: { [FIXTURE_MODEL_ID]: { alias: 'fast', enabled: false } },
        }),
      ),
    );
    await writeFile(join(dir, 'project', 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await codexInventory(join(dir, 'project'), join(dir, 'home'));
    const outDir = join(dir, 'out');

    await expect(
      exportConfig(configPath, 'codex', outDir, { dryRun: false, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() }),
    ).rejects.toThrow('model-not-allowed');
    await expect(readdir(outDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a model whose snapshot status is "missing" is refused, not silently emitted', async () => {
    const snapshot = await snapshotFixture();
    const missingSnapshot = { ...snapshot, models: snapshot.models.map((m) => ({ ...m, status: 'missing' as const })) };
    await writeConfigAndSnapshot(FIXTURE_MODEL_ID, missingSnapshot);
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await codexInventory(join(dir, 'project'), join(dir, 'home'));

    await expect(
      exportConfig(configPath, 'codex', join(dir, 'out'), { dryRun: true, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() }),
    ).rejects.toThrow('model-not-allowed');
  });

  // Permitted exact-ID control: proves the fix does not disturb the valid, enabled path.
  test('a permitted, exact, enabled model ID still exports normally', async () => {
    await writeConfigAndSnapshot(FIXTURE_MODEL_ID, await snapshotFixture());
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await codexInventory(join(dir, 'project'), join(dir, 'home'));

    const plan = await exportConfig(configPath, 'codex', join(dir, 'out'), {
      dryRun: true,
      force: false,
      inventory,
      catalogRequired: false,
      resolverContext: resolverContext(),
    });
    const toml = plan.find((f) => f.relativePath === 'codex/agents/reviewer.toml');
    expect(toml?.content).toContain(FIXTURE_MODEL_ID);
  });

  test('CLI: a disabled codex model exits 2 with model-not-allowed, following the existing config-error convention', async () => {
    await writeFile(
      join(dir, 'project', 'subagent-router.json'),
      JSON.stringify(
        configFixture({
          roles: { 'codex:reviewer': { routeOverride: FIXTURE_MODEL_ID } },
          modelOverrides: { [FIXTURE_MODEL_ID]: { alias: 'fast', enabled: false } },
        }),
      ),
    );
    await writeFile(join(dir, 'project', 'models.lock.json'), JSON.stringify(await snapshotFixture()));

    const err: string[] = [];
    const networkForbidden: FetchLike = async () => {
      throw new Error('config export must never call fetch');
    };
    const deps: CliDeps = {
      cwd: join(dir, 'project'),
      home: join(dir, 'home'),
      env: {},
      stdout: () => {},
      stderr: (t) => err.push(t),
      isTTY: false,
      fetch: networkForbidden,
      fetchAdapter: { id: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic' },
      loadProfile: async (client, version) => ({
        client,
        version,
        status: 'pending',
        correlation: false,
        correlationEntropy: 'pending',
        fork: false,
        adapterMarkerPosition: 'unknown',
        probes: {},
        lifecycle: { 'next-turn': 'pending', resume: 'pending', compaction: 'pending', nested: 'pending', parallel: 'pending' },
      }),
      loadTransportProfile: async (adapterId, runtimeVersion) => ({ adapterId, runtimeVersion, status: 'pending', gzipBytes: 'pending', responseHeaders: 'pending' }),
      now: () => new Date('2026-09-08T00:00:00.000Z'),
    };

    const code = await runCli(['config', 'export', '--client', 'codex', '--output', join(dir, 'out')], deps);
    expect(code).toBe(2);
    expect(err.join('')).toContain('model-not-allowed');
  });

  test('catalogRequired:false with no snapshot exports the role as-is, unverified (naming-only path)', async () => {
    await writeFile(
      join(dir, 'project', 'subagent-router.json'),
      JSON.stringify(configFixture({ roles: { 'codex:reviewer': { routeOverride: 'gateway/not-a-real-model' } } })),
    );
    // No models.lock.json written: no snapshot exists, and catalogRequired:false means codex
    // does not need one, unlike opencode.
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await codexInventory(join(dir, 'project'), join(dir, 'home'));

    const plan = await exportConfig(configPath, 'codex', join(dir, 'out'), {
      dryRun: true,
      force: false,
      inventory,
      catalogRequired: false,
      resolverContext: resolverContext(),
    });
    const toml = plan.find((f) => f.relativePath === 'codex/agents/reviewer.toml');
    expect(toml?.content).toContain('gateway/not-a-real-model');
  });

  test('--force does not overwrite an existing valid export when the newly selected model is invalid', async () => {
    await writeConfigAndSnapshot(FIXTURE_MODEL_ID, await snapshotFixture());
    const configPath = join(dir, 'project', 'subagent-router.json');
    const outDir = join(dir, 'out');
    const firstInventory = await codexInventory(join(dir, 'project'), join(dir, 'home'));
    await exportConfig(configPath, 'codex', outDir, { dryRun: false, force: false, inventory: firstInventory, catalogRequired: false, resolverContext: resolverContext() });

    const tomlPath = join(outDir, 'codex', 'agents', 'reviewer.toml');
    const before = await readFile(tomlPath, 'utf8');
    expect(before).toContain(FIXTURE_MODEL_ID);

    await writeConfigAndSnapshot(UNKNOWN_MODEL_ID, await snapshotFixture());
    const secondInventory = await codexInventory(join(dir, 'project'), join(dir, 'home'));
    await expect(
      exportConfig(configPath, 'codex', outDir, { dryRun: false, force: true, inventory: secondInventory, catalogRequired: false, resolverContext: resolverContext() }),
    ).rejects.toMatchObject({ code: 'unknown-model' });

    const after = await readFile(tomlPath, 'utf8');
    expect(after).toBe(before);
  });
});
