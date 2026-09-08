import { describe, expect, test } from 'bun:test';
import { runClaudeSubagentStartHook } from '../../src/transport/claude-hook';
import type { ClaudeHookDeps } from '../../src/transport/claude-hook';
import type { CapabilityProfile, FetchLike } from '../../src/core/types';
import { configFixture } from '../support/fixtures';

function jsonStdin(payload: unknown): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function collectStdout(order: string[]): { stream: WritableStream<Uint8Array>; text: () => string } {
  const chunks: Uint8Array[] = [];
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      order.push('stdout');
      chunks.push(chunk);
    },
  });
  return { stream, text: () => new TextDecoder().decode(concat(chunks)) };
}

// A "synthetic-trusted-start" resolver stand-in: only a hermetic test may declare
// freshDelegation: true directly like this. A production resolveTrustedStart adapter must derive
// it from a real M10-freshness measurement of the native lifecycle event, never from this shape.
const syntheticProfile: CapabilityProfile = {
  client: 'claude-code',
  version: 'synthetic-hermetic',
  status: 'supported',
  correlation: false,
  correlationEntropy: 'pending',
  fork: false,
  adapterMarkerPosition: 'system',
  probes: { M3: 'passed', M10: 'passed', 'M10-freshness': 'passed' },
  lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' },
};

describe('runClaudeSubagentStartHook', () => {
  test('registers-synthetic-trusted-one-shot-before-writing-system-b-marker', async () => {
    const order: string[] = [];
    const fetchSpy: FetchLike = async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/control/instance')) {
        order.push('instance');
        return new Response(JSON.stringify({ handlerInstanceId: 'h1' }), { status: 200 });
      }
      if (url.pathname.endsWith('/control/delegations')) {
        order.push('delegations');
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch: ${request.url}`);
    };
    const deps: ClaudeHookDeps = {
      controlBaseUrl: 'http://router.local',
      secret: 'test-secret',
      roles: configFixture().roles,
      profile: syntheticProfile,
      fetch: fetchSpy,
      now: () => 0,
      nonce: () => 'nonce-1',
      resolveTrustedStart: () => ({ freshDelegation: true }),
    };
    const out = collectStdout(order);
    await runClaudeSubagentStartHook(
      jsonStdin({ agent_id: 'agent-1', agent_type: 'explorer', hook_event_name: 'SubagentStart' }),
      out.stream,
      deps,
    );

    expect(order).toEqual(['instance', 'delegations', 'stdout']);
    const output = JSON.parse(out.text()) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(output.hookSpecificOutput.hookEventName).toBe('SubagentStart');
    expect(output.hookSpecificOutput.additionalContext).toContain('role="explorer"');
  });

  test('writes-b2-output-only-after-m3-b2-m1-auto-and-freshness-registration', async () => {
    const order: string[] = [];
    const b2Profile: CapabilityProfile = {
      client: 'claude-code',
      version: 'synthetic-hermetic',
      status: 'supported',
      correlation: true,
      correlationEntropy: 'passed',
      fork: false,
      adapterMarkerPosition: 'b2',
      probes: { M1: 'passed', 'M3-B2': 'passed', M10: 'passed', 'M10-freshness': 'passed' },
      lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' },
    };
    const fetchSpy: FetchLike = async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/control/instance')) {
        order.push('instance');
        return new Response(JSON.stringify({ handlerInstanceId: 'h1' }), { status: 200 });
      }
      if (url.pathname.endsWith('/control/delegations')) {
        order.push('delegations');
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch: ${request.url}`);
    };
    const deps: ClaudeHookDeps = {
      controlBaseUrl: 'http://router.local',
      secret: 'test-secret',
      roles: configFixture().roles,
      profile: b2Profile,
      fetch: fetchSpy,
      now: () => 0,
      nonce: () => 'nonce-b2',
      resolveTrustedStart: () => ({ freshDelegation: true }),
      correlation: 'auto',
    };
    const out = collectStdout(order);
    await runClaudeSubagentStartHook(
      jsonStdin({ agent_id: 'agent-2', agent_type: 'explorer', hook_event_name: 'SubagentStart' }),
      out.stream,
      deps,
    );

    expect(order).toEqual(['instance', 'delegations', 'stdout']);
    expect(JSON.parse(out.text())).toEqual({});
  });

  test('producer-registration-failure-does-not-emit-default-marker-or-success', async () => {
    const scenarios: Array<{ label: string; fetch: FetchLike }> = [
      {
        label: '401 on delegations',
        fetch: async (request) => {
          const url = new URL(request.url);
          if (url.pathname.endsWith('/control/instance')) return new Response(JSON.stringify({ handlerInstanceId: 'h1' }), { status: 200 });
          return new Response(null, { status: 401 });
        },
      },
      {
        label: '409 on delegations',
        fetch: async (request) => {
          const url = new URL(request.url);
          if (url.pathname.endsWith('/control/instance')) return new Response(JSON.stringify({ handlerInstanceId: 'h1' }), { status: 200 });
          return new Response(null, { status: 409 });
        },
      },
      {
        label: 'network error on delegations',
        fetch: async (request) => {
          const url = new URL(request.url);
          if (url.pathname.endsWith('/control/instance')) return new Response(JSON.stringify({ handlerInstanceId: 'h1' }), { status: 200 });
          throw new Error('network down');
        },
      },
      {
        label: 'instance endpoint unreachable',
        fetch: async () => {
          throw new Error('connection refused');
        },
      },
    ];

    for (const scenario of scenarios) {
      const deps: ClaudeHookDeps = {
        controlBaseUrl: 'http://router.local',
        secret: 'test-secret',
        roles: configFixture().roles,
        profile: syntheticProfile,
        fetch: scenario.fetch,
        now: () => 0,
        nonce: () => 'nonce-x',
        resolveTrustedStart: () => ({ freshDelegation: true }),
      };
      const out = collectStdout([]);
      await expect(
        runClaudeSubagentStartHook(
          jsonStdin({ agent_id: 'agent-3', agent_type: 'explorer', hook_event_name: 'SubagentStart' }),
          out.stream,
          deps,
        ),
      ).rejects.toThrow();
      expect(out.text()).toBe('');
    }
  });

  test('subagentstart-name-alone-never-sets-fresh', async () => {
    let fetchCalled = false;
    const fetchSpy: FetchLike = async () => {
      fetchCalled = true;
      return new Response(null, { status: 200 });
    };

    const pendingFreshnessProfile: CapabilityProfile = {
      ...syntheticProfile,
      probes: { ...syntheticProfile.probes, 'M10-freshness': 'pending' },
    };
    const depsPendingProbe: ClaudeHookDeps = {
      controlBaseUrl: 'http://router.local',
      secret: 'test-secret',
      roles: configFixture().roles,
      profile: pendingFreshnessProfile,
      fetch: fetchSpy,
      now: () => 0,
      nonce: () => 'nonce-a',
      resolveTrustedStart: () => ({ freshDelegation: true }),
    };
    const outA = collectStdout([]);
    await runClaudeSubagentStartHook(
      jsonStdin({ agent_id: 'agent-4', agent_type: 'explorer', hook_event_name: 'SubagentStart' }),
      outA.stream,
      depsPendingProbe,
    );
    expect(fetchCalled).toBe(false);
    expect(JSON.parse(outA.text())).toEqual({});

    const depsUntrustedResolver: ClaudeHookDeps = {
      controlBaseUrl: 'http://router.local',
      secret: 'test-secret',
      roles: configFixture().roles,
      profile: syntheticProfile,
      fetch: fetchSpy,
      now: () => 0,
      nonce: () => 'nonce-b',
      resolveTrustedStart: () => ({ freshDelegation: false }),
    };
    const outB = collectStdout([]);
    await runClaudeSubagentStartHook(
      jsonStdin({ agent_id: 'agent-5', agent_type: 'explorer', hook_event_name: 'SubagentStart' }),
      outB.stream,
      depsUntrustedResolver,
    );
    expect(fetchCalled).toBe(false);
    expect(JSON.parse(outB.text())).toEqual({});
  });

  test('malformed-or-non-object-stdin-throws-invalid-hook-input-not-silent-success', async () => {
    const fetchSpy: FetchLike = async () => {
      throw new Error('unexpected fetch');
    };
    const deps: ClaudeHookDeps = {
      controlBaseUrl: 'http://router.local',
      secret: 'test-secret',
      roles: configFixture().roles,
      profile: syntheticProfile,
      fetch: fetchSpy,
      now: () => 0,
      nonce: () => 'nonce-invalid',
      resolveTrustedStart: () => ({ freshDelegation: true }),
    };

    const bodies: ReadableStream<Uint8Array>[] = [
      jsonStdin('not-an-object'),
      jsonStdin([1, 2, 3]),
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{not valid json'));
          controller.close();
        },
      }),
    ];

    for (const body of bodies) {
      const out = collectStdout([]);
      let caught: unknown;
      try {
        await runClaudeSubagentStartHook(body, out.stream, deps);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { code?: string }).code).toBe('invalid-hook-input');
      expect(out.text()).toBe('');
    }
  });

  test('unmapped-role-no-ops-to-empty-object-without-any-fetch-not-a-throw', async () => {
    let fetchCalled = false;
    const fetchSpy: FetchLike = async () => {
      fetchCalled = true;
      return new Response(null, { status: 200 });
    };
    const deps: ClaudeHookDeps = {
      controlBaseUrl: 'http://router.local',
      secret: 'test-secret',
      roles: configFixture().roles,
      profile: syntheticProfile,
      fetch: fetchSpy,
      now: () => 0,
      nonce: () => 'nonce-role',
      resolveTrustedStart: () => ({ freshDelegation: true }),
    };
    const out = collectStdout([]);
    await runClaudeSubagentStartHook(
      jsonStdin({ agent_id: 'agent-6', agent_type: 'no-such-role', hook_event_name: 'SubagentStart' }),
      out.stream,
      deps,
    );
    expect(fetchCalled).toBe(false);
    expect(JSON.parse(out.text())).toEqual({});
  });

  test('wrong-event-name-or-overlong-agent-id-no-ops-without-registering', async () => {
    let fetchCalled = false;
    const fetchSpy: FetchLike = async () => {
      fetchCalled = true;
      return new Response(null, { status: 200 });
    };
    const baseDeps: Omit<ClaudeHookDeps, 'now' | 'nonce'> = {
      controlBaseUrl: 'http://router.local',
      secret: 'test-secret',
      roles: configFixture().roles,
      profile: syntheticProfile,
      fetch: fetchSpy,
      resolveTrustedStart: () => ({ freshDelegation: true }),
    };

    const outWrongEvent = collectStdout([]);
    await runClaudeSubagentStartHook(
      jsonStdin({ agent_id: 'agent-7', agent_type: 'explorer', hook_event_name: 'PreToolUse' }),
      outWrongEvent.stream,
      { ...baseDeps, now: () => 0, nonce: () => 'nonce-c' },
    );
    expect(fetchCalled).toBe(false);
    expect(JSON.parse(outWrongEvent.text())).toEqual({});

    const outMissingEvent = collectStdout([]);
    await runClaudeSubagentStartHook(
      jsonStdin({ agent_id: 'agent-7b', agent_type: 'explorer' }),
      outMissingEvent.stream,
      { ...baseDeps, now: () => 0, nonce: () => 'nonce-d' },
    );
    expect(fetchCalled).toBe(false);
    expect(JSON.parse(outMissingEvent.text())).toEqual({});

    const outOverlong = collectStdout([]);
    await runClaudeSubagentStartHook(
      jsonStdin({ agent_id: 'a'.repeat(257), agent_type: 'explorer', hook_event_name: 'SubagentStart' }),
      outOverlong.stream,
      { ...baseDeps, now: () => 0, nonce: () => 'nonce-e' },
    );
    expect(fetchCalled).toBe(false);
    expect(JSON.parse(outOverlong.text())).toEqual({});
  });

  test('b2-without-profile-correlation-true-does-not-register', async () => {
    let fetchCalled = false;
    const fetchSpy: FetchLike = async () => {
      fetchCalled = true;
      return new Response(null, { status: 200 });
    };
    const b2ProfileNoCorrelationFlag: CapabilityProfile = {
      client: 'claude-code',
      version: 'synthetic-hermetic',
      status: 'supported',
      correlation: false,
      correlationEntropy: 'passed',
      fork: false,
      adapterMarkerPosition: 'b2',
      probes: { M1: 'passed', 'M3-B2': 'passed', M10: 'passed', 'M10-freshness': 'passed' },
      lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' },
    };
    const deps: ClaudeHookDeps = {
      controlBaseUrl: 'http://router.local',
      secret: 'test-secret',
      roles: configFixture().roles,
      profile: b2ProfileNoCorrelationFlag,
      fetch: fetchSpy,
      now: () => 0,
      nonce: () => 'nonce-b2-no-flag',
      resolveTrustedStart: () => ({ freshDelegation: true }),
      correlation: 'auto',
    };
    const out = collectStdout([]);
    await runClaudeSubagentStartHook(
      jsonStdin({ agent_id: 'agent-8', agent_type: 'explorer', hook_event_name: 'SubagentStart' }),
      out.stream,
      deps,
    );
    expect(fetchCalled).toBe(false);
    expect(JSON.parse(out.text())).toEqual({});
  });
});
