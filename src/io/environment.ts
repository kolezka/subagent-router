import { RouterError } from '../core/errors';
import { sourceFingerprint } from '../core/hash';
import type { CatalogSnapshot, Env, HeaderMap, OperatorConfig, SourceContext } from '../core/types';

function requiredEnvironmentValue(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new RouterError('source-url', `environment variable ${name} is required`);
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

function mergeHeaders(config: OperatorConfig, env: Env): HeaderMap {
  const headers: Record<string, string> = {};
  const headerNames = new Set<string>();

  const addHeader = (name: string, value: string): void => {
    const normalized = name.toLowerCase();
    if (headerNames.has(normalized)) {
      throw new RouterError('source-header-conflict', `header ${name} is configured more than once`);
    }
    headerNames.add(normalized);
    headers[name] = value;
  };

  for (const envName of config.modelSource.headersEnv) {
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

  if (config.modelSource.authEnv !== undefined) {
    addHeader('Authorization', `Bearer ${requiredEnvironmentValue(env, config.modelSource.authEnv)}`);
  }

  return headers;
}

export function resolveSource(config: OperatorConfig, env: Env): SourceContext {
  const effectiveGatewayUrl = canonicalUrl(env, config.modelSource.baseUrlEnv);
  return {
    sourceId: config.modelSource.sourceId,
    effectiveGatewayUrl,
    effectiveModelsUrl: modelsUrl(effectiveGatewayUrl, config.modelSource.endpointPath),
    headers: mergeHeaders(config, env),
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
