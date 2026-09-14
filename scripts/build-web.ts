#!/usr/bin/env bun
/**
 * Bundles the Svelte console into `dist/web/`: exactly `index.html`, `main.js` and `main.css`.
 *
 * Three rules this script exists to enforce:
 *
 *  1. It never emits a partial bundle. A compile failure, a missing entrypoint or a missing CSS
 *     artifact exits non-zero and names what went wrong, the same way `scripts/build.ts` refuses to
 *     write a placeholder. A `main.js` that exists but carries half an app would satisfy a
 *     file-presence test while serving a blank page.
 *  2. Asset names are fixed, not hashed. The server sends a lockdown CSP and serves three known
 *     paths; a hashed name would mean the HTML and the server had to agree on a generated string.
 *  3. The output has to survive `script-src 'self'; style-src 'self'`, so the generated HTML
 *     carries no inline script and no inline style. `assertNoInlineOrRemote` re-reads what was
 *     written and fails the build if either appears, because the CSP is sent by a module this
 *     script does not own and will not be loosened to match a bundle.
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SveltePlugin } from 'bun-plugin-svelte';

const ROOT = join(import.meta.dir, '..');
const APP_DIR = join(ROOT, 'src', 'web', 'app');
const ENTRY = join(APP_DIR, 'src', 'main.ts');
const HTML_TEMPLATE = join(APP_DIR, 'index.html');
const OUT_DIR = join(ROOT, 'dist', 'web');

/**
 * Absolute URLs that are allowed to appear as text in the bundle because nothing ever requests
 * them. Verified by reading the surrounding code in dist/web/main.js, not assumed: the svelte.dev
 * and github.com strings are the body of `Error(...)` messages Svelte's production runtime throws,
 * and the w3.org one is the XHTML namespace literal passed to `createElementNS`.
 */
const ALLOWED_REMOTE_STRINGS = ['https://svelte.dev/e/', 'https://github.com/sveltejs/svelte', 'http://www.w3.org/'];

/** Off-origin usages that are violations no matter which URL they name. */
const REQUEST_SHAPED: readonly RegExp[] = [
  /\b(?:fetch|EventSource|WebSocket|Worker|importScripts)\s*\(\s*["'`]\s*(?:https?:)?\/\//i,
  /\bimport\s*\(\s*["'`]\s*(?:https?:)?\/\//i,
  /@import\s+(?:url\(\s*)?["']?\s*(?:https?:)?\/\//i,
  /\burl\(\s*["']?\s*(?:https?:)?\/\//i,
  /\bsrc\s*=\s*["'`]\s*(?:https?:)?\/\//i,
];

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * Fails after deleting whatever was written. Measured: without this, a rejected bundle stayed in
 * dist/web after a non-zero exit, so a server started later would serve the exact artifact the
 * check had just refused.
 */
async function failAndDiscard(message: string): Promise<never> {
  await rm(OUT_DIR, { recursive: true, force: true });
  fail(message);
}

async function assertSourcesPresent(): Promise<void> {
  const missing: string[] = [];
  for (const file of [ENTRY, HTML_TEMPLATE]) {
    if (!(await Bun.file(file).exists())) missing.push(file.slice(ROOT.length + 1));
  }
  if (missing.length > 0) {
    fail(
      `build:web: missing app sources, refusing to emit a partial console:\n` +
        missing.map((file) => `  - ${file}`).join('\n'),
    );
  }
}

/**
 * bun-plugin-svelte injects HMR glue whenever NODE_ENV is not 'production', regardless of its own
 * `development: false`. Set it here so `bun run build:web` cannot ship a dev bundle from a shell
 * that happens to have NODE_ENV unset.
 */
function forceProductionEnv(): void {
  process.env.NODE_ENV = 'production';
}

async function bundle(): Promise<void> {
  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir: OUT_DIR,
    target: 'browser',
    format: 'esm',
    minify: true,
    splitting: false,
    sourcemap: 'none',
    // Svelte reads its DEV flag through esm-env, which picks an export condition. Without
    // 'production' here Bun resolves the 'development' one and ships the dev runtime: bigger, with
    // every dev-only validation compiled in. Measured: the flag minifies to `var _=!0` without it.
    conditions: ['production'],
    define: { 'process.env.NODE_ENV': '"production"' },
    // Fixed names: the server serves /main.js and /main.css by path, so a hash would break it.
    naming: { entry: '[name].[ext]', chunk: '[name].[ext]', asset: '[name].[ext]' },
    plugins: [SveltePlugin({ development: false })],
  });

  if (!result.success) {
    const logs = result.logs.map((log) => String(log)).join('\n');
    await failAndDiscard(`build:web: bundling ${ENTRY.slice(ROOT.length + 1)} failed:\n${logs}`);
  }
}

/** Substitutes the asset names into the template rather than copying, so the template can move. */
async function writeHtml(): Promise<void> {
  const template = await Bun.file(HTML_TEMPLATE).text();
  const html = template.replaceAll('__MAIN_JS__', 'main.js').replaceAll('__MAIN_CSS__', 'main.css');
  if (html.includes('__MAIN_')) {
    await failAndDiscard('build:web: index.html still holds an unsubstituted __MAIN_*__ placeholder');
  }
  await Bun.write(join(OUT_DIR, 'index.html'), html);
}

async function assertOutputsPresent(): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const name of ['index.html', 'main.js', 'main.css']) {
    const file = Bun.file(join(OUT_DIR, name));
    if (!(await file.exists())) {
      await failAndDiscard(
        `build:web: expected dist/web/${name} and it was not written. The console serves exactly ` +
          `index.html, main.js and main.css; a missing one means the page loads broken.`,
      );
    }
    if (file.size === 0) await failAndDiscard(`build:web: dist/web/${name} is empty`);
    sizes.set(name, file.size);
  }
  return sizes;
}

/**
 * The CSP the server sends is `script-src 'self'; style-src 'self'; connect-src 'self'` with
 * `default-src 'none'`. Anything inline or off-origin is dead on arrival in the browser, so it is
 * caught here rather than by an operator looking at a blank page.
 */
async function assertNoInlineOrRemote(): Promise<void> {
  const html = await Bun.file(join(OUT_DIR, 'index.html')).text();
  const problems: string[] = [];

  // An inline <script> means a script element with a body; a src-only element is what we want.
  for (const tag of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if ((tag[2] ?? '').trim().length > 0) problems.push(`index.html: inline <script> body: ${(tag[2] ?? '').trim().slice(0, 80)}`);
  }
  if (/<style\b/i.test(html)) problems.push('index.html: inline <style> element');
  if (/\sstyle\s*=\s*["']/i.test(html)) problems.push('index.html: inline style attribute');
  for (const attr of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']*)["']/gi)) {
    const value = attr[1] ?? '';
    // data: is allowed for images only, and the template uses it for the icon so no request is made.
    if (/^(?:[a-z]+:)?\/\//i.test(value)) problems.push(`index.html: remote asset reference ${value}`);
  }

  const js = await Bun.file(join(OUT_DIR, 'main.js')).text();
  const css = await Bun.file(join(OUT_DIR, 'main.css')).text();

  for (const [label, text] of [
    ['main.js', js],
    ['main.css', css],
  ] as const) {
    for (const match of text.matchAll(/https?:\/\/[^\s"'`)]+/gi)) {
      const value = match[0] ?? '';
      if (ALLOWED_REMOTE_STRINGS.some((prefix) => value.startsWith(prefix))) continue;
      problems.push(`${label}: remote URL ${value}`);
    }
    // Checked independently of the allowlist: an allowed string used as a request target would
    // still be a real CSP violation, so the shape of the usage is tested, not only the URL.
    for (const pattern of REQUEST_SHAPED) {
      const found = text.match(pattern);
      if (found !== null) problems.push(`${label}: off-origin request or asset: ${found[0].slice(0, 100)}`);
    }
  }
  if (/\bnew\s+Function\s*\(|[^.\w$]eval\s*\(/.test(js)) {
    problems.push("main.js: eval or new Function, which script-src 'self' blocks without 'unsafe-eval'");
  }

  if (problems.length > 0) {
    await failAndDiscard(
      `build:web: the bundle violates the console's Content-Security-Policy ` +
        `(default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'):\n` +
        problems.map((problem) => `  - ${problem}`).join('\n'),
    );
  }
}

async function main(): Promise<void> {
  await assertSourcesPresent();
  forceProductionEnv();
  // Only dist/web is cleared. `scripts/build.ts` owns the rest of dist/ and rotates it itself.
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  await bundle();
  await writeHtml();
  const sizes = await assertOutputsPresent();
  await assertNoInlineOrRemote();

  const summary = [...sizes].map(([name, size]) => `${name} ${(size / 1024).toFixed(1)} kB`).join(', ');
  process.stdout.write(`build:web: wrote dist/web/ (${summary}), CSP check passed\n`);
}

await main();
