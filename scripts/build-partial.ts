#!/usr/bin/env bun
/**
 * TEMPORARY verification build for the entrypoints whose sources exist today.
 *
 * `scripts/build.ts` remains the real build and correctly refuses to run until every advertised
 * entrypoint exists, `src/adapters/codex-hook.ts` (Task 11) included. This script exists only so
 * `tests/package.test.ts` can verify the entrypoints that DO exist without waiting on Task 11, and
 * it excludes codex-hook rather than emitting a placeholder for it. Delete this file and switch
 * `tests/package.test.ts` back onto `bun run build` once codex-hook.ts lands.
 */
import { chmod, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');

interface Entrypoint {
  source: string;
  out: string;
  target: 'node' | 'bun';
  executable?: boolean;
}

const ENTRYPOINTS: readonly Entrypoint[] = [
  { source: 'src/index.ts', out: 'core.js', target: 'node' },
  { source: 'src/transport/handler.ts', out: 'handler.js', target: 'node' },
  { source: 'src/bun.ts', out: 'cli.js', target: 'bun', executable: true },
  { source: 'src/transport/claude-hook.ts', out: 'claude-hook.js', target: 'bun', executable: true },
  { source: 'src/adapters/opencode-plugin.ts', out: 'opencode-plugin.js', target: 'bun', executable: true },
];

const SHEBANG = '#!/usr/bin/env bun\n';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function bundle(entry: Entrypoint): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(ROOT, entry.source)],
    target: entry.target,
    format: 'esm',
    splitting: false,
    ...(entry.executable ? { banner: SHEBANG.trimEnd() } : {}),
  });
  if (!result.success) fail(`build-partial: bundling ${entry.source} failed:\n${result.logs.map(String).join('\n')}`);
  const artifact = result.outputs[0];
  if (artifact === undefined) fail(`build-partial: bundling ${entry.source} produced no output`);
  const outPath = join(DIST, entry.out);
  await mkdir(dirname(outPath), { recursive: true });
  await Bun.write(outPath, await artifact.text());
  if (entry.executable) await chmod(outPath, 0o755);
}

async function emitDeclarations(): Promise<void> {
  const tsc = join(ROOT, 'node_modules', '.bin', 'tsc');
  if (!(await Bun.file(tsc).exists())) {
    fail('build-partial: node_modules/.bin/tsc is missing. Run `bun install` first.');
  }
  const proc = Bun.spawn([tsc, '-p', join(ROOT, 'tsconfig.build.json')], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) fail(`build-partial: declaration emit failed:\n${out}${err}`);
}

async function copyCapabilityProfiles(): Promise<void> {
  const from = join(ROOT, 'tests', 'fixtures', 'capabilities');
  const to = join(DIST, 'capabilities');
  await cp(from, to, { recursive: true });
}

async function main(): Promise<void> {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  for (const entry of ENTRYPOINTS) await bundle(entry);
  await emitDeclarations();
  await copyCapabilityProfiles();

  process.stdout.write(
    `build-partial: wrote ${ENTRYPOINTS.length} entrypoints (codex-hook excluded, Task 11 not started), ` +
      `declarations and capability profiles to dist/\n`,
  );
}

await main();
