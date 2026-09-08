import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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

// `scripts/build.ts` is the real, advertised build and correctly refuses to run while
// `src/adapters/codex-hook.ts` (Task 11) does not exist yet: emitting a placeholder for a missing
// adapter hook would look installed while failing open at runtime. `scripts/build-partial.ts` is a
// TEMPORARY test-only stand-in that builds every entrypoint that DOES exist, so the rest of this
// file can verify real, running artifacts instead of skipping wholesale until Task 11 lands.
//
// The build runs exactly once per test file, no matter which test executes first and no matter
// how bun orders or filters them. Every test awaits this same promise, so each one is
// independently runnable (`bun test -t '...'`) without ever building twice.
let buildOnce: Promise<{ code: number; stdout: string; stderr: string }> | undefined;
function build(): Promise<{ code: number; stdout: string; stderr: string }> {
  buildOnce ??= run('bun', ['run', 'scripts/build-partial.ts']);
  return buildOnce;
}

describe('package', () => {
  test('build prawdziwy odmawia emisji dopóki brakuje src/adapters/codex-hook.ts', async () => {
    const built = await run('bun', ['run', 'build']);
    expect(built.code).toBe(1);
    const output = built.stdout + built.stderr;
    expect(output).toContain('src/adapters/codex-hook.ts');
    expect(output).toContain('refusing to emit a partial package');
  });

  test('build (partial) tworzy dist z ESM i deklaracjami dla istniejących entrypointów', async () => {
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

  test('import ./bun nie startuje serwera', async () => {
    await build();
    // Importing the CLI module must be inert: the argv dispatch is guarded by import.meta.main,
    // so a consumer importing runCli/startServer never binds a port or writes to stdout.
    const result = await run('bun', ['-e', 'const m = await import("./dist/cli.js"); console.log(JSON.stringify({ runCli: typeof m.runCli, startServer: typeof m.startServer }));']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ runCli: 'function', startServer: 'function' });
  });

  test('build zawiera dwa wykonywalne entrypointy adapterów natywnych (bez codex, Task 11 nieukończone) i uruchamia je na fixtures', async () => {
    await build();
    for (const file of ['claude-hook.js', 'opencode-plugin.js']) {
      expect((await readFile(join(ROOT, 'dist', file), 'utf8')).length).toBeGreaterThan(0);
    }
    const smoke = await run('bun', ['tests/support/run-built-entrypoints.ts']);
    expect(smoke).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(smoke.stdout)).toEqual({ claude: 'synthetic-deny', opencode: 'synthetic-deny' });
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
    for (const file of ['core.js', 'handler.js', 'cli.js', 'claude-hook.js', 'opencode-plugin.js']) {
      expect(await readFile(join(ROOT, 'dist', file), 'utf8')).not.toContain('tests/support');
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
