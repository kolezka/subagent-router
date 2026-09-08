// End-to-end CLI workflow: models sync (fake fetch) -> models describe -> route preview ->
// config check -> config export --dry-run, all through runCli in one temp project directory.
// Every assertion re-reads state from disk (either a raw fixture file, or a fresh `config check`
// call, which itself calls loadState from scratch) rather than trusting anything held in memory
// from a previous step. `config check` also doubles as the generation probe between steps: its
// payload's `generation` field proves a write actually changed on-disk state, and that a
// dry-run export does not. Every step other than the sync itself is given a fetch that throws,
// so an offline command silently reaching the network fails the test loudly instead of passing
// by accident.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main';
import type { CliDeps, FetchLike } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture } from '../support/fixtures';

const TESTS_TMP_DIR = join(import.meta.dir, '..', 'tmp');
const SECOND_MODEL_ID = 'gateway/second-worker';

let dir = '';
let out: string[] = [];
let err: string[] = [];

function listing(ids: string[]): FetchLike {
  return async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
}

const networkForbidden: FetchLike = async () => {
  throw new Error('offline CLI step attempted a network fetch');
};

function deps(fetch: FetchLike): CliDeps {
  return {
    cwd: join(dir, 'project'),
    home: join(dir, 'home'),
    env: { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 'workflow-token', ROUTER_SECRET: 'workflow-secret' },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    isTTY: false,
    fetch,
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
}

async function run(argv: string[], fetch: FetchLike): Promise<{ code: 0 | 1 | 2; json: Record<string, unknown> }> {
  out = [];
  err = [];
  const code = await runCli(argv, deps(fetch));
  return { code, json: out.length === 0 ? {} : (JSON.parse(out.join('')) as Record<string, unknown>) };
}

async function configCheckGeneration(): Promise<{ generation: string; problems: unknown[] }> {
  const { code, json } = await run(['config', 'check', '--json'], networkForbidden);
  expect(code).toBe(0);
  return json as { generation: string; problems: unknown[] };
}

beforeEach(async () => {
  await mkdir(TESTS_TMP_DIR, { recursive: true });
  dir = await mkdtemp(join(TESTS_TMP_DIR, 'subagent-router-cli-workflow-'));
  out = [];
  err = [];
  await mkdir(join(dir, 'project', '.claude', 'agents'), { recursive: true });
  // No `model:` field: declaredModel stays undefined ('unknown' once rendered), which is fine --
  // route preview resolves the model through the role default, not the agent's own declaration.
  await writeFile(join(dir, 'project', '.claude', 'agents', 'explorer.md'), '---\ndescription: Workflow test agent.\n---\nExplore.\n');
  await writeFile(join(dir, 'project', 'subagent-router.json'), JSON.stringify(configFixture()));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('cli-workflow: sync -> describe -> preview -> check -> export --dry-run', () => {
  test('each step reads real on-disk state; generation changes on writes and only on writes', async () => {
    // Baseline: no snapshot yet. config check still works (agent-only checks) and gives a
    // generation computed from config alone.
    const gen0 = await configCheckGeneration();
    expect(gen0.problems).toEqual([]);

    // Step 1: models sync, the only step allowed to touch the network.
    const sync = await run(['models', 'sync', '--json'], listing([FIXTURE_MODEL_ID, SECOND_MODEL_ID]));
    expect(sync.code).toBe(0);
    expect(sync.json.added).toEqual([FIXTURE_MODEL_ID, SECOND_MODEL_ID]);

    // Read the written snapshot directly off disk, not the CLI's own report of it.
    const snapshotOnDisk = JSON.parse(await readFile(join(dir, 'project', 'models.lock.json'), 'utf8')) as { models: Array<{ id: string }> };
    expect(snapshotOnDisk.models.map((m) => m.id).sort()).toEqual([FIXTURE_MODEL_ID, SECOND_MODEL_ID].sort());

    const gen1 = await configCheckGeneration();
    expect(gen1.generation).not.toBe(gen0.generation); // the snapshot write changed on-disk state
    expect(gen1.problems).toEqual([]); // FIXTURE_MODEL_ID (the role default) now resolves cleanly

    // Step 2: models describe, offline.
    const describeText = 'Routes fast workflow steps.';
    const describe = await run(['models', 'describe', FIXTURE_MODEL_ID, '--text', describeText, '--json'], networkForbidden);
    expect(describe.code).toBe(0);

    // Read the written config directly off disk.
    const configOnDisk = JSON.parse(await readFile(join(dir, 'project', 'subagent-router.json'), 'utf8')) as {
      modelOverrides: Record<string, { description?: string }>;
    };
    expect(configOnDisk.modelOverrides[FIXTURE_MODEL_ID]?.description).toBe(describeText);

    const gen2 = await configCheckGeneration();
    expect(gen2.generation).not.toBe(gen1.generation);
    expect(gen2.generation).not.toBe(gen0.generation);

    // Step 3: route preview, offline. Sees the freshly-synced, freshly-described model through
    // the role default (claude-code:explorer -> FIXTURE_MODEL_ID from configFixture()).
    const preview = await run(['route', 'preview', '--client', 'claude-code', '--agent', 'explorer', '--json'], networkForbidden);
    expect(preview.code).toBe(0);
    expect(preview.json).toMatchObject({
      mode: 'simulation',
      generation: gen2.generation, // same on-disk generation config check just reported
      decision: { kind: 'route', upstreamModel: FIXTURE_MODEL_ID, source: 'role-default' },
    });

    // Step 4: config check, offline (already exercised above as the generation probe; run once
    // more explicitly as the documented workflow step and confirm it still reports no problems).
    const check = await run(['config', 'check', '--json'], networkForbidden);
    expect(check.code).toBe(0);
    expect(check.json.problems).toEqual([]);

    // Step 5: config export --dry-run, offline. Reports the planned files but writes nothing.
    const outDir = join(dir, 'out');
    const exportResult = await run(['config', 'export', '--client', 'claude-code', '--output', outDir, '--dry-run', '--json'], networkForbidden);
    expect(exportResult.code).toBe(0);
    expect(exportResult.json.files).toContain('claude/settings-fragment.json');
    await expect(readdir(outDir)).rejects.toMatchObject({ code: 'ENOENT' }); // dry-run created nothing

    const gen3 = await configCheckGeneration();
    expect(gen3.generation).toBe(gen2.generation); // no write happened since the last write (describe)
  });
});
