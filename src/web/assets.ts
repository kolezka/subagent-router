// Serves the built Svelte console out of `dist/web`. The bundle is a build artifact, not a source
// file, so this module reads it from the package root at request time instead of embedding it.
// `scripts/build-web.ts` writes exactly three files there and guarantees they satisfy the CSP
// below, which is why the policy can stay this tight.
import { join } from 'node:path';
import { findPackageRoot } from '../agents/export';

/**
 * `script-src 'self'` rather than the `'unsafe-inline'` the old hand-written page needed: the app
 * ships as a real file now, so nothing has to be inlined. `connect-src 'self'` keeps the page
 * talking to this console and nowhere else, and `img-src data:` covers the empty favicon only.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

// Exactly what `scripts/build-web.ts` writes. An unlisted path is a 404, so the console can never
// be turned into a file server for the package directory.
const ASSETS: Readonly<Record<string, { file: string; type: string }>> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/main.js': { file: 'main.js', type: 'text/javascript; charset=utf-8' },
  '/main.css': { file: 'main.css', type: 'text/css; charset=utf-8' },
};

// A page telling the operator how to fix the build, shown when dist/web is absent. Inline markup
// is fine here because it carries no script: it renders under the same CSP as the real app.
const MISSING_BUNDLE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>subagent-router console</title></head>
<body>
<h1>The console bundle is not built</h1>
<p>Run <code>bun run build:web</code> in the repository, then reload this page.</p>
<p>The JSON API on this port answers already, so <code>curl</code> against <code>/api/system/status</code> works without the bundle.</p>
</body></html>
`;

export function webAssetDir(): string {
  return join(findPackageRoot(import.meta.dir), 'dist', 'web');
}

/**
 * Answers a static path, or `undefined` when the path is not one of the console's three assets.
 * Returning undefined (rather than a 404) lets the caller fall through to the API table, so the
 * route order stays in one place.
 */
export async function assetResponse(pathname: string): Promise<Response | undefined> {
  const asset = ASSETS[pathname];
  if (asset === undefined) return undefined;

  const file = Bun.file(join(webAssetDir(), asset.file));
  if (!(await file.exists())) {
    // Only the entry document explains itself. A missing main.js answers 503 so a stale page in a
    // browser tab fails loudly instead of rendering half an app.
    if (asset.file !== 'index.html') {
      return new Response('the console bundle is not built; run `bun run build:web`\n', {
        status: 503,
        headers: { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    return new Response(MISSING_BUNDLE_PAGE, {
      status: 200,
      headers: { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' },
    });
  }

  return new Response(file, { status: 200, headers: { ...SECURITY_HEADERS, 'content-type': asset.type } });
}
