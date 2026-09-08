import { describe, expect, test } from 'bun:test';
import { discoverModels } from '../../src/catalog/discovery';
import { RouterError } from '../../src/core/errors';
import type { FetchLike } from '../../src/core/types';
import { resolveSource } from '../../src/io/environment';
import { configFixture } from '../support/fixtures';

const env = { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 'secret-token' };

function fakeFetch(pages: Record<string, unknown>, init: ResponseInit = {}): { fetch: FetchLike; calls: Request[] } {
  const calls: Request[] = [];
  const fetch: FetchLike = async (request) => {
    calls.push(request);
    const cursor = new URL(request.url).searchParams.get('cursor') ?? 'first';
    const body = pages[cursor];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init });
  };
  return { fetch, calls };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'no-error';
  } catch (error) {
    return error instanceof RouterError ? error.code : 'other';
  }
}

describe('discoverModels', () => {
  test('pozytywna kontrola: dwie strony z kursorem dają pełną listę w kolejności', async () => {
    const { fetch, calls } = fakeFetch({
      first: { data: [{ id: 'a', display_name: 'A' }], has_more: true, next_cursor: 'p2' },
      p2: { data: [{ id: 'b' }], has_more: false },
    });
    const models = await discoverModels(configFixture(), resolveSource(configFixture(), env), fetch);
    expect(models).toEqual([{ id: 'a', displayName: 'A' }, { id: 'b' }]);
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer secret-token');
    expect(new URL(calls[1]?.url ?? '').searchParams.get('cursor')).toBe('p2');
  });

  test.each([
    ['zły schemat', { first: { models: [] } }, 'discovery-schema'],
    ['puste id', { first: { data: [{ id: '' }] } }, 'discovery-schema'],
    ['duplikat', { first: { data: [{ id: 'a' }, { id: 'a' }] } }, 'discovery-duplicate'],
    ['has_more bez kursora', { first: { data: [{ id: 'a' }], has_more: true } }, 'discovery-pagination'],
    ['cykl kursora', { first: { data: [{ id: 'a' }], has_more: true, next_cursor: 'first' } }, 'discovery-pagination'],
    ['malformed JSON', { first: '{broken' }, 'discovery-json'],
  ])('odrzuca: %s', async (_name, pages, code) => {
    const { fetch } = fakeFetch(pages as Record<string, unknown>);
    expect(await codeOf(discoverModels(configFixture(), resolveSource(configFixture(), env), fetch))).toBe(code);
  });

  test('auth failure daje discovery-auth bez treści nagłówka w komunikacie', async () => {
    const { fetch } = fakeFetch({ first: { data: [] } }, { status: 401 });
    let message = '';
    try {
      await discoverModels(configFixture(), resolveSource(configFixture(), env), fetch);
    } catch (error) {
      message = `${(error as RouterError).code}:${(error as Error).message}`;
    }
    expect(message.startsWith('discovery-auth:')).toBe(true);
    expect(message).not.toContain('secret-token');
  });

  test('przekroczony fetchLimit jest błędem', async () => {
    const config = configFixture({ modelSource: { ...configFixture().modelSource, fetchLimit: 1 } });
    const { fetch } = fakeFetch({ first: { data: [{ id: 'a' }, { id: 'b' }] } });
    expect(await codeOf(discoverModels(config, resolveSource(config, env), fetch))).toBe('discovery-limit');
  });

  test('redirect na inny origin nie jest śledzony z credentials', async () => {
    const calls: Request[] = [];
    const fetch: FetchLike = async (request) => {
      calls.push(request);
      return new Response(null, { status: 302, headers: { location: 'http://evil.example/v1/models' } });
    };
    expect(await codeOf(discoverModels(configFixture(), resolveSource(configFixture(), env), fetch))).toBe('discovery-redirect');
    expect(calls).toHaveLength(1);
  });
});
