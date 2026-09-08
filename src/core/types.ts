export type ClientId = 'claude-code' | 'opencode' | 'codex';
export type Env = Readonly<Record<string, string | undefined>>;
export type HeaderMap = Readonly<Record<string, string>>;
export type FetchLike = (request: Request) => Promise<Response>;

export interface ModelOverride {
  alias?: string;
  description?: string;
  enabled?: boolean;
  clientModel?: string;
}

export interface OperatorConfig {
  version: 1;
  modelSource: {
    sourceId: string;
    baseUrlEnv: string;
    endpointPath: string;
    authEnv?: string;
    headersEnv: string[];
    timeoutMs: number;
    fetchLimit: number;
    staleAfterSeconds: number;
  };
  modelOverrides: Record<string, ModelOverride>;
  roles: Record<string, { routeOverride: string }>;
  defaults: {
    child: string | null;
    unmarkedSubagent: 'error' | 'inherit';
    unmarkedSubagentAcknowledged?: boolean;
  };
  agentRoots: Record<ClientId, { configRoot: string | null }>;
  gateway: { urlEnv: string; headersEnv: string[] };
  harness: {
    claudeCode: { correlation: 'auto' | 'off'; secretEnv: string };
    opencode: { providerId: string };
    codex: { emitModelCatalog: boolean };
  };
}

export interface SnapshotModel {
  id: string;
  alias: string;
  status: 'available' | 'missing';
  metadata: { displayName?: string };
}

export interface CatalogSnapshot {
  version: 1;
  sourceId: string;
  sourceFingerprint: string;
  fetchedAt: string;
  models: SnapshotModel[];
}

export interface ResolvedModel {
  id: string;
  alias: string;
  status: 'available' | 'missing';
  enabled: boolean;
  description?: string;
  clientModel?: string;
}

export interface EffectiveCatalog {
  byId: ReadonlyMap<string, ResolvedModel>;
  byAlias: ReadonlyMap<string, ResolvedModel>;
}

export type RouteErrorCode =
  | 'unknown-model'
  | 'model-not-allowed'
  | 'invalid-marker'
  | 'conflicting-markers'
  | 'correlation-conflict'
  | 'unsupported-path'
  | 'missing-selection';

export type RouteDecision =
  | { kind: 'pass-through'; reason: 'parent' | 'inherit-allowed'; ignoredMarkers: number }
  | {
      kind: 'route';
      upstreamModel: string;
      clientModel?: string;
      source: 'explicit' | 'role-default' | 'global-default' | 'correlated';
      ignoredMarkers: number;
    }
  | { kind: 'error'; code: RouteErrorCode; ignoredMarkers: number };

export interface RouteInput {
  client: ClientId;
  scope: 'parent' | 'child';
  role?: string;
  explicitIds: readonly string[];
  roleDefaultId?: string;
  correlatedId?: string;
  freshDelegation?: boolean;
  markerError?: 'invalid-marker' | 'conflicting-markers';
  explicitError?: 'unknown-model';
  clientModel?: string;
  ignoredMarkers: number;
}

export interface AgentDefinition {
  client: ClientId;
  name: string;
  scope: string;
  path?: string;
  declaredModel?: string;
  hidden: boolean;
  body?: string;
  native: Readonly<Record<string, unknown>>;
  availability: 'available' | 'missing' | 'fileless';
  shadowed: boolean;
}

export interface AgentInventory {
  entries: readonly AgentDefinition[];
  completeness: 'files-only' | 'native';
  diagnostics: readonly string[];
}

export interface ResolverOptions {
  cwd: string;
  home: string;
  env: Env;
  configRoot?: string;
  additionalRoots: readonly string[];
  nativeInventory?: AgentInventory;
}

export interface SourceContext {
  sourceId: string;
  effectiveGatewayUrl: string;
  effectiveModelsUrl: string;
  /** Discovery-only headers (modelSource.headersEnv/authEnv). Never forwarded to the gateway. */
  headers: HeaderMap;
  /** Forwarding headers (gateway.headersEnv). The only headers the transport handler may send upstream. */
  gatewayHeaders: HeaderMap;
}

export interface LoadedState {
  config: OperatorConfig;
  snapshot?: CatalogSnapshot;
  expected: { configHash: string; snapshotHash: string | null };
  generation: string;
  /** The resolved, absolute path this state was loaded from (`loadState`'s `configPath`, resolved). */
  configPath: string;
}

export interface SyncResult {
  snapshot: CatalogSnapshot;
  added: string[];
  changed: string[];
  missing: string[];
}

export type ProbeResult = 'passed' | 'failed' | 'pending';
export type LifecyclePhase = 'next-turn' | 'resume' | 'compaction' | 'nested' | 'parallel';

export interface TrustedLifecycleContext {
  lifecyclePhase?: LifecyclePhase;
  freshDelegation: boolean;
}

export interface NativeConfigWitness {
  source: 'authoritative-native-resolver';
  providerId?: string;
  effectiveModel: string;
  expectedGeneration: string;
  actualGeneration: string;
  artifactHash: string;
}

export interface NativeRuntimeContext extends TrustedLifecycleContext {
  nativeConfig: NativeConfigWitness;
}

export interface FreshDelegationEnvelope {
  version: 1;
  handlerInstanceId: string;
  agentId: string;
  role: string;
  nonce: string;
  issuedAtMs: number;
  proof: string;
}

export interface FreshDelegationReceipt {
  agentId: string;
  role: string;
  nonce: string;
}

export type ConsumeFreshDelegation = (agentId: string) => FreshDelegationReceipt | undefined;

export interface CapabilityProfile {
  client: ClientId;
  version: string;
  status: 'pending' | 'supported' | 'unsupported';
  correlation: boolean;
  correlationEntropy: ProbeResult;
  fork: boolean;
  adapterMarkerPosition: 'system' | 'first-user' | 'b2' | 'unknown';
  diagnostics?: readonly string[];
  probes: Readonly<Record<string, ProbeResult>>;
  lifecycle: Readonly<Record<LifecyclePhase, ProbeResult>>;
}

export interface TransportCapabilityProfile {
  adapterId: string;
  runtimeVersion: string;
  status: ProbeResult;
  gzipBytes: ProbeResult;
  responseHeaders: ProbeResult;
}

export type CapabilityGate =
  | 'claude-marker'
  | 'claude-correlation'
  | 'claude-fork'
  | 'opencode-native-runtime'
  | 'codex-native-runtime'
  | 'codex-explicit-over-role';

export interface CliDeps {
  cwd: string;
  home: string;
  env: Env;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  isTTY: boolean;
  fetch: FetchLike;
  fetchAdapter: { id: string; runtimeVersion: string };
  loadProfile: (client: ClientId, version: string) => Promise<CapabilityProfile>;
  loadTransportProfile: (adapterId: string, runtimeVersion: string) => Promise<TransportCapabilityProfile>;
  now: () => Date;
}

export interface ExportFile {
  relativePath: string;
  content: string;
}
