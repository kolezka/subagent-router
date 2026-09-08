import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { assertCapability, loadCapabilityProfile, loadTransportCapabilityProfile } from '../../src/adapters/capabilities';
import { RouterError } from '../../src/core/errors';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'capabilities');
const INVALID_FIXTURES = join(import.meta.dir, '..', 'fixtures', 'capabilities-invalid');

const TRUSTED_NEXT = { lifecyclePhase: 'next-turn', freshDelegation: false } as const;
const TRUSTED_UNKNOWN = { freshDelegation: false } as const;

const ALL_LIFECYCLE_PASSED = {
  'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed',
} as const;

describe('capabilities', () => {
  test('profil pending odmawia każdej bramki runtime kodem unsupported-path', async () => {
    const profile = await loadCapabilityProfile('codex', 'pending', FIXTURES);
    for (const gate of ['claude-marker', 'claude-correlation', 'claude-fork', 'opencode-native-runtime', 'codex-native-runtime', 'codex-explicit-over-role'] as const) {
      expect(() => assertCapability(profile, gate, TRUSTED_UNKNOWN)).toThrow(RouterError);
    }
  });

  test('profil Claude bez M1 i dowodu entropy odmawia korelacji', async () => {
    const profile = await loadCapabilityProfile('claude-code', '2.1.263', FIXTURES);
    expect(profile.status).toBe('pending');
    expect(profile.probes.M1).toBe('pending');
    expect(profile.correlationEntropy).toBe('pending');
    expect(() => assertCapability(profile, 'claude-correlation', TRUSTED_NEXT)).toThrow(RouterError);
  });

  test('znana z zaufanego adaptera faza sprawdza swój dowód, a nieznana wymaga wszystkich pięciu', () => {
    const onePending = { ...ALL_LIFECYCLE_PASSED, resume: 'pending' } as const;
    const opencode = { client: 'opencode', version: '1.18.29', status: 'supported', correlation: false, correlationEntropy: 'pending', fork: false, adapterMarkerPosition: 'unknown', probes: { M6: 'passed', 'M6-runtime': 'passed', M10: 'passed' }, lifecycle: onePending } as const;
    expect(() => assertCapability(opencode, 'opencode-native-runtime', TRUSTED_NEXT)).not.toThrow();
    expect(() => assertCapability(opencode, 'opencode-native-runtime', TRUSTED_UNKNOWN)).toThrow(RouterError);
  });

  test('Codex wymaga M7, a osobna ścieżka rola plus model wymaga M9', () => {
    const codexWithoutM9 = { client: 'codex', version: '0.153.4', status: 'supported', correlation: false, correlationEntropy: 'pending', fork: false, adapterMarkerPosition: 'unknown', probes: { M7: 'passed', M9: 'failed', M10: 'passed' }, lifecycle: ALL_LIFECYCLE_PASSED } as const;
    expect(() => assertCapability(codexWithoutM9, 'codex-native-runtime', TRUSTED_UNKNOWN)).not.toThrow();
    expect(() => assertCapability(codexWithoutM9, 'codex-explicit-over-role', TRUSTED_UNKNOWN)).toThrow(RouterError);
  });

  test('transport profile jest związany z adapterem i wersją runtime, a pending nie jest assumed passed', async () => {
    const profile = await loadTransportCapabilityProfile('bun-fetch', '1.3.11', FIXTURES);
    expect(profile).toMatchObject({ adapterId: 'bun-fetch', runtimeVersion: '1.3.11', status: 'pending', gzipBytes: 'pending', responseHeaders: 'pending' });
  });

  test('domyślny bun-fetch (bez decompress:false) zostaje pending także na aktualnym runtime', async () => {
    const profile = await loadTransportCapabilityProfile('bun-fetch', '1.4.2', FIXTURES);
    expect(profile).toMatchObject({ adapterId: 'bun-fetch', runtimeVersion: '1.4.2', status: 'pending', gzipBytes: 'pending', responseHeaders: 'pending' });
  });

  test('bun-fetch-raw ma osobny, zmierzony profil, niezależny od domyślnego pending bun-fetch', async () => {
    const profile = await loadTransportCapabilityProfile('bun-fetch-raw', '1.4.2', FIXTURES);
    expect(profile).toMatchObject({ adapterId: 'bun-fetch-raw', runtimeVersion: '1.4.2', status: 'passed', gzipBytes: 'passed', responseHeaders: 'passed' });
  });

  test('nowsza wersja dostaje ostrzeżenie, ale żadna bramka nie dziedziczy dowodów starszej', async () => {
    const profile = await loadCapabilityProfile('claude-code', '2.1.999', FIXTURES);
    expect(profile.status).toBe('pending');
    expect(profile.diagnostics).toContain('capability-newer-version-unmeasured');
    expect(() => assertCapability(profile, 'claude-marker', TRUSTED_NEXT)).toThrow(RouterError);
  });
});

describe('capabilities fixture validation (fail-closed schema/identity checks)', () => {
  test('zepsuty JSON rzuca jawny błąd, nie wygląda jak brak pliku', async () => {
    await expect(loadCapabilityProfile('claude-code', '9.0.0', INVALID_FIXTURES)).rejects.toThrow(RouterError);
    await expect(loadCapabilityProfile('claude-code', '9.0.0', INVALID_FIXTURES)).rejects.toMatchObject({ code: 'capability-fixture-invalid-json' });
  });

  test('plik deklarujący innego klienta niż żądany jest odrzucany jako niespójność, nie cast', async () => {
    await expect(loadCapabilityProfile('claude-code', '9.0.1', INVALID_FIXTURES)).rejects.toMatchObject({ code: 'capability-fixture-invalid-schema' });
  });

  test('plik deklarujący inną wersję niż żądana jest odrzucany', async () => {
    await expect(loadCapabilityProfile('claude-code', '9.0.2', INVALID_FIXTURES)).rejects.toMatchObject({ code: 'capability-fixture-invalid-schema' });
  });

  test('brakująca faza lifecycle jest odrzucana zamiast cichego undefined', async () => {
    await expect(loadCapabilityProfile('claude-code', '9.0.3', INVALID_FIXTURES)).rejects.toMatchObject({ code: 'capability-fixture-invalid-schema' });
  });

  test('nieprawidłowa wartość enum probe jest odrzucana', async () => {
    await expect(loadCapabilityProfile('claude-code', '9.0.4', INVALID_FIXTURES)).rejects.toMatchObject({ code: 'capability-fixture-invalid-schema' });
  });

  test('version z próbą path traversal jest odrzucany bez dotykania systemu plików poza fixturesDir', async () => {
    await expect(loadCapabilityProfile('claude-code', '../../../../etc/passwd', FIXTURES)).rejects.toMatchObject({ code: 'capability-invalid-identifier' });
  });

  test('transport: plik deklarujący inny adapterId niż żądany jest odrzucany', async () => {
    await expect(loadTransportCapabilityProfile('bun-fetch', '9.0.0', INVALID_FIXTURES)).rejects.toMatchObject({ code: 'capability-fixture-invalid-schema' });
  });

  test('transport: plik deklarujący inną runtimeVersion niż żądana jest odrzucany', async () => {
    await expect(loadTransportCapabilityProfile('bun-fetch', '9.0.1', INVALID_FIXTURES)).rejects.toMatchObject({ code: 'capability-fixture-invalid-schema' });
  });

  test('transport: adapterId z próbą path traversal jest odrzucany', async () => {
    await expect(loadTransportCapabilityProfile('../../../../etc', '1.3.11', FIXTURES)).rejects.toMatchObject({ code: 'capability-invalid-identifier' });
  });
});
