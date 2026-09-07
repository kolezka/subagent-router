import { describe, expect, test } from 'bun:test';
import { modelAlias, sha256, sourceFingerprint } from '../../src/core/hash';

describe('hash', () => {
  test('sha256 zwraca 64 znaki hex dla pustego ciągu', async () => {
    expect(await sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('modelAlias buduje prefiks m- i pełny hash dokładnego ID', async () => {
    expect(await modelAlias('gateway/fast-worker')).toBe(
      'm-6414d01405c95a7bd2b2a13b415d7685a1673f800ca90dd031a5eeb1776dc81d',
    );
  });

  test('modelAlias rozróżnia wielkość liter i spacje w ID', async () => {
    const lower = await modelAlias('gateway/model');
    const upper = await modelAlias('gateway/Model');
    const spaced = await modelAlias('gateway/model ');
    expect(new Set([lower, upper, spaced]).size).toBe(3);
  });

  test('sourceFingerprint haszuje zwartą tablicę JSON trzech elementów', async () => {
    expect(
      await sourceFingerprint('primary-gateway', 'https://gateway.example/v1', 'https://gateway.example/v1/models'),
    ).toBe('96b80377b311dc1765bde8e0ec7bae4efa848497ad0245cfb927653ba2d0527b');
  });
});
