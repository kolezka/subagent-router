import { describe, expect, test } from 'bun:test';
import { parseOperatorConfig, parseSnapshot } from '../../src/core/config';
import { RouterError } from '../../src/core/errors';
import { configFixture, snapshotFixture } from '../support/fixtures';

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

function configWith(patch: object): unknown {
  return { ...configFixture(), ...patch };
}

describe('parseOperatorConfig', () => {
  test('accepts a valid file and returns a copy', () => {
    const input = configFixture();
    const parsed = parseOperatorConfig(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
  });

  test.each([
    ['unknown version', { version: 2 }, 'config-version'],
    ['unknown field', { extra: true }, 'config-unknown-field'],
    ['unknown nested field', { modelSource: { ...configFixture().modelSource, extra: true } }, 'config-unknown-field'],
    ['inline header', { gateway: { urlEnv: 'GATEWAY_URL', headersEnv: ['Authorization: Bearer x'] } }, 'config-inline-header'],
    ['inherit without acknowledgement', { defaults: { child: null, unmarkedSubagent: 'inherit' } }, 'config-inherit-unacknowledged'],
    ['invalid alias', { modelOverrides: { 'gateway/fast-worker': { alias: '9bad' } } }, 'config-alias-syntax'],
    ['invalid role name', { roles: { explorer: { routeOverride: 'gateway/fast-worker' } } }, 'config-role-name'],
    ['zero timeout', { modelSource: { ...configFixture().modelSource, timeoutMs: 0 } }, 'config-schema'],
    ['zero fetch limit', { modelSource: { ...configFixture().modelSource, fetchLimit: 0 } }, 'config-schema'],
    ['zero stale period', { modelSource: { ...configFixture().modelSource, staleAfterSeconds: 0 } }, 'config-schema'],
    [
      'missing client in agent roots',
      (() => {
        const { codex: _codex, ...agentRoots } = configFixture().agentRoots;
        return { agentRoots };
      })(),
      'config-schema',
    ],
    [
      'invalid correlation value',
      { harness: { ...configFixture().harness, claudeCode: { correlation: 'on', secretEnv: 'ROUTER_SECRET' } } },
      'config-schema',
    ],
  ])('rejects %s', (_name, patch, code) => {
    expectCode(() => parseOperatorConfig(configWith(patch as object)), code);
  });
});

describe('parseSnapshot', () => {
  test('rejects duplicate IDs', async () => {
    const snapshot = await snapshotFixture(['a', 'a']);
    expectCode(() => parseSnapshot(snapshot), 'snapshot-duplicate-id');
  });

  test('rejects an unknown status', async () => {
    const snapshot = await snapshotFixture(['a']);
    (snapshot.models[0] as { status: string }).status = 'gone';
    expectCode(() => parseSnapshot(snapshot), 'snapshot-schema');
  });
});
