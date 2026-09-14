// `subagent-router install` generates the Claude Code integration bundle. The invariants locked
// here are the ones an operator cannot check by reading the output: the bundle never lands in an
// installed client configuration, it never carries a credential, and the URL it hands the client
// is one the client can actually dial.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main';
import type { CliDeps } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

let dir = '';
let out: string[] = [];
let err: string[] = [];

const SECRETS = ['secret-token', 'hook-secret'];

function deps(patch: Partial<CliDeps> = {}): CliDeps {
  return {
    cwd: dir,
    home: join(dir, 'home'),
    env: { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: SECRETS[0], ROUTER_SECRET: SECRETS[1] },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    isTTY: false,
    fetch: async () => {
      throw new Error('network forbidden in install tests');
    },
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
    now: () => new Date('2026-09-14T12:00:00.000Z'),
    ...patch,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-install-'));
  out = [];
  err = [];
  await mkdir(join(dir, 'home', '.claude', 'agents'), { recursive: true });
  await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(configFixture()));
  await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture([FIXTURE_MODEL_ID])));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function lastJson(): Record<string, unknown> {
  return JSON.parse(out.join('')) as Record<string, unknown>;
}

async function readBundle(target: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (base: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(base, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(base, entry.name), relative);
      else files.set(relative, await readFile(join(base, entry.name), 'utf8'));
    }
  };
  await walk(target, '');
  return files;
}

describe('install: the generated bundle', () => {
  test('writes the settings file, launcher, plugin and README', async () => {
    expect(await runCli(['install', '--output', 'bundle', '--json'], deps())).toBe(0);
    const bundle = await readBundle(join(dir, 'bundle'));
    expect([...bundle.keys()].sort()).toEqual([
      '.claude-plugin/plugin.json',
      'README.md',
      'claude-router',
      'commands/status.md',
      'hooks/check-router.sh',
      'hooks/hooks.json',
      'settings.json',
    ]);
    expect(lastJson().routerUrl).toBe('http://127.0.0.1:8787');
  });

  test('the scripts a client spawns are executable', async () => {
    await runCli(['install', '--output', 'bundle'], deps());
    for (const script of ['claude-router', 'hooks/check-router.sh']) {
      const mode = (await stat(join(dir, 'bundle', script))).mode & 0o111;
      expect(mode).not.toBe(0);
    }
  });

  test('settings.json points the client at the router and never at a real credential', async () => {
    await runCli(['install', '--output', 'bundle', '--port', '9100'], deps());
    const settings = JSON.parse(await readFile(join(dir, 'bundle', 'settings.json'), 'utf8')) as { env: Record<string, string> };
    expect(settings.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9100');
    // Claude Code sends its own Authorization header and the router only replaces the headers named
    // in ROUTER_GATEWAY_HEADERS. Without an explicit placeholder a logged-in client would forward a
    // real Anthropic credential to a third-party gateway.
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toContain('not-a-credential');
    expect(settings.env.ANTHROPIC_MODEL).toBeUndefined();
  });

  test('--parent-model is the only way ANTHROPIC_MODEL is set', async () => {
    await runCli(['install', '--output', 'bundle', '--parent-model', 'gateway/parent'], deps());
    const settings = JSON.parse(await readFile(join(dir, 'bundle', 'settings.json'), 'utf8')) as { env: Record<string, string> };
    expect(settings.env.ANTHROPIC_MODEL).toBe('gateway/parent');
  });

  test('no generated file carries the value of an environment secret', async () => {
    // The whole bundle is meant to be readable, committable and shareable. Env var NAMES may appear
    // in it; a value resolved out of deps.env never may.
    await runCli(['install', '--output', 'bundle', '--claude-version', '2.1.270'], deps());
    const bundle = await readBundle(join(dir, 'bundle'));
    for (const [name, content] of bundle) {
      for (const secret of SECRETS) expect(`${name}: ${content}`).not.toContain(secret);
    }
  });

  test('a wildcard bind address becomes an address the client can dial', async () => {
    // `serve --host 0.0.0.0` is a listen-side address. A client that connects to it reaches nothing.
    expect(await runCli(['install', '--output', 'bundle', '--host', '0.0.0.0', '--json'], deps())).toBe(0);
    expect(lastJson().routerUrl).toBe('http://127.0.0.1:8787');
  });
});

describe('install: refusals', () => {
  test('--output is required', async () => {
    expect(await runCli(['install'], deps())).toBe(2);
    expect(err.join('')).toContain('install-missing-output');
  });

  test('a client whose integration is unmeasured is refused, not generated half-way', async () => {
    expect(await runCli(['install', '--client', 'opencode', '--output', 'bundle'], deps())).toBe(2);
    expect(err.join('')).toContain('install-unsupported-client');
    expect(await readdir(dir)).not.toContain('bundle');
  });

  test('an existing file is a collision until --force says otherwise', async () => {
    expect(await runCli(['install', '--output', 'bundle'], deps())).toBe(0);
    expect(await runCli(['install', '--output', 'bundle'], deps())).toBe(2);
    expect(err.join('')).toContain('install-collision');
    expect(await runCli(['install', '--output', 'bundle', '--force'], deps())).toBe(0);
  });

  test('the bundle never lands inside an installed client configuration', async () => {
    // The command generates files an operator opts into by hand. Writing into a native agent root
    // would make it edit the client configuration it promises not to touch.
    expect(await runCli(['install', '--output', 'home/.claude/agents'], deps())).toBe(2);
    expect(err.join('')).toContain('export-native-root');
  });

  test('--dry-run reports the plan and writes nothing', async () => {
    expect(await runCli(['install', '--output', 'bundle', '--dry-run', '--json'], deps())).toBe(0);
    expect((lastJson().files as string[]).length).toBe(7);
    expect(await readdir(dir)).not.toContain('bundle');
  });
});
