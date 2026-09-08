// Unit tests for scripts/poc-serve.ts's own pure logic: argument parsing and the
// synthetic/pending profile rejection gates. These do not need src/transport/handler.ts (Task 9)
// or a running server, so they run and pass today, independent of that pending dependency.
import { describe, expect, test } from 'bun:test';
import {
  assertProductionCapabilityProfile,
  assertProductionTransportProfile,
  exitCodeForError,
  isHelpRequested,
  parsePocServeArgs,
} from '../../scripts/poc-serve';
import { RouterError } from '../../src/core/errors';
import type { CapabilityProfile, TransportCapabilityProfile } from '../../src/core/types';
import { loadTransportCapabilityProfile } from '../../src/adapters/capabilities';

function profile(patch: Partial<CapabilityProfile> = {}): CapabilityProfile {
  return {
    client: 'claude-code',
    version: '2.1.263',
    status: 'supported',
    correlation: false,
    correlationEntropy: 'pending',
    fork: false,
    adapterMarkerPosition: 'unknown',
    probes: {},
    lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' },
    ...patch,
  };
}

function transportProfile(patch: Partial<TransportCapabilityProfile> = {}): TransportCapabilityProfile {
  return { adapterId: 'bun-fetch-raw', runtimeVersion: '1.4.2', status: 'passed', gzipBytes: 'passed', responseHeaders: 'passed', ...patch };
}

describe('parsePocServeArgs', () => {
  test('parses required flags and defaults the port', () => {
    const args = parsePocServeArgs(['--config', '/tmp/c.json', '--profile', '/tmp/p', '--transport-profile', '/tmp/t', '--claude-version', '2.1.263']);
    expect(args).toEqual({ configPath: '/tmp/c.json', profileDir: '/tmp/p', transportProfileDir: '/tmp/t', claudeVersion: '2.1.263', port: 8787 });
  });

  test('accepts an explicit --port', () => {
    const args = parsePocServeArgs(['--config', 'c', '--profile', 'p', '--transport-profile', 't', '--claude-version', 'v', '--port', '0']);
    expect(args.port).toBe(0);
  });

  test('throws when a required flag is missing', () => {
    expect(() => parsePocServeArgs(['--config', 'c'])).toThrow();
  });

  test('throws on an out-of-range port', () => {
    expect(() =>
      parsePocServeArgs(['--config', 'c', '--profile', 'p', '--transport-profile', 't', '--claude-version', 'v', '--port', '99999']),
    ).toThrow();
  });

  test('rejects an unknown flag instead of silently ignoring it', () => {
    expect(() =>
      parsePocServeArgs(['--config', 'c', '--profile', 'p', '--transport-profile', 't', '--claude-version', 'v', '--calude-version', 'typo']),
    ).toThrow();
  });

  test('rejects a stray positional argument', () => {
    expect(() =>
      parsePocServeArgs(['--config', 'c', '--profile', 'p', '--transport-profile', 't', '--claude-version', 'v', 'extra']),
    ).toThrow();
  });

  test('rejects a duplicated flag', () => {
    expect(() =>
      parsePocServeArgs(['--config', 'c', '--config', 'c2', '--profile', 'p', '--transport-profile', 't', '--claude-version', 'v']),
    ).toThrow();
  });
});

describe('isHelpRequested', () => {
  test('detects --help anywhere in argv', () => {
    expect(isHelpRequested(['--config', 'c', '--help'])).toBe(true);
  });

  test('is false when --help is absent', () => {
    expect(isHelpRequested(['--config', 'c'])).toBe(false);
  });
});

describe('exitCodeForError', () => {
  test('maps a RouterError (bad args/config/unsupported profile) to exit 2', () => {
    expect(exitCodeForError(new RouterError('cli-args', 'bad'))).toBe(2);
  });

  test('maps any other error (operational I/O) to exit 1', () => {
    expect(exitCodeForError(new Error('ECONNRESET'))).toBe(1);
  });
});

describe('assertProductionCapabilityProfile', () => {
  test('refuses a synthetic/hermetic version string', () => {
    expect(() => assertProductionCapabilityProfile(profile({ version: 'synthetic-hermetic' }))).toThrow();
  });

  test('refuses a pending profile even for a real version string', () => {
    expect(() => assertProductionCapabilityProfile(profile({ status: 'pending' }))).toThrow();
  });

  test('refuses a profile for the wrong client', () => {
    expect(() => assertProductionCapabilityProfile(profile({ client: 'opencode' }))).toThrow();
  });

  test('accepts a real, measured, supported profile', () => {
    expect(() => assertProductionCapabilityProfile(profile({ status: 'supported' }))).not.toThrow();
  });
});

describe('assertProductionTransportProfile', () => {
  test('refuses a synthetic adapter id', () => {
    expect(() => assertProductionTransportProfile(transportProfile({ adapterId: 'synthetic-fetch' }))).toThrow();
  });

  test('refuses an unmeasured (pending) transport profile', () => {
    expect(() => assertProductionTransportProfile(transportProfile({ status: 'pending' }))).toThrow();
  });

  test('accepts the real measured bun-fetch-raw-1.4.2 fixture copied from Task 7', async () => {
    const real = await loadTransportCapabilityProfile('bun-fetch-raw', '1.4.2', `${import.meta.dir}/../fixtures/capabilities`);
    expect(() => assertProductionTransportProfile(real)).not.toThrow();
  });
});
