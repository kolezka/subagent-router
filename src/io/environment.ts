import { RouterError } from '../core/errors';
import { sourceFingerprint } from '../core/hash';
import type { CatalogSnapshot, Env, HeaderMap, OperatorConfig, SourceContext } from '../core/types';

function requiredEnvironmentValue(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new RouterError('source-env-missing', `environment variable ${name} is required`);
  }
  return value;
}

function canonicalUrl(env: Env, name: string): string {
  const value = requiredEnvironmentValue(env, name);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RouterError('source-url', `environment variable ${name} must contain a valid URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RouterError('source-url', `environment variable ${name} must use http or https`);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.href.includes('?') || url.href.includes('#')) {
    throw new RouterError('source-url', `environment variable ${name} must not contain userinfo, a query, or a fragment`);
  }

  return url.toString().replace(/\/+$/, '');
}

function modelsUrl(gatewayUrl: string, endpointPath: string): string {
  const gateway = new URL(gatewayUrl);
  const baseSegments = gateway.pathname.split('/').filter(Boolean);
  const endpointSegments = endpointPath.split('/').filter(Boolean);
  const lastBaseSegment = baseSegments.at(-1);

  if (lastBaseSegment !== undefined && endpointSegments[0] === lastBaseSegment) {
    endpointSegments.shift();
  }

  gateway.pathname = `/${[...baseSegments, ...endpointSegments].join('/')}`;
  return gateway.toString().replace(/\/+$/, '');
}

// Builds a validated HeaderMap from a list of env vars holding JSON string-to-string objects,
// plus an optional Bearer-token env var. Each channel (discovery headersEnv+authEnv, or gateway
// headersEnv) validates and rejects internal collisions independently: a name duplicated across
// separate channels is not a conflict, per spec (case-insensitive within a channel only).
function headersFromEnv(headersEnv: readonly string[], env: Env, authEnv?: string): HeaderMap {
  const result: Record<string, string> = {};
  const headerNames = new Set<string>();

  const addHeader = (name: string, value: string): void => {
    const normalized = name.toLowerCase();
    if (headerNames.has(normalized)) {
      throw new RouterError('source-header-conflict', `header ${name} is configured more than once`);
    }
    // A throwaway Headers instance validates the name/value grammar for us; a rejected name or
    // value could otherwise leak into an underlying TypeError message, so we redirect any
    // failure to a RouterError without repeating the raw error text (which may echo the value).
    try {
      new Headers({ [name]: value });
    } catch {
      throw new RouterError('source-header-conflict', `header ${name} is not a valid HTTP header`);
    }
    headerNames.add(normalized);
    result[name] = value;
  };

  for (const envName of headersEnv) {
    const encodedHeaders = requiredEnvironmentValue(env, envName);
    let parsed: unknown;
    try {
      parsed = JSON.parse(encodedHeaders);
    } catch {
      throw new RouterError('source-header-conflict', `environment variable ${envName} must contain a JSON header object`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new RouterError('source-header-conflict', `environment variable ${envName} must contain a JSON header object`);
    }
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') {
        throw new RouterError('source-header-conflict', `environment variable ${envName} must contain string header values`);
      }
      addHeader(name, value);
    }
  }

  if (authEnv !== undefined) {
    addHeader('Authorization', `Bearer ${requiredEnvironmentValue(env, authEnv)}`);
  }

  return result;
}

export function resolveSource(config: OperatorConfig, env: Env): SourceContext {
  // Two independent origins: gateway.urlEnv is where live traffic is forwarded, while
  // modelSource.baseUrlEnv is only where the model catalog is discovered from. They may point
  // at different hosts entirely; each is validated and combined with its own header channel.
  const effectiveGatewayUrl = canonicalUrl(env, config.gateway.urlEnv);
  const discoveryBaseUrl = canonicalUrl(env, config.modelSource.baseUrlEnv);
  return {
    sourceId: config.modelSource.sourceId,
    effectiveGatewayUrl,
    effectiveModelsUrl: modelsUrl(discoveryBaseUrl, config.modelSource.endpointPath),
    headers: headersFromEnv(config.modelSource.headersEnv, env, config.modelSource.authEnv),
    gatewayHeaders: headersFromEnv(config.gateway.headersEnv, env),
  };
}

export async function validateSource(source: SourceContext, snapshot: CatalogSnapshot): Promise<void> {
  if (source.sourceId !== snapshot.sourceId) {
    throw new RouterError('snapshot-source-mismatch', 'snapshot source ID does not match the configured source');
  }
  const fingerprint = await sourceFingerprint(source.sourceId, source.effectiveGatewayUrl, source.effectiveModelsUrl);
  if (fingerprint !== snapshot.sourceFingerprint) {
    throw new RouterError('snapshot-source-mismatch', 'snapshot source fingerprint does not match the configured source');
  }
}
