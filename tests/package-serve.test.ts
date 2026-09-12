import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelAlias, sourceFingerprint } from '../src/core/hash';
import { resolveSource } from '../src/io/environment';
import { startCaptureGateway } from './support/capture-gateway';
import { FIXTURE_FETCHED_AT, FIXTURE_MODEL_ID, configFixture } from './support/fixtures';

const ROOT = join(import.meta.dir, '..');
const SYNTHETIC_CLAUDE_VERSION = '9.9.9';

function run(command: string, args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env });
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

async function waitForListening(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`packaged serve did not report readiness: ${output}`)), 10000);
    if (child.stdout === null) {
      clearTimeout(timer);
      reject(new Error('packaged serve has no stdout pipe'));
      return;
    }
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`packaged serve exited before readiness: ${code}`));
    });
  });
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once('exit', (code, signal) => {
      if (code === 0 || signal === 'SIGTERM') resolve();
      else reject(new Error(`packaged serve exited unexpectedly: code=${code} signal=${signal}`));
    });
    child.kill('SIGTERM');
  });
}

test('two default builds archive the previous dist and retain every shipped artifact', async () => {
  const defaultBuildEnv = { ...process.env };
  delete defaultBuildEnv.BUILD_OUTPUT_DIR;

  const first = await run('bun', ['run', 'scripts/build.ts'], defaultBuildEnv as Record<string, string>);
  expect(first.code).toBe(0);
  const second = await run('bun', ['run', 'scripts/build.ts'], defaultBuildEnv as Record<string, string>);
  expect(second.code).toBe(0);

  for (const path of [
    'core.js',
    'handler.js',
    'cli.js',
    'claude-hook.js',
    'opencode-plugin.js',
    'codex-hook.js',
    'types/index.d.ts',
    'types/transport/handler.d.ts',
    'types/bun.d.ts',
    'types/transport/claude-hook.d.ts',
    'types/adapters/opencode-plugin.d.ts',
    'types/adapters/codex-hook.d.ts',
  ]) {
    expect((await readFile(join(ROOT, 'dist', path), 'utf8')).length).toBeGreaterThan(0);
  }

  const sourceProfiles = await readdir(join(ROOT, 'tests', 'fixtures', 'capabilities'));
  for (const profile of sourceProfiles) {
    expect((await readFile(join(ROOT, 'dist', 'capabilities', profile), 'utf8')).length).toBeGreaterThan(0);
  }
  expect((await readdir(join(ROOT, '.build-history'))).length).toBeGreaterThan(0);
});

test('build writes a packaged CLI to an explicit empty dist directory and serves a loopback request', async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'subagent-router-package-serve-'));
  const destination = join(packageRoot, 'dist');
  const build = await run('bun', ['run', 'scripts/build.ts'], { ...process.env, BUILD_OUTPUT_DIR: destination });

  expect(build.code).toBe(0);
  expect(await readFile(join(destination, 'cli.js'), 'utf8')).toContain('startServer');
  const help = await run('bun', [join(destination, 'cli.js'), '--help'], process.env as Record<string, string>);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('serve [--port <n>]');

  const gateway = await startCaptureGateway();
  const stateDir = await mkdtemp(join(tmpdir(), 'subagent-router-package-serve-state-'));
  const config = configFixture();
  const env = { GATEWAY_URL: `${gateway.url}/v1`, GATEWAY_HEADERS: '{}', MODELS_AUTH: 't', ROUTER_SECRET: 'synthetic-test-secret' };
  const source = resolveSource(config, env);
  const alias = await modelAlias(FIXTURE_MODEL_ID);
  await writeFile(join(stateDir, 'subagent-router.json'), JSON.stringify(config));
  await writeFile(
    join(stateDir, 'models.lock.json'),
    JSON.stringify({
      version: 1,
      sourceId: source.sourceId,
      sourceFingerprint: await sourceFingerprint(source.sourceId, source.effectiveGatewayUrl, source.effectiveModelsUrl),
      fetchedAt: FIXTURE_FETCHED_AT,
      models: [{ id: FIXTURE_MODEL_ID, alias, status: 'available', metadata: {} }],
    }),
  );
  await writeFile(
    join(destination, 'capabilities', `claude-code-${SYNTHETIC_CLAUDE_VERSION}.json`),
    JSON.stringify({
      client: 'claude-code',
      version: SYNTHETIC_CLAUDE_VERSION,
      status: 'supported',
      correlation: false,
      correlationEntropy: 'pending',
      fork: false,
      adapterMarkerPosition: 'unknown',
      probes: { M10: 'passed' },
      lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' },
      diagnostics: ['synthetic-package-serve-test-only'],
    }),
  );
  await writeFile(
    join(destination, 'capabilities', `transport-bun-fetch-raw-${Bun.version}.json`),
    JSON.stringify({ adapterId: 'bun-fetch-raw', runtimeVersion: Bun.version, status: 'passed', gzipBytes: 'passed', responseHeaders: 'passed' }),
  );

  const child = spawn('bun', [join(destination, 'cli.js'), 'serve', '--config', join(stateDir, 'subagent-router.json'), '--host', '127.0.0.1', '--port', '0', '--claude-version', SYNTHETIC_CLAUDE_VERSION], {
    cwd: stateDir,
    env: { ...process.env, ...env },
  });
  try {
    const url = await waitForListening(child);
    const response = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-child-default',
        system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }],
        messages: [{ role: 'user', content: '<subagent-router v="1" model="fast"/>\nRoute this child.' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.model).toBe(FIXTURE_MODEL_ID);
  } finally {
    await waitForExit(child);
    await gateway.close();
  }
});
