import { describe, expect, test } from 'bun:test';
import { RouterError } from '../../src/core/errors';
import { resolveSource, validateSource } from '../../src/io/environment';
import { FIXTURE_GATEWAY_URL, configFixture, snapshotFixture } from '../support/fixtures';

const env = {
  GATEWAY_URL: `${FIXTURE_GATEWAY_URL}/`,
  GATEWAY_HEADERS: JSON.stringify({ 'X-Team': 'router' }),
  MODELS_AUTH: 'secret-token',
};

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RouterError);
  expect((caught as RouterError).code).toBe(code);
}

describe('resolveSource', () => {
  test('removes a trailing slash, avoids duplicating /v1, and adds auth', () => {
    const source = resolveSource(configFixture(), env);
    expect(source.effectiveGatewayUrl).toBe('http://127.0.0.1:8000/v1');
    expect(source.effectiveModelsUrl).toBe('http://127.0.0.1:8000/v1/models');
    expect(source.headers).toEqual({ 'X-Team': 'router', Authorization: 'Bearer secret-token' });
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

  test('names a missing URL variable without exposing values', () => {
    let message = '';
    try {
      resolveSource(configFixture(), {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('GATEWAY_URL');
    expect(message).not.toContain('secret-token');
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
