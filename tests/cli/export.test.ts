// Task 13 export subsystem tests. Calls `exportConfig` directly (main.ts/write.ts dispatch is a
// separate, unimplemented task on this base) so these tests exercise the real contract without
// depending on `runCli`.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readAgentInventory } from '../../src/agents/inventory';
import { CLAUDE_VERSION_ENV_REF, CONTROL_URL_ENV_REF, dumpToml, exportConfig, findPackageRoot, type ExportOptions } from '../../src/agents/export';
import { sha256 } from '../../src/core/hash';
import { loadState } from '../../src/io/store';
import type { AgentInventory, ClientId, ResolverOptions } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

// Inventory shape for tests that only exercise root protection or export/sidecar agreement and
// don't care about file-based agent entries.
const emptyInventory: AgentInventory = { entries: [], completeness: 'files-only', diagnostics: [] };

// Required test temp root, not the OS tmpdir: keeps fixture state inside this checkout.
const TESTS_TMP_ROOT = join(import.meta.dir, '..', 'tmp');

let dir = '';

async function inventoryFor(client: ClientId, cwd: string, home: string): Promise<AgentInventory> {
  const options: ResolverOptions = { cwd, home, env: {}, additionalRoots: [] };
  return readAgentInventory(client, options);
}

// The default resolver context for most tests: project/home under the per-test `dir`, no env
// overrides, no extra roots. Root-protection-specific tests build their own context instead.
function resolverContext(): ExportOptions['resolverContext'] {
  return { cwd: join(dir, 'project'), home: join(dir, 'home'), env: {}, additionalRoots: [] };
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
  dir = await mkdtemp(join(TESTS_TMP_ROOT, 'subagent-router-export-'));
  await mkdir(join(dir, 'project', '.opencode', 'agents'), { recursive: true });
  await mkdir(join(dir, 'home', '.codex', 'agents'), { recursive: true });
  await writeFile(join(dir, 'project', '.opencode', 'agents', 'reviewer.md'), '---\ndescription: Przegląd\nmodel: inherit\n---\nSprawdzaj.\n');
  await writeFile(join(dir, 'home', '.codex', 'agents', 'reviewer.toml'), 'name = "reviewer"\nmodel = "gateway/base"\n');
  await writeFile(
    join(dir, 'project', 'subagent-router.json'),
    JSON.stringify(configFixture({ roles: { 'codex:reviewer': { routeOverride: FIXTURE_MODEL_ID } } })),
  );
  await writeFile(join(dir, 'project', 'models.lock.json'), JSON.stringify(await snapshotFixture()));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('config export', () => {
  test('opencode export writes a variant into the artifact directory and never touches native files', async () => {
    const configPath = join(dir, 'project', 'subagent-router.json');
    const before = await treeHash(join(dir, 'project', '.opencode'));
    const inventory = await inventoryFor('opencode', join(dir, 'project'), join(dir, 'home'));

    const files = await exportConfig(configPath, 'opencode', join(dir, 'out'), { dryRun: false, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() });

    expect(files.some((f) => f.relativePath === 'opencode/agents/reviewer@fast.md')).toBe(true);
    expect(await readFile(join(dir, 'out', 'opencode', 'agents', 'reviewer@fast.md'), 'utf8')).toContain('model: gateway/gateway/fast-worker');
    expect(await treeHash(join(dir, 'project', '.opencode'))).toBe(before);
  });

  test('codex export produces a TOML role with routeOverride that Bun.TOML.parse reads back', async () => {
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await inventoryFor('codex', join(dir, 'project'), join(dir, 'home'));

    await exportConfig(configPath, 'codex', join(dir, 'out'), { dryRun: false, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() });

    const parsed = Bun.TOML.parse(await readFile(join(dir, 'out', 'codex', 'agents', 'reviewer.toml'), 'utf8')) as { model: string; name: string };
    expect(parsed.model).toBe(FIXTURE_MODEL_ID);
    expect(parsed.name).toBe('reviewer');
  });

  test('a native agent directory and a symlink to it are both rejected, even with --force', async () => {
    const configPath = join(dir, 'project', 'subagent-router.json');
    const native = join(dir, 'project', '.opencode', 'agents');
    const inventory = await inventoryFor('opencode', join(dir, 'project'), join(dir, 'home'));

    await expect(
      exportConfig(configPath, 'opencode', native, { dryRun: false, force: true, inventory, catalogRequired: false, resolverContext: resolverContext() }),
    ).rejects.toThrow('export-native-root');

    await symlink(native, join(dir, 'link'));
    await expect(
      exportConfig(configPath, 'opencode', join(dir, 'link'), { dryRun: true, force: true, inventory, catalogRequired: false, resolverContext: resolverContext() }),
    ).rejects.toThrow('export-native-root');
  });

  test('an existing artifact requires --force, and --dry-run writes nothing', async () => {
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await inventoryFor('opencode', join(dir, 'project'), join(dir, 'home'));
    const outDir = join(dir, 'out');

    await exportConfig(configPath, 'opencode', outDir, { dryRun: true, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() });
    await expect(readdir(outDir)).rejects.toMatchObject({ code: 'ENOENT' });

    await exportConfig(configPath, 'opencode', outDir, { dryRun: false, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() });
    await expect(
      exportConfig(configPath, 'opencode', outDir, { dryRun: false, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() }),
    ).rejects.toThrow('export-collision');
    // The failed collision attempt must not have disturbed the previously published artifact.
    expect(await readFile(join(outDir, 'opencode', 'agents', 'reviewer@fast.md'), 'utf8')).toContain(FIXTURE_MODEL_ID);

    await exportConfig(configPath, 'opencode', outDir, { dryRun: false, force: true, inventory, catalogRequired: false, resolverContext: resolverContext() });
  });

  test('--dry-run against an existing artifact returns the plan without --force and leaves the artifact untouched', async () => {
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await inventoryFor('opencode', join(dir, 'project'), join(dir, 'home'));
    const outDir = join(dir, 'out');

    await exportConfig(configPath, 'opencode', outDir, { dryRun: false, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() });
    const before = await treeHash(outDir);

    const plan = await exportConfig(configPath, 'opencode', outDir, { dryRun: true, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() });
    expect(plan.some((f) => f.relativePath === 'opencode/agents/reviewer@fast.md')).toBe(true);
    expect(await treeHash(outDir)).toBe(before);
  });

  test('a caller-supplied LoadedState is used as-is: exportConfig does not re-read the config from disk', async () => {
    // Guards the CLI against a config edit landing between its own loadState and exportConfig's:
    // both must describe the same generation. Proven by removing the on-disk config after loading
    // and requiring the export to still succeed from the supplied state.
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await inventoryFor('opencode', join(dir, 'project'), join(dir, 'home'));
    const state = await loadState(configPath);
    await rm(configPath);

    const files = await exportConfig(configPath, 'opencode', join(dir, 'out'), { dryRun: true, force: false, inventory, catalogRequired: false, resolverContext: resolverContext(), state });
    const sidecar = JSON.parse(files.find((f) => f.relativePath === 'opencode/sidecar.json')?.content ?? '{}') as { snapshotGeneration: string };
    expect(sidecar.snapshotGeneration).toBe(state.generation);
  });

  test('force-replace fully swaps content: a renamed alias leaves no stale variant file behind', async () => {
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await inventoryFor('opencode', join(dir, 'project'), join(dir, 'home'));
    const outDir = join(dir, 'out');

    await exportConfig(configPath, 'opencode', outDir, { dryRun: false, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() });
    expect(await readdir(join(outDir, 'opencode', 'agents'))).toContain('reviewer@fast.md');

    const changed = configFixture({
      roles: { 'codex:reviewer': { routeOverride: FIXTURE_MODEL_ID } },
      modelOverrides: { [FIXTURE_MODEL_ID]: { alias: 'renamed', description: 'x', enabled: true } },
    });
    await writeFile(configPath, JSON.stringify(changed));

    await exportConfig(configPath, 'opencode', outDir, { dryRun: false, force: true, inventory, catalogRequired: false, resolverContext: resolverContext() });
    const after = await readdir(join(outDir, 'opencode', 'agents'));
    expect(after).toContain('reviewer@renamed.md');
    expect(after).not.toContain('reviewer@fast.md');
  });

  test('missing snapshot is refused for opencode before any write', async () => {
    await rm(join(dir, 'project', 'models.lock.json'));
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await inventoryFor('opencode', join(dir, 'project'), join(dir, 'home'));

    await expect(
      exportConfig(configPath, 'opencode', join(dir, 'out'), { dryRun: false, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() }),
    ).rejects.toThrow('export-snapshot-missing');
    await expect(readdir(join(dir, 'out'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a traversal attempt in a codex role name is rejected before any file is written', async () => {
    const configPath = join(dir, 'project', 'subagent-router.json');
    await writeFile(configPath, JSON.stringify(configFixture({ roles: { 'codex:../../evil': { routeOverride: FIXTURE_MODEL_ID } } })));
    const inventory: AgentInventory = {
      entries: [
        {
          client: 'codex',
          name: '../../evil',
          scope: 'user',
          path: join(dir, 'home', '.codex', 'agents', 'reviewer.toml'),
          hidden: false,
          native: {},
          availability: 'available',
          shadowed: false,
        },
      ],
      completeness: 'files-only',
      diagnostics: [],
    };

    await expect(
      exportConfig(configPath, 'codex', join(dir, 'out'), { dryRun: false, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() }),
    ).rejects.toThrow('export-unsafe-name');
    await expect(readdir(join(dir, 'out'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Reproduction of the final-review blocker: a native OpenCode agent file whose frontmatter
  // `name` carries `..` segments flowed verbatim into `opencode/agents/<name>@<alias>.md` and was
  // joined into the staging dir, so the write landed OUTSIDE the output directory (here: inside
  // the toy home's .claude/agents). The file is read through the real inventory scanner, not an
  // injected entry, so the whole chain frontmatter -> inventory -> variants -> export is covered.
  const TRAVERSAL_NAME = '../../../home/.claude/agents/unexpected';

  async function writeTraversalAgent(): Promise<void> {
    await writeFile(
      join(dir, 'project', '.opencode', 'agents', 'evil.md'),
      `---\nname: ${TRAVERSAL_NAME}\ndescription: Escapes\nmodel: inherit\n---\nEscape.\n`,
    );
  }

  test('a traversal attempt in an opencode agent frontmatter name is rejected and writes nothing outside the output directory', async () => {
    const configPath = join(dir, 'project', 'subagent-router.json');
    await writeTraversalAgent();
    const inventory = await inventoryFor('opencode', join(dir, 'project'), join(dir, 'home'));
    expect(inventory.entries.some((entry) => entry.name === TRAVERSAL_NAME)).toBe(true); // positive control: the scanner really picked the name up

    await expect(
      exportConfig(configPath, 'opencode', join(dir, 'out'), { dryRun: false, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() }),
    ).rejects.toThrow('export-unsafe-name');

    await expect(readdir(join(dir, 'out'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(join(dir, 'home', '.claude'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('the same opencode traversal is rejected in --dry-run too, and the plan is never returned', async () => {
    const configPath = join(dir, 'project', 'subagent-router.json');
    await writeTraversalAgent();
    const inventory = await inventoryFor('opencode', join(dir, 'project'), join(dir, 'home'));

    await expect(
      exportConfig(configPath, 'opencode', join(dir, 'out'), { dryRun: true, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() }),
    ).rejects.toThrow('export-unsafe-name');
    await expect(readdir(join(dir, 'out'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('claude settings fragment', () => {
  test('exports a read-only SubagentStart hook fragment naming dist/claude-hook.js and only the secretEnv name', async () => {
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await inventoryFor('claude-code', join(dir, 'project'), join(dir, 'home'));

    const files = await exportConfig(configPath, 'claude-code', join(dir, 'out'), { dryRun: true, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() });

    const fragment = files.find((f) => f.relativePath === 'claude/settings-fragment.json');
    expect(fragment).toBeDefined();
    const parsed = JSON.parse(fragment?.content ?? '{}') as {
      hooks: { SubagentStart: Array<{ hooks: Array<{ type: string; command: string }> }> };
      secretEnv: string;
    };
    expect(parsed.hooks.SubagentStart[0]?.hooks[0]?.type).toBe('command');
    expect(parsed.hooks.SubagentStart[0]?.hooks[0]?.command).toContain('dist/claude-hook.js');
    expect(parsed.hooks.SubagentStart[0]?.hooks[0]?.command).toContain(configPath);
    expect(parsed.secretEnv).toBe('ROUTER_SECRET');
    // exportConfig never receives `env`, so there is structurally no secret value it could leak;
    // this asserts the fragment carries only the env var NAME, never something claiming to be a value.
    expect(fragment?.content).not.toMatch(/"secret"\s*:\s*"(?!ROUTER_SECRET")/);
  });

  test('dry-run and a real run produce byte-identical fragments, and nothing is written on --settings', async () => {
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await inventoryFor('claude-code', join(dir, 'project'), join(dir, 'home'));

    const dryPlan = await exportConfig(configPath, 'claude-code', join(dir, 'out'), { dryRun: true, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() });
    await expect(readdir(join(dir, 'out'))).rejects.toMatchObject({ code: 'ENOENT' });

    await exportConfig(configPath, 'claude-code', join(dir, 'out'), { dryRun: false, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() });
    const written = await readFile(join(dir, 'out', 'claude', 'settings-fragment.json'), 'utf8');
    expect(written).toBe(dryPlan.find((f) => f.relativePath === 'claude/settings-fragment.json')?.content ?? '');
  });
});

describe('opencode plugin wiring', () => {
  test('exports an absolute tool.execute.before plugin entrypoint and a providerId/upstreamModel sidecar', async () => {
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await inventoryFor('opencode', join(dir, 'project'), join(dir, 'home'));

    const files = await exportConfig(configPath, 'opencode', join(dir, 'out'), { dryRun: true, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() });

    const plugin = files.find((f) => f.relativePath === 'opencode/plugin-fragment.json');
    const sidecar = files.find((f) => f.relativePath === 'opencode/sidecar.json');
    expect(plugin).toBeDefined();
    expect(sidecar).toBeDefined();

    const pluginParsed = JSON.parse(plugin?.content ?? '{}') as { plugin: string[] };
    expect(pluginParsed.plugin[0]).toContain('dist/opencode-plugin.js');
    expect(pluginParsed.plugin[0]?.startsWith('/')).toBe(true);

    const sidecarParsed = JSON.parse(sidecar?.content ?? '{}') as { providerId: string; models: Record<string, { upstreamModel: string }> };
    expect(sidecarParsed.providerId).toBe('gateway');
    expect(sidecarParsed.models.fast?.upstreamModel).toBe(FIXTURE_MODEL_ID);
  });
});

describe('codex PreToolUse wiring', () => {
  test('exports a PreToolUse/Agent hook descriptor naming dist/codex-hook.js without claiming measured support', async () => {
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await inventoryFor('codex', join(dir, 'project'), join(dir, 'home'));

    const files = await exportConfig(configPath, 'codex', join(dir, 'out'), { dryRun: true, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() });

    const fragment = files.find((f) => f.relativePath === 'codex/pretooluse-fragment.json');
    expect(fragment).toBeDefined();
    const parsed = JSON.parse(fragment?.content ?? '{}') as { hookEventName: string; matcher: string; command: string; _status: string };
    expect(parsed.hookEventName).toBe('PreToolUse');
    expect(parsed.matcher).toBe('Agent');
    expect(parsed.command).toContain('dist/codex-hook.js');
    expect(parsed._status.toLowerCase()).toContain('unmeasured');
  });

  test('the optional model_catalog is emitted only when harness.codex.emitModelCatalog is true', async () => {
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await inventoryFor('codex', join(dir, 'project'), join(dir, 'home'));

    const off = await exportConfig(configPath, 'codex', join(dir, 'out-off'), { dryRun: true, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() });
    expect(off.some((f) => f.relativePath === 'codex/model_catalog.json')).toBe(false);

    await writeFile(
      configPath,
      JSON.stringify(
        configFixture({
          roles: { 'codex:reviewer': { routeOverride: FIXTURE_MODEL_ID } },
          harness: { claudeCode: { correlation: 'auto', secretEnv: 'ROUTER_SECRET' }, opencode: { providerId: 'gateway' }, codex: { emitModelCatalog: true } },
        }),
      ),
    );
    const on = await exportConfig(configPath, 'codex', join(dir, 'out-on'), { dryRun: true, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() });
    expect(on.some((f) => f.relativePath === 'codex/model_catalog.json')).toBe(true);
  });
});

describe('sidecar hashing', () => {
  test('sidecar hashes match the actual bytes of every other artifact in the same atomic plan', async () => {
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await inventoryFor('opencode', join(dir, 'project'), join(dir, 'home'));

    const files = await exportConfig(configPath, 'opencode', join(dir, 'out'), { dryRun: true, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() });
    const sidecar = files.find((f) => f.relativePath === 'opencode/sidecar.json');
    expect(sidecar).toBeDefined();

    const parsed = JSON.parse(sidecar?.content ?? '{}') as { artifacts: Record<string, string> };
    for (const file of files) {
      if (file === sidecar) continue;
      expect(parsed.artifacts[file.relativePath]).toBe(await sha256(file.content));
    }
    expect(Object.keys(parsed.artifacts)).not.toContain(sidecar?.relativePath);
  });
});

describe('dumpToml', () => {
  test('roundtrips through Bun.TOML.parse for the supported subset', () => {
    const value = { name: 'reviewer', model: 'gateway/x y', enabled: true, depth: 2, tags: ['a', 'b'], limits: { max: 3 } };
    expect(Bun.TOML.parse(dumpToml(value))).toEqual(value);
  });

  test('a value beyond one level of tables throws RouterError', () => {
    expect(() => dumpToml({ nested: { deeper: { x: 1 } } })).toThrow('export-unsupported-value');
  });

  test('a non-string array element throws RouterError', () => {
    expect(() => dumpToml({ tags: ['a', 1 as unknown as string] })).toThrow('export-unsupported-value');
  });
});

describe('generated command paths and quoting', () => {
  // `set --` applies the exact same word-splitting/quote-removal a POSIX shell applies to a
  // command's own arguments, without executing anything, so this parses `command` the same way a
  // real shell would if it ran it. The first resulting word is the program path itself.
  async function shArgv(command: string): Promise<string[]> {
    const script = `set -- ${command}\nfor a in "$@"; do printf '%s\\n' "$a"; done`;
    const proc = Bun.spawn(['/bin/sh', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`sh failed to parse generated command: ${err}`);
    return out.length === 0 ? [] : out.replace(/\n$/, '').split('\n');
  }

  test('the claude command references the exact program and profile-dir paths this package computes', async () => {
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await inventoryFor('claude-code', join(dir, 'project'), join(dir, 'home'));

    const files = await exportConfig(configPath, 'claude-code', join(dir, 'out'), { dryRun: true, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() });
    const fragment = files.find((f) => f.relativePath === 'claude/settings-fragment.json');
    const parsed = JSON.parse(fragment?.content ?? '{}') as { hooks: { SubagentStart: Array<{ hooks: Array<{ command: string }> }> } };
    const command = parsed.hooks.SubagentStart[0]?.hooks[0]?.command ?? '';

    // Same package.json marker findPackageRoot itself walks up to, so this holds without dist/
    // being built; actual dist/ artifact existence is covered by tests/package.test.ts, after its
    // own real build.
    const packageRoot = findPackageRoot(import.meta.dir);
    const argv = await shArgv(command);
    expect(argv[0]).toBe(join(packageRoot, 'dist', 'claude-hook.js'));
    expect(argv[argv.indexOf('--profile-dir') + 1]).toBe(join(packageRoot, 'dist', 'capabilities'));
  });

  test('the claude command keeps the operator env-var references double-quoted, never POSIX single-quoted', async () => {
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await inventoryFor('claude-code', join(dir, 'project'), join(dir, 'home'));

    const files = await exportConfig(configPath, 'claude-code', join(dir, 'out'), { dryRun: true, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() });
    const fragment = files.find((f) => f.relativePath === 'claude/settings-fragment.json');
    const parsed = JSON.parse(fragment?.content ?? '{}') as { hooks: { SubagentStart: Array<{ hooks: Array<{ command: string }> }> } };
    const command = parsed.hooks.SubagentStart[0]?.hooks[0]?.command ?? '';

    expect(command).toContain(`"\${${CONTROL_URL_ENV_REF}}"`);
    expect(command).toContain(`"\${${CLAUDE_VERSION_ENV_REF}}"`);
  });

  test('a config path containing a space and an apostrophe survives shell tokenization as one argument', async () => {
    const trickyProjectDir = join(dir, "o'brien's project");
    await mkdir(trickyProjectDir, { recursive: true });
    const configPath = join(trickyProjectDir, 'subagent-router.json');
    await writeFile(configPath, JSON.stringify(configFixture()));
    const inventory = await inventoryFor('claude-code', trickyProjectDir, join(dir, 'home'));

    const files = await exportConfig(configPath, 'claude-code', join(dir, 'out'), {
      dryRun: true,
      force: false,
      inventory,
      catalogRequired: false,
      resolverContext: { cwd: trickyProjectDir, home: join(dir, 'home'), env: {}, additionalRoots: [] },
    });
    const fragment = files.find((f) => f.relativePath === 'claude/settings-fragment.json');
    const parsed = JSON.parse(fragment?.content ?? '{}') as { hooks: { SubagentStart: Array<{ hooks: Array<{ command: string }> }> } };
    const command = parsed.hooks.SubagentStart[0]?.hooks[0]?.command ?? '';

    const argv = await shArgv(command);
    const configArg = argv[argv.indexOf('--config') + 1];
    expect(configArg).toBe(configPath); // one token, byte-identical to the literal path -- never split on the space
  });

  test('the codex command quotes its program path, config path, sidecar path and profile dir; a space in outputDir does not split the sidecar path', async () => {
    const trickyOutDir = join(dir, 'out dir');
    const configPath = join(dir, 'project', 'subagent-router.json');
    const inventory = await inventoryFor('codex', join(dir, 'project'), join(dir, 'home'));

    const files = await exportConfig(configPath, 'codex', trickyOutDir, { dryRun: true, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() });
    const fragment = files.find((f) => f.relativePath === 'codex/pretooluse-fragment.json');
    const parsed = JSON.parse(fragment?.content ?? '{}') as { command: string };

    const packageRoot = findPackageRoot(import.meta.dir);
    const argv = await shArgv(parsed.command);
    expect(argv[0]).toBe(join(packageRoot, 'dist', 'codex-hook.js'));
    const configArg = argv[argv.indexOf('--config') + 1];
    expect(configArg).toBe(configPath);
    // exportConfig resolves outputDir's real (symlink-free) location first, so compare against
    // that same resolution rather than the raw tmpdir string (macOS: /var -> /private/var).
    const sidecarArg = argv[argv.indexOf('--sidecar') + 1];
    expect(sidecarArg).toBe(join(await realpath(dir), 'out dir', 'codex', 'sidecar.json'));
    expect(argv[argv.indexOf('--profile-dir') + 1]).toBe(join(packageRoot, 'dist', 'capabilities'));
  });
});

describe('native root protection', () => {
  test('an empty, not-yet-created native root is still protected -- no files are needed to trigger it', async () => {
    // home/.claude/agents does not exist at all (beforeEach only ever creates .codex/agents under
    // home); this is the coordinator's own reproduction of the bug: exportConfig writing straight
    // into an empty simulated home/.claude/agents.
    const configPath = join(dir, 'project', 'subagent-router.json');
    const context: ExportOptions['resolverContext'] = { cwd: join(dir, 'project'), home: join(dir, 'home'), env: {}, additionalRoots: [] };

    await expect(
      exportConfig(configPath, 'claude-code', join(dir, 'home', '.claude', 'agents'), {
        dryRun: true, force: true, inventory: emptyInventory, catalogRequired: false, resolverContext: context,
      }),
    ).rejects.toThrow('export-native-root');
  });

  test('a native root is protected across every client, not only the one being exported', async () => {
    // codex's own user root (created in beforeEach); exporting 'opencode' straight into it must
    // still be refused, even though opencode itself declares no root there.
    const configPath = join(dir, 'project', 'subagent-router.json');
    const context: ExportOptions['resolverContext'] = { cwd: join(dir, 'project'), home: join(dir, 'home'), env: {}, additionalRoots: [] };

    await expect(
      exportConfig(configPath, 'opencode', join(dir, 'home', '.codex', 'agents'), {
        dryRun: true, force: true, inventory: emptyInventory, catalogRequired: false, resolverContext: context,
      }),
    ).rejects.toThrow('export-native-root');
  });

  test('a claude-code configRoot override and an additionalRoots entry are both protected, with no files present', async () => {
    const customConfigRoot = join(dir, 'custom-claude-config');
    const extraRoot = join(dir, 'extra-agents');
    const configPath = join(dir, 'project', 'subagent-router.json');
    await writeFile(
      configPath,
      JSON.stringify(
        configFixture({ agentRoots: { 'claude-code': { configRoot: customConfigRoot }, opencode: { configRoot: null }, codex: { configRoot: null } } }),
      ),
    );
    const context: ExportOptions['resolverContext'] = { cwd: join(dir, 'project'), home: join(dir, 'home'), env: {}, additionalRoots: [extraRoot] };

    await expect(
      exportConfig(configPath, 'claude-code', join(customConfigRoot, 'agents'), {
        dryRun: true, force: true, inventory: emptyInventory, catalogRequired: false, resolverContext: context,
      }),
    ).rejects.toThrow('export-native-root');

    await expect(
      exportConfig(configPath, 'claude-code', extraRoot, {
        dryRun: true, force: true, inventory: emptyInventory, catalogRequired: false, resolverContext: context,
      }),
    ).rejects.toThrow('export-native-root');
  });

  test('a native root declared through a symlinked ancestor resolves to the same real location as its literal target', async () => {
    const realHome = await mkdtemp(join(TESTS_TMP_ROOT, 'subagent-router-realhome-'));
    const homeLink = join(dir, 'home-link');
    await symlink(realHome, homeLink);
    const configPath = join(dir, 'project', 'subagent-router.json');
    // The root is declared through the symlink (a realistic resolverContext.home value)...
    const context: ExportOptions['resolverContext'] = { cwd: join(dir, 'project'), home: homeLink, env: {}, additionalRoots: [] };

    try {
      // ...but the export targets the REAL path directly, bypassing the symlink lexically.
      await expect(
        exportConfig(configPath, 'claude-code', join(realHome, '.claude', 'agents'), {
          dryRun: true, force: true, inventory: emptyInventory, catalogRequired: false, resolverContext: context,
        }),
      ).rejects.toThrow('export-native-root');
    } finally {
      await rm(realHome, { recursive: true, force: true });
    }
  });

  test('the concrete client target directory is checked, not just the parent output root', async () => {
    const nativeRoot = join(dir, 'protected-elsewhere');
    await mkdir(nativeRoot, { recursive: true });
    const outParent = join(dir, 'out-parent');
    await mkdir(outParent, { recursive: true });
    // outParent itself is clean; outParent/claude (the concrete per-client target) is a symlink
    // into a protected root.
    await symlink(nativeRoot, join(outParent, 'claude'));

    const configPath = join(dir, 'project', 'subagent-router.json');
    const context: ExportOptions['resolverContext'] = { cwd: join(dir, 'project'), home: join(dir, 'home'), env: {}, additionalRoots: [nativeRoot] };

    await expect(
      exportConfig(configPath, 'claude-code', outParent, {
        dryRun: true, force: true, inventory: emptyInventory, catalogRequired: false, resolverContext: context,
      }),
    ).rejects.toThrow('export-native-root');
  });

  test('a not-yet-created native root spelled with different case is still refused, even with --force', async () => {
    // home/.claude/agents (the real, lowercase candidate root claude-code declares) does not
    // exist in this test; this exercises the exact bypass this fix closes: a native root that
    // never existed yet cannot be canonicalized by a real `realpath` call, so only a case-folded
    // string comparison -- not the filesystem itself -- can catch a differently-cased spelling.
    const configPath = join(dir, 'project', 'subagent-router.json');
    const context: ExportOptions['resolverContext'] = { cwd: join(dir, 'project'), home: join(dir, 'home'), env: {}, additionalRoots: [] };
    const differentlyCasedTarget = join(dir, 'home', '.CLAUDE', 'AGENTS');

    await expect(
      exportConfig(configPath, 'claude-code', differentlyCasedTarget, {
        dryRun: false, force: true, inventory: emptyInventory, catalogRequired: false, resolverContext: context,
      }),
    ).rejects.toThrow('export-native-root');

    await expect(readdir(differentlyCasedTarget)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(join(dir, 'home', '.claude', 'agents'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('an EXISTING native root reached through a differently-cased output path is still refused, and its file is untouched', async () => {
    const configPath = join(dir, 'project', 'subagent-router.json');
    await mkdir(join(dir, 'home', '.claude', 'agents'), { recursive: true });
    await writeFile(join(dir, 'home', '.claude', 'agents', 'explorer.md'), '---\nname: explorer\n---\nExplore.\n');
    const nativeBefore = await readFile(join(dir, 'home', '.claude', 'agents', 'explorer.md'), 'utf8');
    const context: ExportOptions['resolverContext'] = { cwd: join(dir, 'project'), home: join(dir, 'home'), env: {}, additionalRoots: [] };

    await expect(
      exportConfig(configPath, 'claude-code', join(dir, 'home', '.CLAUDE', 'AGENTS'), {
        dryRun: false, force: true, inventory: emptyInventory, catalogRequired: false, resolverContext: context,
      }),
    ).rejects.toThrow('export-native-root');

    expect(await readFile(join(dir, 'home', '.claude', 'agents', 'explorer.md'), 'utf8')).toBe(nativeBefore);
  });

  test('a case-differing spelling of a protected additionalRoots entry is refused, with no files present', async () => {
    const extraRoot = join(dir, 'Extra-Agents');
    const configPath = join(dir, 'project', 'subagent-router.json');
    const context: ExportOptions['resolverContext'] = { cwd: join(dir, 'project'), home: join(dir, 'home'), env: {}, additionalRoots: [extraRoot] };

    await expect(
      exportConfig(configPath, 'claude-code', join(dir, 'EXTRA-agents'), {
        dryRun: true, force: true, inventory: emptyInventory, catalogRequired: false, resolverContext: context,
      }),
    ).rejects.toThrow('export-native-root');
    await expect(readdir(extraRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a Unicode NFD-decomposed spelling of the same accented path segment is treated as the same overlap as its NFC form', async () => {
    const nfc = 'café-agents'; // "café-agents", one precomposed codepoint for é
    const nfd = 'café-agents'; // "café-agents", decomposed: e + a combining acute accent
    expect(nfc).not.toBe(nfd); // sanity: genuinely different byte sequences
    expect(nfc.normalize('NFC')).toBe(nfc);
    const nativeRoot = join(dir, nfc);
    const configPath = join(dir, 'project', 'subagent-router.json');
    const context: ExportOptions['resolverContext'] = { cwd: join(dir, 'project'), home: join(dir, 'home'), env: {}, additionalRoots: [nativeRoot] };

    await expect(
      exportConfig(configPath, 'claude-code', join(dir, nfd), {
        dryRun: true, force: true, inventory: emptyInventory, catalogRequired: false, resolverContext: context,
      }),
    ).rejects.toThrow('export-native-root');
  });

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  (isRoot ? test.skip : test)('a permission error while resolving a candidate root propagates, never silently permitting the export', async () => {
    const blocked = join(dir, 'blocked');
    await mkdir(join(blocked, 'sub'), { recursive: true });
    await chmod(blocked, 0o000);
    const configPath = join(dir, 'project', 'subagent-router.json');
    const context: ExportOptions['resolverContext'] = {
      cwd: join(dir, 'no-such-cwd'),
      home: join(dir, 'no-such-home'),
      env: {},
      additionalRoots: [join(blocked, 'sub', 'agents')],
    };
    try {
      await expect(
        exportConfig(configPath, 'claude-code', join(dir, 'out'), {
          dryRun: true, force: false, inventory: emptyInventory, catalogRequired: false, resolverContext: context,
        }),
      ).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(blocked, 0o755);
    }
  });
});

describe('codex sidecar and export agreement', () => {
  test('a codex role with no native counterpart to override is omitted from the sidecar, not just from the written artifacts', async () => {
    const configPath = join(dir, 'project', 'subagent-router.json');
    await writeFile(
      configPath,
      JSON.stringify(configFixture({ roles: { 'codex:reviewer': { routeOverride: FIXTURE_MODEL_ID }, 'codex:ghost': { routeOverride: FIXTURE_MODEL_ID } } })),
    );
    // home/.codex/agents has 'reviewer.toml' (from beforeEach) but no 'ghost'.
    const inventory = await inventoryFor('codex', join(dir, 'project'), join(dir, 'home'));

    const files = await exportConfig(configPath, 'codex', join(dir, 'out'), { dryRun: true, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() });

    expect(files.some((f) => f.relativePath === 'codex/agents/reviewer.toml')).toBe(true);
    expect(files.some((f) => f.relativePath === 'codex/agents/ghost.toml')).toBe(false);

    const sidecar = files.find((f) => f.relativePath === 'codex/sidecar.json');
    const parsed = JSON.parse(sidecar?.content ?? '{}') as { roles: Record<string, { model: string }> };
    expect(parsed.roles).toHaveProperty('reviewer');
    expect(parsed.roles).not.toHaveProperty('ghost'); // no artifact was written for it -- the sidecar must not claim otherwise
  });

  test('a codex role whose native TOML shape is unsupported fails loudly instead of silently dropping the role or its properties', async () => {
    const configPath = join(dir, 'project', 'subagent-router.json');
    await writeFile(configPath, JSON.stringify(configFixture({ roles: { 'codex:reviewer': { routeOverride: FIXTURE_MODEL_ID } } })));
    const inventory: AgentInventory = {
      entries: [
        {
          client: 'codex',
          name: 'reviewer',
          scope: 'user',
          path: join(dir, 'home', '.codex', 'agents', 'reviewer.toml'),
          hidden: false,
          // Two levels of nested tables: dumpToml's documented, supported limit is one.
          native: { limits: { nested: { deeper: 1 } } },
          availability: 'available',
          shadowed: false,
        },
      ],
      completeness: 'files-only',
      diagnostics: [],
    };

    await expect(
      exportConfig(configPath, 'codex', join(dir, 'out'), { dryRun: true, force: false, inventory, catalogRequired: false, resolverContext: resolverContext() }),
    ).rejects.toThrow('export-unsupported-value');
  });
});
