// Owns at most one router listener inside the console's own process. Deliberately not a process
// manager: there is no fork, no pid file and no respawn, because a console that outlives the
// router it started would have to reason about a listener it can no longer reach. One handle, held
// in memory, stopped when the console stops.
//
// The router it starts is the same `startServer` the CLI runs, on the same measured routing path.
// The console adds exactly one thing to it: the telemetry observer that feeds the event log.
import type { ParsedArgs } from '../cli/args';
import { startServer } from '../cli/serve';
import type { ServeHandle } from '../cli/serve';
import { resolveServeOptions } from '../cli/write';
import type { ServeOptions } from '../cli/write';
import { RouterError } from '../core/errors';
import type { CliDeps } from '../core/types';
import { HEALTH_PATH } from '../install/claude-code';
import { loadState } from '../io/store';
import type { RouterProcessStatus } from './api-types';
import { EventLog, handlerEventToLogInput } from './events';

export interface SupervisorOptions {
  deps: CliDeps;
  configPath: string;
  log: EventLog;
  /** Injected for tests. Defaults to the real `startServer` from src/cli/serve.ts. */
  start?: typeof startServer;
}

export interface StartRouterOptions {
  port?: number;
  host?: string;
  claudeVersion?: string;
}

// A console page load must not hang on a port nothing answers on.
const PROBE_TIMEOUT_MS = 1000;

// The console only ever probes an address a router on this same machine could be listening on.
// Probing anything else would turn a local operator tool into a scanner.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function routerUrl(host: string, port: number): string {
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${authority}:${port}`;
}

// Bun may bind a port other than the one asked for (0 means "any"), so the running address is read
// back from the handle's own URL rather than from the request that started it.
function addressOf(url: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    return Number.isInteger(port) ? { host: parsed.hostname, port } : null;
  } catch {
    return null;
  }
}

export class RouterSupervisor {
  private readonly deps: CliDeps;
  private readonly configPath: string;
  private readonly log: EventLog;
  private readonly startServerFn: typeof startServer;
  private handle: ServeHandle | undefined;
  private startedAt: string | null = null;
  private lastError: string | null = null;
  private host: string;
  private port: number;

  constructor(options: SupervisorOptions) {
    this.deps = options.deps;
    this.configPath = options.configPath;
    this.log = options.log;
    this.startServerFn = options.start ?? startServer;
    const defaults = this.serveOptionsFor({});
    this.host = defaults.host;
    this.port = defaults.port;
  }

  // Defaults and port validation come from `serve`'s own resolver, so the console and the CLI can
  // never drift apart on where a router binds.
  private serveOptionsFor(options: StartRouterOptions): ServeOptions {
    const parsed: ParsedArgs = {
      command: ['serve'],
      options: {
        ...(options.port !== undefined ? { port: String(options.port) } : {}),
        ...(options.host !== undefined ? { host: options.host } : {}),
        ...(options.claudeVersion !== undefined ? { 'claude-version': options.claudeVersion } : {}),
      },
      positionals: [],
      additionalRoots: [],
    };
    return resolveServeOptions(this.deps, parsed);
  }

  private async currentGeneration(): Promise<string | null> {
    try {
      return (await loadState(this.configPath)).generation;
    } catch {
      return null;
    }
  }

  /** Loopback only, bounded, and it never throws: a failed probe is a normal "nothing there". */
  private async probeExternal(): Promise<string | null> {
    if (!LOOPBACK_HOSTS.has(this.host)) return null;
    const url = routerUrl(this.host, this.port);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await this.deps.fetch(new Request(`${url}${HEALTH_PATH}`, { method: 'GET', signal: controller.signal }));
      return response.status === 200 ? url : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async status(): Promise<RouterProcessStatus> {
    const onDisk = await this.currentGeneration();
    const handle = this.handle;
    if (handle !== undefined) {
      return {
        owner: 'in-process',
        running: true,
        url: handle.url,
        host: this.host,
        port: this.port,
        generation: handle.generation,
        startedAt: this.startedAt,
        lastError: this.lastError,
        // The listener froze its generation at start time and never reloads it, so any difference
        // means the file on disk has moved on and this router still serves the old one.
        stale: onDisk !== null && onDisk !== handle.generation,
      };
    }

    const external = await this.probeExternal();
    return {
      owner: external === null ? 'none' : 'external',
      running: external !== null,
      url: external,
      host: external === null ? null : this.host,
      port: external === null ? null : this.port,
      // An externally started router owns its own generation; this console never loaded it and
      // will not guess one, so it cannot claim staleness about it either.
      generation: null,
      startedAt: null,
      lastError: this.lastError,
      stale: false,
    };
  }

  async start(options: StartRouterOptions): Promise<RouterProcessStatus> {
    if (this.handle !== undefined) {
      throw new RouterError('router-already-running', 'a router is already running in this console; stop or restart it instead');
    }

    const serveOptions = this.serveOptionsFor(options);
    // Recorded before the attempt so a start that failed on a busy port leaves status() probing
    // that port, which is exactly where an already-running external router would answer.
    this.host = serveOptions.host;
    this.port = serveOptions.port;

    try {
      const handle = await this.startServerFn(this.configPath, this.deps, {
        ...serveOptions,
        onEvent: (event) => this.log.append(handlerEventToLogInput(event)),
      });
      const address = addressOf(handle.url);
      if (address !== null) {
        this.host = address.host;
        this.port = address.port;
      }
      this.handle = handle;
      this.startedAt = this.deps.now().toISOString();
      this.lastError = null;
      this.log.append({ kind: 'router-started', level: 'info', message: `router listening on ${handle.url} (generation ${handle.generation})` });
    } catch (error) {
      // lastError is the code and nothing else: raw start failure text can quote a configured
      // gateway URL, credentials and all, and this value is rendered in a browser.
      const failure = error instanceof RouterError ? error : new RouterError('router-start-failed', 'the router failed to start');
      this.handle = undefined;
      this.startedAt = null;
      this.lastError = failure.code;
      this.log.append({
        kind: 'router-failed',
        level: 'error',
        message: error instanceof RouterError ? `${failure.code}: ${failure.message}` : failure.code,
      });
      throw failure;
    }

    return this.status();
  }

  async stop(): Promise<RouterProcessStatus> {
    await this.shutdown();
    return this.status();
  }

  async restart(options: StartRouterOptions): Promise<RouterProcessStatus> {
    await this.shutdown();
    return this.start(options);
  }

  /** Stops a running router. Safe to call twice. For process shutdown. */
  async dispose(): Promise<void> {
    await this.shutdown();
  }

  // The handle is dropped before it is stopped: a stop that fails must not leave the supervisor
  // holding a listener it can no longer address, which would block every later start.
  private async shutdown(): Promise<void> {
    const handle = this.handle;
    if (handle === undefined) return;
    this.handle = undefined;
    this.startedAt = null;
    await handle.stop();
    this.log.append({ kind: 'router-stopped', level: 'info', message: `router on ${handle.url} stopped` });
  }
}
