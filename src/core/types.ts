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

export type ParentPromptPosition = 'first-text' | 'after-native-context-v1' | 'after-native-context-v2';

export interface CapabilityProfile {
  client: ClientId;
  version: string;
  status: 'pending' | 'supported' | 'unsupported';
  correlation: boolean;
  correlationEntropy: ProbeResult;
  fork: boolean;
  adapterMarkerPosition: 'system' | 'first-user' | 'b2' | 'unknown';
  /**
   * Where the parent-authored channel-A marker line is read from in the first user message.
   * Absent or 'first-text': the first line of the first text block (legacy D2 position 2).
   * 'after-native-context-v1': additionally, the first line of text block 1 when block 0 is a
   * recognized native context scaffold (measured on Claude Code 2.1.266).
   * 'after-native-context-v2': additionally, the first line of text block 2 when block 0 is the
   * recognized operator-instructions block and block 1 that same context scaffold (measured on
   * Claude Code 2.1.268). Each alternate slot is only honoured together with a passed 'M3-A'
   * probe and an exact request-to-profile version match, matches only its own block count, and
   * never applies to signed adapter markers.
   */
  parentPromptPosition?: ParentPromptPosition;
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
