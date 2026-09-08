import { describe, expect, test } from 'bun:test';
import { DEFAULT_REPLY_TEXT, startCaptureGateway } from '../support/capture-gateway';
import type { CapturedRequest } from '../support/capture-gateway';
import { isolatedHarnessEnv, judgeCodexDeny, judgeM1, judgeOpencodeHook, parseProbeArgs, summarizeEvidence, summarizeLifecycle } from './run';

describe('capture gateway', () => {
  test('rejestruje model, nagłówek agenta i marker dziecka z body', async () => {
    const gateway = await startCaptureGateway();
    try {
      const response = await fetch(`${gateway.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-claude-code-agent-id': 'agent-1' },
        body: JSON.stringify({
          model: 'gateway/fast-worker',
          system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }],
          messages: [{ role: 'user', content: 'hej' }],
        }),
      });
      expect(response.status).toBe(200);
      expect(gateway.requests).toHaveLength(1);
      expect(gateway.requests[0]).toMatchObject({ path: '/v1/messages', model: 'gateway/fast-worker', agentId: 'agent-1', isChild: true });
    } finally {
      await gateway.close();
    }
  });

  test('odpowiada poprawnym strumieniem SSE, który klient może zdekodować', async () => {
    const gateway = await startCaptureGateway();
    try {
      const response = await fetch(`${gateway.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [] }) });
      const text = await response.text();
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(text).toContain('event: message_stop');
    } finally {
      await gateway.close();
    }
  });

  test('scripted fixture emituje tool_use, potem odbija tylko matching tool_result nonce', async () => {
    const gateway = await startCaptureGateway();
    try {
      const first = await fetch(`${gateway.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'm', tools: [{ name: 'read_fixture', input_schema: { type: 'object' } }], messages: [] }) });
      const started = await first.json() as { content: Array<{ type: string; id?: string }> };
      const toolUseId = started.content.find((part) => part.type === 'tool_use')?.id;
      const nonce = 'fixture-file-nonce-7c10';
      const second = await fetch(`${gateway.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: nonce }] }] }) });
      expect(JSON.stringify(await second.json())).toContain(nonce);
    } finally {
      await gateway.close();
    }
  });

  test('domyślna odpowiedź zwraca ustalony niepusty token, nigdy echo prompta', async () => {
    const gateway = await startCaptureGateway();
    try {
      const distinctivePrompt = 'this-exact-prompt-text-must-never-appear-verbatim-in-the-reply-xyz123';
      const response = await fetch(`${gateway.url}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: distinctivePrompt }] }),
      });
      const payload = (await response.json()) as { content: Array<{ type: string; text?: string }> };
      const text = payload.content.find((part) => part.type === 'text')?.text;
      expect(text).toBe(DEFAULT_REPLY_TEXT);
      expect(text).not.toHaveLength(0);
      expect(text).not.toContain(distinctivePrompt);
    } finally {
      await gateway.close();
    }
  });
});

function capturedRequest(patch: Partial<CapturedRequest>): CapturedRequest {
  return { method: 'POST', path: '/v1/messages', headers: {}, rawRequestBody: new Uint8Array(), body: {}, ...patch };
}

describe('summarizeEvidence', () => {
  test('dwa requesty z tym samym agentId dają distinctAgentIds: 1', () => {
    const evidence = summarizeEvidence([
      capturedRequest({ agentId: 'agent-1', isChild: true }),
      capturedRequest({ agentId: 'agent-1', isChild: true }),
    ]);
    expect(evidence.distinctAgentIds).toBe(1);
  });

  test('request bez isChild nie liczy się do childRequests', () => {
    const evidence = summarizeEvidence([
      capturedRequest({ agentId: 'agent-1', isChild: true }),
      capturedRequest({ agentId: 'agent-2', isChild: false }),
      capturedRequest({ agentId: 'agent-3' }),
    ]);
    expect(evidence.childRequests).toBe(1);
    expect(evidence.distinctAgentIds).toBe(3);
  });
});

describe('probe evidence judges (fail-closed)', () => {
  test('rejects-m1-identifier-variety-without-entropy-evidence', () => {
    const evidence = summarizeEvidence([
      capturedRequest({ agentId: 'agent-1', isChild: true }),
      capturedRequest({ agentId: 'agent-2', isChild: true }),
      capturedRequest({ agentId: 'agent-3', isChild: true }),
    ]);
    expect(evidence.distinctAgentIds).toBe(3);
    expect(judgeM1(evidence, undefined)).toBe('pending');
    expect(judgeM1(evidence, { source: 'crypto-random', sampleCount: 1 })).toBe('failed');
    expect(judgeM1(evidence, { source: 'crypto-random', sampleCount: 3 })).toBe('passed');
  });

  test('requires-opencode-hook-invocation-and-effective-model', () => {
    expect(judgeOpencodeHook(undefined)).toBe('pending');
    expect(judgeOpencodeHook({ hookRegistered: true, invokedBeforeSpawn: true, deniedWithoutRequest: true, effectiveModelObserved: false })).toBe('failed');
    expect(judgeOpencodeHook({ hookRegistered: true, invokedBeforeSpawn: true, deniedWithoutRequest: true, effectiveModelObserved: true })).toBe('passed');
  });

  test('requires-codex-deny-without-child-request', () => {
    const spawnedDespiteDeny = summarizeEvidence([capturedRequest({ agentId: 'agent-1', isChild: true })]);
    const blockedByDeny = summarizeEvidence([]);
    expect(judgeCodexDeny(blockedByDeny, undefined)).toBe('pending');
    expect(judgeCodexDeny(blockedByDeny, { receivedModelField: true, permissionDecision: 'allow' })).toBe('pending');
    expect(judgeCodexDeny(spawnedDespiteDeny, { receivedModelField: true, permissionDecision: 'deny' })).toBe('failed');
    expect(judgeCodexDeny(blockedByDeny, { receivedModelField: true, permissionDecision: 'deny' })).toBe('passed');
  });

  test('keeps-lifecycle-phases-separate', () => {
    const summary = summarizeLifecycle({ 'next-turn': 'passed' });
    expect(summary).toEqual({ 'next-turn': 'passed', resume: 'pending', compaction: 'pending', nested: 'pending', parallel: 'pending' });
  });
});

describe('parseProbeArgs / isolatedHarnessEnv', () => {
  test('parsuje wymagane flagi i odrzuca nieznanego klienta', () => {
    const argv = ['--client', 'opencode', '--probe', 'M6', '--config-root', '/tmp/root', '--binary', '/usr/bin/opencode'];
    expect(parseProbeArgs(argv)).toEqual({ client: 'opencode', probe: 'M6', configRoot: '/tmp/root', binary: '/usr/bin/opencode' });
    expect(() => parseProbeArgs(['--client', 'gpt', '--probe', 'M1', '--config-root', '/tmp', '--binary', '/bin/x'])).toThrow();
    expect(() => parseProbeArgs(['--client', 'codex'])).toThrow();
  });

  test('izoluje HOME i katalogi configu harnessów pod config-root', () => {
    const env = isolatedHarnessEnv('/tmp/probe-root');
    expect(env.HOME).toBe('/tmp/probe-root');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/probe-root/claude');
    expect(env.XDG_CONFIG_HOME).toBe('/tmp/probe-root/xdg');
    expect(env.CODEX_HOME).toBe('/tmp/probe-root/codex');
  });
});
