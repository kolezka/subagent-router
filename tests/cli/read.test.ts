import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main';
import type { CliDeps } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

let dir = '';
let out: string[] = [];
let err: string[] = [];

function deps(patch: Partial<CliDeps> = {}): CliDeps {
  return {
    cwd: dir,
    home: join(dir, 'home'),
    env: { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 'secret-token', ROUTER_SECRET: 'hook-secret' },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    isTTY: false,
    fetch: async () => { throw new Error('sieć zabroniona w testach odczytu'); },
    fetchAdapter: { id: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic' },
    loadProfile: async (client, version) => ({ client, version, status: 'pending', correlation: false, correlationEntropy: 'pending', fork: false, adapterMarkerPosition: 'unknown', probes: {}, lifecycle: { 'next-turn': 'pending', resume: 'pending', compaction: 'pending', nested: 'pending', parallel: 'pending' } }),
    loadTransportProfile: async (adapterId, runtimeVersion) => ({ adapterId, runtimeVersion, status: 'pending', gzipBytes: 'pending', responseHeaders: 'pending' }),
    now: () => new Date('2026-09-06T12:00:00.000Z'),
    ...patch,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-cli-'));
  out = [];
  err = [];
  await mkdir(join(dir, 'home', '.claude', 'agents'), { recursive: true });
  await writeFile(join(dir, 'home', '.claude', 'agents', 'explorer.md'), '---\nname: explorer\nmodel: inherit\n---\nSzukaj.\n');
  await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(configFixture()));
  await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/undescribed'])));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function lastJson(): Record<string, unknown> {
  return JSON.parse(out.join('')) as Record<string, unknown>;
}

describe('read-only CLI', () => {
  test('models list --json pokazuje status, alias i brak opisu bez sięgania do sieci', async () => {
    expect(await runCli(['models', 'list', '--json'], deps())).toBe(0);
    const rows = lastJson().models as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.id, r.alias, r.status, r.description ?? null])).toEqual([
      [FIXTURE_MODEL_ID, 'fast', 'available', 'Szybkie zadania.'],
      ['gateway/undescribed', rows[1]?.alias, 'available', null],
    ]);
    expect(lastJson().fetchedAt).toBe('2026-09-06T00:00:00.000Z');
  });

  test('models show akceptuje alias, zwraca dokładne ID i nie normalizuje wielkości liter', async () => {
    expect(await runCli(['models', 'show', 'fast', '--json'], deps())).toBe(0);
    expect(lastJson().id).toBe(FIXTURE_MODEL_ID);
    out = [];
    expect(await runCli(['models', 'show', 'Fast', '--json'], deps())).toBe(2);
    expect(err.join('')).toContain('unknown-model');
  });

  test('agents show pokazuje declaredModel inherit, scope i router override', async () => {
    expect(await runCli(['agents', 'show', 'explorer', '--client', 'claude-code', '--json'], deps())).toBe(0);
    expect(lastJson()).toMatchObject({ name: 'explorer', declaredModel: 'inherit', scope: 'user', routeOverride: FIXTURE_MODEL_ID });
  });

  test('route preview symuluje decyzję z generacją plików, bez uruchamiania agenta i sieci', async () => {
    expect(await runCli(['route', 'preview', '--client', 'claude-code', '--agent', 'explorer', '--json'], deps())).toBe(0);
    const preview = lastJson();
    expect(preview.mode).toBe('simulation');
    expect(preview.assumptions).toEqual({ authenticatedChild: true, freshDelegation: true, runtimeCapabilityNotProven: true });
    expect(typeof preview.generation).toBe('string');
    expect(preview.decision).toMatchObject({ kind: 'route', upstreamModel: FIXTURE_MODEL_ID, source: 'role-default' });
    out = [];
    expect(await runCli(['route', 'preview', '--client', 'claude-code', '--agent', 'explorer', '--model', 'gateway/undescribed', '--json'], deps())).toBe(0);
    expect(lastJson().decision).toMatchObject({ kind: 'route', upstreamModel: 'gateway/undescribed', source: 'explicit' });
  });

  test('config show ukrywa wartości nagłówków i sekretów, także w JSON', async () => {
    expect(await runCli(['config', 'show', '--json'], deps())).toBe(0);
    const text = out.join('');
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain('hook-secret');
    expect(text).toContain('MODELS_AUTH');
  });

  test('config check zgłasza trasę do nieistniejącej roli i kończy kodem 2', async () => {
    const broken = configFixture({ roles: { 'claude-code:nobody': { routeOverride: FIXTURE_MODEL_ID } } });
    await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(broken));
    expect(await runCli(['config', 'check', '--json'], deps())).toBe(2);
    expect(JSON.stringify(lastJson().problems)).toContain('claude-code:nobody');
  });

  test('brak snapshotu nie blokuje agents list, ale blokuje preview z instrukcją sync', async () => {
    await rm(join(dir, 'models.lock.json'));
    expect(await runCli(['agents', 'list', '--client', 'claude-code', '--json'], deps())).toBe(0);
    out = [];
    expect(await runCli(['route', 'preview', '--client', 'claude-code', '--agent', 'explorer', '--json'], deps())).toBe(2);
    expect(err.join('')).toContain('models sync');
  });

  test('tryb tekstowy bez TTY nie zawiera ANSI, a znaki sterujące z opisu są escapowane', async () => {
    const config = configFixture();
    config.modelOverrides[FIXTURE_MODEL_ID] = { alias: 'fast', description: 'zły[31m opis' };
    await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(config));
    expect(await runCli(['models', 'list'], deps())).toBe(0);
    expect(out.join('')).not.toContain('');
    expect(out.join('')).toContain('\\u001b');
  });

  test('doctor offline raportuje stan configured, measured i pending bez sieci', async () => {
    expect(await runCli(['doctor', '--json'], deps())).toBe(0);
    const report = lastJson();
    expect(report.network).toBe(false);
    expect((report.clients as Array<Record<string, unknown>>).map((c) => c.status)).toEqual(['pending', 'pending', 'pending']);
  });

  test('nieznana komenda i błędne użycie dają kod 2 z pomocą na stderr', async () => {
    expect(await runCli(['models', 'explode'], deps())).toBe(2);
    expect(err.join('')).toContain('models');
  });
});
