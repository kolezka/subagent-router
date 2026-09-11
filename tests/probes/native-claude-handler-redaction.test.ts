// Hermetic regression test: the front server's generic pre-handler capture must never record a
// control-plane request body verbatim. Control-plane bodies are FreshDelegationEnvelope-shaped
// (src/core/types.ts) and carry a plaintext `nonce` plus an HMAC `proof`; the dedicated
// instance-fetch / delegation-register / delegation-replay records already capture the redacted
// form (nonceHash only). Never starts the real front server or sets RUN_NATIVE_PROBES (both
// forbidden in this worktree) -- calls recordPreHandlerIfNotControlPlane directly, the exact
// function the real front server calls, with a real rec() writing real files to a real temp dir.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isControlPlaneUrl, recordPreHandlerIfNotControlPlane } from './native-claude-handler';

let dir = '';
let seq = 0;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-handler-redaction-'));
  seq = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Mirrors the real front server's own rec() closure exactly (see native-claude-handler.ts's
// RUN_NATIVE_PROBES-gated block): pretty-printed JSON, one file per call, sequence-numbered.
function rec(kind: string, o: unknown): void {
  writeFileSync(join(dir, `${String(++seq).padStart(3, '0')}-${kind}.json`), JSON.stringify(o, null, 2));
}

function allCaptureFileContents(): string[] {
  return readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf8'));
}

const PLAINTEXT_NONCE = 'PLAINTEXT-NONCE-SECRET-7q2';
const HMAC_PROOF = 'HMAC-PROOF-SECRET-9k3';

function synthDelegationEnvelope(): Record<string, unknown> {
  return {
    version: 1,
    handlerInstanceId: 'probe-instance',
    agentId: 'agent-1',
    role: 'native-probe-alpha',
    nonce: PLAINTEXT_NONCE,
    issuedAtMs: 0,
    proof: HMAC_PROOF,
  };
}

describe('isControlPlaneUrl', () => {
  test('classifies-control-plane-urls-and-nothing-else', () => {
    expect(isControlPlaneUrl('/subagent-router/control/delegations')).toBe(true);
    expect(isControlPlaneUrl('/subagent-router/control/instance')).toBe(true);
    expect(isControlPlaneUrl('/v1/messages')).toBe(false);
    expect(isControlPlaneUrl(undefined)).toBe(false);
  });
});

describe('recordPreHandlerIfNotControlPlane', () => {
  test('never-writes-a-plaintext-nonce-or-proof-for-a-delegation-register-post', () => {
    recordPreHandlerIfNotControlPlane(rec, '/subagent-router/control/delegations', { 'content-type': 'application/json' }, synthDelegationEnvelope());

    const contents = allCaptureFileContents();
    for (const text of contents) {
      expect(text).not.toContain(PLAINTEXT_NONCE);
      expect(text).not.toContain(HMAC_PROOF);
    }
  });

  test('skips-the-instance-fetch-control-endpoint-too', () => {
    recordPreHandlerIfNotControlPlane(rec, '/subagent-router/control/instance', {}, {});
    expect(readdirSync(dir)).toHaveLength(0);
  });

  test('still-records-a-normal-v1-messages-request-unchanged', () => {
    recordPreHandlerIfNotControlPlane(rec, '/v1/messages', { 'content-type': 'application/json' }, { model: 'probe-parent-model', messages: [] });
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('pre-handler');
    const text = readFileSync(join(dir, files[0] as string), 'utf8');
    expect(text).toContain('probe-parent-model');
    expect(JSON.parse(text)).toEqual({ url: '/v1/messages', headers: { 'content-type': 'application/json' }, body: { model: 'probe-parent-model', messages: [] } });
  });
});
