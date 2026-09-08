#!/usr/bin/env bun
/**
 * Builds the publishable `dist/` tree: one bundle per advertised export, the declaration tree,
 * and the capability-profile data the runtime loads at startup.
 *
 * Two rules this script exists to enforce:
 *
 *  1. It never emits a placeholder. If a source entrypoint is missing, the build fails and names
 *     the missing files. A `dist/codex-hook.js` that exists but does nothing would satisfy a
 *     file-presence test while shipping a hook that silently allows every spawn, so absence is
 *     reported as an error rather than papered over.
 *  2. Declarations come from `tsconfig.build.json` (include: src, rootDir: src) and from the
 *     repository's own installed `tsc`. The root `tsconfig.json` also includes `tests` and
 *     `scripts`, which would place `dist/types/src/...` under a common root and break every
 *     advertised `types` path; and `bunx tsc` would fetch whatever version the registry serves
 *     today instead of the one in the lockfile.
 */
import { chmod, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');

interface Entrypoint {
  /** Source module, relative to the repository root. */
  source: string;
  /** Output file name inside `dist/`. */
  out: string;
  target: 'node' | 'bun';
  /** Executable entrypoints get a shebang and the executable bit. */
  executable?: boolean;
}

// `./core` and `./handler` are libraries and target Node so they stay importable outside Bun.
// The CLI and the three adapter entrypoints are executables run by Bun (or by a harness that
// spawns them), so they target Bun and carry a shebang.
const ENTRYPOINTS: readonly Entrypoint[] = [
  { source: 'src/index.ts', out: 'core.js', target: 'node' },
  { source: 'src/transport/handler.ts', out: 'handler.js', target: 'node' },
  { source: 'src/bun.ts', out: 'cli.js', target: 'bun', executable: true },
  { source: 'src/transport/claude-hook.ts', out: 'claude-hook.js', target: 'bun', executable: true },
  { source: 'src/adapters/opencode-plugin.ts', out: 'opencode-plugin.js', target: 'bun', executable: true },
  { source: 'src/adapters/codex-hook.ts', out: 'codex-hook.js', target: 'bun', executable: true },
];

const SHEBANG = '#!/usr/bin/env bun\n';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function assertSourcesPresent(): Promise<void> {
  const missing: string[] = [];
  for (const entry of ENTRYPOINTS) {
    if (!(await Bun.file(join(ROOT, entry.source)).exists())) missing.push(entry.source);
  }
  if (missing.length > 0) {
    fail(
      `build: missing entrypoint sources, refusing to emit a partial package:\n` +
        missing.map((file) => `  - ${file}`).join('\n') +
        `\nThese modules are advertised in package.json exports/bin. The build does not create ` +
        `placeholders for them, because an empty adapter entrypoint would look installed while ` +
        `failing open at runtime.`,
    );
  }
}

async function bundle(entry: Entrypoint): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(ROOT, entry.source)],
    target: entry.target,
    format: 'esm',
    splitting: false,
    // No minification: the package ships readable code, and `tests/package.test.ts` greps the
    // bundles for `Bun.`/`node:fs` to prove the core stayed runtime-agnostic.
    ...(entry.executable ? { banner: SHEBANG.trimEnd() } : {}),
  });

  if (!result.success) {
    const logs = result.logs.map((log) => String(log)).join('\n');
    fail(`build: bundling ${entry.source} failed:\n${logs}`);
  }
  const artifact = result.outputs[0];
  if (artifact === undefined) fail(`build: bundling ${entry.source} produced no output`);

  const outPath = join(DIST, entry.out);
  await mkdir(dirname(outPath), { recursive: true });
  await Bun.write(outPath, await artifact.text());
  // The hooks and the CLI are spawned directly by a harness (and by `bin`), so they need the
  // executable bit, not just a shebang.
  if (entry.executable) await chmod(outPath, 0o755);
}

async function emitDeclarations(): Promise<void> {
  const tsc = join(ROOT, 'node_modules', '.bin', 'tsc');
  if (!(await Bun.file(tsc).exists())) {
    fail('build: node_modules/.bin/tsc is missing. Run `bun install` first; the build never fetches a compiler.');
  }
  const proc = Bun.spawn([tsc, '-p', join(ROOT, 'tsconfig.build.json')], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) fail(`build: declaration emit failed:\n${out}${err}`);
}

/**
 * Capability profiles are runtime data, not test fixtures: the CLI resolves a client version to
 * one of these files before it will call any adapter path supported. They are copied into the
 * package so an installed copy fails closed on an unmeasured version instead of falling back to
 * whatever happens to sit in a consumer's checkout.
 */
async function copyCapabilityProfiles(): Promise<void> {
  const from = join(ROOT, 'tests', 'fixtures', 'capabilities');
  const to = join(DIST, 'capabilities');
  if (!(await Bun.file(join(from, 'claude-code-2.1.263.json')).exists())) {
    fail(`build: capability profiles not found at ${from}`);
  }
  await cp(from, to, { recursive: true });
}

async function main(): Promise<void> {
  await assertSourcesPresent();
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  for (const entry of ENTRYPOINTS) await bundle(entry);
  await emitDeclarations();
  await copyCapabilityProfiles();

  process.stdout.write(`build: wrote ${ENTRYPOINTS.length} entrypoints, declarations and capability profiles to dist/\n`);
}

await main();
