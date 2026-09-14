// Exercises the in-process router supervisor with an injected `startServer`, so nothing here
// binds a port or dials a gateway. deps.fetch is the only network surface and every test states
// exactly what it answers, which is what makes the loopback probe assertions meaningful.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { startServer, ServeHandle } from '../../src/cli/serve';
import { RouterError } from '../../src/core/errors';
import type { CliDeps, FetchLike } from '../../src/core/types';
import { HEALTH_PATH } from '../../src/install/claude-code';
import { loadState } from '../../src/io/store';
import type { HandlerEvent } from '../../src/transport/handler';
import type { RouterEvent } from '../../src/web/api-types';
import { EventLog } from '../../src/web/events';
import { RouterSupervisor } from '../../src/web/supervisor';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

let dir = '';
let configPath = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-supervisor-'));
  configPath = join(dir, 'subagent-router.json');
  await writeFile(configPath, JSON.stringify(configFixture()));
  await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NEVER_DIALS: FetchLike = () => Promise.reject(new Error('nothing is listening'));

function testDeps(fetchLike: FetchLike = NEVER_DIALS): CliDeps {
  return {
    cwd: dir,
    home: dir,
    env: { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 't', ROUTER_SECRET: 's' },
    stdout: () => {},
    stderr: () => {},
    isTTY: false,
    fetch: fetchLike,
    fetchAdapter: { id: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic' },
    loadProfile: async (client) => ({
      client,
      version: 'synthetic-hermetic',
      status: 'supported',
      correlation: false,
      correlationEntropy: 'pending',
      fork: false,
      adapterMarkerPosition: 'unknown',
      probes: {},
      lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' },
    }),
    loadTransportProfile: async () => ({ adapterId: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic', status: 'passed', gzipBytes: 'passed', responseHeaders: 'passed' }),
    now: () => new Date('2026-09-14T10:00:00.000Z'),
  };
}

type StartCall = Parameters<typeof startServer>[2];

interface FakeStart {
  start: typeof startServer;
  calls: StartCall[];
  stops: number;
}

/** An injected startServer that records what it was asked for and hands back a handle that never binds. */
function fakeStart(options: { fail?: unknown; generation?: 'from-disk' | string; boundPort?: number } = {}): FakeStart {
  const record: FakeStart = {
    calls: [],
    stops: 0,
    start: async (path, _deps, serveOptions): Promise<ServeHandle> => {
      record.calls.push(serveOptions);
      if (options.fail !== undefined) throw options.fail;
      const generation = options.generation === 'from-disk' || options.generation === undefined ? (await loadState(path)).generation : options.generation;
      const port = options.boundPort ?? serveOptions.port;
      return {
        url: `http://${serveOptions.host}:${port}`,
        generation,
        stop: async () => {
          record.stops += 1;
        },
      };
    },
  };
  return record;
}

function newLog(): EventLog {
  return new EventLog({ now: () => new Date('2026-09-14T10:00:00.000Z') });
}

function kinds(log: EventLog): RouterEvent['kind'][] {
  return log.since(0).events.map((event) => event.kind);
}

describe('RouterSupervisor start and stop', () => {
  test('start reports an in-process router and logs router-started', async () => {
    const log = newLog();
    const start = fakeStart();
    const supervisor = new RouterSupervisor({ deps: testDeps(), configPath, log, start: start.start });

    const status = await supervisor.start({});

    expect(status.owner).toBe('in-process');
    expect(status.running).toBe(true);
    expect(status.url).toBe('http://127.0.0.1:8787');
    expect(status.host).toBe('127.0.0.1');
    expect(status.port).toBe(8787);
    expect(status.generation).toBe((await loadState(configPath)).generation);
    expect(status.startedAt).toBe('2026-09-14T10:00:00.000Z');
    expect(status.lastError).toBeNull();
    expect(status.stale).toBe(false);
    expect(kinds(log)).toEqual(['router-started']);
    await supervisor.dispose();
  });

  test('defaults come from serve own resolver, not a second copy', async () => {
    const start = fakeStart();
    const supervisor = new RouterSupervisor({ deps: testDeps(), configPath, log: newLog(), start: start.start });

    await supervisor.start({});
    await supervisor.stop();
    await supervisor.start({ port: 9001, host: '127.0.0.1', claudeVersion: '2.1.0' });

    expect(start.calls[0]?.port).toBe(8787);
    expect(start.calls[0]?.host).toBe('127.0.0.1');
    expect(start.calls[0]?.claudeVersion).toBeUndefined();
    expect(start.calls[1]?.port).toBe(9001);
    expect(start.calls[1]?.claudeVersion).toBe('2.1.0');
    await supervisor.dispose();
  });

  test('an out of range port is refused by the same rule serve applies', async () => {
    const start = fakeStart();
    const supervisor = new RouterSupervisor({ deps: testDeps(), configPath, log: newLog(), start: start.start });

    await expect(supervisor.start({ port: 70000 })).rejects.toThrow(RouterError);
    expect(start.calls).toHaveLength(0);
  });

  test('start while already running throws router-already-running and starts nothing', async () => {
    const start = fakeStart();
    const supervisor = new RouterSupervisor({ deps: testDeps(), configPath, log: newLog(), start: start.start });
    await supervisor.start({});

    const error = (await supervisor.start({}).catch((thrown: unknown) => thrown)) as RouterError;

    expect(error).toBeInstanceOf(RouterError);
    expect(error.code).toBe('router-already-running');
    expect(start.calls).toHaveLength(1);
    await supervisor.dispose();
  });

  test('stop stops the handle, logs router-stopped and is idempotent', async () => {
    const log = newLog();
    const start = fakeStart();
    const supervisor = new RouterSupervisor({ deps: testDeps(), configPath, log, start: start.start });
    await supervisor.start({});

    const stopped = await supervisor.stop();
    const again = await supervisor.stop();

    expect(start.stops).toBe(1);
    expect(stopped.owner).toBe('none');
    expect(stopped.running).toBe(false);
    expect(stopped.url).toBeNull();
    expect(again.owner).toBe('none');
    expect(kinds(log)).toEqual(['router-started', 'router-stopped']);
  });

  test('restart stops the old listener before starting a new one', async () => {
    const log = newLog();
    const start = fakeStart();
    const supervisor = new RouterSupervisor({ deps: testDeps(), configPath, log, start: start.start });
    await supervisor.start({ port: 9100 });

    const status = await supervisor.restart({ port: 9200 });

    expect(start.stops).toBe(1);
    expect(start.calls.map((call) => call.port)).toEqual([9100, 9200]);
    expect(status.port).toBe(9200);
    expect(kinds(log)).toEqual(['router-started', 'router-stopped', 'router-started']);
    await supervisor.dispose();
  });

  test('dispose is safe to call twice', async () => {
    const start = fakeStart();
    const supervisor = new RouterSupervisor({ deps: testDeps(), configPath, log: newLog(), start: start.start });
    await supervisor.start({});

    await supervisor.dispose();
    await supervisor.dispose();

    expect(start.stops).toBe(1);
  });
});

describe('RouterSupervisor failed start', () => {
  test('a RouterError is rethrown, recorded as a code and logged first', async () => {
    const log = newLog();
    const start = fakeStart({ fail: new RouterError('snapshot-missing', 'serve requires a models.lock.json snapshot') });
    const supervisor = new RouterSupervisor({ deps: testDeps(), configPath, log, start: start.start });

    const error = (await supervisor.start({}).catch((thrown: unknown) => thrown)) as RouterError;
    const status = await supervisor.status();

    expect(error).toBeInstanceOf(RouterError);
    expect(error.code).toBe('snapshot-missing');
    expect(status.owner).toBe('none');
    expect(status.running).toBe(false);
    expect(status.lastError).toBe('snapshot-missing');
    expect(kinds(log)).toEqual(['router-failed']);
    expect(log.since(0).events[0]?.message).toBe('snapshot-missing: serve requires a models.lock.json snapshot');
    expect(log.since(0).events[0]?.level).toBe('error');
  });

  test('a raw error never reaches the caller, lastError or the log', async () => {
    const log = newLog();
    const secret = 'https://operator:hunter2@gateway.invalid/v1';
    const start = fakeStart({ fail: new Error(`ECONNREFUSED talking to ${secret}`) });
    const supervisor = new RouterSupervisor({ deps: testDeps(), configPath, log, start: start.start });

    const error = (await supervisor.start({}).catch((thrown: unknown) => thrown)) as RouterError;
    const status = await supervisor.status();

    expect(error).toBeInstanceOf(RouterError);
    expect(error.code).toBe('router-start-failed');
    expect(error.message).not.toContain('hunter2');
    expect(status.lastError).toBe('router-start-failed');
    expect(JSON.stringify(log.since(0))).not.toContain('hunter2');
  });

  test('a start can be retried after a failure', async () => {
    const supervisor = new RouterSupervisor({ deps: testDeps(), configPath, log: newLog(), start: fakeStart({ fail: new RouterError('unsupported-path', 'nope') }).start });
    await supervisor.start({}).catch(() => undefined);

    const recovered = new RouterSupervisor({ deps: testDeps(), configPath, log: newLog(), start: fakeStart().start });
    const status = await recovered.start({});

    expect(status.running).toBe(true);
    await recovered.dispose();
  });
});

describe('RouterSupervisor staleness', () => {
  test('flags a config edit made after the listener froze its generation', async () => {
    const supervisor = new RouterSupervisor({ deps: testDeps(), configPath, log: newLog(), start: fakeStart().start });
    await supervisor.start({});
    expect((await supervisor.status()).stale).toBe(false);

    const changed = configFixture();
    changed.modelOverrides[FIXTURE_MODEL_ID] = { alias: 'quick', description: 'changed after start' };
    await writeFile(configPath, JSON.stringify(changed));

    expect((await supervisor.status()).stale).toBe(true);
    await supervisor.dispose();
  });

  test('an unreadable config is not reported as staleness', async () => {
    const supervisor = new RouterSupervisor({ deps: testDeps(), configPath, log: newLog(), start: fakeStart({ generation: 'gen-frozen' }).start });
    await supervisor.start({});

    await rm(configPath);

    const status = await supervisor.status();
    expect(status.running).toBe(true);
    expect(status.stale).toBe(false);
    await supervisor.dispose();
  });
});

describe('RouterSupervisor external probe', () => {
  function probeDeps(answer: (request: Request) => Promise<Response>): { deps: CliDeps; seen: Request[] } {
    const seen: Request[] = [];
    return {
      seen,
      deps: testDeps((request) => {
        seen.push(request);
        return answer(request);
      }),
    };
  }

  test('a 200 on the control path means an external router owns the port', async () => {
    const { deps, seen } = probeDeps(async () => new Response(JSON.stringify({ handlerInstanceId: 'x' }), { status: 200 }));
    const supervisor = new RouterSupervisor({ deps, configPath, log: newLog(), start: fakeStart().start });

    const status = await supervisor.status();

    expect(status.owner).toBe('external');
    expect(status.running).toBe(true);
    expect(status.url).toBe('http://127.0.0.1:8787');
    expect(status.generation).toBeNull();
    expect(seen[0]?.method).toBe('GET');
    expect(new URL(seen[0]?.url ?? '').pathname).toBe(HEALTH_PATH);
  });

  test('a non-200 answer is nothing there, not an external router', async () => {
    const { deps } = probeDeps(async () => new Response('nope', { status: 404 }));
    const supervisor = new RouterSupervisor({ deps, configPath, log: newLog(), start: fakeStart().start });

    const status = await supervisor.status();

    expect(status.owner).toBe('none');
    expect(status.running).toBe(false);
    expect(status.url).toBeNull();
  });

  test('a rejected probe never throws out of status', async () => {
    const supervisor = new RouterSupervisor({ deps: testDeps(), configPath, log: newLog(), start: fakeStart().start });

    const status = await supervisor.status();

    expect(status.owner).toBe('none');
    expect(status.running).toBe(false);
  });

  test('a probe that hangs is aborted and still answers none', async () => {
    const { deps } = probeDeps(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const supervisor = new RouterSupervisor({ deps, configPath, log: newLog(), start: fakeStart().start });

    const status = await supervisor.status();

    expect(status.owner).toBe('none');
  }, 5000);

  test('never probes an address that is not loopback', async () => {
    const { deps, seen } = probeDeps(async () => new Response(null, { status: 200 }));
    const supervisor = new RouterSupervisor({ deps, configPath, log: newLog(), start: fakeStart().start });
    await supervisor.start({ host: '0.0.0.0' });
    await supervisor.stop();

    const status = await supervisor.status();

    expect(status.owner).toBe('none');
    expect(seen).toHaveLength(0);
  });
});

describe('RouterSupervisor telemetry wiring', () => {
  test('handler events reach the log through the observer it passes to startServer', async () => {
    const log = newLog();
    const start = fakeStart();
    const supervisor = new RouterSupervisor({ deps: testDeps(), configPath, log, start: start.start });
    await supervisor.start({});

    const onEvent = start.calls[0]?.onEvent;
    expect(onEvent).toBeDefined();
    const handlerEvent: HandlerEvent = {
      kind: 'route-decision',
      scope: 'child',
      role: 'explorer',
      agentId: 'agent-1',
      decision: 'route',
      source: 'role-default',
      upstreamModel: FIXTURE_MODEL_ID,
      path: '/v1/messages',
      durationMs: 3,
    };
    onEvent?.(handlerEvent);

    const events = log.since(0).events;
    expect(events.map((event) => event.kind)).toEqual(['router-started', 'route-decision']);
    expect(events[1]?.level).toBe('info');
    expect(events[1]?.detail?.upstreamModel).toBe(FIXTURE_MODEL_ID);
    expect(events[1]?.detail?.durationMs).toBe(3);
    await supervisor.dispose();
  });
});
