// The version probe is the only place the package runs someone else's binary. Its whole contract
// is "bounded and non-fatal", so the two cases that used to break that bound are tested here with
// real processes: a binary that ignores SIGTERM, and a binary that exits while a grandchild still
// holds the stdout pipe it inherited. Both left the probe's await pending for as long as the
// grandchild lived, which hung every caller, including the console's /api/detect.
//
// This file replaces tests/support/version-probe-check.ts, a runnable script nothing ever ran.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectClientVersion } from '../../src/cli/version-probe';

const PROBE_TIMEOUT_MS = 300;
// Generous on purpose: the assertion is "bounded", not "fast". Before the fix these cases did not
// return at all until the child's own 30 s sleep ended.
const BOUND_MS = 3_000;

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-version-probe-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function script(name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}`);
  await chmod(path, 0o755);
  return path;
}

describe('detectClientVersion', () => {
  test('reads a dotted version from a real binary', async () => {
    expect(await detectClientVersion('bun')).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('a missing binary and a version-less binary both yield undefined, never a throw', async () => {
    expect(await detectClientVersion('subagent-router-no-such-binary-xyz')).toBeUndefined();
    expect(await detectClientVersion('true')).toBeUndefined();
  });

  test('a binary that ignores SIGTERM is still bounded by the timeout', async () => {
    const binary = await script('traps-term', "trap '' TERM\nsleep 30\n");
    const started = Date.now();
    const version = await detectClientVersion(binary, PROBE_TIMEOUT_MS);
    const elapsed = Date.now() - started;

    expect(version).toBeUndefined();
    expect(elapsed).toBeLessThan(BOUND_MS);
  });

  test('a binary that exits while a grandchild holds the stdout pipe is still bounded', async () => {
    // The normal shape of a shell-wrapper launcher: the wrapper exits, the real process keeps the
    // inherited pipe open, so the pipe never reaches EOF even though the direct child is gone.
    const binary = await script('leaks-pipe', 'sleep 30 &\nexit 0\n');
    const started = Date.now();
    const version = await detectClientVersion(binary, PROBE_TIMEOUT_MS);
    const elapsed = Date.now() - started;

    expect(version).toBeUndefined();
    expect(elapsed).toBeLessThan(BOUND_MS);
  });

  test('the probe releases the leaked pipe, so the process that ran it exits with it', async () => {
    // Returning on time is not the whole bound. An abandoned read keeps the pipe open and the pipe
    // keeps the event loop, so `doctor` used to print its answer and then sit there until the
    // grandchild died. This case times the whole child process, not the probe call.
    const binary = await script('leaks-pipe-exit', 'sleep 30 &\nexit 0\n');
    const module = join(import.meta.dir, '../../src/cli/version-probe.ts');
    const entry = join(dir, 'probe-entry.ts');
    await writeFile(
      entry,
      `import { detectClientVersion } from ${JSON.stringify(module)};\n` +
        `await detectClientVersion(${JSON.stringify(binary)}, ${PROBE_TIMEOUT_MS});\n`,
    );

    const started = Date.now();
    const proc = Bun.spawn([process.execPath, entry], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
    await proc.exited;

    expect(Date.now() - started).toBeLessThan(BOUND_MS);
  });

  test('a binary that prints its version quickly is not cut off by the timeout', async () => {
    const binary = await script('prints-version', 'echo "client 9.8.7"\n');
    expect(await detectClientVersion(binary, PROBE_TIMEOUT_MS)).toBe('9.8.7');
  });
});
