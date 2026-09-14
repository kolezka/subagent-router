import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportConfig, findPackageRoot } from '../src/agents/export';

const ROOT = join(import.meta.dir, '..');

function run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

// `scripts/build.ts` is the real, advertised build. It still refuses to run (and names the
// missing file) if any advertised entrypoint source is absent -- see `scripts/build.ts`'s own
// `assertSourcesPresent`, which this task does not touch -- but every entrypoint the package
// advertises, `src/adapters/codex-hook.ts` (Task 11) included, now exists, so the real build is
// exercised directly here instead of a temporary partial-build stand-in.
//
// The build runs exactly once per test file, no matter which test executes first and no matter
// how bun orders or filters them. Every test awaits this same promise, so each one is
// independently runnable (`bun test -t '...'`) without ever building twice.
let buildOnce: Promise<{ code: number; stdout: string; stderr: string }> | undefined;
function build(): Promise<{ code: number; stdout: string; stderr: string }> {
  buildOnce ??= run('bun', ['run', 'build']);
  return buildOnce;
}

describe('package', () => {
  test('build tworzy dist z ESM i deklaracjami', async () => {
    const built = await build();
    expect(built.code).toBe(0);
    expect(await readFile(join(ROOT, 'dist', 'core.js'), 'utf8')).toContain('resolveRoute');
    expect(await readFile(join(ROOT, 'dist', 'types', 'index.d.ts'), 'utf8')).toContain('RouteDecision');
  });

  test('rdzeń importuje się w Node bez Bun i podejmuje decyzję', async () => {
    await build();
    // Not a typeof check: this actually builds a catalog from a parsed snapshot and resolves a
    // real route through it, so the assertion fails if the exported pipeline is broken rather
    // than merely absent.
    const script = `
      import('./dist/core.js').then(async (m) => {
        const alias = await m.modelAlias('gateway/fast-worker');
        const config = m.parseOperatorConfig(${JSON.stringify(configForNode())});
        const snapshot = m.parseSnapshot({
          version: 1,
          sourceId: 'test-gateway',
          sourceFingerprint: await m.sourceFingerprint('test-gateway', 'http://127.0.0.1:8000/v1', 'http://127.0.0.1:8000/v1/models'),
          fetchedAt: '2026-09-06T00:00:00.000Z',
          models: [{ id: 'gateway/fast-worker', alias, status: 'available', metadata: {} }],
        });
        const catalog = m.buildCatalog(config, snapshot);
        const decision = m.resolveRoute(
          { client: 'claude-code', scope: 'child', explicitIds: ['fast'], ignoredMarkers: 0 },
          config,
          catalog,
        );
        const unknown = m.resolveRoute(
          { client: 'claude-code', scope: 'child', explicitIds: ['nope'], ignoredMarkers: 0 },
          config,
          catalog,
        );
        console.log(JSON.stringify({
          alias,
          kind: typeof m.resolveRoute,
          decision,
          unknown: unknown.code,
          resolved: m.resolveModel('fast', catalog).id,
          routerError: new m.RouterError('x', 'y').name,
        }));
      }).catch((error) => { console.error(error); process.exit(1); });
    `;
    const result = await run('node', ['--input-type=module', '-e', script]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      alias: 'm-6414d01405c95a7bd2b2a13b415d7685a1673f800ca90dd031a5eeb1776dc81d',
      kind: 'function',
      decision: { kind: 'route', upstreamModel: 'gateway/fast-worker', clientModel: 'haiku', source: 'explicit', ignoredMarkers: 0 },
      unknown: 'unknown-model',
      resolved: 'gateway/fast-worker',
      routerError: 'RouterError',
    });
  });

  test('dist/core.js nie zawiera odwołań do Bun ani do node:fs', async () => {
    await build();
    const core = await readFile(join(ROOT, 'dist', 'core.js'), 'utf8');
    expect(core.includes('Bun.')).toBe(false);
    expect(core.includes('node:fs')).toBe(false);
  });

  test('handler importuje się w Node bez Bun i wystawia createClaudeStartOutput', async () => {
    await build();
    const script = `
      import('./dist/handler.js').then((m) => {
        console.log(JSON.stringify({
          createHandler: typeof m.createHandler,
          createClaudeStartOutput: typeof m.createClaudeStartOutput,
        }));
      }).catch((error) => { console.error(error); process.exit(1); });
    `;
    const result = await run('node', ['--input-type=module', '-e', script]);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ createHandler: 'function', createClaudeStartOutput: 'function' });
  });

  test('CLI odpowiada na --version i --help z kodem 0, a nieznana komenda kodem 2', async () => {
    await build();
    expect((await run('bun', ['dist/cli.js', '--version'])).code).toBe(0);
    expect((await run('bun', ['dist/cli.js', '--help'])).stdout).toContain('models sync');
    expect((await run('bun', ['dist/cli.js', 'nope'])).code).toBe(2);
  });

  test('the version the CLI prints is the version the package declares', async () => {
    await build();
    // src/cli/main.ts carries the version as a literal, so a release bump touches two files and
    // nothing links them. A CLI that reports a version the package does not declare makes every
    // bug report ambiguous, so the two are locked together here rather than in a release checklist.
    const declared = (JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
    const printed = (await run('bun', ['dist/cli.js', '--version'])).stdout.trim();
    expect(printed).toBe(declared);
  });

  test('import ./bun nie startuje serwera', async () => {
    await build();
    // Importing the CLI module must be inert: the argv dispatch is guarded by import.meta.main,
    // so a consumer importing runCli/startServer never binds a port or writes to stdout.
    const result = await run('bun', ['-e', 'const m = await import("./dist/cli.js"); console.log(JSON.stringify({ runCli: typeof m.runCli, startServer: typeof m.startServer }));']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ runCli: 'function', startServer: 'function' });
  });

  test('build zawiera trzy wykonywalne entrypointy adapterów natywnych i uruchamia je na fixtures', async () => {
    await build();
    for (const file of ['claude-hook.js', 'opencode-plugin.js', 'codex-hook.js']) {
      expect((await readFile(join(ROOT, 'dist', file), 'utf8')).length).toBeGreaterThan(0);
    }
    const smoke = await run('bun', ['tests/support/run-built-entrypoints.ts']);
    expect(smoke).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(smoke.stdout)).toEqual({ claude: 'synthetic-deny', opencode: 'synthetic-deny', codex: 'synthetic-deny' });
  });

  test('wszystkie reklamowane ścieżki exports i bin istnieją w dist', async () => {
    await build();
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      exports: Record<string, { import: string; types: string }>;
      bin: Record<string, string>;
      files: string[];
    };
    const advertised: string[] = [];
    for (const entry of Object.values(pkg.exports)) {
      advertised.push(entry.import, entry.types);
    }
    advertised.push(...Object.values(pkg.bin));
    for (const relative of advertised) {
      const contents = await readFile(join(ROOT, relative.replace(/^\.\//, '')), 'utf8');
      expect(contents.length).toBeGreaterThan(0);
    }
    expect(pkg.files).toEqual(['dist']);
  });

  test('paczka zawiera profile capability i nie importuje testów', async () => {
    await build();
    const profile = JSON.parse(await readFile(join(ROOT, 'dist', 'capabilities', 'claude-code-2.1.263.json'), 'utf8')) as { client: string };
    expect(profile.client).toBe('claude-code');
    for (const file of ['core.js', 'handler.js', 'cli.js', 'claude-hook.js', 'opencode-plugin.js', 'codex-hook.js']) {
      expect(await readFile(join(ROOT, 'dist', file), 'utf8')).not.toContain('tests/support');
    }
  });

  // The one place that checks exportConfig's program/profile-dir paths actually exist on disk.
  // Source-level export tests only check them structurally, so they still pass with no dist/.
  test('exportConfig references program and profile-dir paths that exist in the built package', async () => {
    await build();
    const scratchDir = join(ROOT, 'tests', 'tmp', 'package-export-check');
    await mkdir(scratchDir, { recursive: true });
    try {
      const configPath = join(scratchDir, 'subagent-router.json');
      await writeFile(configPath, JSON.stringify(configForNode()));
      const files = await exportConfig(configPath, 'claude-code', join(scratchDir, 'out'), {
        dryRun: true,
        force: false,
        inventory: { entries: [], completeness: 'files-only', diagnostics: [] },
        catalogRequired: false,
        resolverContext: { cwd: ROOT, home: join(scratchDir, 'home'), env: {}, additionalRoots: [] },
      });
      const fragment = files.find((f) => f.relativePath === 'claude/settings-fragment.json');
      const command = (JSON.parse(fragment?.content ?? '{}') as { hooks: { SubagentStart: Array<{ hooks: Array<{ command: string }> }> } })
        .hooks.SubagentStart[0]?.hooks[0]?.command ?? '';

      const packageRoot = findPackageRoot(import.meta.dir);
      const programPath = join(packageRoot, 'dist', 'claude-hook.js');
      const profileDir = join(packageRoot, 'dist', 'capabilities');
      expect(command).toContain(programPath);
      expect(command).toContain(profileDir);
      expect((await readFile(programPath, 'utf8')).length).toBeGreaterThan(0);
      expect((await readFile(join(profileDir, 'claude-code-2.1.263.json'), 'utf8')).length).toBeGreaterThan(0);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});

// Kept out of the Node script string so the fixture stays readable and is not duplicated.
function configForNode(): Record<string, unknown> {
  return {
    version: 1,
    modelSource: {
      sourceId: 'test-gateway',
      baseUrlEnv: 'GATEWAY_URL',
      endpointPath: '/v1/models',
      authEnv: 'MODELS_AUTH',
      headersEnv: ['GATEWAY_HEADERS'],
      timeoutMs: 10000,
      fetchLimit: 1000,
      staleAfterSeconds: 86400,
    },
    modelOverrides: { 'gateway/fast-worker': { alias: 'fast', description: 'Szybkie zadania.', enabled: true, clientModel: 'haiku' } },
    roles: { 'claude-code:explorer': { routeOverride: 'gateway/fast-worker' } },
    defaults: { child: null, unmarkedSubagent: 'error' },
    agentRoots: { 'claude-code': { configRoot: null }, opencode: { configRoot: null }, codex: { configRoot: null } },
    gateway: { urlEnv: 'GATEWAY_URL', headersEnv: ['GATEWAY_HEADERS'] },
    harness: { claudeCode: { correlation: 'auto', secretEnv: 'ROUTER_SECRET' }, opencode: { providerId: 'gateway' }, codex: { emitModelCatalog: false } },
  };
}
