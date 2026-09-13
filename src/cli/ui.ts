// Local, read-only web console for the router. Deliberately a SEPARATE listener from `serve`:
// `serve` is the measured routing path a native client talks to, and adding UI routes to it
// would put operator-facing endpoints on the same origin and the same request pipeline that the
// lifecycle evidence was recorded against. This module never forwards a request upstream, never
// writes a file and never dials the network; every endpoint re-uses the same read-only command
// functions the CLI already exposes, so the console can never show a different answer than
// `subagent-router models list` and friends would.
import { RouterError } from '../core/errors';
import type { CliDeps } from '../core/types';
import { loadState } from '../io/store';
import type { ParsedArgs } from './args';
import { writeDiagnostic } from './output';
import { agentsList, configCheck, configShow, doctor, modelsList, resolveConfigPath, routePreview, type CommandResult } from './read';
import { UI_PAGE } from './ui-page';

export interface UiHandle {
  readonly url: string;
  stop(): Promise<void>;
}

export interface UiOptions {
  port: number;
  host: string;
}

// `serve` owns 8787 (see write.ts). The console gets its own default so both can run side by side
// against the same config without a port flag.
const DEFAULT_UI_PORT = 8788;
const DEFAULT_UI_HOST = '127.0.0.1';

// Host names a browser may use to reach the console at its own address; see isAllowedHost. The
// same set answers "is this bind address loopback?" at startup, which is why the IPv6 address is
// present both bracketed (as a URL hostname carries it) and bare (as an operator types it).
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// A dotted-quad or a bracketed IPv6 literal. Used to tell "the browser connected straight to an
// address" from "the browser resolved a name", which is the whole DNS-rebinding distinction.
const IP_LITERAL = /^(\[[0-9a-f:.]+\]|\d{1,3}(\.\d{1,3}){3})$/i;

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  // The page is inline-only and same-origin-only: no external script, style, font or image, and
  // no cross-origin fetch. ui-page.ts is written to hold to this.
  'content-security-policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

/**
 * Usage/config problems the caller can fix (a missing config file, an unknown agent, a missing
 * snapshot) answer 400; anything else is an operational failure and answers 500. Deliberately
 * narrower than main.ts's own classifier: the console exposes no `config export` command, so the
 * export- codes that one folds in cannot occur here.
 */
function isRequestProblem(code: string): boolean {
  return (
    code.startsWith('config-') ||
    code.startsWith('snapshot-') ||
    code.startsWith('usage-') ||
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

/**
 * Refuses a request addressed to a DNS name this console does not answer to. Without this, a page
 * on any website can point a hostname it controls at the console's address and then read the
 * responses from the browser of whoever is running it (DNS rebinding); the same-origin policy
 * does not stop that, because after the rebind the attacker's origin IS the request origin. An
 * address literal is always allowed: rebinding needs a name, and a browser that connected to a
 * bare IP still cannot read a no-CORS cross-origin response.
 *
 * `hostname` comes from `request.url`, which Bun.serve builds from the request's Host header
 * (measured on Bun 1.3: a spoofed Host lands verbatim in request.url), so this reads the value
 * the client actually sent, not the address the socket happens to be bound to.
 */
function isAllowedHost(hostname: string, boundHost: string): boolean {
  const host = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || IP_LITERAL.test(host) || host === boundHost.toLowerCase();
}

type ApiHandler = (deps: CliDeps, parsed: ParsedArgs) => Promise<CommandResult>;

/**
 * Overview header data. The only endpoint that is not a straight CLI command: it reports the
 * loaded generation and where the state came from, which the console shows on every view.
 * `human` is unused on this path (the API always renders `payload` as JSON) but keeping the
 * CommandResult shape lets every endpoint go through one code path.
 */
async function uiStatus(deps: CliDeps, parsed: ParsedArgs): Promise<CommandResult> {
  const state = await loadState(resolveConfigPath(deps, parsed));
  const payload = {
    generation: state.generation,
    configPath: state.configPath,
    snapshotFetchedAt: state.snapshot?.fetchedAt ?? null,
    snapshotModelCount: state.snapshot?.models.length ?? null,
  };
  return { code: 0, payload, human: () => '' };
}

interface Endpoint {
  /** The CLI command this endpoint mirrors, echoed back so the console can label a result. */
  command: string;
  handler: ApiHandler;
  /** Query parameters lifted into the synthetic ParsedArgs. Anything else is ignored. */
  query: readonly string[];
}

const ENDPOINTS: Readonly<Record<string, Endpoint>> = {
  '/api/status': { command: 'status', handler: uiStatus, query: [] },
  '/api/doctor': { command: 'doctor', handler: doctor, query: [] },
  '/api/config/check': { command: 'config check', handler: configCheck, query: [] },
  '/api/config/show': { command: 'config show', handler: configShow, query: [] },
  '/api/models': { command: 'models list', handler: modelsList, query: [] },
  '/api/agents': { command: 'agents list', handler: agentsList, query: ['client'] },
  '/api/route/preview': { command: 'route preview', handler: routePreview, query: ['client', 'agent', 'model', 'parent-model'] },
};

/**
 * Builds the ParsedArgs a read command expects from the request's query string. The `--config`
 * and `--agents-dir` values the `ui` command itself was started with are carried through, so the
 * console always inspects the same config file and agent roots as the invocation that started it.
 * Only the parameters an endpoint declares are copied; an unexpected one is dropped rather than
 * handed to a command that never asked for it.
 */
function requestArgs(base: ParsedArgs, url: URL, query: readonly string[]): ParsedArgs {
  const options: Record<string, string | boolean> = {};
  const configOption = base.options.config;
  if (typeof configOption === 'string') options.config = configOption;
  for (const name of query) {
    const value = url.searchParams.get(name);
    if (value !== null) options[name] = value;
  }
  return { command: [], options, positionals: [], additionalRoots: base.additionalRoots };
}

/**
 * The console's request handler. Exported for tests, which drive it directly instead of binding
 * a port. GET only: every endpoint is read-only, so a non-GET method is a client mistake, not a
 * route this server has simply not implemented yet.
 */
export function createUiHandler(deps: CliDeps, parsed: ParsedArgs, boundHost: string): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    // Bun builds request.url from the Host header, so a raw client can put a value in there that
    // URL rejects (a space, a bare `::1`, no Host at all). Parsing outside this guard let the
    // throw escape into Bun's own error page, which carries source paths and source lines.
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse('ui-bad-request', 'the request target could not be parsed', 400);
    }

    if (!isAllowedHost(url.hostname, boundHost)) {
      return errorResponse('ui-host-not-allowed', 'the console does not answer to this host name', 403);
    }
    if (request.method !== 'GET') {
      const refusal = errorResponse('ui-method-not-allowed', `${request.method} is not allowed; the console is read-only`, 405);
      refusal.headers.set('allow', 'GET');
      return refusal;
    }

    if (url.pathname === '/') {
      return new Response(UI_PAGE, { status: 200, headers: { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' } });
    }

    const endpoint = ENDPOINTS[url.pathname];
    if (endpoint === undefined) {
      return errorResponse('ui-not-found', `no such endpoint: ${url.pathname}`, 404);
    }

    try {
      const result = await endpoint.handler(deps, requestArgs(parsed, url, endpoint.query));
      // `code` is the CLI's own exit code for the same command and is reported as data: a
      // config check that found problems (code 2) is a successful inspection, not a failed
      // request, and the console renders it as findings.
      return json({ command: endpoint.command, code: result.code, payload: result.payload }, 200);
    } catch (error) {
      if (error instanceof RouterError) {
        return errorResponse(error.code, error.message, isRequestProblem(error.code) ? 400 : 500);
      }
      // The raw text of an unexpected failure can embed a configured URL with credentials in it,
      // the same reasoning doctor --connect applies to a fetch rejection. Report a fixed label.
      return errorResponse('ui-internal-error', 'the console failed to produce this report', 500);
    }
  };
}

export function resolveUiOptions(parsed: ParsedArgs): UiOptions {
  const portRaw = parsed.options.port;
  let port = DEFAULT_UI_PORT;
  if (typeof portRaw === 'string') {
    // Digits only, on purpose: plain Number() also accepts '0x50', '1e3', ' 80 ' and '3.0', so a
    // typo would silently bind a port the operator never asked for.
    port = /^\d{1,5}$/.test(portRaw) ? Number(portRaw) : Number.NaN;
    if (!Number.isInteger(port) || port > 65535) {
      throw new RouterError('usage-invalid-port', `--port must be an integer between 0 and 65535, got ${JSON.stringify(portRaw)}`);
    }
  }
  const hostRaw = parsed.options.host;
  return { port, host: typeof hostRaw === 'string' ? hostRaw : DEFAULT_UI_HOST };
}

/**
 * Starts the console. State is loaded per request, not frozen at startup like `serve` does: an
 * inspection tool that kept showing a config the operator has already edited would be actively
 * misleading, and nothing here is on a routing path where a mid-flight generation change matters.
 */
export async function startUiServer(deps: CliDeps, parsed: ParsedArgs, options: UiOptions): Promise<UiHandle> {
  // Fail at startup, not on the first request, when the config cannot be loaded at all.
  await loadState(resolveConfigPath(deps, parsed));

  // The console is unauthenticated: anyone who can reach the port reads the operator's config.
  // Binding it off loopback is allowed (an operator may want it on a workstation LAN) but never
  // silent.
  if (!LOOPBACK_HOSTS.has(options.host.toLowerCase())) {
    writeDiagnostic(deps, `subagent-router: ui is bound to ${options.host} and has no authentication; anyone who can reach this address can read the config`);
  }

  const handler = createUiHandler(deps, parsed, options.host);
  const server = Bun.serve({
    port: options.port,
    hostname: options.host,
    // Bun's development error page embeds source paths and source lines. The handler already
    // answers its own failures; anything that still escapes gets the same fixed label.
    development: false,
    error: () => errorResponse('ui-internal-error', 'the console failed to handle this request', 500),
    fetch: handler,
  });

  return {
    url: server.url.toString().replace(/\/$/, ''),
    async stop() {
      await server.stop(true);
    },
  };
}

export async function startUiCommand(deps: CliDeps, parsed: ParsedArgs): Promise<{ result: CommandResult; server: UiHandle }> {
  const options = resolveUiOptions(parsed);
  const server = await startUiServer(deps, parsed, options);
  const payload = { url: server.url, host: options.host, port: options.port, readOnly: true };
  const human = () => `console on ${server.url} (read-only)\n`;
  return { result: { code: 0, payload, human }, server };
}

/**
 * CLI-facing wrapper. Like `serve`, it returns once the listener is open and the process stays
 * alive because of the open socket; no signal handling or daemonizing lives here.
 */
export async function uiCommand(deps: CliDeps, parsed: ParsedArgs): Promise<CommandResult> {
  const { result } = await startUiCommand(deps, parsed);
  return result;
}
