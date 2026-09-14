// Exercises the console's bounded event log: seq accounting, eviction, paging, listener isolation
// and the pure HandlerEvent mapping. Everything here is in memory; the clock is injected so `at`
// is an assertion rather than a wall-clock guess.
import { describe, expect, test } from 'bun:test';
import type { HandlerEvent } from '../../src/transport/handler';
import { EventLog, handlerEventToLogInput } from '../../src/web/events';
import type { RouterEvent } from '../../src/web/api-types';

function steppingClock(startMs = 0, stepMs = 1000): () => Date {
  let current = startMs;
  return () => {
    const at = new Date(current);
    current += stepMs;
    return at;
  };
}

function logWith(capacity?: number): EventLog {
  return new EventLog({ now: steppingClock(), ...(capacity !== undefined ? { capacity } : {}) });
}

function info(log: EventLog, message: string): RouterEvent {
  return log.append({ kind: 'console-action', level: 'info', message });
}

describe('EventLog', () => {
  test('assigns seq from 1 upward and stamps at from the injected clock', () => {
    const log = logWith();
    expect(log.latestSeq).toBe(0);
    expect(log.oldestSeq).toBe(0);
    expect(log.dropped).toBe(0);

    const first = info(log, 'one');
    const second = info(log, 'two');

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.at).toBe('1970-01-01T00:00:00.000Z');
    expect(second.at).toBe('1970-01-01T00:00:01.000Z');
    expect(log.latestSeq).toBe(2);
    expect(log.oldestSeq).toBe(1);
  });

  test('drops the oldest entries past capacity, counts them, and keeps seq strictly increasing', () => {
    const log = logWith(3);
    for (let i = 1; i <= 5; i += 1) info(log, `event ${i}`);

    expect(log.dropped).toBe(2);
    expect(log.oldestSeq).toBe(3);
    expect(log.latestSeq).toBe(5);

    const page = log.since(0);
    expect(page.events.map((event) => event.seq)).toEqual([3, 4, 5]);
    expect(page.dropped).toBe(2);
    expect(page.oldestSeq).toBe(3);
    expect(page.latestSeq).toBe(5);

    // seq never restarts after eviction, so a client that polled at 5 sees 6 next, not 4.
    expect(info(log, 'event 6').seq).toBe(6);
  });

  test('since returns only newer events, oldest first, bounded by limit', () => {
    const log = logWith();
    for (let i = 1; i <= 4; i += 1) info(log, `event ${i}`);

    expect(log.since(2).events.map((event) => event.seq)).toEqual([3, 4]);
    expect(log.since(0, 2).events.map((event) => event.seq)).toEqual([1, 2]);
    expect(log.since(4).events).toEqual([]);
    expect(log.since(0, 0).events).toEqual([]);
  });

  test('subscribe delivers live events and the returned function unsubscribes', () => {
    const log = logWith();
    const seen: number[] = [];
    const unsubscribe = log.subscribe((event) => seen.push(event.seq));

    info(log, 'delivered');
    unsubscribe();
    info(log, 'not delivered');

    expect(seen).toEqual([1]);
  });

  test('a listener that throws breaks neither append nor the other listeners', () => {
    const log = logWith();
    const seen: number[] = [];
    log.subscribe(() => {
      throw new Error('listener blew up');
    });
    log.subscribe((event) => seen.push(event.seq));

    const stored = info(log, 'still appended');

    expect(stored.seq).toBe(1);
    expect(seen).toEqual([1]);
    expect(log.since(0).events).toHaveLength(1);
  });

  test('strips control characters from the message and from detail strings', () => {
    // Built with fromCharCode, never as literals: a raw ESC or NUL byte in this file is invisible
    // in an editor and does not survive every encoder. Same reasoning src/cli/output.ts gives.
    const esc = String.fromCharCode(0x1b);
    const nul = String.fromCharCode(0x00);
    const log = logWith();
    const stored = log.append({
      kind: 'route-error',
      level: 'error',
      message: `first line\nsecond line${esc}[31m`,
      detail: { role: `explo${nul}rer`, status: 422 },
    });

    expect(stored.message).toBe('first line\\u000asecond line\\u001b[31m');
    expect(stored.message).not.toContain('\n');
    expect(stored.detail?.role).toBe('explo\\u0000rer');
    expect(stored.detail?.status).toBe(422);
  });
});

describe('handlerEventToLogInput', () => {
  const base: HandlerEvent = { kind: 'route-decision', scope: 'child', path: '/v1/messages', durationMs: 4 };

  test('a routed decision logs at info and carries the decision fields', () => {
    const input = handlerEventToLogInput({
      ...base,
      role: 'explorer',
      agentId: 'agent-1',
      decision: 'route',
      source: 'role-default',
      upstreamModel: 'gateway/fast-worker',
    });

    expect(input.kind).toBe('route-decision');
    expect(input.level).toBe('info');
    expect(input.message).toBe('child explorer /v1/messages route to gateway/fast-worker via role-default (4ms)');
    expect(input.detail).toEqual({
      scope: 'child',
      path: '/v1/messages',
      durationMs: 4,
      role: 'explorer',
      agentId: 'agent-1',
      decision: 'route',
      source: 'role-default',
      upstreamModel: 'gateway/fast-worker',
    });
  });

  test('a pass-through logs at info', () => {
    const input = handlerEventToLogInput({ ...base, scope: 'parent', decision: 'pass-through' });

    expect(input.level).toBe('info');
    expect(input.message).toBe('parent /v1/messages pass-through (4ms)');
  });

  test('a route error logs at error and names its code', () => {
    const input = handlerEventToLogInput({ ...base, kind: 'route-error', decision: 'error', code: 'missing-selection', status: 422 });

    expect(input.kind).toBe('route-error');
    expect(input.level).toBe('error');
    expect(input.message).toBe('child /v1/messages 422 error missing-selection (4ms)');
    expect(input.detail?.code).toBe('missing-selection');
    expect(input.detail?.status).toBe(422);
  });

  test('emits no key beyond the RouterEvent detail contract', () => {
    const input = handlerEventToLogInput({ ...base, decision: 'pass-through' });
    const allowed = ['scope', 'role', 'agentId', 'decision', 'source', 'upstreamModel', 'code', 'path', 'status', 'durationMs'];

    for (const key of Object.keys(input.detail ?? {})) expect(allowed).toContain(key);
  });
});
