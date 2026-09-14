// The console's HTTP listener. Deliberately a SEPARATE process-local server from `serve`: `serve`
// is the measured routing path a native client talks to, and putting operator endpoints on it
// would share an origin and a request pipeline with the routing evidence.
//
// This server writes files and starts a router, which the old read-only console did not, so it
// carries three guards a read-only tool did not need:
//
//  1. Host allowlist, against DNS rebinding. A page on any site can point a name it controls at
//     this address; the same-origin policy does not help, because after the rebind the attacker's
//     origin IS the request origin.
//  2. Origin check on every write. A browser always sends Origin on a cross-origin POST and cannot
//     suppress it, so a mismatched Origin is refused. An absent Origin (curl, a test) is allowed.
//  3. Read-only mode. Binding off loopback forces it, because this console has no authentication.
import type { startServer } from '../cli/serve';
import type { ParsedArgs } from '../cli/args';
import { writeDiagnostic } from '../cli/output';
import { RouterError } from '../core/errors';
import type { CliDeps } from '../core/types';
import type { ApiEnvelope, RouterEvent, SystemStatus } from './api-types';
import { assetResponse, SECURITY_HEADERS } from './assets';
import { EventLog } from './events';
import { defaultConfigPath, EVENT_STREAM_PATH, ROUTES, type RouteContext } from './routes';
import { RouterSupervisor } from './supervisor';

export interface WebHandle {
  readonly url: string;
  stop(): Promise<void>;
}

export interface WebOptions {
  port: number;
  host: string;
  /** Forced on when the bind address is not loopback. */
  readOnly: boolean;
  /** Injected by tests. Defaults to the real `startServer`. */
  startRouter?: typeof startServer;
  /** Injected by tests so a bounded log can be asserted on. */
  eventCapacity?: number;
}

// `serve` owns 8787 (see write.ts). The console keeps its own default so both run side by side
// against one config without a port flag.
export const DEFAULT_WEB_PORT = 8788;
export const DEFAULT_WEB_HOST = '127.0.0.1';

// Host names a browser may use to reach the console at its own address, and the same set that
// answers "is this bind address loopback?". IPv6 appears bracketed (as a URL hostname carries it)
// and bare (as an operator types it).
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// A dotted quad or a bracketed IPv6 literal. Tells "the browser connected straight to an address"
// from "the browser resolved a name", which is the whole DNS-rebinding distinction.
const IP_LITERAL = /^(\[[0-9a-f:.]+\]|\d{1,3}(\.\d{1,3}){3})$/i;

// Conflicts, not bad requests: the caller's input was well formed but the world moved underneath
// it. The console re-reads and offers the edit again rather than showing a validation error.
const CONFLICT_CODES = new Set(['config-generation-conflict', 'config-exists', 'router-already-running', 'store-conflict', 'store-locked']);

function isRequestProblem(code: string): boolean {
  return (
    code.startsWith('config-') ||
    code.startsWith('snapshot-') ||
    code.startsWith('usage-') ||
    code.startsWith('install-') ||
    code.startsWith('export-') ||
    code.startsWith('web-') ||
    code === 'unknown-model' ||
    code === 'model-not-allowed' ||
    code === 'agent-unknown'
  );
}

function json(body: unknown, status: number): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' },
  });
}

function errorResponse(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

export function isAllowedHost(hostname: string, boundHost: string): boolean {
  const host = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || IP_LITERAL.test(host) || host === boundHost.toLowerCase();
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * Holds the state a request touches. `configPath` is mutable because the setup wizard can create a
 * config at a path that did not exist when the console started; without this, every later request
 * would keep reading the file the operator has just replaced.
 */
class ConsoleSession {
  readonly log: EventLog;
  private readonly deps: CliDeps;
  private readonly startRouter: typeof startServer | undefined;
  private path: string;
  private router: RouterSupervisor;

  constructor(deps: CliDeps, configPath: string, options: { eventCapacity?: number; startRouter?: typeof startServer }) {
    this.deps = deps;
    this.startRouter = options.startRouter;
    this.path = configPath;
    this.log = new EventLog({ now: deps.now, ...(options.eventCapacity !== undefined ? { capacity: options.eventCapacity } : {}) });
    this.router = this.buildSupervisor();
  }

  private buildSupervisor(): RouterSupervisor {
    return new RouterSupervisor({
      deps: this.deps,
      configPath: this.path,
      log: this.log,
      ...(this.startRouter !== undefined ? { start: this.startRouter } : {}),
    });
  }

  configPath(): string {
    return this.path;
  }

  supervisor(): RouterSupervisor {
    return this.router;
  }

  /**
   * Points the console at a different config file. A router started from the old config keeps
   * serving it, so retargeting under a running router is refused rather than silently leaving the
   * console describing one file while the router answers from another.
   */
  async retarget(configPath: string): Promise<void> {
    if (configPath === this.path) return;
    const status = await this.router.status();
    if (status.owner === 'in-process') {
      throw new RouterError('web-router-running', 'stop the router before switching to a different config file');
    }
    await this.router.dispose();
    this.path = configPath;
    this.router = this.buildSupervisor();
    this.log.append({ kind: 'console-action', level: 'info', message: `config path is now ${configPath}` });
  }

  async dispose(): Promise<void> {
    await this.router.dispose();
  }
}

/**
 * Server-sent events for the live log view. Backlog first, then every later append. Buffering is
 * unbounded by design for a local console: the reader is a page on the same machine, and the only
 * producer is a bounded in-memory log.
 */
function eventStream(log: EventLog, after: number): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: RouterEvent): void => {
        try {
          controller.enqueue(encoder.encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`));
        } catch {
          // The client went away between the close and the next append. Drop the subscription
          // rather than letting a dead controller keep receiving events.
          unsubscribe?.();
          unsubscribe = undefined;
        }
      };
      for (const event of log.since(after).events) send(event);
      unsubscribe = log.subscribe(send);
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { ...SECURITY_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' },
  });
}

/** Refuses a cross-origin write. An absent Origin is a non-browser client and is allowed. */
function originAllowed(request: Request, url: URL): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  return origin === url.origin;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const type = request.headers.get('content-type') ?? '';
  // Requiring the header is itself a CSRF guard: an HTML form can only send three content types
  // and application/json is not one of them, so a form post cannot reach a write endpoint.
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new RouterError('web-bad-content-type', 'writes require content-type: application/json');
  }
  const text = await request.text();
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RouterError('web-bad-request', 'the request body is not valid JSON');
  }
}

export interface WebHandlerOptions {
  deps: CliDeps;
  parsed: ParsedArgs;
  session: ConsoleSession;
  boundHost: string;
  console: SystemStatus['console'];
}

export function createWebHandler(options: WebHandlerOptions): (request: Request) => Promise<Response> {
  const { deps, parsed, session, boundHost } = options;
  const ctx: RouteContext = {
    deps,
    base: parsed,
    log: session.log,
    readOnly: options.console.readOnly,
    console: options.console,
    configPath: () => session.configPath(),
    supervisor: () => session.supervisor(),
    retarget: (path) => session.retarget(path),
  };

  return async (request: Request): Promise<Response> => {
    // Bun builds request.url from the Host header, so a raw client can put a value in there that
    // URL rejects (a space, a bare `::1`, no Host at all). Parsing outside this guard let the
    // throw escape into Bun's own error page, which carries source paths and source lines.
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse('web-bad-request', 'the request target could not be parsed', 400);
    }

    if (!isAllowedHost(url.hostname, boundHost)) {
      return errorResponse('web-host-not-allowed', 'the console does not answer to this host name', 403);
    }

    if (request.method === 'GET' && url.pathname === EVENT_STREAM_PATH) {
      const afterRaw = url.searchParams.get('after');
      const after = afterRaw !== null && /^\d{1,15}$/.test(afterRaw) ? Number(afterRaw) : 0;
      return eventStream(session.log, after);
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      const asset = await assetResponse(url.pathname);
      if (asset !== undefined) return asset;
    }

    const route = ROUTES[url.pathname];
    if (route === undefined) {
      return errorResponse('web-not-found', `no such endpoint: ${url.pathname}`, 404);
    }
    if (request.method !== route.method) {
      const refusal = errorResponse('web-method-not-allowed', `${request.method} is not allowed on ${url.pathname}`, 405);
      refusal.headers.set('allow', route.method);
      return refusal;
    }
    if (route.write === true && ctx.readOnly) {
      return errorResponse('web-read-only', 'this console runs read-only; restart it on a loopback address to make changes', 403);
    }
    if (route.method === 'POST' && !originAllowed(request, url)) {
      return errorResponse('web-origin-not-allowed', 'the request came from another origin', 403);
    }

    try {
      const body = route.method === 'POST' ? await readJsonBody(request) : undefined;
      const outcome = await route.handler(ctx, { url, body });
      if (route.write === true) {
        session.log.append({ kind: 'console-action', level: 'info', message: `${route.command} ok` });
      }
      const envelope: ApiEnvelope<unknown> = { command: route.command, code: outcome.code, payload: outcome.payload };
      return json(envelope, 200);
    } catch (error) {
      if (error instanceof RouterError) {
        if (route.write === true) {
          session.log.append({ kind: 'console-action', level: 'error', message: `${route.command} failed: ${error.code}` });
        }
        const status = CONFLICT_CODES.has(error.code) ? 409 : isRequestProblem(error.code) ? 400 : 500;
        return errorResponse(error.code, error.message, status);
      }
      // The raw text of an unexpected failure can embed a configured URL with credentials in it,
      // the same reasoning `doctor --connect` applies to a fetch rejection. Report a fixed label.
      if (route.write === true) {
        session.log.append({ kind: 'console-action', level: 'error', message: `${route.command} failed` });
      }
      return errorResponse('web-internal-error', 'the console failed to handle this request', 500);
    }
  };
}

export function resolveWebOptions(parsed: ParsedArgs): WebOptions {
  const portRaw = parsed.options.port;
  let port = DEFAULT_WEB_PORT;
  if (typeof portRaw === 'string') {
    // Digits only, on purpose: plain Number() also accepts '0x50', '1e3', ' 80 ' and '3.0', so a
    // typo would silently bind a port the operator never asked for.
    port = /^\d{1,5}$/.test(portRaw) ? Number(portRaw) : Number.NaN;
    if (!Number.isInteger(port) || port > 65535) {
      throw new RouterError('usage-invalid-port', `--port must be an integer between 0 and 65535, got ${JSON.stringify(portRaw)}`);
    }
  }
  const hostRaw = parsed.options.host;
  const host = typeof hostRaw === 'string' ? hostRaw : DEFAULT_WEB_HOST;
  // An unauthenticated console that can write files and start processes must never do so for
  // whoever can reach a LAN address. Off loopback it degrades to the read-only tool it used to be.
  const readOnly = parsed.options['read-only'] === true || !isLoopbackHost(host);
  return { port, host, readOnly };
}

/**
 * Starts the console. Unlike `serve`, state is loaded per request rather than frozen at startup,
 * and a missing config is NOT a startup failure: a fresh machine has no config yet, and the setup
 * view exists to create one.
 */
export async function startWebServer(deps: CliDeps, parsed: ParsedArgs, options: WebOptions): Promise<WebHandle> {
  if (!isLoopbackHost(options.host)) {
    writeDiagnostic(
      deps,
      `subagent-router: web is bound to ${options.host} and has no authentication; it runs read-only and anyone who can reach this address can read the config`,
    );
  }

  const session = new ConsoleSession(deps, defaultConfigPath(deps, parsed), {
    ...(options.eventCapacity !== undefined ? { eventCapacity: options.eventCapacity } : {}),
    ...(options.startRouter !== undefined ? { startRouter: options.startRouter } : {}),
  });

  const handler = createWebHandler({
    deps,
    parsed,
    session,
    boundHost: options.host,
    console: {
      url: `http://${options.host.includes(':') && !options.host.startsWith('[') ? `[${options.host}]` : options.host}:${options.port}`,
      host: options.host,
      port: options.port,
      readOnly: options.readOnly,
    },
  });

  const server = Bun.serve({
    port: options.port,
    hostname: options.host,
    // Bun's development error page embeds source paths and source lines. The handler answers its
    // own failures; anything that still escapes gets the same fixed label.
    development: false,
    error: () => errorResponse('web-internal-error', 'the console failed to handle this request', 500),
    fetch: handler,
  });

  const url = server.url.toString().replace(/\/$/, '');
  session.log.append({ kind: 'console-action', level: 'info', message: `console listening on ${url}` });

  return {
    url,
    async stop() {
      await session.dispose();
      await server.stop(true);
    },
  };
}

/** Exported for tests, which drive a session without binding a port. */
export function createSession(deps: CliDeps, configPath: string, options: { eventCapacity?: number; startRouter?: typeof startServer } = {}): ConsoleSession {
  return new ConsoleSession(deps, configPath, options);
}

export type { ConsoleSession };
