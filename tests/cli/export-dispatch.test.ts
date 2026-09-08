// Focused coverage for the `config export` CLI dispatch/argument layer this worktree owns:
// --client/--output/--force parsing and validation, resolverContext threading from CliDeps into
// exportConfig, and exit-code mapping for export- error codes. The full export contract (per-
// client artifact shape, TOML round-trip, atomic staging, sidecar hashing) is already covered
// directly against exportConfig in tests/cli/export.test.ts (not owned here); this file proves
// runCli wires the same contract correctly, not a second copy of that matrix.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main';
import { sha256 } from '../../src/core/hash';
import type { CliDeps, FetchLike } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

const TESTS_TMP_ROOT = join(import.meta.dir, '..', 'tmp');

let dir = '';
let out: string[] = [];
let err: string[] = [];

const networkForbidden: FetchLike = async () => {
  throw new Error('config export must never call fetch');
};

function deps(): CliDeps {
  return {
    cwd: join(dir, 'project'),
    home: join(dir, 'home'),
    env: { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 't', ROUTER_SECRET: 's' },
    stdout: (t) => out.push(t),
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
}

function lastJson(): Record<string, unknown> {
  return JSON.parse(out.join('')) as Record<string, unknown>;
}

async function treeHash(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const entry of (await readdir(root, { recursive: true, withFileTypes: true })).filter((e) => e.isFile())) {
    const path = join(entry.parentPath, entry.name);
    hash.update(path).update(await readFile(path));
  }
  return hash.digest('hex');
}

beforeEach(async () => {
  await mkdir(TESTS_TMP_ROOT, { recursive: true });
  dir = await mkdtemp(join(TESTS_TMP_ROOT, 'subagent-router-export-dispatch-'));
  out = [];
  err = [];
  await mkdir(join(dir, 'project', '.opencode', 'agents'), { recursive: true });
  await mkdir(join(dir, 'home', '.codex', 'agents'), { recursive: true });
  await writeFile(join(dir, 'project', '.opencode', 'agents', 'reviewer.md'), '---\ndescription: Review\nmodel: inherit\n---\nCheck it.\n');
  await writeFile(join(dir, 'home', '.codex', 'agents', 'reviewer.toml'), 'name = "reviewer"\nmodel = "gateway/base"\n');
  await writeFile(join(dir, 'project', 'subagent-router.json'), JSON.stringify(configFixture({ roles: { 'codex:reviewer': { routeOverride: FIXTURE_MODEL_ID } } })));
  await writeFile(join(dir, 'project', 'models.lock.json'), JSON.stringify(await snapshotFixture()));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('config export: argument validation', () => {
  test('missing --client is a usage error, exit 2, and writes nothing', async () => {
    expect(await runCli(['config', 'export', '--output', join(dir, 'out')], deps())).toBe(2);
    expect(err.join('')).toContain('usage-missing-client');
    await expect(readdir(join(dir, 'out'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('an invalid --client value is a usage error, exit 2', async () => {
    expect(await runCli(['config', 'export', '--client', 'not-a-client', '--output', join(dir, 'out')], deps())).toBe(2);
    expect(err.join('')).toContain('usage-missing-client');
  });

  test('missing --output is a usage error, exit 2, distinct from missing --client', async () => {
    expect(await runCli(['config', 'export', '--client', 'opencode'], deps())).toBe(2);
    expect(err.join('')).toContain('usage-missing-output');
  });
});

describe('config export: dispatch produces the same artifacts exportConfig itself would', () => {
  test('opencode export via the CLI writes a variant and sidecar, never touches native files, and --json reports the plan', async () => {
    const before = await treeHash(join(dir, 'project', '.opencode'));
    const outDir = join(dir, 'out');

    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', outDir, '--json'], deps())).toBe(0);

    const payload = lastJson();
    expect(payload.client).toBe('opencode');
    expect(payload.files).toContain('opencode/agents/reviewer@fast.md');
    expect(payload.files).toContain('opencode/sidecar.json');

    // opencode variants prefix the upstream model with the configured providerId ('gateway'),
    // matching the same fixture expectation tests/cli/export.test.ts asserts against exportConfig
    // directly.
    expect(await readFile(join(outDir, 'opencode', 'agents', 'reviewer@fast.md'), 'utf8')).toContain(`model: gateway/${FIXTURE_MODEL_ID}`);
    expect(await treeHash(join(dir, 'project', '.opencode'))).toBe(before); // native source hashes unchanged

    // The sidecar's own hashes match the exact bytes written for every OTHER artifact in the
    // same plan, proving the CLI-produced files agree with what the sidecar itself claims.
    const sidecar = JSON.parse(await readFile(join(outDir, 'opencode', 'sidecar.json'), 'utf8')) as { artifacts: Record<string, string> };
    for (const relativePath of payload.files as string[]) {
      if (relativePath === 'opencode/sidecar.json') continue;
      const content = await readFile(join(outDir, ...relativePath.split('/')), 'utf8');
      expect(sidecar.artifacts[relativePath]).toBe(await sha256(content));
    }
  });

  test('codex export via the CLI produces a TOML role Bun.TOML.parse reads back with the routed model', async () => {
    const outDir = join(dir, 'out');
    expect(await runCli(['config', 'export', '--client', 'codex', '--output', outDir], deps())).toBe(0);
    const parsed = Bun.TOML.parse(await readFile(join(outDir, 'codex', 'agents', 'reviewer.toml'), 'utf8')) as { model: string; name: string };
    expect(parsed.model).toBe(FIXTURE_MODEL_ID);
    expect(parsed.name).toBe('reviewer');
  });

  test('--dry-run writes nothing but --json still reports the planned files', async () => {
    const outDir = join(dir, 'out');
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', outDir, '--dry-run', '--json'], deps())).toBe(0);
    expect(lastJson().files).toContain('opencode/agents/reviewer@fast.md');
    await expect(readdir(outDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('config export: collisions require --force', () => {
  test('a second export without --force is a collision, exit 2; --force replaces it', async () => {
    const outDir = join(dir, 'out');
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', outDir], deps())).toBe(0);
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', outDir], deps())).toBe(2);
    expect(err.join('')).toContain('export-collision');
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', outDir, '--force'], deps())).toBe(0);
  });
});

describe('config export: native-root protection reached through the CLI', () => {
  test('exporting straight into the native agents directory is refused, even with --force', async () => {
    const native = join(dir, 'project', '.opencode', 'agents');
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', native, '--force'], deps())).toBe(2);
    expect(err.join('')).toContain('export-native-root');
  });

  test('a symlink to a native root is refused too', async () => {
    const native = join(dir, 'project', '.opencode', 'agents');
    const link = join(dir, 'link');
    await symlink(native, link);
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', link, '--force'], deps())).toBe(2);
    expect(err.join('')).toContain('export-native-root');
  });

  test('an empty, not-yet-created native root is protected across every client, not only the one exporting', async () => {
    // home/.claude/agents does not exist (beforeEach only creates .codex/agents); exporting
    // 'opencode' straight into it must still be refused via the CLI's own resolverContext.
    const emptyClaudeRoot = join(dir, 'home', '.claude', 'agents');
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', emptyClaudeRoot, '--force'], deps())).toBe(2);
    expect(err.join('')).toContain('export-native-root');
  });

  test('codex\'s native root is protected even when exporting a different client (opencode)', async () => {
    const codexRoot = join(dir, 'home', '.codex', 'agents');
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', codexRoot, '--force'], deps())).toBe(2);
    expect(err.join('')).toContain('export-native-root');
  });
});

describe('config export: unsafe opencode agent names reached through the CLI', () => {
  // The final-review reproduction, through runCli: a native agent file whose frontmatter `name`
  // carries `..` segments used to exit 0 and write `home/.claude/agents/unexpected@fast.md`
  // outside --output. Exit 2 with export-unsafe-name, nothing under --output, nothing under the
  // toy home's .claude, in both the real run and --dry-run.
  const traversalName = '../../../home/.claude/agents/unexpected';

  beforeEach(async () => {
    await writeFile(
      join(dir, 'project', '.opencode', 'agents', 'evil.md'),
      `---\nname: ${traversalName}\ndescription: Escapes\nmodel: inherit\n---\nEscape.\n`,
    );
  });

  test('a real export is refused with exit 2 and writes nothing outside the output directory', async () => {
    const outDir = join(dir, 'out');
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', outDir], deps())).toBe(2);
    expect(err.join('')).toContain('export-unsafe-name');
    await expect(readdir(outDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(join(dir, 'home', '.claude'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('--dry-run is refused the same way and reports no plan', async () => {
    const outDir = join(dir, 'out');
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', outDir, '--dry-run', '--json'], deps())).toBe(2);
    expect(err.join('')).toContain('export-unsafe-name');
    expect(out.join('')).toBe('');
    await expect(readdir(outDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('config export: never touches the network', () => {
  test('a real export makes zero fetch calls (deps.fetch throws if it is ever invoked)', async () => {
    expect(await runCli(['config', 'export', '--client', 'codex', '--output', join(dir, 'out')], deps())).toBe(0);
  });
});
