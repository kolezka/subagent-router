import type { FetchLike } from '../core/types';

/**
 * Bun-specific FetchLike adapter that forwards a request's raw wire bytes untouched: it disables
 * Bun's default gzip auto-decompression (which otherwise rewrites the body without correcting the
 * content-length/content-encoding headers it still reports -- see the pending default
 * transport-bun-fetch-<version>.json fixture) and disables automatic redirect following, so a
 * caller sees exactly what the upstream sent. This is a transport-layer adapter only, not a
 * request handler, and it is never imported by the handler directly -- the entrypoint injects it
 * as the FetchLike dependency.
 */
export const bunRawFetch: FetchLike = (request: Request): Promise<Response> => {
  return fetch(request, { decompress: false, redirect: 'manual' } as RequestInit);
};

export const BUN_RAW_FETCH_ADAPTER: { readonly id: string; readonly runtimeVersion: string } = {
  id: 'bun-fetch-raw',
  runtimeVersion: Bun.version,
};
