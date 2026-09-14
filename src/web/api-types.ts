// The contract between the web console's server modules and its Svelte app. One file so the
// browser code and the server code can never drift: every endpoint's response type lives here and
// both sides import it.
//
// Rule that binds every type below: a value read from the environment NEVER appears in a payload.
// Environment variables are reported by name plus a presence boolean, never by value. The same
// rule the CLI already follows for `config show`.
import type { CatalogSnapshot, ClientId, OperatorConfig, ResolvedModel, RouteDecision } from '../core/types';

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/** Every successful endpoint answers with this shape. `code` mirrors the CLI exit code. */
export interface ApiEnvelope<T> {
  command: string;
  code: 0 | 1 | 2;
  payload: T;
}

export interface ApiError {
  error: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// GET /api/system/status
// ---------------------------------------------------------------------------

export type ConfigHealth = 'ok' | 'missing' | 'invalid';

export interface EnvVarReport {
  name: string;
  /** Whether the variable is set and non-empty in the console's own environment. Never the value. */
  present: boolean;
  /** What the router uses it for, so the console can explain a missing one. */
  purpose: 'gateway-url' | 'gateway-headers' | 'models-base-url' | 'models-auth' | 'models-headers' | 'correlation-secret';
}

export interface RouterProcessStatus {
  /** 'in-process' when this console started the router itself; 'external' when it only probed one. */
  owner: 'in-process' | 'external' | 'none';
  running: boolean;
  url: string | null;
  host: string | null;
  port: number | null;
  /** Config+snapshot generation the running instance froze at, so the console can flag config drift. */
  generation: string | null;
  startedAt: string | null;
  /** Set when the last start attempt failed. The RouterError code, never raw error text. */
  lastError: string | null;
  /** True when the config on disk changed after the router started; it serves the old generation. */
  stale: boolean;
}

export interface SystemStatus {
  version: string;
  configPath: string;
  configHealth: ConfigHealth;
  /** Present only when configHealth is 'invalid'. A RouterError code. */
  configError: string | null;
  generation: string | null;
  snapshot: { present: boolean; fetchedAt: string | null; modelCount: number | null; stale: boolean };
  env: EnvVarReport[];
  router: RouterProcessStatus;
  console: { url: string; host: string; port: number; readOnly: boolean };
  /** Findings from `config check`, folded in so the header can show one health light. */
  problems: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// GET /api/detect
// ---------------------------------------------------------------------------

export interface DetectedClient {
  client: ClientId;
  /** Absolute path of the binary found on PATH, or null when the client is not installed. */
  binary: string | null;
  /** Version string as the binary reported it, or null when it could not be asked. */
  version: string | null;
  /** Whether a capability profile ships for this exact version. Routing needs one. */
  profileStatus: 'supported' | 'unsupported' | 'pending' | 'unknown';
  /** Agent roots that exist on disk for this client, with how many agent files each holds. */
  agentRoots: { path: string; scope: string; agentCount: number }[];
}

export interface DetectedGateway {
  /** Loopback URL that answered a models request, e.g. http://127.0.0.1:3456/v1 */
  url: string;
  /** How many models the endpoint listed on its first page. */
  modelCount: number;
  /** Label of the well-known gateway this port belongs to, when recognized. */
  label: string;
}

export interface DetectReport {
  clients: DetectedClient[];
  env: EnvVarReport[];
  /** Only present when the caller asked for a probe; loopback addresses only. */
  gateways: DetectedGateway[] | null;
  /** Directories that look like a generated install bundle. */
  bundles: { path: string; routerUrl: string | null }[];
  config: { path: string; exists: boolean; health: ConfigHealth; snapshotPresent: boolean };
}

// ---------------------------------------------------------------------------
// POST /api/config/init
// ---------------------------------------------------------------------------

export interface ConfigInitRequest {
  /** 'project' writes next to cwd, 'home' writes into ~/.subagent-router. */
  scope: 'project' | 'home';
  /** Env var names the operator chose. Names only; the console never sees a value. */
  gatewayUrlEnv: string;
  gatewayHeadersEnv: string[];
  modelsBaseUrlEnv: string;
  modelsAuthEnv?: string;
  modelsHeadersEnv: string[];
  correlationSecretEnv: string;
  sourceId: string;
  endpointPath: string;
  force?: boolean;
}

export interface ConfigInitResult {
  configPath: string;
  created: boolean;
}

// ---------------------------------------------------------------------------
// Config mutations
// ---------------------------------------------------------------------------

/**
 * Optimistic concurrency for every write: the console sends the generation it rendered from, and
 * the write is refused when the file changed since. Same guarantee `commitState` gives the CLI,
 * carried over HTTP.
 */
export interface MutationRequest {
  expectedGeneration: string;
}

export interface ModelOverrideRequest extends MutationRequest {
  /** Model id or alias. Resolved through the effective catalog, same as `models show`. */
  reference: string;
  /** null clears the field; undefined leaves it untouched. */
  alias?: string | null;
  description?: string | null;
  enabled?: boolean | null;
  clientModel?: string | null;
}

export interface RoleRequest extends MutationRequest {
  client: ClientId;
  agent: string;
  /** null removes the role entry. */
  routeOverride: string | null;
}

export interface DefaultsRequest extends MutationRequest {
  child?: string | null;
  unmarkedSubagent?: 'error' | 'inherit';
  unmarkedSubagentAcknowledged?: boolean;
}

export interface SourceRequest extends MutationRequest {
  sourceId?: string;
  endpointPath?: string;
  timeoutMs?: number;
  fetchLimit?: number;
  staleAfterSeconds?: number;
  gatewayUrlEnv?: string;
  gatewayHeadersEnv?: string[];
  modelsBaseUrlEnv?: string;
  /** null clears authEnv. */
  modelsAuthEnv?: string | null;
  modelsHeadersEnv?: string[];
  correlationSecretEnv?: string;
  correlation?: 'auto' | 'off';
}

export interface AgentRootRequest extends MutationRequest {
  client: ClientId;
  /** null restores the client's built-in root discovery. */
  configRoot: string | null;
}

export interface MutationResult {
  /** Generation after the write. The console re-renders from this without a round trip. */
  generation: string;
  config: OperatorConfig;
}

// ---------------------------------------------------------------------------
// Router lifecycle
// ---------------------------------------------------------------------------

export interface RouterStartRequest {
  port?: number;
  host?: string;
  /** Claude Code version the capability gate is checked against. Required by `serve`. */
  claudeVersion?: string;
}

// ---------------------------------------------------------------------------
// Events (status + logs view)
// ---------------------------------------------------------------------------

export type RouterEventKind =
  | 'router-started'
  | 'router-stopped'
  | 'router-failed'
  | 'route-decision'
  | 'route-error'
  | 'console-action';

export interface RouterEvent {
  /** Monotonic per-console sequence number. The console polls with `after=<seq>`. */
  seq: number;
  at: string;
  kind: RouterEventKind;
  level: 'info' | 'warn' | 'error';
  /** One short line, already redacted. Never contains a header value or a URL with credentials. */
  message: string;
  /** Present on route-decision/route-error. */
  detail?: {
    scope?: 'parent' | 'child';
    role?: string;
    agentId?: string;
    decision?: RouteDecision['kind'];
    source?: string;
    upstreamModel?: string;
    code?: string;
    path?: string;
    status?: number;
    durationMs?: number;
  };
}

export interface EventPage {
  events: RouterEvent[];
  /** Highest seq the buffer holds, so a client that fell behind can tell it dropped events. */
  latestSeq: number;
  /** Lowest seq still retained. A client whose `after` is below this missed events. */
  oldestSeq: number;
  dropped: number;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export interface InstallRequest {
  output: string;
  port?: number;
  host?: string;
  claudeVersion?: string;
  parentModel?: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface InstallResult {
  output: string;
  routerUrl: string;
  files: string[];
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Read payloads reused by the app
// ---------------------------------------------------------------------------

export interface ModelsPayload {
  models: ResolvedModel[];
  fetchedAt: string | undefined;
  generation: string;
}

export interface AgentsPayload {
  agents: {
    name: string;
    client: ClientId;
    scope: string;
    declaredModel: string;
    hidden: boolean;
    availability: string;
    shadowed: boolean;
  }[];
  completeness: string;
  diagnostics: readonly string[];
}

export interface ConfigPayload {
  config: OperatorConfig;
  generation: string;
}

export interface SyncPayload {
  added: string[];
  changed: string[];
  missing: string[];
  dryRun: boolean;
  fetchedAt: string;
}

export type { CatalogSnapshot, ClientId, OperatorConfig, ResolvedModel, RouteDecision };
