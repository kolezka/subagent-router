import { describe, expect, test } from 'bun:test';
import { RouterError } from '../../src/core/errors';
import { resolveSource, validateSource } from '../../src/io/environment';
import { FIXTURE_GATEWAY_URL, configFixture, snapshotFixture } from '../support/fixtures';

const env = {
  GATEWAY_URL: `${FIXTURE_GATEWAY_URL}/`,
  GATEWAY_HEADERS: JSON.stringify({ 'X-Team': 'router' }),
  MODELS_AUTH: 'secret-token',
};

function expectCode(fn: () => unknown, code: string): RouterError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RouterError);
  const routerError = caught as RouterError;
  expect(routerError.code).toBe(code);
  return routerError;
}

describe('resolveSource', () => {
  test('removes a trailing slash, avoids duplicating /v1, and adds auth', () => {
    const source = resolveSource(configFixture(), env);
    expect(source.effectiveGatewayUrl).toBe('http://127.0.0.1:8000/v1');
    expect(source.effectiveModelsUrl).toBe('http://127.0.0.1:8000/v1/models');
    expect(source.headers).toEqual({ 'X-Team': 'router', Authorization: 'Bearer secret-token' });
  });

  test('gateway (forwarding) and modelSource (discovery) are resolved as two independent origins and header channels', () => {
    const config = configFixture({
      modelSource: {
        ...configFixture().modelSource,
        baseUrlEnv: 'DISCOVERY_URL',
        headersEnv: ['DISCOVERY_HEADERS'],
        authEnv: 'DISCOVERY_AUTH',
      },
      gateway: { urlEnv: 'FORWARD_URL', headersEnv: ['FORWARD_HEADERS'] },
    });
    const twoOrigins = {
      DISCOVERY_URL: 'https://discovery.example/v1',
      DISCOVERY_HEADERS: JSON.stringify({ 'X-Discovery': 'only-for-catalog' }),
      DISCOVERY_AUTH: 'discovery-secret',
      FORWARD_URL: 'https://forward.example/v1',
      FORWARD_HEADERS: JSON.stringify({ 'X-Forward': 'only-for-gateway' }),
    };

    const source = resolveSource(config, twoOrigins);

    // Different hosts are preserved independently: discovery and forwarding never collapse to
    // one origin just because they happen to share a config shape.
    expect(source.effectiveGatewayUrl).toBe('https://forward.example/v1');
    expect(source.effectiveModelsUrl).toBe('https://discovery.example/v1/models');

    // Each channel carries only its own headers: gateway.headersEnv must never leak into
    // discovery headers, and modelSource.headersEnv/authEnv must never leak into gatewayHeaders
    // (the handler forwards gatewayHeaders only, so a discovery secret here would otherwise ride
    // along on every proxied request).
    expect(source.headers).toEqual({ 'X-Discovery': 'only-for-catalog', Authorization: 'Bearer discovery-secret' });
    expect(source.gatewayHeaders).toEqual({ 'X-Forward': 'only-for-gateway' });
    expect(source.gatewayHeaders).not.toHaveProperty('Authorization');
    expect(source.gatewayHeaders).not.toHaveProperty('X-Discovery');
    expect(source.headers).not.toHaveProperty('X-Forward');
  });

  test.each([
    ['http:', 'ftp://127.0.0.1:8000/v1'],
    ['https:', 'file:///etc/passwd'],
  ])('rejects a non-http(s) URL scheme (%s)', (_label, url) => {
    expectCode(() => resolveSource(configFixture(), { ...env, GATEWAY_URL: url }), 'source-url');
  });

  test.each([
    ['userinfo', 'http://user:pw@127.0.0.1:8000/v1'],
    ['query', 'http://127.0.0.1:8000/v1?x=1'],
    ['fragment', 'http://127.0.0.1:8000/v1#frag'],
  ])('rejects a URL with %s', (_label, url) => {
    expectCode(() => resolveSource(configFixture(), { ...env, GATEWAY_URL: url }), 'source-url');
  });

  test('rejects a duplicate header name regardless of casing', () => {
    const headers = JSON.stringify({ authorization: 'x' });
    expectCode(() => resolveSource(configFixture(), { ...env, GATEWAY_HEADERS: headers }), 'source-header-conflict');
  });

  test('uses source-env-missing for a missing base URL variable without exposing values', () => {
    const error = expectCode(() => resolveSource(configFixture(), {}), 'source-env-missing');
    expect(error.message).toContain('GATEWAY_URL');
    expect(error.message).not.toContain('secret-token');
  });

  test.each([
    ['headers', { ...env, GATEWAY_HEADERS: undefined }, 'GATEWAY_HEADERS'],
    ['auth', { ...env, MODELS_AUTH: undefined }, 'MODELS_AUTH'],
  ])('uses source-env-missing for a missing %s variable without exposing values', (_kind, incompleteEnv, envName) => {
    const error = expectCode(() => resolveSource(configFixture(), incompleteEnv), 'source-env-missing');
    expect(error.message).toContain(envName);
    expect(error.message).not.toContain('secret-token');
  });
});

describe('validateSource', () => {
  test('accepts a matching snapshot fingerprint and rejects a changed endpoint', async () => {
    const snapshot = await snapshotFixture();
    await validateSource(resolveSource(configFixture(), env), snapshot);
    const moved = resolveSource(configFixture(), { ...env, GATEWAY_URL: 'http://127.0.0.1:9000/v1' });
    await expect(validateSource(moved, snapshot)).rejects.toBeInstanceOf(RouterError);
  });
});
