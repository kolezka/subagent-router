/**
 * The console's only HTTP surface. Every endpoint the app touches is a named function here, so a
 * view never builds a URL and never parses an envelope.
 *
 * A failure is a value, not an exception: `ApiResult` carries the server's own `code` and
 * `message` through to the UI unchanged. Nothing in this file turns a failure into an empty list,
 * because "no models" and "the server refused to read the config" must not look the same on screen.
 */
import type {
  AgentRootRequest,
  AgentsPayload,
  ApiEnvelope,
  ClientId,
  ConfigInitRequest,
  ConfigInitResult,
  ConfigPayload,
  DefaultsRequest,
  DetectReport,
  EventPage,
  InstallRequest,
  InstallResult,
  ModelOverrideRequest,
  ModelsPayload,
  MutationResult,
  RoleRequest,
  RouterProcessStatus,
  RouterStartRequest,
  SourceRequest,
  SyncPayload,
  SystemStatus,
} from '../../../api-types';
// Type-only: the bundler erases this import, so no CLI module is pulled into the browser bundle.
import type { RoutePreviewResult } from '../../../../cli/read';

export type { RoutePreviewResult };

export const CLIENT_IDS: readonly ClientId[] = ['claude-code', 'opencode', 'codex'];

/** The generation conflict the server raises when the config changed under an open page. */
export const GENERATION_CONFLICT = 'config-generation-conflict';

export interface ApiFailure {
  code: string;
  message: string;
}

export type ApiResult<T> = { ok: true; value: T; code: 0 | 1 | 2 } | { ok: false; error: ApiFailure };

/** `config check`, which the CLI answers but api-types does not name. Shape given by the server. */
export interface ConfigCheckPayload {
  problems: string[];
  warnings: string[];
  generation: string;
}

/**
 * The `doctor` payload. `src/cli/read.ts` builds it inline and exports no interface for it, so it
 * is described here structurally rather than imported.
 */
export interface DoctorPayload {
  network: boolean;
  config: { ok: true; generation: string } | { ok: false; error: string };
  snapshotStale: boolean;
  clients: { client: ClientId; version: string; status: string; diagnostics?: readonly string[] }[];
  transport: { adapterId: string; runtimeVersion: string; status: string };
}

export interface SyncCatalogRequest {
  dryRun?: boolean;
  allowEmpty?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readApiError(body: unknown): ApiFailure | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const { code, message } = body.error;
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  return { code, message };
}

function readEnvelope<T>(body: unknown): ApiEnvelope<T> | null {
  if (!isRecord(body) || typeof body.command !== 'string' || typeof body.code !== 'number') return null;
  if (!('payload' in body)) return null;
  return body as unknown as ApiEnvelope<T>;
}

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'console-unreachable',
        message: `The console server did not answer ${path}. It may have stopped. (${String(cause)})`,
      },
    };
  }

  const raw = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: {
        code: 'invalid-response',
        message: `${path} answered HTTP ${response.status} with a body that is not JSON.`,
      },
    };
  }

  // The server reports a refusal as { error } with a 4xx/5xx status. Read the error first so its
  // own code and message reach the operator rather than a generic status line.
  const failure = readApiError(body);
  if (failure !== null) return { ok: false, error: failure };

  if (!response.ok) {
    return { ok: false, error: { code: `http-${response.status}`, message: `${path} answered HTTP ${response.status}.` } };
  }

  const envelope = readEnvelope<T>(body);
  if (envelope === null) {
    return {
      ok: false,
      error: { code: 'invalid-response', message: `${path} answered without a { command, code, payload } envelope.` },
    };
  }
  return { ok: true, value: envelope.payload, code: envelope.code };
}

function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<ApiResult<T>> {
  let url = path;
  if (params !== undefined) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === '') continue;
      query.set(key, String(value));
    }
    const encoded = query.toString();
    if (encoded.length > 0) url = `${path}?${encoded}`;
  }
  return request<T>(url);
}

function post<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getSystemStatus(): Promise<ApiResult<SystemStatus>> {
  return get<SystemStatus>('/api/system/status');
}

export function getDetect(probe = false): Promise<ApiResult<DetectReport>> {
  return get<DetectReport>('/api/detect', probe ? { probe: 1 } : undefined);
}

export function getConfig(): Promise<ApiResult<ConfigPayload>> {
  return get<ConfigPayload>('/api/config/show');
}

export function getConfigCheck(): Promise<ApiResult<ConfigCheckPayload>> {
  return get<ConfigCheckPayload>('/api/config/check');
}

export function getModels(): Promise<ApiResult<ModelsPayload>> {
  return get<ModelsPayload>('/api/models');
}

export function getAgents(client: ClientId): Promise<ApiResult<AgentsPayload>> {
  return get<AgentsPayload>('/api/agents', { client });
}

export interface RoutePreviewQuery {
  client: ClientId;
  agent: string;
  model?: string;
  parentModel?: string;
}

export function getRoutePreview(query: RoutePreviewQuery): Promise<ApiResult<RoutePreviewResult>> {
  return get<RoutePreviewResult>('/api/route/preview', {
    client: query.client,
    agent: query.agent,
    model: query.model,
    'parent-model': query.parentModel,
  });
}

export function getDoctor(): Promise<ApiResult<DoctorPayload>> {
  return get<DoctorPayload>('/api/doctor');
}

export function getEvents(after: number): Promise<ApiResult<EventPage>> {
  return get<EventPage>('/api/events', { after });
}

export const EVENT_STREAM_PATH = '/api/events/stream';

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function initConfig(body: ConfigInitRequest): Promise<ApiResult<ConfigInitResult>> {
  return post<ConfigInitResult>('/api/config/init', body);
}

export function setModelOverride(body: ModelOverrideRequest): Promise<ApiResult<MutationResult>> {
  return post<MutationResult>('/api/config/models/override', body);
}

export function setRole(body: RoleRequest): Promise<ApiResult<MutationResult>> {
  return post<MutationResult>('/api/config/roles', body);
}

export function setDefaults(body: DefaultsRequest): Promise<ApiResult<MutationResult>> {
  return post<MutationResult>('/api/config/defaults', body);
}

export function setSource(body: SourceRequest): Promise<ApiResult<MutationResult>> {
  return post<MutationResult>('/api/config/source', body);
}

export function setAgentRoot(body: AgentRootRequest): Promise<ApiResult<MutationResult>> {
  return post<MutationResult>('/api/config/agent-root', body);
}

export function syncCatalog(body: SyncCatalogRequest): Promise<ApiResult<SyncPayload>> {
  return post<SyncPayload>('/api/models/sync', body);
}

export function startRouter(body: RouterStartRequest): Promise<ApiResult<RouterProcessStatus>> {
  return post<RouterProcessStatus>('/api/router/start', body);
}

export function stopRouter(): Promise<ApiResult<RouterProcessStatus>> {
  return post<RouterProcessStatus>('/api/router/stop', {});
}

export function restartRouter(body: RouterStartRequest): Promise<ApiResult<RouterProcessStatus>> {
  return post<RouterProcessStatus>('/api/router/restart', body);
}

export function install(body: InstallRequest): Promise<ApiResult<InstallResult>> {
  return post<InstallResult>('/api/install', body);
}
