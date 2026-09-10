// Hermetic test for m1-sample-report.ts: never runs a native client, never sets
// RUN_NATIVE_PROBES. Builds one synthetic run directory on disk and spawns the real script
// against it as a subprocess (same spawnSync(process.execPath, ['run', ...]) shape as
// handler-fixture.test.ts's import-isolation test), so this exercises the actual CLI entry
// point, not just the exported buildM1SampleReport function.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildM1SampleReport } from './m1-sample-report';
import { writeSyntheticRunCapture } from '../support/native-run-capture';

const SCRIPT_PATH = join(import.meta.dir, 'm1-sample-report.ts');

describe('buildM1SampleReport (direct, in-process)', () => {
  test('report-omits-ids-and-summarizes-a-synthetic-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'subagent-router-m1-report-'));
    try {
      const runDir = join(dir, 'run-1');
      await writeSyntheticRunCapture(runDir, { agentId: 'agent-report-secret' });

      const report = await buildM1SampleReport([join(dir, '*')], process.cwd());
      expect(report.runsMatched).toBe(1);
      expect(report.sampleCount).toBe(1);
      expect(report.distinctCount).toBe(1);
      expect(report.idsPerRunCount).toEqual({ 'run-1': 1 });

      // "ids omitted" means no raw agent-id value ever appears -- not that the common English
      // word "ids" is banned (it legitimately appears in field names like idsPerRunCount and
      // in the diagnostic text).
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain('agent-report-secret');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('no-matching-run-dirs-still-produces-a-valid-zeroed-report', async () => {
    const report = await buildM1SampleReport(['/tmp/definitely-does-not-exist-subagent-router-*'], process.cwd());
    expect(report.runsMatched).toBe(0);
    expect(report.sampleCount).toBe(0);
    expect(report.verdict.result).toBe('pending');
  });
});

describe('m1-sample-report.ts CLI entry point (subprocess)', () => {
  test('running-the-script-against-a-synthetic-dir-prints-parseable-json-with-no-raw-ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'subagent-router-m1-report-cli-'));
    try {
      const runDirA = join(dir, 'run-a');
      const runDirB = join(dir, 'run-b');
      await writeSyntheticRunCapture(runDirA, { agentId: 'agent-cli-secret-a' });
      await writeSyntheticRunCapture(runDirB, { agentId: 'agent-cli-secret-b' });

      const result = spawnSync(process.execPath, ['run', SCRIPT_PATH, join(dir, '*')], {
        timeout: 10000,
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stderr ?? '').toBe('');

      const parsed = JSON.parse(result.stdout ?? '');
      expect(parsed.runsMatched).toBe(2);
      expect(parsed.sampleCount).toBe(2);
      expect(parsed.distinctCount).toBe(2);
      expect(parsed.idsPerRunCount).toEqual({ 'run-a': 1, 'run-b': 1 });

      // "ids omitted": neither the raw agent id values nor a literal "ids" key anywhere in the
      // printed JSON, only aggregate counts and the report's own idsPerRunCount field name.
      expect(result.stdout).not.toContain('agent-cli-secret-a');
      expect(result.stdout).not.toContain('agent-cli-secret-b');
      expect(result.stdout).not.toMatch(/"ids"\s*:/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('exits-zero-even-with-a-glob-matching-nothing', () => {
    const result = spawnSync(process.execPath, ['run', SCRIPT_PATH, '/tmp/definitely-does-not-exist-subagent-router-*'], {
      timeout: 10000,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout ?? '');
    expect(parsed.runsMatched).toBe(0);
    expect(parsed.sampleCount).toBe(0);
  });
});
