import { RouterError } from '../core/errors';
import type { FetchLike, OperatorConfig, SourceContext } from '../core/types';

export interface DiscoveredModel {
  id: string;
  displayName?: string;
}

interface ParsedPage {
  data: readonly DiscoveredModel[];
  hasMore: boolean;
  nextCursor?: string;
}

function schemaError(detail: string): never {
  throw new RouterError('discovery-schema', `discovery response ${detail}`);
}

// Contract: {"data":[{"id":"...","display_name"?:"..."}],"has_more"?:boolean,"next_cursor"?:string}.
// A response without "has_more" means the list is complete.
function parsePage(text: string): ParsedPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RouterError('discovery-json', 'discovery response body is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return schemaError('must be a JSON object');
  }
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.data)) {
    return schemaError('must contain a "data" array');
  }

  const data: DiscoveredModel[] = root.data.map((raw): DiscoveredModel => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return schemaError('"data" items must be objects');
    }
    const item = raw as Record<string, unknown>;
    // Upstream IDs are compared case-sensitive and are never trimmed or normalized.
    if (typeof item.id !== 'string' || item.id.length === 0) {
      return schemaError('"data" items must have a non-empty string id');
    }
    const displayNameRaw = item.display_name;
    return typeof displayNameRaw === 'string' && displayNameRaw.length > 0
      ? { id: item.id, displayName: displayNameRaw }
      : { id: item.id };
  });

  if (root.has_more !== undefined && typeof root.has_more !== 'boolean') {
    return schemaError('"has_more" must be a boolean when present');
  }
  if (root.next_cursor !== undefined && (typeof root.next_cursor !== 'string' || root.next_cursor.length === 0)) {
    return schemaError('"next_cursor" must be a non-empty string when present');
  }

  return {
    data,
    hasMore: root.has_more === true,
    ...(typeof root.next_cursor === 'string' ? { nextCursor: root.next_cursor } : {}),
  };
}

export async function discoverModels(
  config: OperatorConfig,
  source: SourceContext,
  fetcher: FetchLike,
  signal?: AbortSignal,
): Promise<readonly DiscoveredModel[]> {
  const combinedSignal = AbortSignal.any([
    AbortSignal.timeout(config.modelSource.timeoutMs),
    ...(signal === undefined ? [] : [signal]),
  ]);
  const headers = new Headers(source.headers);
  // Cursor values already used to fetch a page. A proposed next_cursor that reuses one of these
  // stops pagination before it loops forever against a misbehaving or malicious upstream.
  const visitedCursors = new Set<string>();
  const seenIds = new Set<string>();
  const results: DiscoveredModel[] = [];
  let cursor: string | undefined;

  for (;;) {
    if (cursor !== undefined) visitedCursors.add(cursor);

    // The response never controls the request: the cursor is the only value it can influence,
    // and it only ever lands in the "cursor" query parameter on the configured models URL.
    const url = new URL(source.effectiveModelsUrl);
    if (cursor !== undefined) url.searchParams.set('cursor', cursor);

    const request = new Request(url, { headers, redirect: 'manual', signal: combinedSignal });
    const response = await fetcher(request);

    if (response.status >= 300 && response.status < 400) {
      throw new RouterError('discovery-redirect', `discovery response returned a redirect (status ${response.status}); redirects are not followed`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new RouterError('discovery-auth', `discovery request was rejected (status ${response.status})`);
    }
    if (!response.ok) {
      throw new RouterError('discovery-http', `discovery request failed with status ${response.status}`);
    }

    const page = parsePage(await response.text());

    // Pagination metadata is validated before this page's models are merged into the result so a
    // page that repeats an already-visited cursor is reported as a pagination cycle, not folded
    // into the duplicate-id check below.
    if (page.hasMore) {
      if (page.nextCursor === undefined) {
        throw new RouterError('discovery-pagination', 'has_more is true but next_cursor is missing');
      }
      if (visitedCursors.has(page.nextCursor)) {
        throw new RouterError('discovery-pagination', 'discovery pagination cursor cycle detected');
      }
    }

    for (const item of page.data) {
      if (seenIds.has(item.id)) {
        throw new RouterError('discovery-duplicate', `model id ${item.id} was returned more than once`);
      }
      seenIds.add(item.id);
      results.push(item);
    }

    if (results.length > config.modelSource.fetchLimit) {
      throw new RouterError('discovery-limit', `discovery returned more than the configured fetchLimit of ${config.modelSource.fetchLimit} models`);
    }

    if (!page.hasMore) return results;
    cursor = page.nextCursor;
  }
}
