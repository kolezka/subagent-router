/**
 * Public `./core` entrypoint: the runtime-agnostic decision core.
 *
 * Everything re-exported here must stay free of Bun globals and of `node:` builtins, so the
 * bundle can be imported by a plain Node process, a browser-like runtime or another bundler.
 * Anything that touches the filesystem, the network or a harness lives behind `./handler`,
 * `./bun` or one of the adapter entrypoints instead. `tests/package.test.ts` asserts the
 * absence of `Bun.` and `node:fs` in the built `dist/core.js`, so an accidental import of an
 * I/O module here fails the build's own test rather than silently shipping.
 */
export { buildCatalog, resolveModel } from './core/catalog';
export { parseOperatorConfig, parseSnapshot } from './core/config';
export { RouterError } from './core/errors';
export { modelAlias, sha256, sourceFingerprint } from './core/hash';
export { resolveRoute } from './core/route';

export type {
  AgentDefinition,
  AgentInventory,
  CapabilityGate,
  CapabilityProfile,
  CatalogSnapshot,
  ClientId,
  CliDeps,
  ConsumeFreshDelegation,
  EffectiveCatalog,
  Env,
  ExportFile,
  FetchLike,
  FreshDelegationEnvelope,
  FreshDelegationReceipt,
  HeaderMap,
  LifecyclePhase,
  LoadedState,
  ModelOverride,
  NativeConfigWitness,
  NativeRuntimeContext,
  OperatorConfig,
  ProbeResult,
  ResolvedModel,
  ResolverOptions,
  RouteDecision,
  RouteErrorCode,
  RouteInput,
  SnapshotModel,
  SourceContext,
  SyncResult,
  TransportCapabilityProfile,
  TrustedLifecycleContext,
} from './core/types';
