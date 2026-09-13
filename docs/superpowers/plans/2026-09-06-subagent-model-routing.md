# Subagent Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Execute the tasks with checkboxes; end each TDD cycle with a review of spec compliance and quality. The user already chose the execution mode; do not ask again about an alternative workflow.

**Goal:** Implement a small Bun and TypeScript package that routes native subagent models, with catalog discovery, unchanged agent definitions, and a CLI for inspection.

**Architecture:** A pure core makes the decision based on an immutable config/snapshot pair. Separate modules provide the atomic write, catalog discovery, and client adapters. Claude Code uses a marker and an HTTP handler; OpenCode and Codex use the native model with runtime validation.

**Tech Stack:** TypeScript strict, Bun 1.3.11, `bun:test`, Web Crypto, and the standard Request/Response/ReadableStream. Bun's built-in YAML and TOML parsers are confined to the adapter layer. The core has no runtime dependencies and no Bun imports. TypeScript generates the type declarations.

**Spec:** [Subagent model routing, revision 6](../specs/2026-09-06-subagent-model-routing-design.md). Historical base for revision 3: Git `721ca0065c94ee5b1e5fa7b765b464f3f5e6201c`.

Date: 2026-09-06

Status: execution in progress; the first milestone is a local PoC. The full client support matrix remains unverified.

## Checkpoint PoC, 2026-09-08

At the user's request, priority goes to a runnable Claude Code vertical slice: marker, HTTP handler, external gateway. Tasks 1-4 delivered the core and the store. For the PoC, the local elements of Task 7, Task 8, Task 9, and a minimal `serve` from Task 13 are implemented. Task 5-6, 10-12, the full Task 13, packaging, and the full Task 15 remain to be done; they have not been cancelled.

Real client profiles remain `pending`. The local synthetic scenario does not pass M1-M10 and does not replace the native roundtrip. A probe driver without evidence extractors must not mark a measurement as passed. The entries below describing the lack of an implementation belong to historical revisions of the document.

## Plan revision 2, 2026-09-07

The source of this revision is the spec revision 4. The pin `721ca0065c94ee5b1e5fa7b765b464f3f5e6201c` remains the historical base of revision 3, not a declaration that revision 4 is current. Execution has still not started. No tests, probes, harness changes, or harness configuration updates have been made.

Revision 2 changelog:

- clarified the boundaries between the single router package, the external gateway, and the separate KB;
- separated the pure core decision from the measured native enforcement of OpenCode and Codex;
- tightened capability profiles, marker channels, B2, and correlation to fail-closed;
- added executable plugin and hook entry points, controlled export of their configuration, and denial evidence;
- clarified forwarding without response decoding and the E2E gate for all three clients;
- added a map from requirement to spec section, step, and named test. The map describes planned tests, not results;
- after review, synchronized the trusted lifecycle context, explicit handler gates, the Claude hook producer, transport profiles, entrypoint build, and the separation of hermetic tests from native E2E evidence. No production adapter takes over tool execution or the lifecycle; continuation occurs only in test drivers.

The user requested preparation of a plan based on the spec. This is not an instruction to start implementation, run paid tests, or publish the package. The spec remains the overriding contract; the plan does not change its status or scope.

## Plan revision 3, 2026-09-08

The source is the spec revision 5. One substantive change: the conversation with the provider is carried by an external gateway, `9router` or OmniRoute as the target, and the package must not depend on `@the-next-ai/ai-gateway` used by CCR. The reason is low performance of that package with the OpenAI provider observed by the operator; no measurement was made in this project. Added a global constraint and a named boundary test in Task 15. Tasks 1-4 completed before this revision need no changes, since they add no runtime dependency.

## Plan revision 4, 2026-09-09

The source is the spec revision 6. One substantive change, from the measured child request layout on Claude Code 2.1.266: the native context sits in text block 0 of the first `user` message, the delegation prompt in block 1. Task 7 adds the profile field `parentPromptPosition` and the measurement `M3-A`; Task 8 adds the parent-only slot `after-native-context-v1` in `extractMarkers` with the scaffold grammar, and binds the client version from the request to the profile version in `normalizeClaudeRequest`; Task 15 lists `M3-A` among the Claude Code gates. The legacy position, channels B and B2, M3, and M10 stay unchanged. Profiles 2.1.263 and 2.1.266 remain `pending`; the synthetic handler probe profile is not evidence.

## Execution integration clarifications, 2026-09-08

- `SourceContext.headers` applies only to discovery. `gatewayHeaders` applies only to forwarding. `effectiveGatewayUrl` comes from `gateway.urlEnv`, and `effectiveModelsUrl` from `modelSource.baseUrlEnv` and `endpointPath`. Catalog credentials are not a fallback for gateway headers.
- In OpenCode, `tool.execute.before` receives `(input, output)`; the tool arguments are in `output.args`; success completes without a value; and a denial throws an exception. This real contract replaces the single-argument callback sketch from Task 10. A test plugin attempt alone proves the hook mechanism, not the complete M6-runtime of the router.
- The generation and artifact hash are adapter expectations compared against the actual effective configuration. They are not native client fields. Neither a sidecar nor a literal `source: 'authoritative-native-resolver'` replaces reading the native resolver.
- A positive test of the native validator requires either a genuinely native inventory or an explicit synthetic equivalent. `files-only` must not be promoted to `native` by the mere presence of the `nativeInventory` argument.

## Global Constraints

- The package MUST be a single Bun + TypeScript package, no monorepo.
- The core MUST be pure and importable without a mandatory server process.
- The core MUST NOT depend on harness SDKs.
- Bun is allowed in the CLI and standalone mode, but the core MUST NOT require a Bun-specific API.
- The project MUST NOT create its own agent loop, MCP runner, scheduler, UI, or database.
- The project does not cover provider account auth, protocol translation, provider-specific discovery, or automatic fallback to another model.
- The conversation with the provider is carried by an external gateway, `9router` or OmniRoute as the target; LiteLLM or another gateway with the same HTTP contract is acceptable. The package MUST NOT depend on `@the-next-ai/ai-gateway` or any other gateway package; the test `boundary::package-has-no-ai-gateway-dependency-or-import` in Task 15 checks this.
- No command MUST automatically change native harness files. Export writes only to a separate artifact directory, never to the agent source directory, even with `--force`.
- Native agent definitions, including `model: inherit`, MUST remain unchanged.
- Upstream IDs and aliases are compared case-sensitive. An upstream ID MUST NOT be trimmed, normalized, or derived from an alias. The native resolver supplies the role name.
- Marker alias: `^[A-Za-z][A-Za-z0-9_-]{0,126}$`; automatic alias: `m-` plus the full UTF-8 SHA-256 of the exact ID.
- Marker syntax: `<subagent-router v="1" model="ALIAS"/>` and `<subagent-router v="1" role="NAME" agent="AGENT_ID" token="HMAC"/>`. The variants are mutually exclusive.
- `subagent-router.json` is the operator file. `models.lock.json` is the snapshot next to it, with `available` and `missing` states.
- `sourceFingerprint`: UTF-8 SHA-256 of the compact JSON array `[sourceId, effectiveGatewayUrl, effectiveModelsUrl]`. The base URLs reject userinfo, query, and fragment. Only discovery adds the pagination parameter.
- Selection order: explicit model, role default model, global default model for children. An invalid explicit selection does not fall through to a default.
- No selection for a recognized child means `missing-selection`, unless the operator explicitly chose `inherit` and `unmarkedSubagentAcknowledged: true`.
- The snapshot and config of a `serve` instance are immutable. Sync or editing the description does not switch running sessions.
- `modelSource`: defaults to `/v1/models`, `timeoutMs: 10000`, `fetchLimit: 1000`, `staleAfterSeconds: 86400`. A failed or partial fetch does not replace the previous snapshot.
- An empty list requires `--allow-empty`. Discovery handles `has_more` and `next_cursor`, detects cycles, and does not pass credentials between origins.
- Inspection and preview are offline. `doctor --connect` and `models sync` explicitly perform network access; the `serve` transport has its own scope.
- CLI: exit `0` success, `1` operational error, `2` bad usage/config/selection. `--json` puts data on stdout, diagnostics on stderr. Secrets and untrusted control characters must not leak.
- Base versions from the spec: Claude Code 2.1.263, OpenCode 1.18.29, Codex at least rust-v0.153.4, Bun 1.3.11. The version alone does not pass the compatibility test.
- A fork is not a guarantee of the first release per D3, but requires the M4 measurement and a separate case. It must not be conflated with an ordinary agent using `model: inherit`.
- All temporary files and isolated test config roots are created under the designated test working directory. The examples never touch the operator's real HOME.

## Revision 2 boundaries

| Area | In scope for this plan | Out of scope and owner |
|---|---|---|
| Core | Catalog from the snapshot, aliases, validation, the pure `upstreamModel` decision, configuration, and deterministic defaults. `upstreamModel` is opaque and case-sensitive. The core gets the exact resolved ID, for example `gateway/fast-worker`, and does not know the native `providerId`; the native field can be `gateway/gateway/fast-worker` when the provider is `gateway`, but the second segment remains the unchanged core ID. | No provider, auth, normalization, prefix stripping, LLM chooser, fallback, or session state. |
| Adapters | Read-only inventory, Claude marker and HMAC, native OpenCode and Codex gates, measurement profiles, and manual integration export. | Agent loop, tools, lifecycle, UI, scheduler, and daemon manager remain owned by the native harnesses. |
| Handler and forwarding | Only Claude Code in `marker-routed` mode: recognizes a confirmed child, makes the decision, strips the marker from the body copy, and forwards the request to the configured gateway. | The handler is not a provider gateway; it performs no provider auth, protocol translation, response decode/re-encode, or new runtime. The external gateway, `9router` or OmniRoute as the target, LiteLLM acceptable, handles the providers. The `@the-next-ai/ai-gateway` package from CCR is not a dependency. |
| Catalog and CLI | Offline inspection, discovery on explicit request, snapshot, preview, diagnostics, controlled export, and `serve`. | The KB is a separate Markdown/Git plus PostgreSQL and Weaviate system with its own CLI/MCP. The router does not import the KB, does not open a connection to its storage, and does not call the KB MCP. |
| E2E | Fake gateway, opt-in run of real clients through their native CLI, capture of the measured `upstreamModel`, transport, and native enforcement evidence. | No custom agent runtime or AI SDK wrapper is built. The core and handler have no mandatory AI SDK dependency. |

Terminology distinction: an AI SDK client is a request library, an agent runtime manages the child, tools, and lifecycle, and the router's forwarding carries the request and response to the gateway. The SDK library itself is not an agent loop, but the router does not plan to use it or offer a wrapper. The core and handler do not require an AI SDK. If a fetch runtime adapter automatically decompresses the response or changes the semantics of `content-encoding` or `content-length`, the adapter must not claim transparency. Task 9 then requires a measured `unsupported-path` denial, not a documented limitation that counts as passing pass-through, instead of SDK decode and response regeneration.

---

## Evidence scope and commands

At the time of writing this plan, the repository at the stated base contains documentation only, without `src`, `tests`, or `package.json`. Tracked files and a clean Git status were read. [verified]

On the machine preparing the plan, Bun 1.3.11 and Node v22.23.2 were read. In Bun, parsing of synthetic `name` and `model: inherit` documents was run through `Bun.YAML.parse` and `Bun.TOML.parse`, yielding the expected objects. This confirms the parsers are present, not the correctness of the future agent resolver. [verified]

The code in the tasks is plan material, not a deployed application. The expected RED or GREEN result is a condition for the implementer to observe, not a report of an executed test. Checking block syntax does not replace typechecking, tests, or an actual client call.

The commands `bun test`, `bun run typecheck`, and `bun run build` in the tasks are run from the root of the implementation worktree. The project scripts are created in Task 1. Dev dependencies are recorded in `bun.lock`; CI uses `bun install --frozen-lockfile`. Do not install tools globally or change the operator's active shell profile.

## Plan integration decisions

1. **OpenCode validation is a gate, not a generator.** Requirement 33 mandates a runtime check. D5 of revision 3 called the plugin optional; revision 4 separates optional diagnostics from the mandatory guard. Export alone must not enforce the allowlist. Task 10 designs a guard that validates the chosen variant without changing the task arguments. If the measurements do not confirm such a hook, the adapter for that version remains `unsupported`; do not replace the check with trust in the model's instructions.
2. **A profile is not built from a version number or the look of an ID.** M1 requires proof of a stable identity and how it is generated. A handful of different 64-bit-length strings does not prove randomness. Absence of proof keeps correlation off. The remaining independent tasks can still proceed.
3. **RED is a behavior failure.** After writing the test, you may add only an exported, type-correct empty skeleton so the import is not the cause of the failure. Then run the assertion. Do not count an import error, a syntax error, or a test runner configuration error as RED for the function in question.
4. **An error does not count as a working integration.** A denial test does not entitle marking the whole client as supported. The final gate requires a request received by the controlled gateway, a tool roundtrip, and a decoded child result.
5. **Concurrent write has an explicit scope.** All router commands share a per-config lock and check both input hashes under the lock. An external editor that does not apply the lock is detected on recheck, but we do not promise a transaction with an arbitrary filesystem process. Writing the config and snapshot at the same time is not a public operation.
6. **Knowledge of native precedence is versioned.** The directory order and role names come from a confirmed resolver profile or a supplied native inventory. Do not introduce a universal default order based on file name. An incomplete offline result is explicitly `files-only`, and an effective name without proof is undetermined.

Cost of these decisions: some adapters may remain unactivated after the independent modules are finished, until their measurements pass. This does not remove adapters, measurements, or criteria from the plan's scope.

## File Structure

The target files below do not yet exist. Each task's `Files` field names the owner of their creation; later tasks change shared files only where this is stated.

```text
package.json
bun.lock
tsconfig.json
src/
  index.ts
  bun.ts
  core/
    types.ts
    errors.ts
    hash.ts
    config.ts
    catalog.ts
    route.ts
  io/
    environment.ts
    store.ts
  catalog/
    discovery.ts
    sync.ts
  agents/
    inventory.ts
    claude-code.ts
    opencode.ts
    codex.ts
    export.ts
  adapters/
    capabilities.ts
    claude-code.ts
    markers.ts
    correlation.ts
    opencode.ts
    opencode-plugin.ts
    codex.ts
    codex-hook.ts
  transport/
    handler.ts
    hooks.ts
    claude-hook.ts
  cli/
    args.ts
    output.ts
    read.ts
    main.ts
    write.ts
    serve.ts
scripts/build.ts
tests/
  support/{fixtures.ts,capture-gateway.ts}
  core/
  io/
  catalog/
  agents/
  adapters/
  transport/
  cli/
  fixtures/{agents,capabilities}/
  probes/{run.ts,evidence.test.ts}
  e2e/{routing.test.ts,cli-workflow.test.ts}
  package.test.ts
docs/
  core/
  catalog/
  agents/
  transport/
  cli/
```

The target documents for the working blocks are `README.md`, `CONTRACTS.md`, `INVARIANTS.md`, `GAPS.md`, and `OPERATIONS.md`. They are created only at Task 15, with the actual evidence scope, not as earlier implementation declarations.

## Dependencies and ordering

| Task | Delivers | Requires |
|---|---|---|
| 1 | Types, test harness, aliases, and fixtures | documentation baseline |
| 2 | Config, source, and effective catalog | 1 |
| 3 | Pure routing decisions | 1, 2 |
| 4 | Write and read with conflict checking | 1, 2 |
| 5 | Discovery and snapshot sync | 1, 2, 4 |
| 6 | Native agent inventory | 1, 2 |
| 7 | Capture gateway, evidence, and capability profiles | 1, 2, 6 |
| 8 | Claude markers, tool catalog, and correlation | 1, 2, 3, 7 |
| 9 | HTTP handler and local Claude hooks | 1, 2, 3, 7, 8 |
| 10 | OpenCode variants and validation | 1, 2, 3, 6, 7 |
| 11 | Codex validating hook | 1, 2, 3, 6, 7 |
| 12 | Read-only CLI, preview, and diagnostics | 1, 2, 3, 4, 6, 7 |
| 13 | Write commands, export, and serve | 4, 5, 6, 9, 10, 11, 12 |
| 14 | Package, Node import, and smoke CLI | 1-13 |
| 15 | Full integration gate and documentation | 1-14 |

Execute in order. Document authors may prepare disjoint parts in parallel; implementers must not mutate the same worktree in parallel.

## Superpowers protocol and progress ledger

Chosen method: `superpowers:subagent-driven-development`, not a Workflow and not one large inline execution.

- Before execution: worktree via `superpowers:using-git-worktrees`; read the plan and the spec.
- Resolve this plan's directory through the skill's installed script `scripts/sdd-workspace PLAN_FILE`, run from the root of the correct worktree. The helper uses the current repository; it does not derive it from the plan path. Do not assume a machine-specific cache path, and do not run it in the CCR repo. The helper must not touch another plan's directory.
- The first row of the ledger identifies this plan. After resuming, read the ledger and Git before launching the next implementer. Do not repeat tasks marked complete.
- For each Task, record BASE and use `scripts/task-brief PLAN_FILE N`. A fresh implementer receives its own brief, the needed interfaces from predecessors, and the report path. It does not inherit the whole conversation and does not delegate further.
- Every sub-case goes through RED, GREEN, and REFACTOR. The report includes the commands, exit status, the relevant RED assertion, and the GREEN result. Do not commit red tests as a completed task.
- After the task, use `scripts/review-package PLAN_FILE BASE HEAD`. The reviewer receives the brief, the report, and the diff package. It must return separate assessments of spec compliance and quality.
- Comments go back to the implementer. Do not replace the review with a coordinator fix of your own. Run the loop as the loaded skill describes, with decisions recorded explicitly.
- Minimum model: Terra or a similar worker for a well-specified implementation; Sol for concurrency, auth, and harder reviews. For the final review of the whole branch, use a strong independent model. Every subagent prompt starts with the correct CCR tag, and the chosen model is explicit.
- Before marking a task complete, the coordinator checks the actual commits and artifacts, not just the implementer's claim.
- After Task 15, a broad review of the whole branch, verification of remaining comments, and a summary of decisions. Merge, push, and package publication are not an automatic step of the plan.

Before implementation, produce a preflight table with a producer/consumer pair for every shared file and interface. In the ledger, record the statuses `pending`, `red-observed`, `green-observed`, `review`, `complete`, and `blocked` with the actual reason. Agreement to prepare the plan does not count as passing any of these stages.

---

## Tasks

The code in the blocks below is design material, not a run or type-checked artifact. Every RED step must end in an assertion failure, not an import error. After writing the test, you may add only an exported, type-correct empty skeleton so the test reaches the assertion.

### Task 1: Public types, project tooling, and deterministic aliases

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/core/types.ts`
- Create: `src/core/errors.ts`
- Create: `src/core/hash.ts`
- Create: `tests/support/fixtures.ts`
- Test: `tests/core/hash.test.ts`

**Interfaces:**
- Consumes: nothing. The repository baseline contains only documentation.
- Produces: all the types from the block below, `RouterError`, `sha256(text: string): Promise<string>`, `modelAlias(id: string): Promise<string>`, `sourceFingerprint(sourceId: string, gatewayUrl: string, modelsUrl: string): Promise<string>`, `configFixture(patch?: Partial<OperatorConfig>): OperatorConfig`, `snapshotFixture(ids?: readonly string[]): Promise<CatalogSnapshot>`.

- [ ] **Step 1: Create the manifest and TypeScript configuration**

```json
{
  "name": "subagent-router",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "bun": ">=1.3.11" },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "build": "bun run scripts/build.ts"
  },
  "devDependencies": {
    "@types/bun": "1.3.11",
    "typescript": "5.9.2"
  }
}
```

The devDependencies versions are starting values. The implementer sets them with the command `bun add -d typescript @types/bun` and records the result in `bun.lock`. Adding a runtime dependency to `dependencies` is not allowed in this task.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "types": ["bun-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "emitDeclarationOnly": true,
    "outDir": "dist/types",
    "rootDir": "src"
  },
  "include": ["src", "tests", "scripts"]
}
```

`lib` includes `DOM` solely for the `Request`, `Response`, and `crypto.subtle` types. The core must not use browser APIs beyond these standard objects.

- [ ] **Step 2: Write the public types in one file**

The file `src/core/types.ts` is the single source of types shared across tasks. Later tasks import from here; they do not define their own copies.

```ts
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
  headers: HeaderMap; // discovery only
  gatewayHeaders: HeaderMap; // forwarding only
}

export interface LoadedState {
  config: OperatorConfig;
  snapshot?: CatalogSnapshot;
  expected: { configHash: string; snapshotHash: string | null };
  generation: string;
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
```

- [ ] **Step 3: Write the error class**

```ts
export class RouterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RouterError';
    this.code = code;
  }
}
```

The message must not contain header values, tokens, or prompt content. Tasks that create errors from input data pass only identifiers and field names.

- [ ] **Step 4: Write a failing test for aliases and the fingerprint**

The expected values were computed by hand outside the project code: the UTF-8 SHA-256 of the string `gateway/fast-worker`, and the SHA-256 of the compact JSON array `["primary-gateway","https://gateway.example/v1","https://gateway.example/v1/models"]`. These are the same literals given by the snapshot example in the spec.

```ts
import { describe, expect, test } from 'bun:test';
import { modelAlias, sha256, sourceFingerprint } from '../../src/core/hash';

describe('hash', () => {
  test('sha256 zwraca 64 znaki hex dla pustego ciągu', async () => {
    expect(await sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('modelAlias buduje prefiks m- i pełny hash dokładnego ID', async () => {
    expect(await modelAlias('gateway/fast-worker')).toBe(
      'm-6414d01405c95a7bd2b2a13b415d7685a1673f800ca90dd031a5eeb1776dc81d',
    );
  });

  test('modelAlias rozróżnia wielkość liter i spacje w ID', async () => {
    const lower = await modelAlias('gateway/model');
    const upper = await modelAlias('gateway/Model');
    const spaced = await modelAlias('gateway/model ');
    expect(new Set([lower, upper, spaced]).size).toBe(3);
  });

  test('sourceFingerprint haszuje zwartą tablicę JSON trzech elementów', async () => {
    expect(
      await sourceFingerprint('primary-gateway', 'https://gateway.example/v1', 'https://gateway.example/v1/models'),
    ).toBe('96b80377b311dc1765bde8e0ec7bae4efa848497ad0245cfb927653ba2d0527b');
  });
});
```

- [ ] **Step 5: Add an empty skeleton and run the test to observe RED**

The skeleton in `src/core/hash.ts` returns an empty string from every function. Run:

```bash
bun test ./tests/core/hash.test.ts
```

Expected: 4 tests fail on `toBe` assertions, for example `Expected: "m-6414d0..." Received: ""`. If the test fails on a missing module, go back to the skeleton.

- [ ] **Step 6: Implement the hash via Web Crypto**

```ts
const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return toHex(digest);
}

export async function modelAlias(id: string): Promise<string> {
  return `m-${await sha256(id)}`;
}

export async function sourceFingerprint(sourceId: string, gatewayUrl: string, modelsUrl: string): Promise<string> {
  return sha256(JSON.stringify([sourceId, gatewayUrl, modelsUrl]));
}
```

`JSON.stringify` of the array without spacing gives exactly the compact form the spec requires. Do not use `Bun.hash` or `node:crypto`, because the core must work in any environment with Web Crypto.

- [ ] **Step 7: Run the test and observe GREEN**

```bash
bun test ./tests/core/hash.test.ts
```

Expected: 4 pass, 0 fail.

- [ ] **Step 8: Write the shared fixtures**

```ts
import type { CatalogSnapshot, OperatorConfig } from '../../src/core/types';
import { modelAlias, sourceFingerprint } from '../../src/core/hash';

export const FIXTURE_SOURCE_ID = 'test-gateway';
export const FIXTURE_GATEWAY_URL = 'http://127.0.0.1:8000/v1';
export const FIXTURE_MODELS_URL = 'http://127.0.0.1:8000/v1/models';
export const FIXTURE_FETCHED_AT = '2026-09-06T00:00:00.000Z';
export const FIXTURE_MODEL_ID = 'gateway/fast-worker';

export function configFixture(patch: Partial<OperatorConfig> = {}): OperatorConfig {
  const base: OperatorConfig = {
    version: 1,
    modelSource: {
      sourceId: FIXTURE_SOURCE_ID,
      baseUrlEnv: 'GATEWAY_URL',
      endpointPath: '/v1/models',
      authEnv: 'MODELS_AUTH',
      headersEnv: ['GATEWAY_HEADERS'],
      timeoutMs: 10000,
      fetchLimit: 1000,
      staleAfterSeconds: 86400,
    },
    modelOverrides: {
      [FIXTURE_MODEL_ID]: { alias: 'fast', description: 'Szybkie zadania.', enabled: true, clientModel: 'haiku' },
    },
    roles: { 'claude-code:explorer': { routeOverride: FIXTURE_MODEL_ID } },
    defaults: { child: null, unmarkedSubagent: 'error' },
    agentRoots: {
      'claude-code': { configRoot: null },
      opencode: { configRoot: null },
      codex: { configRoot: null },
    },
    gateway: { urlEnv: 'GATEWAY_URL', headersEnv: ['GATEWAY_HEADERS'] },
    harness: {
      claudeCode: { correlation: 'auto', secretEnv: 'ROUTER_SECRET' },
      opencode: { providerId: 'gateway' },
      codex: { emitModelCatalog: false },
    },
  };
  return structuredClone({ ...base, ...patch });
}

export async function snapshotFixture(ids: readonly string[] = [FIXTURE_MODEL_ID]): Promise<CatalogSnapshot> {
  const models = await Promise.all(
    ids.map(async (id) => ({ id, alias: await modelAlias(id), status: 'available' as const, metadata: {} })),
  );
  return {
    version: 1,
    sourceId: FIXTURE_SOURCE_ID,
    sourceFingerprint: await sourceFingerprint(FIXTURE_SOURCE_ID, FIXTURE_GATEWAY_URL, FIXTURE_MODELS_URL),
    fetchedAt: FIXTURE_FETCHED_AT,
    models,
  };
}
```

Every call returns a fresh copy. A test that mutates a fixture must not affect other tests.

- [ ] **Step 9: Run typecheck and the whole suite**

```bash
bun run typecheck && bun test
```

Expected: no type errors, 4 pass.

- [ ] **Step 10: Commit**

```bash
git add package.json bun.lock tsconfig.json src/core tests
git commit -m "feat: add core types, hashing and test fixtures"
```

### Task 2: Validation of config, snapshot, and effective catalog

**Files:**
- Create: `src/core/config.ts`
- Create: `src/core/catalog.ts`
- Create: `src/io/environment.ts`
- Test: `tests/core/config.test.ts`
- Test: `tests/core/catalog.test.ts`
- Test: `tests/io/environment.test.ts`

**Interfaces:**
- Consumes: types and `RouterError` from Task 1, `sourceFingerprint`, fixtures.
- Produces: `parseOperatorConfig(value: unknown): OperatorConfig`, `parseSnapshot(value: unknown): CatalogSnapshot`, `buildCatalog(config: OperatorConfig, snapshot: CatalogSnapshot): EffectiveCatalog`, `resolveModel(ref: string, catalog: EffectiveCatalog): ResolvedModel`, `resolveSource(config: OperatorConfig, env: Env): SourceContext`, `validateSource(source: SourceContext, snapshot: CatalogSnapshot): Promise<void>`.

- [ ] **Step 1: Write failing tests for config validation**

```ts
import { describe, expect, test } from 'bun:test';
import { parseOperatorConfig, parseSnapshot } from '../../src/core/config';
import { RouterError } from '../../src/core/errors';
import { configFixture, snapshotFixture } from '../support/fixtures';

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RouterError);
  expect((caught as RouterError).code).toBe(code);
}

describe('parseOperatorConfig', () => {
  test('przyjmuje poprawny plik i zwraca kopię', () => {
    const input = configFixture();
    const parsed = parseOperatorConfig(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
  });

  test.each([
    ['nieznana wersja', { version: 2 }, 'config-version'],
    ['nieznane pole', { extra: true }, 'config-unknown-field'],
    ['inline header', { gateway: { urlEnv: 'GATEWAY_URL', headersEnv: ['Authorization: Bearer x'] } }, 'config-inline-header'],
    ['inherit bez potwierdzenia', { defaults: { child: null, unmarkedSubagent: 'inherit' } }, 'config-inherit-unacknowledged'],
    ['zły alias', { modelOverrides: { 'gateway/fast-worker': { alias: '9bad' } } }, 'config-alias-syntax'],
    ['zła nazwa roli', { roles: { explorer: { routeOverride: 'gateway/fast-worker' } } }, 'config-role-name'],
  ])('odrzuca: %s', (_name, patch, code) => {
    expectCode(() => parseOperatorConfig({ ...configFixture(), ...(patch as object) }), code);
  });
});

describe('parseSnapshot', () => {
  test('odrzuca duplikat ID', async () => {
    const snapshot = await snapshotFixture(['a', 'a']);
    expectCode(() => parseSnapshot(snapshot), 'snapshot-duplicate-id');
  });

  test('odrzuca nieznany status', async () => {
    const snapshot = await snapshotFixture(['a']);
    (snapshot.models[0] as { status: string }).status = 'gone';
    expectCode(() => parseSnapshot(snapshot), 'snapshot-schema');
  });
});
```

An environment variable name in `headersEnv` must match `^[A-Z][A-Z0-9_]*$`. Everything else is treated as an inline value. A role key must have the form `<client>:<name>` with a client from the `ClientId` set.

- [ ] **Step 2: Add skeletons and observe RED**

The `parseOperatorConfig` skeleton returns `value as OperatorConfig`; `parseSnapshot` returns `value as CatalogSnapshot`.

```bash
bun test ./tests/core/config.test.ts
```

Expected: the test "accepts a valid file" fails on `not.toBe` (the same object was returned), the rest fail on `toBeInstanceOf(RouterError)`.

- [ ] **Step 3: Implement the validator**

The validator is manual, without a schema library. Every error path has a fixed code. Check order: `version`, the set of allowed keys at each level, field types, semantic rules.

```ts
import { RouterError } from './errors';
import type { CatalogSnapshot, ClientId, OperatorConfig } from './types';

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const ALIAS = /^[A-Za-z][A-Za-z0-9_-]{0,126}$/;
const CLIENTS: readonly ClientId[] = ['claude-code', 'opencode', 'codex'];

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RouterError('config-schema', `${path} musi być obiektem`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new RouterError('config-unknown-field', `${path}.${key} nie jest znanym polem`);
    }
  }
}

function envNames(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new RouterError('config-schema', `${path} musi być tablicą`);
  return value.map((item) => {
    if (typeof item !== 'string' || !ENV_NAME.test(item)) {
      throw new RouterError('config-inline-header', `${path} może zawierać tylko nazwy zmiennych środowiskowych`);
    }
    return item;
  });
}

export function parseOperatorConfig(value: unknown): OperatorConfig {
  const root = record(value, 'config');
  if (root.version !== 1) throw new RouterError('config-version', 'obsługiwana jest tylko version 1');
  onlyKeys(root, ['version', 'modelSource', 'modelOverrides', 'roles', 'defaults', 'agentRoots', 'gateway', 'harness'], 'config');
  const source = record(root.modelSource, 'config.modelSource');
  onlyKeys(source, ['sourceId', 'baseUrlEnv', 'endpointPath', 'authEnv', 'headersEnv', 'timeoutMs', 'fetchLimit', 'staleAfterSeconds'], 'config.modelSource');
  const overrides = record(root.modelOverrides, 'config.modelOverrides');
  for (const [id, raw] of Object.entries(overrides)) {
    const override = record(raw, `config.modelOverrides.${id}`);
    onlyKeys(override, ['alias', 'description', 'enabled', 'clientModel'], `config.modelOverrides.${id}`);
    if (override.alias !== undefined && (typeof override.alias !== 'string' || !ALIAS.test(override.alias))) {
      throw new RouterError('config-alias-syntax', `alias modelu ${id} nie spełnia gramatyki markera`);
    }
  }
  const roles = record(root.roles, 'config.roles');
  for (const key of Object.keys(roles)) {
    const [client] = key.split(':');
    if (!key.includes(':') || !CLIENTS.includes(client as ClientId)) {
      throw new RouterError('config-role-name', `rola ${key} musi mieć postać <client>:<name>`);
    }
  }
  const defaults = record(root.defaults, 'config.defaults');
  if (defaults.unmarkedSubagent === 'inherit' && defaults.unmarkedSubagentAcknowledged !== true) {
    throw new RouterError('config-inherit-unacknowledged', 'inherit wymaga unmarkedSubagentAcknowledged: true');
  }
  const gateway = record(root.gateway, 'config.gateway');
  envNames(gateway.headersEnv, 'config.gateway.headersEnv');
  envNames(source.headersEnv, 'config.modelSource.headersEnv');
  return structuredClone(root) as unknown as OperatorConfig;
}

export function parseSnapshot(value: unknown): CatalogSnapshot {
  const root = record(value, 'snapshot');
  if (root.version !== 1) throw new RouterError('snapshot-version', 'obsługiwana jest tylko version 1');
  const models = Array.isArray(root.models) ? root.models : [];
  const seen = new Set<string>();
  for (const raw of models) {
    const model = record(raw, 'snapshot.models[]');
    if (typeof model.id !== 'string' || model.id.length === 0) throw new RouterError('snapshot-schema', 'id modelu musi być niepustym ciągiem');
    if (model.status !== 'available' && model.status !== 'missing') throw new RouterError('snapshot-schema', `status modelu ${model.id} jest nieznany`);
    if (seen.has(model.id)) throw new RouterError('snapshot-duplicate-id', `model ${model.id} występuje dwa razy`);
    seen.add(model.id);
  }
  return structuredClone(root) as unknown as CatalogSnapshot;
}
```

The fragment shows the shape; the implementer adds type checks for the remaining fields (`timeoutMs`, `fetchLimit`, `staleAfterSeconds` as positive integers, `agentRoots` with the full set of three clients, `harness` with the allowed values). Every missing check is a separate row in `test.each`.

- [ ] **Step 4: Observe GREEN and add the missing table rows**

```bash
bun test ./tests/core/config.test.ts
```

Expected: all rows pass. Add rows for `timeoutMs: 0`, a missing client in `agentRoots`, and `correlation: 'on'`; each must first fail, then pass.

- [ ] **Step 5: Write failing tests for the effective catalog**

```ts
import { describe, expect, test } from 'bun:test';
import { buildCatalog, resolveModel } from '../../src/core/catalog';
import { RouterError } from '../../src/core/errors';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

describe('buildCatalog', () => {
  test('nakładka nadpisuje alias, a model bez nakładki zachowuje alias m-', async () => {
    const snapshot = await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/other']);
    const catalog = buildCatalog(configFixture(), snapshot);
    expect(catalog.byAlias.get('fast')?.id).toBe(FIXTURE_MODEL_ID);
    expect(catalog.byId.get('gateway/other')?.alias).toBe(snapshot.models[1]?.alias);
    expect(catalog.byId.get('gateway/other')?.description).toBeUndefined();
  });

  test('nakładka dla ID spoza snapshotu nie tworzy modelu', async () => {
    const config = configFixture({ modelOverrides: { 'gateway/ghost': { description: 'x' } } });
    const catalog = buildCatalog(config, await snapshotFixture());
    expect(catalog.byId.has('gateway/ghost')).toBe(false);
  });

  test('missing w snapshotcie daje enabled false nawet z enabled true w nakładce', async () => {
    const snapshot = await snapshotFixture([FIXTURE_MODEL_ID]);
    (snapshot.models[0] as { status: string }).status = 'missing';
    const catalog = buildCatalog(configFixture(), snapshot);
    expect(catalog.byId.get(FIXTURE_MODEL_ID)?.enabled).toBe(false);
  });

  test('kolizja aliasu z ID innego modelu jest błędem', async () => {
    const config = configFixture({ modelOverrides: { 'gateway/a': { alias: 'gateway-b' } } });
    const snapshot = await snapshotFixture(['gateway/a', 'gateway-b']);
    expect(() => buildCatalog(config, snapshot)).toThrow(RouterError);
  });
});

describe('resolveModel', () => {
  test('rozwiązuje po dokładnym ID i po aliasie, ale nie po innej wielkości liter', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    expect(resolveModel(FIXTURE_MODEL_ID, catalog).id).toBe(FIXTURE_MODEL_ID);
    expect(resolveModel('fast', catalog).id).toBe(FIXTURE_MODEL_ID);
    expect(() => resolveModel('Fast', catalog)).toThrow(RouterError);
    expect(() => resolveModel('gateway/Fast-Worker', catalog)).toThrow(RouterError);
  });
});
```

- [ ] **Step 6: Skeleton, RED, implementation, GREEN**

The skeleton returns empty maps and throws `RouterError('unknown-model')`. Run `bun test ./tests/core/catalog.test.ts`, observe the assertion failures. Implementation: for every model in the snapshot, create a `ResolvedModel` with the overlay alias or the snapshot alias; `enabled` is `status === 'available' && (override.enabled ?? true)`; build `byAlias` checking that the alias does not collide with another alias or with any ID in the snapshot (`RouterError('config-alias-collision')`). `resolveModel` looks first in `byId`, then in `byAlias`, without normalization; no match throws `RouterError('unknown-model')`.

```bash
bun test ./tests/core/catalog.test.ts
```

Expected: 5 pass.

- [ ] **Step 7: Write a failing test for the source and the fingerprint**

```ts
import { describe, expect, test } from 'bun:test';
import { RouterError } from '../../src/core/errors';
import { resolveSource, validateSource } from '../../src/io/environment';
import { FIXTURE_GATEWAY_URL, configFixture, snapshotFixture } from '../support/fixtures';

const env = {
  GATEWAY_URL: `${FIXTURE_GATEWAY_URL}/`,
  GATEWAY_HEADERS: JSON.stringify({ 'X-Team': 'router' }),
  MODELS_AUTH: 'secret-token',
};

describe('resolveSource', () => {
  test('usuwa końcowy ukośnik, nie dokleja /v1 dwa razy i dodaje nagłówek auth', () => {
    const source = resolveSource(configFixture(), env);
    expect(source.effectiveGatewayUrl).toBe('http://127.0.0.1:8000/v1');
    expect(source.effectiveModelsUrl).toBe('http://127.0.0.1:8000/v1/models');
    expect(source.headers).toEqual({ 'X-Team': 'router', Authorization: 'Bearer secret-token' });
  });

  test.each([
    ['userinfo', 'http://user:pw@127.0.0.1:8000/v1'],
    ['query', 'http://127.0.0.1:8000/v1?x=1'],
    ['fragment', 'http://127.0.0.1:8000/v1#frag'],
  ])('odrzuca URL z %s', (_label, url) => {
    expect(() => resolveSource(configFixture(), { ...env, GATEWAY_URL: url })).toThrow(RouterError);
  });

  test('zduplikowana nazwa nagłówka niezależnie od wielkości liter jest błędem', () => {
    const headers = JSON.stringify({ authorization: 'x' });
    expect(() => resolveSource(configFixture(), { ...env, GATEWAY_HEADERS: headers })).toThrow(RouterError);
  });

  test('brak zmiennej z URL jest błędem z nazwą zmiennej, bez wartości', () => {
    let message = '';
    try {
      resolveSource(configFixture(), {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('GATEWAY_URL');
    expect(message).not.toContain('secret-token');
  });
});

describe('validateSource', () => {
  test('przyjmuje snapshot o zgodnym fingerprincie i odrzuca zmieniony endpoint', async () => {
    const snapshot = await snapshotFixture();
    await validateSource(resolveSource(configFixture(), env), snapshot);
    const moved = resolveSource(configFixture(), { ...env, GATEWAY_URL: 'http://127.0.0.1:9000/v1' });
    await expect(validateSource(moved, snapshot)).rejects.toBeInstanceOf(RouterError);
  });
});
```

- [ ] **Step 8: Skeleton, RED, implementation, GREEN**

Run `bun test ./tests/io/environment.test.ts` against the skeleton returning empty fields and observe the assertion failures. Implementation of `resolveSource`: read the URL from the `baseUrlEnv` variable, parse it with `new URL`, reject `username`, `password`, `search`, and `hash` with the code `source-url`; strip the trailing `/`; build `effectiveModelsUrl` from segments: if `endpointPath` starts with the last base segment (`/v1`), do not duplicate it. Headers: merge the JSON objects from all `headersEnv` entries, then `Authorization: Bearer <authEnv>`; a name collision compared with `toLowerCase()` throws `source-header-conflict`. `validateSource` compares `snapshot.sourceId` and `sourceFingerprint(sourceId, effectiveGatewayUrl, effectiveModelsUrl)` against the snapshot; a mismatch throws `snapshot-source-mismatch`.

```bash
bun test ./tests/io/environment.test.ts
```

Expected: 7 pass.

- [ ] **Step 9: Refactor and the full suite**

```bash
bun run typecheck && bun test
```

Expected: 0 fail. The core (`src/core`) imports nothing from `src/io`.

- [ ] **Step 10: Commit**

```bash
git add src/core/config.ts src/core/catalog.ts src/io/environment.ts tests/core tests/io
git commit -m "feat: validate operator config, snapshot and gateway source"
```

### Task 3: Deterministic routing decision

**Files:**
- Create: `src/core/route.ts`
- Test: `tests/core/route.test.ts`

**Interfaces:**
- Consumes: `RouteInput`, `RouteDecision`, `EffectiveCatalog`, `buildCatalog`, fixtures.
- Produces: `resolveRoute(input: RouteInput, config: OperatorConfig, catalog: EffectiveCatalog): RouteDecision`. A pure function: no state, no network, no clock.

- [ ] **Step 1: Write a failing table-driven test**

```ts
import { describe, expect, test } from 'bun:test';
import { buildCatalog } from '../../src/core/catalog';
import { resolveRoute } from '../../src/core/route';
import type { RouteDecision, RouteInput } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

const OTHER = 'gateway/other';

function child(patch: Partial<RouteInput>): RouteInput {
  return { client: 'claude-code', scope: 'child', explicitIds: [], freshDelegation: true, ignoredMarkers: 0, ...patch };
}

describe('resolveRoute', () => {
  const cases: Array<[string, RouteInput, RouteDecision]> = [
    ['rodzic bez markera', { client: 'claude-code', scope: 'parent', explicitIds: [], ignoredMarkers: 0 }, { kind: 'pass-through', reason: 'parent', ignoredMarkers: 0 }],
    ['rodzic z cytowanym markerem', { client: 'claude-code', scope: 'parent', explicitIds: [], ignoredMarkers: 2 }, { kind: 'pass-through', reason: 'parent', ignoredMarkers: 2 }],
    ['jawny wybór wygrywa z rolą', child({ explicitIds: [OTHER], roleDefaultId: FIXTURE_MODEL_ID }), { kind: 'route', upstreamModel: OTHER, source: 'explicit', ignoredMarkers: 0 }],
    ['rola bez jawnego wyboru', child({ role: 'claude-code:explorer', roleDefaultId: FIXTURE_MODEL_ID }), { kind: 'route', upstreamModel: FIXTURE_MODEL_ID, clientModel: 'haiku', source: 'role-default', ignoredMarkers: 0 }],
    ['korelacja bez markera', child({ correlatedId: OTHER }), { kind: 'route', upstreamModel: OTHER, source: 'correlated', ignoredMarkers: 0 }],
    ['korelacja wygrywa z domyślną trasą roli', child({ role: 'claude-code:explorer', roleDefaultId: FIXTURE_MODEL_ID, correlatedId: OTHER }), { kind: 'route', upstreamModel: OTHER, source: 'correlated', ignoredMarkers: 0 }],
    ['jawny wybór zgodny z korelacją', child({ explicitIds: [OTHER], correlatedId: OTHER }), { kind: 'route', upstreamModel: OTHER, source: 'explicit', ignoredMarkers: 0 }],
    ['jawny wybór sprzeczny z korelacją', child({ explicitIds: [FIXTURE_MODEL_ID], correlatedId: OTHER }), { kind: 'error', code: 'correlation-conflict', ignoredMarkers: 0 }],
    ['nieznany jawny model nie spada do roli', child({ explicitIds: ['gateway/none'], roleDefaultId: FIXTURE_MODEL_ID }), { kind: 'error', code: 'unknown-model', ignoredMarkers: 0 }],
    ['adapter oznacza nierozwiązany jawny token jako błąd przed defaultem', child({ explicitIds: [], explicitError: 'unknown-model', roleDefaultId: FIXTURE_MODEL_ID }), { kind: 'error', code: 'unknown-model', ignoredMarkers: 0 }],
    ['dwa różne jawne markery', child({ explicitIds: [OTHER, FIXTURE_MODEL_ID] }), { kind: 'error', code: 'conflicting-markers', ignoredMarkers: 0 }],
    ['niepoprawny marker w autoryzowanej pozycji', child({ markerError: 'invalid-marker', roleDefaultId: FIXTURE_MODEL_ID }), { kind: 'error', code: 'invalid-marker', ignoredMarkers: 0 }],
    ['dziecko bez wskazania mimo świeżej delegacji', child({}), { kind: 'error', code: 'missing-selection', ignoredMarkers: 0 }],
    ['brak dowodu świeżej delegacji nie stosuje role defaultu', child({ freshDelegation: false, roleDefaultId: FIXTURE_MODEL_ID }), { kind: 'error', code: 'missing-selection', ignoredMarkers: 0 }],
  ];

  test.each(cases)('%s', async (_name, input, expected) => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture([FIXTURE_MODEL_ID, OTHER]));
    expect(resolveRoute(input, configFixture(), catalog)).toEqual(expected);
  });

  test('globalny default działa tylko bez roli i bez jawnego wyboru', async () => {
    const config = configFixture({ defaults: { child: OTHER, unmarkedSubagent: 'error' } });
    const catalog = buildCatalog(config, await snapshotFixture([FIXTURE_MODEL_ID, OTHER]));
    expect(resolveRoute(child({}), config, catalog)).toEqual({ kind: 'route', upstreamModel: OTHER, source: 'global-default', ignoredMarkers: 0 });
  });

  test('inherit z potwierdzeniem przepuszcza dziecko bez wskazania', async () => {
    const config = configFixture({ defaults: { child: null, unmarkedSubagent: 'inherit', unmarkedSubagentAcknowledged: true } });
    const catalog = buildCatalog(config, await snapshotFixture());
    expect(resolveRoute(child({}), config, catalog)).toEqual({ kind: 'pass-through', reason: 'inherit-allowed', ignoredMarkers: 0 });
  });

  test('model missing albo wyłączony daje model-not-allowed bez fallbacku', async () => {
    const snapshot = await snapshotFixture([FIXTURE_MODEL_ID, OTHER]);
    (snapshot.models[1] as { status: string }).status = 'missing';
    const config = configFixture({ defaults: { child: FIXTURE_MODEL_ID, unmarkedSubagent: 'error' } });
    const catalog = buildCatalog(config, snapshot);
    expect(resolveRoute(child({ explicitIds: [OTHER] }), config, catalog)).toEqual({ kind: 'error', code: 'model-not-allowed', ignoredMarkers: 0 });
  });
});
```

The `clientModel` values in the result come from the model overlay, and `ignoredMarkers` is copied from the input unchanged. The `route` result contains `clientModel` only when the overlay defines it; `toEqual` ignores `undefined` fields.

- [ ] **Step 2: Skeleton and RED**

The skeleton always returns `{ kind: 'error', code: 'unsupported-path', ignoredMarkers: input.ignoredMarkers }`.

```bash
bun test ./tests/core/route.test.ts
```

Expected: every case fails on `toEqual`, without exception.

- [ ] **Step 3: Implement the decision order**

```ts
import { RouterError } from './errors';
import { resolveModel } from './catalog';
import type { EffectiveCatalog, OperatorConfig, ResolvedModel, RouteDecision, RouteInput } from './types';

function lookup(id: string, catalog: EffectiveCatalog): ResolvedModel | 'unknown' {
  try {
    return resolveModel(id, catalog);
  } catch (error) {
    if (error instanceof RouterError && error.code === 'unknown-model') return 'unknown';
    throw error;
  }
}

export function resolveRoute(input: RouteInput, config: OperatorConfig, catalog: EffectiveCatalog): RouteDecision {
  const ignoredMarkers = input.ignoredMarkers;
  if (input.scope === 'parent') return { kind: 'pass-through', reason: 'parent', ignoredMarkers };
  if (input.markerError) return { kind: 'error', code: input.markerError, ignoredMarkers };
  if (input.explicitError) return { kind: 'error', code: input.explicitError, ignoredMarkers };
  const explicit = [...new Set(input.explicitIds)];
  if (explicit.length > 1) return { kind: 'error', code: 'conflicting-markers', ignoredMarkers };

  const candidates: Array<[string, RouteDecision extends { source: infer S } ? S : never]> = [];
  if (explicit[0] !== undefined) candidates.push([explicit[0], 'explicit']);
  else if (input.correlatedId !== undefined) candidates.push([input.correlatedId, 'correlated']);
  else if (input.freshDelegation !== true) {
    if (config.defaults.unmarkedSubagent === 'inherit') return { kind: 'pass-through', reason: 'inherit-allowed', ignoredMarkers };
    return { kind: 'error', code: 'missing-selection', ignoredMarkers };
  }
  else if (input.roleDefaultId !== undefined) candidates.push([input.roleDefaultId, 'role-default']);
  else if (config.defaults.child !== null) candidates.push([config.defaults.child, 'global-default']);

  if (explicit[0] !== undefined && input.correlatedId !== undefined && input.correlatedId !== explicit[0]) {
    return { kind: 'error', code: 'correlation-conflict', ignoredMarkers };
  }
  const candidate = candidates[0];
  if (candidate === undefined) {
    if (config.defaults.unmarkedSubagent === 'inherit') return { kind: 'pass-through', reason: 'inherit-allowed', ignoredMarkers };
    return { kind: 'error', code: 'missing-selection', ignoredMarkers };
  }
  const model = lookup(candidate[0], catalog);
  if (model === 'unknown') return { kind: 'error', code: 'unknown-model', ignoredMarkers };
  if (!model.enabled) return { kind: 'error', code: 'model-not-allowed', ignoredMarkers };
  return {
    kind: 'route',
    upstreamModel: model.id,
    ...(model.clientModel !== undefined ? { clientModel: model.clientModel } : {}),
    source: candidate[1],
    ignoredMarkers,
  };
}
```

The implementer writes the `source` type in the candidates as the explicit alias `RouteSource`, to avoid a conditional type in production code. Correlation comes before role, because an existing child keeps its earlier decision; an explicit parent marker still takes precedence and detects the collision.

- [ ] **Step 4: GREEN and mutation**

```bash
bun test ./tests/core/route.test.ts
```

Expected: all described cases pass, 0 fail. Control mutation: swap the order of `correlated` and `role-default` in the implementation, rerun, and check that the case with role and correlation (`child({ role: 'claude-code:explorer', roleDefaultId: FIXTURE_MODEL_ID, correlatedId: OTHER })`, expecting `correlated`) fails. Restore the order.

- [ ] **Step 5: Commit**

```bash
git add src/core/route.ts tests/core/route.test.ts
git commit -m "feat: add deterministic route decision"
```

### Task 4: Atomic write of the config/snapshot pair with conflict detection

**Files:**
- Create: `src/io/store.ts`
- Test: `tests/io/store.test.ts`

**Interfaces:**
- Consumes: `parseOperatorConfig`, `parseSnapshot`, `sha256`, the `LoadedState` types.
- Produces: `loadState(configPath: string): Promise<LoadedState>`, `commitState(configPath: string, base: LoadedState, change: { config?: OperatorConfig; snapshot?: CatalogSnapshot }): Promise<void>`, `snapshotPathFor(configPath: string): string`.

Rules: the snapshot sits next to the config as `models.lock.json`; `generation` is `sha256(configHash + ':' + (snapshotHash ?? 'none'))`; `commitState` with both `config` and `snapshot` at once throws `store-single-file`; before writing, under the `<config>.lock` lock (created with the `wx` flag), it recomputes the hashes of both files and compares them against `base.expected`; a difference throws `store-conflict`; the write goes to a temporary file in the same directory, then `rename`. An external process without the lock is detected only by comparing hashes; the plan promises nothing more.

- [ ] **Step 1: Napisz failing testy**

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouterError } from '../../src/core/errors';
import { commitState, loadState, snapshotPathFor } from '../../src/io/store';
import { configFixture, snapshotFixture } from '../support/fixtures';

let dir = '';
let configPath = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-store-'));
  configPath = join(dir, 'subagent-router.json');
  await writeFile(configPath, JSON.stringify(configFixture()));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('store', () => {
  test('loadState bez snapshotu zwraca snapshotHash null i stabilną generację', async () => {
    const first = await loadState(configPath);
    const second = await loadState(configPath);
    expect(first.snapshot).toBeUndefined();
    expect(first.expected.snapshotHash).toBeNull();
    expect(first.generation).toBe(second.generation);
  });

  test('commitState zapisuje snapshot obok configu i zmienia generację', async () => {
    const base = await loadState(configPath);
    await commitState(configPath, base, { snapshot: await snapshotFixture() });
    const after = await loadState(configPath);
    expect(JSON.parse(await readFile(snapshotPathFor(configPath), 'utf8')).sourceId).toBe('test-gateway');
    expect(after.generation).not.toBe(base.generation);
  });

  test('równoległa edycja configu jest odrzucona bez nadpisania', async () => {
    const base = await loadState(configPath);
    const foreign = configFixture({ defaults: { child: null, unmarkedSubagent: 'error' } });
    foreign.modelOverrides['gateway/fast-worker'] = { description: 'zmiana z zewnątrz' };
    await writeFile(configPath, JSON.stringify(foreign));
    const mine = configFixture();
    mine.modelOverrides['gateway/fast-worker'] = { description: 'moja zmiana' };
    await expect(commitState(configPath, base, { config: mine })).rejects.toMatchObject({ code: 'store-conflict' });
    expect(JSON.parse(await readFile(configPath, 'utf8')).modelOverrides['gateway/fast-worker'].description).toBe('zmiana z zewnątrz');
  });

  test('zmiana obu plików naraz jest odrzucona', async () => {
    const base = await loadState(configPath);
    await expect(commitState(configPath, base, { config: configFixture(), snapshot: await snapshotFixture() })).rejects.toMatchObject({ code: 'store-single-file' });
  });

  test('błędny snapshot na dysku daje RouterError z kodem, nie wyjątek JSON', async () => {
    await writeFile(snapshotPathFor(configPath), '{broken');
    await expect(loadState(configPath)).rejects.toBeInstanceOf(RouterError);
  });

  test('nieudany zapis nie zostawia pliku tymczasowego', async () => {
    const base = await loadState(configPath);
    await writeFile(configPath, JSON.stringify(configFixture({ version: 1 })) + ' ');
    await expect(commitState(configPath, base, { config: configFixture() })).rejects.toMatchObject({ code: 'store-conflict' });
    const entries = (await import('node:fs/promises')).readdir(dir);
    expect((await entries).filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Skeleton and RED**

Skeleton: `loadState` reads the config without a snapshot and returns `generation: ''`; `commitState` does nothing.

```bash
bun test ./tests/io/store.test.ts
```

Expected: failures on `not.toBe`, `rejects`, and the file read.

- [ ] **Step 3: Implement the store**

```ts
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseOperatorConfig, parseSnapshot } from '../core/config';
import { RouterError } from '../core/errors';
import { sha256 } from '../core/hash';
import type { CatalogSnapshot, LoadedState, OperatorConfig } from '../core/types';

export function snapshotPathFor(configPath: string): string {
  return join(dirname(configPath), 'models.lock.json');
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parseJson(text: string, code: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new RouterError(code, 'plik nie jest poprawnym JSON');
  }
}

async function hashes(configPath: string): Promise<{ configText: string; snapshotText: string | null; configHash: string; snapshotHash: string | null }> {
  const configText = await readOptional(configPath);
  if (configText === null) throw new RouterError('config-missing', `brak pliku ${configPath}`);
  const snapshotText = await readOptional(snapshotPathFor(configPath));
  return {
    configText,
    snapshotText,
    configHash: await sha256(configText),
    snapshotHash: snapshotText === null ? null : await sha256(snapshotText),
  };
}

export async function loadState(configPath: string): Promise<LoadedState> {
  const current = await hashes(configPath);
  const config = parseOperatorConfig(parseJson(current.configText, 'config-json'));
  const snapshot = current.snapshotText === null ? undefined : parseSnapshot(parseJson(current.snapshotText, 'snapshot-json'));
  const generation = await sha256(`${current.configHash}:${current.snapshotHash ?? 'none'}`);
  return { config, ...(snapshot ? { snapshot } : {}), expected: { configHash: current.configHash, snapshotHash: current.snapshotHash }, generation };
}

async function withLock<T>(configPath: string, work: () => Promise<T>): Promise<T> {
  const lockPath = `${configPath}.lock`;
  const handle = await open(lockPath, 'wx').catch(() => {
    throw new RouterError('store-locked', 'inny proces trzyma blokadę zapisu');
  });
  try {
    return await work();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

export async function commitState(
  configPath: string,
  base: LoadedState,
  change: { config?: OperatorConfig; snapshot?: CatalogSnapshot },
): Promise<void> {
  if (change.config !== undefined && change.snapshot !== undefined) throw new RouterError('store-single-file', 'zapisz config albo snapshot, nie oba');
  if (change.config === undefined && change.snapshot === undefined) throw new RouterError('store-empty-change', 'brak zmiany do zapisania');
  await withLock(configPath, async () => {
    const current = await hashes(configPath);
    if (current.configHash !== base.expected.configHash || current.snapshotHash !== base.expected.snapshotHash) {
      throw new RouterError('store-conflict', 'pliki zmieniły się od odczytu; odczytaj ponownie');
    }
    const target = change.config !== undefined ? configPath : snapshotPathFor(configPath);
    const payload = JSON.stringify(change.config ?? change.snapshot, null, 2) + '\n';
    const temp = `${target}.${process.pid}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(temp, payload, { flag: 'wx' });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
  });
}
```

Validating the new value through `parseOperatorConfig` or `parseSnapshot` before the write is mandatory; the implementer adds it at the start of `commitState`, plus a test where an invalid snapshot does not get written.

- [ ] **Step 4: GREEN**

```bash
bun test ./tests/io/store.test.ts
```

Expected: 6 pass, no `.tmp` or `.lock` files left after the tests.

- [ ] **Step 5: Commit**

```bash
git add src/io/store.ts tests/io/store.test.ts
git commit -m "feat: add atomic state store with conflict detection"
```

### Task 5: Catalog discovery and snapshot synchronization

**Files:**
- Create: `src/catalog/discovery.ts`
- Create: `src/catalog/sync.ts`
- Test: `tests/catalog/discovery.test.ts`
- Test: `tests/catalog/sync.test.ts`

**Interfaces:**
- Consumes: `resolveSource`, `validateSource`, `loadState`, `commitState`, `modelAlias`, `sourceFingerprint`, `FetchLike`.
- Produces: `discoverModels(config: OperatorConfig, source: SourceContext, fetcher: FetchLike, signal?: AbortSignal): Promise<readonly { id: string; displayName?: string }[]>`, `synchronize(configPath: string, deps: { env: Env; fetch: FetchLike; now: () => Date; allowEmpty: boolean; dryRun: boolean }): Promise<SyncResult>`.

Response contract: `{"data":[{"id":"...","display_name"?:"..."}],"has_more"?:boolean,"next_cursor"?:string}`. The next page is the same URL with a `cursor` parameter. A response without `has_more` means the full list.

- [ ] **Step 1: Write failing discovery tests with a fake fetch**

```ts
import { describe, expect, test } from 'bun:test';
import { discoverModels } from '../../src/catalog/discovery';
import { RouterError } from '../../src/core/errors';
import type { FetchLike } from '../../src/core/types';
import { resolveSource } from '../../src/io/environment';
import { configFixture } from '../support/fixtures';

const env = { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 'secret-token' };

function fakeFetch(pages: Record<string, unknown>, init: ResponseInit = {}): { fetch: FetchLike; calls: Request[] } {
  const calls: Request[] = [];
  const fetch: FetchLike = async (request) => {
    calls.push(request);
    const cursor = new URL(request.url).searchParams.get('cursor') ?? 'first';
    const body = pages[cursor];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init });
  };
  return { fetch, calls };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'no-error';
  } catch (error) {
    return error instanceof RouterError ? error.code : 'other';
  }
}

describe('discoverModels', () => {
  test('pozytywna kontrola: dwie strony z kursorem dają pełną listę w kolejności', async () => {
    const { fetch, calls } = fakeFetch({
      first: { data: [{ id: 'a', display_name: 'A' }], has_more: true, next_cursor: 'p2' },
      p2: { data: [{ id: 'b' }], has_more: false },
    });
    const models = await discoverModels(configFixture(), resolveSource(configFixture(), env), fetch);
    expect(models).toEqual([{ id: 'a', displayName: 'A' }, { id: 'b' }]);
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer secret-token');
    expect(new URL(calls[1]?.url ?? '').searchParams.get('cursor')).toBe('p2');
  });

  test.each([
    ['zły schemat', { first: { models: [] } }, 'discovery-schema'],
    ['puste id', { first: { data: [{ id: '' }] } }, 'discovery-schema'],
    ['duplikat', { first: { data: [{ id: 'a' }, { id: 'a' }] } }, 'discovery-duplicate'],
    ['has_more bez kursora', { first: { data: [{ id: 'a' }], has_more: true } }, 'discovery-pagination'],
    ['cykl kursora', { first: { data: [{ id: 'a' }], has_more: true, next_cursor: 'first' } }, 'discovery-pagination'],
    ['malformed JSON', { first: '{broken' }, 'discovery-json'],
  ])('odrzuca: %s', async (_name, pages, code) => {
    const { fetch } = fakeFetch(pages as Record<string, unknown>);
    expect(await codeOf(discoverModels(configFixture(), resolveSource(configFixture(), env), fetch))).toBe(code);
  });

  test('auth failure daje discovery-auth bez treści nagłówka w komunikacie', async () => {
    const { fetch } = fakeFetch({ first: { data: [] } }, { status: 401 });
    let message = '';
    try {
      await discoverModels(configFixture(), resolveSource(configFixture(), env), fetch);
    } catch (error) {
      message = `${(error as RouterError).code}:${(error as Error).message}`;
    }
    expect(message.startsWith('discovery-auth:')).toBe(true);
    expect(message).not.toContain('secret-token');
  });

  test('przekroczony fetchLimit jest błędem', async () => {
    const config = configFixture({ modelSource: { ...configFixture().modelSource, fetchLimit: 1 } });
    const { fetch } = fakeFetch({ first: { data: [{ id: 'a' }, { id: 'b' }] } });
    expect(await codeOf(discoverModels(config, resolveSource(config, env), fetch))).toBe('discovery-limit');
  });

  test('redirect na inny origin nie jest śledzony z credentials', async () => {
    const calls: Request[] = [];
    const fetch: FetchLike = async (request) => {
      calls.push(request);
      return new Response(null, { status: 302, headers: { location: 'http://evil.example/v1/models' } });
    };
    expect(await codeOf(discoverModels(configFixture(), resolveSource(configFixture(), env), fetch))).toBe('discovery-redirect');
    expect(calls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Skeleton and RED**

The skeleton returns `[]`. Run `bun test ./tests/catalog/discovery.test.ts`. Expected: failures on the `toEqual` and `toBe` assertions.

- [ ] **Step 3: Implement discovery**

Implementation requirements: `Request` created with `redirect: 'manual'`; a 3xx status is `discovery-redirect` regardless of the target (the plan does not follow redirects); 401 and 403 are `discovery-auth`; other non-2xx statuses are `discovery-http`; a timeout via `AbortSignal.timeout(config.modelSource.timeoutMs)` combined with the optional `signal`; the model count on each page is compared against `fetchLimit`; the set of visited cursors detects a cycle; `display_name` maps to `displayName` only if it is a non-empty string. The response does not control the URL or headers: the cursor goes only into the `cursor` parameter on `effectiveModelsUrl`.

- [ ] **Step 4: GREEN**

```bash
bun test ./tests/catalog/discovery.test.ts
```

Expected: 10 pass.

- [ ] **Step 5: Write failing synchronization tests**

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synchronize } from '../../src/catalog/sync';
import { sha256 } from '../../src/core/hash';
import type { FetchLike } from '../../src/core/types';
import { snapshotPathFor } from '../../src/io/store';
import { configFixture } from '../support/fixtures';

const env = { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 'secret-token' };
const now = () => new Date('2026-09-06T12:00:00.000Z');

function listing(ids: string[]): FetchLike {
  return async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
}

let dir = '';
let configPath = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-sync-'));
  configPath = join(dir, 'subagent-router.json');
  await writeFile(configPath, JSON.stringify(configFixture()));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('synchronize', () => {
  test('pierwszy sync zapisuje snapshot z fingerprintem i fetchedAt', async () => {
    const result = await synchronize(configPath, { env, fetch: listing(['gateway/fast-worker']), now, allowEmpty: false, dryRun: false });
    expect(result.added).toEqual(['gateway/fast-worker']);
    const saved = JSON.parse(await readFile(snapshotPathFor(configPath), 'utf8'));
    expect(saved.fetchedAt).toBe('2026-09-06T12:00:00.000Z');
    expect(saved.sourceId).toBe('test-gateway');
    expect(saved.models[0].alias.startsWith('m-')).toBe(true);
  });

  test('zniknięty model zostaje jako missing, powrót przywraca available', async () => {
    await synchronize(configPath, { env, fetch: listing(['a', 'b']), now, allowEmpty: false, dryRun: false });
    const second = await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    expect(second.missing).toEqual(['b']);
    expect(second.snapshot.models.find((m) => m.id === 'b')?.status).toBe('missing');
    const third = await synchronize(configPath, { env, fetch: listing(['a', 'b']), now, allowEmpty: false, dryRun: false });
    expect(third.changed).toEqual(['b']);
    expect(third.snapshot.models.find((m) => m.id === 'b')?.status).toBe('available');
  });

  test('dry-run raportuje diff i nie zmienia hashy plików', async () => {
    await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    const before = await sha256(await readFile(snapshotPathFor(configPath), 'utf8'));
    const result = await synchronize(configPath, { env, fetch: listing(['a', 'c']), now, allowEmpty: false, dryRun: true });
    expect(result.added).toEqual(['c']);
    expect(await sha256(await readFile(snapshotPathFor(configPath), 'utf8'))).toBe(before);
  });

  test('nieudany fetch zachowuje poprzedni snapshot bajt w bajt', async () => {
    await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    const before = await readFile(snapshotPathFor(configPath), 'utf8');
    const failing: FetchLike = async () => new Response('{broken', { status: 200 });
    await expect(synchronize(configPath, { env, fetch: failing, now, allowEmpty: false, dryRun: false })).rejects.toMatchObject({ code: 'discovery-json' });
    expect(await readFile(snapshotPathFor(configPath), 'utf8')).toBe(before);
  });

  test('pusta lista wymaga allowEmpty i nie usuwa wcześniejszych wpisów', async () => {
    await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    await expect(synchronize(configPath, { env, fetch: listing([]), now, allowEmpty: false, dryRun: false })).rejects.toMatchObject({ code: 'sync-empty' });
    const result = await synchronize(configPath, { env, fetch: listing([]), now, allowEmpty: true, dryRun: false });
    expect(result.snapshot.models.map((m) => [m.id, m.status])).toEqual([['a', 'missing']]);
  });

  test('sync nie zmienia pliku operatora', async () => {
    const before = await readFile(configPath, 'utf8');
    await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  test('zmiana endpointu przy tym samym sourceId odrzuca stary snapshot poza sync', async () => {
    await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    const moved = { ...env, GATEWAY_URL: 'http://127.0.0.1:9000/v1' };
    const result = await synchronize(configPath, { env: moved, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    expect(result.snapshot.sourceFingerprint).not.toBe((await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: true })).snapshot.sourceFingerprint);
  });
});
```

- [ ] **Step 6: Skeleton and RED**

The skeleton returns `{ snapshot: { version: 1, sourceId: '', sourceFingerprint: '', fetchedAt: '', models: [] }, added: [], changed: [], missing: [] }` without writing. Run `bun test ./tests/catalog/sync.test.ts`, and observe `toEqual` failures and the missing snapshot file.

- [ ] **Step 7: Implement synchronization**

Implementation steps: `loadState`; `resolveSource`; `discoverModels`; if the list is empty and `!allowEmpty`, throw `sync-empty`; the new snapshot: for each fetched ID, `status: 'available'` with alias `modelAlias(id)` and metadata `{ displayName }` when provided; for an ID from the previous snapshot absent from the list, `status: 'missing'` with the metadata preserved; `added` is IDs absent before, `changed` is IDs with a changed status or `displayName`, `missing` is IDs that just transitioned to `missing`; sort the lists alphabetically by code unit (`localeCompare` with `'en'`, `{ sensitivity: 'variant' }` is forbidden, use `<` comparison), `fetchedAt` from `now().toISOString()`, `sourceFingerprint` computed from the source; on `dryRun` return the result without `commitState`; otherwise `commitState(configPath, state, { snapshot })`. Do not touch overlays, since they live in the config.

- [ ] **Step 8: GREEN and the full suite**

```bash
bun test ./tests/catalog/sync.test.ts && bun run typecheck && bun test
```

Expected: 7 pass in the file, 0 fail globally.

- [ ] **Step 9: Commit**

```bash
git add src/catalog tests/catalog
git commit -m "feat: add model discovery and snapshot synchronization"
```

### Task 6: Inventory of native agent definitions without file edits

**Files:**
- Create: `src/agents/inventory.ts`
- Create: `src/agents/claude-code.ts`
- Create: `src/agents/opencode.ts`
- Create: `src/agents/codex.ts`
- Create: `tests/fixtures/agents/claude-code/project/.claude/agents/reviewer.md`
- Create: `tests/fixtures/agents/claude-code/home/.claude/agents/reviewer.md`
- Create: `tests/fixtures/agents/claude-code/home/.claude/agents/explorer.md`
- Create: `tests/fixtures/agents/opencode/project/opencode.json`
- Create: `tests/fixtures/agents/opencode/project/.opencode/agents/planner.md`
- Create: `tests/fixtures/agents/codex/home/.codex/agents/reviewer.toml`
- Test: `tests/agents/inventory.test.ts`

**Interfaces:**
- Consumes: the `AgentDefinition`, `AgentInventory`, `ResolverOptions`, `RouterError` types.
- Produces: `readAgentInventory(client: ClientId, options: ResolverOptions): Promise<AgentInventory>`, `getAgent(inventory: AgentInventory, name: string): AgentDefinition`. The YAML and TOML parsers live only in this layer and use `Bun.YAML.parse` and `Bun.TOML.parse`, measured locally on Bun 1.3.11. The core never imports this layer.

Rules: the scan is `files-only` unless the caller passed `nativeInventory`; then the result has `completeness: 'native'` and roles without a file get `availability: 'fileless'`. The directory order recorded in this task is a declaration to confirm in the Task 7 M-probe, not a truth about the harness: for Claude Code, the project entry `.claude/agents` shadows the entry from the config directory (`CLAUDE_CONFIG_DIR`, then `configRoot`, then `~/.claude`); for OpenCode, the file `.opencode/agents/*.md` shadows the `agent` block in `opencode.json`; for Codex, only the `agents` directories under `~/.codex` and `.codex`. The effective name is the `name` from the frontmatter, or the file name without extension. A shadowed entry stays in the inventory with `shadowed: true`.

- [ ] **Step 1: Create the fixtures**

`tests/fixtures/agents/claude-code/home/.claude/agents/reviewer.md`:

```markdown
---
name: reviewer
description: Przegląd kodu z katalogu domowego.
model: inherit
---
Sprawdzaj regresje.
```

`tests/fixtures/agents/claude-code/project/.claude/agents/reviewer.md` has `model: sonnet` and the content "Project version." `explorer.md` in the home directory has `name: file-explorer` and `model: haiku`, which checks an effective name different from the file name. `opencode.json` contains `{"agent":{"planner":{"model":"gateway/base","mode":"subagent","hidden":true}}}`, and `planner.md` under `.opencode/agents` has the frontmatter `model: gateway/from-file`. Codex's `reviewer.toml` contains `name = "reviewer"` and `model = "gateway/base"`.

- [ ] **Step 2: Napisz failing testy**

```ts
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAgent, readAgentInventory } from '../../src/agents/inventory';
import { RouterError } from '../../src/core/errors';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'agents');

async function treeHash(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const entry of (await readdir(root, { recursive: true, withFileTypes: true })).filter((e) => e.isFile())) {
    const path = join(entry.parentPath ?? entry.path, entry.name);
    hash.update(path).update(await readFile(path));
  }
  return hash.digest('hex');
}

describe('readAgentInventory claude-code', () => {
  const options = {
    cwd: join(FIXTURES, 'claude-code', 'project'),
    home: join(FIXTURES, 'claude-code', 'home'),
    env: {},
    additionalRoots: [],
  };

  test('wpis projektowy przesłania domowy, a inherit jest zachowane w declaredModel', async () => {
    const inventory = await readAgentInventory('claude-code', options);
    const reviewer = getAgent(inventory, 'reviewer');
    expect(reviewer.declaredModel).toBe('sonnet');
    expect(reviewer.scope).toBe('project');
    const shadowed = inventory.entries.filter((e) => e.name === 'reviewer' && e.shadowed);
    expect(shadowed.map((e) => e.declaredModel)).toEqual(['inherit']);
    expect(inventory.completeness).toBe('files-only');
  });

  test('nazwa efektywna pochodzi z frontmatteru, nie z nazwy pliku', async () => {
    const inventory = await readAgentInventory('claude-code', options);
    expect(getAgent(inventory, 'file-explorer').path?.endsWith('explorer.md')).toBe(true);
    expect(() => getAgent(inventory, 'explorer')).toThrow(RouterError);
  });

  test('CLAUDE_CONFIG_DIR zastępuje katalog domowy', async () => {
    const inventory = await readAgentInventory('claude-code', { ...options, env: { CLAUDE_CONFIG_DIR: join(FIXTURES, 'empty-config') } });
    expect(inventory.entries.some((e) => e.name === 'file-explorer')).toBe(false);
  });

  test('nativeInventory dodaje role fileless bez usuwania plików', async () => {
    const native = { entries: [{ client: 'claude-code' as const, name: 'Explore', scope: 'builtin', hidden: false, native: {}, availability: 'fileless' as const, shadowed: false }], completeness: 'native' as const, diagnostics: [] };
    const inventory = await readAgentInventory('claude-code', { ...options, nativeInventory: native });
    expect(inventory.completeness).toBe('native');
    expect(getAgent(inventory, 'Explore').availability).toBe('fileless');
    expect(getAgent(inventory, 'reviewer').availability).toBe('available');
  });

  test('odczyt nie zmienia żadnego pliku fixture', async () => {
    const before = await treeHash(FIXTURES);
    await readAgentInventory('claude-code', options);
    await readAgentInventory('opencode', { ...options, cwd: join(FIXTURES, 'opencode', 'project'), home: join(FIXTURES, 'opencode', 'home') });
    await readAgentInventory('codex', { ...options, cwd: join(FIXTURES, 'codex', 'project'), home: join(FIXTURES, 'codex', 'home') });
    expect(await treeHash(FIXTURES)).toBe(before);
  });
});

describe('readAgentInventory opencode i codex', () => {
  test('plik Markdown przesłania blok agent z opencode.json i zachowuje hidden', async () => {
    const inventory = await readAgentInventory('opencode', { cwd: join(FIXTURES, 'opencode', 'project'), home: join(FIXTURES, 'opencode', 'home'), env: {}, additionalRoots: [] });
    const planner = getAgent(inventory, 'planner');
    expect(planner.declaredModel).toBe('gateway/from-file');
    expect(inventory.entries.find((e) => e.name === 'planner' && e.shadowed)?.hidden).toBe(true);
  });

  test('rola Codex z TOML ma model i ścieżkę', async () => {
    const inventory = await readAgentInventory('codex', { cwd: join(FIXTURES, 'codex', 'project'), home: join(FIXTURES, 'codex', 'home'), env: {}, additionalRoots: [] });
    expect(getAgent(inventory, 'reviewer').declaredModel).toBe('gateway/base');
  });

  test('additionalRoots jest tylko dodatkowym źródłem odczytu', async () => {
    const inventory = await readAgentInventory('codex', { cwd: join(FIXTURES, 'empty-config'), home: join(FIXTURES, 'empty-config'), env: {}, additionalRoots: [join(FIXTURES, 'codex', 'home', '.codex', 'agents')] });
    expect(getAgent(inventory, 'reviewer').scope).toBe('additional');
  });
});
```

The directory `tests/fixtures/agents/empty-config` contains only a `.keep` file.

- [ ] **Step 3: Skeleton and RED**

The skeleton returns `{ entries: [], completeness: 'files-only', diagnostics: [] }`, and `getAgent` throws `RouterError('agent-unknown')`.

```bash
bun test ./tests/agents/inventory.test.ts
```

Expected: all tests except "read does not modify any file" fail on assertions.

- [ ] **Step 4: Implement the parsers and merging**

`src/agents/claude-code.ts` exports `readClaudeAgents(options): Promise<AgentDefinition[]>`: it enumerates roots in the order `[cwd/.claude/agents (scope 'project'), env.CLAUDE_CONFIG_DIR/agents or configRoot/agents or home/.claude/agents (scope 'user'), ...additionalRoots (scope 'additional')]`, reads `*.md` files, splits the `---` frontmatter and parses it through `Bun.YAML.parse`, and builds an `AgentDefinition` with `native` equal to the parsed frontmatter and `body` equal to the content. `src/agents/opencode.ts` reads `opencode.json` from `cwd` and `home/.config/opencode`, the `agent` field, plus the files `.opencode/agents/*.md` and `home/.config/opencode/agents/*.md`. `src/agents/codex.ts` reads `*.toml` from `cwd/.codex/agents` and `home/.codex/agents` through `Bun.TOML.parse`. `src/agents/inventory.ts` merges: the first definition of a given name in root order is effective, later ones get `shadowed: true`; if `nativeInventory` exists, its entries without a matching file are appended as `fileless`, and `completeness` becomes `'native'`. `getAgent` returns the effective entry or throws `agent-unknown` with the name.

- [ ] **Step 5: GREEN**

```bash
bun test ./tests/agents/inventory.test.ts
```

Expected: 8 pass, fixture hash unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/agents/inventory.ts src/agents/claude-code.ts src/agents/opencode.ts src/agents/codex.ts tests/agents tests/fixtures/agents
git commit -m "feat: read native agent definitions read-only"
```

### Task 7: Capture gateway, harness probes, and capability profiles

**Files:**
- Create: `tests/support/capture-gateway.ts`
- Create: `tests/probes/run.ts`
- Create: `tests/probes/evidence.test.ts`
- Create: `src/adapters/capabilities.ts`
- Create: `tests/fixtures/capabilities/claude-code-2.1.263.json`
- Create: `tests/fixtures/capabilities/opencode-1.18.29.json`
- Create: `tests/fixtures/capabilities/codex-pending.json`
- Create: `tests/fixtures/capabilities/transport-bun-fetch-1.3.11.json`
- Test: `tests/adapters/capabilities.test.ts`

**Interfaces:**
- Consumes: the `CapabilityProfile` type, `RouterError`.
- Produces: `startCaptureGateway(): Promise<{ url: string; requests: CapturedRequest[]; close: () => Promise<void> }>` with `CapturedRequest { method: string; path: string; headers: Record<string, string>; rawRequestBody: Uint8Array; model?: string; agentId?: string; isChild?: boolean; body: unknown }`; `assertCapability(profile: CapabilityProfile, gate: CapabilityGate, context: TrustedLifecycleContext): void`; `loadCapabilityProfile(client: ClientId, version: string, fixturesDir: string): Promise<CapabilityProfile>`; `loadTransportCapabilityProfile(adapterId: string, runtimeVersion: string, fixturesDir: string): Promise<TransportCapabilityProfile>`.

The starting profile for each client has `status: 'pending'`, all probes `pending`, `correlationEntropy: 'pending'`, and a separate state for each lifecycle transition. Changing a production version to `supported` happens only by recording a probe result from `tests/probes/run.ts`, run manually against the real harness in an isolated config directory, with the capture gateway as the target. The result recorded in the fixture contains the binary version, the date, the model from the gateway, the marker position, and identifiers, without prompt content. Hermetic tests in later tasks get a separate, explicitly synthetic `FIXTURE_SUPPORTED_PROFILE` profile through dependency injection, and do not record it as evidence of the production version. The profile status is not a shortcut for every function: each gate checks the client, the right measurement, and the right lifecycle, fail-closed.

`TrustedLifecycleContext` can be constructed only in the native harness context adapter. It is never built from the prompt, `tool_input`, `args`, history, or a tool result. When no phase is recognized, `lifecyclePhase` is left as `undefined`. `NativeConfigWitness` likewise comes from a supplied, authoritative native resolver, not from files-only inventory, a sidecar, or a value declared by the caller without an M6-runtime or M7 measurement. The fixture for these contracts is marked as synthetic and tests the data flow, not runtime proof.

- [ ] **Step 1: Write a failing capture gateway test**

```ts
import { describe, expect, test } from 'bun:test';
import { startCaptureGateway } from '../support/capture-gateway';

describe('capture gateway', () => {
  test('rejestruje model, nagłówek agenta i marker dziecka z body', async () => {
    const gateway = await startCaptureGateway();
    try {
      const response = await fetch(`${gateway.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-claude-code-agent-id': 'agent-1' },
        body: JSON.stringify({
          model: 'gateway/fast-worker',
          system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }],
          messages: [{ role: 'user', content: 'hej' }],
        }),
      });
      expect(response.status).toBe(200);
      expect(gateway.requests).toHaveLength(1);
      expect(gateway.requests[0]).toMatchObject({ path: '/v1/messages', model: 'gateway/fast-worker', agentId: 'agent-1', isChild: true });
    } finally {
      await gateway.close();
    }
  });

  test('odpowiada poprawnym strumieniem SSE, który klient może zdekodować', async () => {
    const gateway = await startCaptureGateway();
    try {
      const response = await fetch(`${gateway.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [] }) });
      const text = await response.text();
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(text).toContain('event: message_stop');
    } finally {
      await gateway.close();
    }
  });

  test('scripted fixture emituje tool_use, potem odbija tylko matching tool_result nonce', async () => {
    const gateway = await startCaptureGateway();
    try {
      const first = await fetch(`${gateway.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'm', tools: [{ name: 'read_fixture', input_schema: { type: 'object' } }], messages: [] }) });
      const started = await first.json() as { content: Array<{ type: string; id?: string }> };
      const toolUseId = started.content.find((part) => part.type === 'tool_use')?.id;
      const nonce = 'fixture-file-nonce-7c10';
      const second = await fetch(`${gateway.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: nonce }] }] }) });
      expect(JSON.stringify(await second.json())).toContain(nonce);
    } finally {
      await gateway.close();
    }
  });
});
```

- [ ] **Step 2: Skeleton and RED**

The skeleton starts `Bun.serve` on port 0 and returns 404 for everything. Run `bun test ./tests/probes/evidence.test.ts`; expected failures on `toBe(200)` and `toHaveLength(1)`.

- [ ] **Step 3: Implement the gateway**

The gateway parses JSON, extracts `model`, the `x-claude-code-agent-id` header, detects `cc_is_subagent=true` in the first `system` block, records the request into an array, and returns a minimal valid Anthropic response or SSE with `message_start`, `content_block_delta`, `message_stop`. It has a deterministic test contract for the roundtrip: the first request containing the `read_fixture` fixture tool gets a scripted `tool_use`; the second request gets a text block containing only the last synthetic `tool_result` tied to that `tool_use_id`, if its content has the expected fixture nonce format. It does not echo an arbitrary prompt or earlier results. This is a scripted response fixture, not a router model loop, and not proof of native tool execution. The gateway runs only on `127.0.0.1` and does not log content to disk.

- [ ] **Step 4: GREEN**

```bash
bun test ./tests/probes/evidence.test.ts
```

Expected: all described cases pass, 0 fail. This remains a planned result, not an executed one.

- [ ] **Step 5: Write a failing profiles test**

```ts
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { assertCapability, loadCapabilityProfile, loadTransportCapabilityProfile } from '../../src/adapters/capabilities';
import { RouterError } from '../../src/core/errors';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'capabilities');

const TRUSTED_NEXT = { lifecyclePhase: 'next-turn', freshDelegation: false } as const;
const TRUSTED_UNKNOWN = { freshDelegation: false } as const;

const ALL_LIFECYCLE_PASSED = {
  'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed',
} as const;

describe('capabilities', () => {
  test('profil pending odmawia każdej bramki runtime kodem unsupported-path', async () => {
    const profile = await loadCapabilityProfile('codex', 'pending', FIXTURES);
    for (const gate of ['claude-marker', 'claude-correlation', 'claude-fork', 'opencode-native-runtime', 'codex-native-runtime', 'codex-explicit-over-role'] as const) {
      expect(() => assertCapability(profile, gate, TRUSTED_UNKNOWN)).toThrow(RouterError);
    }
  });

  test('profil Claude bez M1 i dowodu entropy odmawia korelacji', async () => {
    const profile = await loadCapabilityProfile('claude-code', '2.1.263', FIXTURES);
    expect(profile.status).toBe('pending');
    expect(profile.probes.M1).toBe('pending');
    expect(profile.correlationEntropy).toBe('pending');
    expect(() => assertCapability(profile, 'claude-correlation', TRUSTED_NEXT)).toThrow(RouterError);
  });

  test('znana z zaufanego adaptera faza sprawdza swój dowód, a nieznana wymaga wszystkich pięciu', () => {
    const onePending = { ...ALL_LIFECYCLE_PASSED, resume: 'pending' } as const;
    const opencode = { client: 'opencode', version: '1.18.29', status: 'supported', correlation: false, correlationEntropy: 'pending', fork: false, adapterMarkerPosition: 'unknown', probes: { M6: 'passed', 'M6-runtime': 'passed', M10: 'passed' }, lifecycle: onePending } as const;
    expect(() => assertCapability(opencode, 'opencode-native-runtime', TRUSTED_NEXT)).not.toThrow();
    expect(() => assertCapability(opencode, 'opencode-native-runtime', TRUSTED_UNKNOWN)).toThrow(RouterError);
  });

  test('Codex wymaga M7, a osobna ścieżka rola plus model wymaga M9', () => {
    const codexWithoutM9 = { client: 'codex', version: '0.153.4', status: 'supported', correlation: false, correlationEntropy: 'pending', fork: false, adapterMarkerPosition: 'unknown', probes: { M7: 'passed', M9: 'failed', M10: 'passed' }, lifecycle: ALL_LIFECYCLE_PASSED } as const;
    expect(() => assertCapability(codexWithoutM9, 'codex-native-runtime', TRUSTED_UNKNOWN)).not.toThrow();
    expect(() => assertCapability(codexWithoutM9, 'codex-explicit-over-role', TRUSTED_UNKNOWN)).toThrow(RouterError);
  });

  test('transport profile jest związany z adapterem i wersją runtime, a pending nie jest assumed passed', async () => {
    const profile = await loadTransportCapabilityProfile('bun-fetch', '1.3.11', FIXTURES);
    expect(profile).toMatchObject({ adapterId: 'bun-fetch', runtimeVersion: '1.3.11', status: 'pending', gzipBytes: 'pending', responseHeaders: 'pending' });
  });

  test('nowsza wersja dostaje ostrzeżenie, ale żadna bramka nie dziedziczy dowodów starszej', async () => {
    const profile = await loadCapabilityProfile('claude-code', '2.1.999', FIXTURES);
    expect(profile.status).toBe('pending');
    expect(profile.diagnostics).toContain('capability-newer-version-unmeasured');
    expect(() => assertCapability(profile, 'claude-marker', TRUSTED_NEXT)).toThrow(RouterError);
  });
});
```

Fixture `claude-code-2.1.263.json`:

```json
{
  "client": "claude-code",
  "version": "2.1.263",
  "status": "pending",
  "correlation": false,
  "correlationEntropy": "pending",
  "fork": false,
  "adapterMarkerPosition": "unknown",
  "probes": { "M1": "pending", "M2": "pending", "M3": "pending", "M4": "pending", "M10": "pending" },
  "lifecycle": { "next-turn": "pending", "resume": "pending", "compaction": "pending", "nested": "pending", "parallel": "pending" }
}
```

Fixture `transport-bun-fetch-1.3.11.json` starts as an unmeasured result:

```json
{
  "adapterId": "bun-fetch",
  "runtimeVersion": "1.3.11",
  "status": "pending",
  "gzipBytes": "pending",
  "responseHeaders": "pending"
}
```

The transport profile is pinned to a specific `FetchLike` adapter and runtime version. A custom fetch passed by the embedding application requires a profile passed by that same caller for that exact pair; a missing profile, a different adapter, or a `pending` or `failed` result is never `passed` by default.

- [ ] **Step 6: Skeleton, RED, implementation, GREEN**

The skeleton for `assertCapability` does nothing, and `loadCapabilityProfile` returns a fixed `supported` object. Run `bun test ./tests/adapters/capabilities.test.ts` and observe `toThrow` failures. Implementation: the file `<client>-<version>.json` is read literally. A lower or unrecognizable version gives `RouterError('capability-unknown-version')`. A version newer than the highest known profile gets a synthetic `pending` profile with the diagnostic `capability-newer-version-unmeasured`, inherits no `passed` from the older profile, and every gate returns `unsupported-path` until real probes exist. `assertCapability` first requires a matching `client` and `status === 'supported'`. It reads the phase only from the `TrustedLifecycleContext` supplied by the trusted context adapter, never from tool arguments. When the phase is reliably known, it requires `profile.lifecycle[context.lifecyclePhase] === 'passed'`. When the phase is unknown, it allows the path only when all the required phases `next-turn`, `resume`, `compaction`, `nested`, and `parallel` have `passed` for that version. It does not default to assuming `next-turn`. It then applies only the following gates:

- `claude-marker`: client `claude-code` and M10 `passed` with a passed lifecycle. The channel A parent variant is independent of M3. The alternative parent slot `after-native-context-v1` (plan revision 4) is not an `assertCapability` gate: it is a per-request condition in `normalizeClaudeRequest`, requiring an explicit `parentPromptPosition` in the profile, `M3-A` `passed`, and the client version from the request's `user-agent` equal to `profile.version`; the field value is validated in `loadCapabilityProfile`, and a missing field means `first-text`. Every channel B adapter variant requires an HMAC, a matching `agent`, a matching `x-claude-code-agent-id` header, M3 `passed`, a profile recording the exact measured position (`system` by default, possibly `first-user`), and a separately consumed trusted freshness witness. Channel B2 requires `harness.claudeCode.correlation === 'auto'`, M1, `M3-B2`, and `M10-freshness` as mandatory `passed`, not a possible future addition. M10 does not replace M3 for the adapter channel, and M3 does not replace M10 or the freshness proof.
- `claude-correlation`: client `claude-code`, M1 `passed`, `correlation: true`, and an M1 artifact with entropy evidence from the identifier source. A list of a few different IDs is not entropy evidence.
- `claude-fork`: client `claude-code`, M4 `passed`, `fork: true`, and a separate passed fork lifecycle.
- `opencode-native-runtime`: client `opencode`, M6, `M6-runtime`, and M10 `passed`; M6-runtime covers a registered `tool.execute.before` hook, gate execution before spawn, a negative denial without a request, and a positive measurement of the effective model for every declared path. Role and global-default paths additionally require the `M10-freshness` subcase confirming a fresh delegation.
- `codex-native-runtime`: client `codex`, M7 `passed` and M10 `passed`; M7 covers an executable stdin/stdout `PreToolUse` hook, receiving the `model` field, and proof that `permissionDecision: "deny"` blocks the spawn.
- `codex-explicit-over-role`: client `codex`, M9 `passed`; this gate is additional, not implied by M7 or M10.

Any missing piece, mismatched client, unknown profile, pending, or failed result throws `RouterError('unsupported-path')`. There is no general `native` gate, because M10 alone certifies only lifecycle, not the marker, the hook, or native enforcement. Fork stays a separate M4 gate. An unrecognized fork passes through like a parent, while a recognized fork without a selection falls under requirement 19 and does not get an automatic inherit.

`assertCapability(profile, 'claude-marker', context)` checks the shared M10 gate. The special B and B2 conditions about the marker source, operator config, and the consumed receipt are checked by the handler in Task 9, after extraction. They are not an unconditional requirement of channel A, and cannot depend on data that `assertCapability` does not receive.

`loadTransportCapabilityProfile` performs no network access. It reads the profile for the exact adapter-plus-runtime pair. A handler can be created only when `status`, `gzipBytes`, and `responseHeaders` are all `passed`. A missing or mismatched profile denies starting `serve` or creating the embed handler with `unsupported-path`, before any traffic is accepted. This is not a per-request parent block, and there is no hidden self-check request.

```bash
bun test ./tests/adapters/capabilities.test.ts
```

Expected: all described cases pass, 0 fail.

- [ ] **Step 7: Write the probe runner as a manual tool**

`tests/probes/run.ts` accepts the arguments `--client`, `--probe`, `--config-root <tmp>`, and `--binary <path>`. It starts the capture gateway, prepares an isolated config directory with synthetic agents, runs the harness in non-interactive mode with the gateway endpoint, and writes to stdout the JSON `{ probe, client, version, result: 'passed' | 'failed', evidence }`. `evidence` contains only the data needed for the decision, without prompts, secrets, or auth headers:

- M1: requests from every child after a normal turn, resume, and compaction, plus proof that the ID is generated from a controlled entropy source or an adequate implementation inspection, not just `distinctAgentIds`.
- M3: the marker position in the body captured by the gateway.
- M6: registration and invocation of `tool.execute.before`, effective denial of a direct invalid task, and the `effectiveModel` received by the gateway after native precedence.
- M7: the input and stdout of the real `PreToolUse` hook, the content of `tool_input.model`, and the absence of a child process after `deny`.
- M9: the model received by the gateway for role B and explicit model C.
- M10: a result separately for `next-turn`, `resume`, `compaction`, `nested`, and `parallel`, without raising the whole adapter status from a single positive case. The `M10-freshness` subcase must confirm a fresh-delegation signal before the first request and distinguish it from replayed or lost state through resume, compaction, TTL expiry, and restart, without a history-length heuristic.

The script does not write fixtures automatically; the operator copies the result into `tests/fixtures/capabilities` deliberately. The script must not touch the operator's real `HOME`: it sets `HOME`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, and `CODEX_HOME` to a temporary directory. Running the real harness is an opt-in step outside `bun test`.

The script's unit test in `tests/probes/evidence.test.ts` checks `summarizeEvidence(requests: CapturedRequest[]): Evidence` and the named cases `rejects-m1-identifier-variety-without-entropy-evidence`, `requires-opencode-hook-invocation-and-effective-model`, `requires-codex-deny-without-child-request`, and `keeps-lifecycle-phases-separate`. Two requests with the same `agentId` give `distinctAgentIds: 1`; a request without `isChild` does not count toward `childRequests`, but these counters cannot raise any gate on their own.

- [ ] **Step 8: Commit**

```bash
git add tests/support/capture-gateway.ts tests/probes src/adapters/capabilities.ts tests/fixtures/capabilities tests/adapters/capabilities.test.ts
git commit -m "feat: add capture gateway, probe runner and capability profiles"
```

### Task 8: Claude Code markers, catalog in the tool description, and correlation

**Files:**
- Create: `src/adapters/markers.ts`
- Create: `src/adapters/correlation.ts`
- Create: `src/adapters/claude-code.ts`
- Test: `tests/adapters/markers.test.ts`
- Test: `tests/adapters/correlation.test.ts`
- Test: `tests/adapters/claude-code.test.ts`

**Interfaces:**
- Consumes: `EffectiveCatalog`, `resolveModel`, `RouteInput`, `CapabilityProfile`, `sha256`.
- Produces: `parseMarker(text: string): ParsedMarker | 'invalid' | null` with `ParsedMarker = { kind: 'parent'; alias: string } | { kind: 'adapter'; role: string; agent: string; token: string }`; `signRoleMarker(secret: string, role: string, agent: string): Promise<string>`; `extractMarkers(body: Record<string, unknown>, agentId: string | undefined, secret: string | undefined, adapterMarkerPosition: CapabilityProfile['adapterMarkerPosition'] = 'system'): Promise<{ explicitAliases: string[]; roleFromAdapter?: string; markerError?: 'invalid-marker' | 'conflicting-markers'; ignored: number; stripped: Record<string, unknown> }>`; `class CorrelationStore { constructor(now: () => number, ttlMs: number); get(agentId: string): string | undefined; bind(agentId: string, modelId: string): void }`; `enrichParentTools(body: Record<string, unknown>, catalog: EffectiveCatalog): Record<string, unknown>`; `normalizeClaudeRequest(body: Record<string, unknown>, headers: Headers, options: { secret?: string; profile: CapabilityProfile; correlation?: CorrelationStore; catalog: EffectiveCatalog; roles: OperatorConfig['roles'] }): Promise<{ input: RouteInput; forwardBody: Record<string, unknown>; agentId?: string; adapterRole?: string }>`.

The marker grammar is exactly the one from spec D2. The token is a `sha256` HMAC: `HMAC-SHA-256(secret, 'v=1|role=<role>|agent=<agent>')` computed through `crypto.subtle` with an `HMAC` key. Authorized positions: the adapter variant in `system` only with a valid token and a matching `agent`; the parent variant only as the first line of the first text block of the first `user` message without a `tool_result`; the adapter variant in that `user` position only when the profile has `adapterMarkerPosition: 'first-user'` and a passed M3. `system` with HMAC is the default adapter position. `unknown` does not extend the grammar or the authorization, and `b2` denotes only the local registry from Task 9, not a marker in the body. All other occurrences count toward `ignored`.

Plan revision 4: `extractMarkers` accepts a fifth argument, `parentPromptPosition: ParentPromptPosition = 'first-text'`. Under `after-native-context-v1`, when the legacy position carried no marker and the first `user` message has exactly two text blocks and block 0 satisfies `isNativeContextScaffoldV1` (complete, non-nested `<system-reminder>` sections, each with a harness introductory sentence on the second line and at least one `# name` header, with no text outside the sections), the first line of block 1 is checked only for the parent variant: an accepted alias removes that line from block 1, block 0 stays unchanged, malformed grammar is `invalid-marker`, and the adapter variant is `ignored`. `normalizeClaudeRequest` passes this argument only when `profile.parentPromptPosition === 'after-native-context-v1'`, `profile.probes['M3-A'] === 'passed'`, and `observedClaudeClientVersion(headers)` from a `user-agent` of `claude-cli/x.y.z` equals `profile.version`; in every other case, `first-text`. Tests: `tests/adapters/markers.test.ts` (the `after-native-context-v1` description), `tests/adapters/claude-code.test.ts`, `tests/transport/handler.test.ts`, the fixture `tests/support/native-layout.ts` with a sanitized scaffold, never with a raw capture.

- [ ] **Step 1: Write failing parser tests**

```ts
import { describe, expect, test } from 'bun:test';
import { extractMarkers, parseMarker, signRoleMarker } from '../../src/adapters/markers';

const SECRET = 'test-secret';

describe('parseMarker', () => {
  test.each([
    ['<subagent-router v="1" model="fast"/>', { kind: 'parent', alias: 'fast' }],
    ['<subagent-router v="1" role="reviewer" agent="agent-1" token="abc"/>', { kind: 'adapter', role: 'reviewer', agent: 'agent-1', token: 'abc' }],
    ['<subagent-router v="2" model="fast"/>', 'invalid'],
    ['<subagent-router v="1" model="fast" role="x"/>', 'invalid'],
    ['<subagent-router v="1" model="9bad"/>', 'invalid'],
    ['<subagent-router v="1" model="fast">', 'invalid'],
    ['zwykły tekst', null],
  ])('%s', (text, expected) => {
    expect(parseMarker(text)).toEqual(expected as never);
  });
});

function body(system: unknown[], messages: unknown[]): Record<string, unknown> {
  return { model: 'client-alias', system, messages };
}

describe('extractMarkers', () => {
  test('marker rodzica w pierwszej linii promptu delegacji jest jawnym wyborem i zostaje usunięty z kopii', async () => {
    const input = body([], [{ role: 'user', content: [{ type: 'text', text: '<subagent-router v="1" model="fast"/>\nZbadaj repo.' }] }]);
    const result = await extractMarkers(input, 'agent-1', SECRET);
    expect(result.explicitAliases).toEqual(['fast']);
    expect((result.stripped.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text).toBe('Zbadaj repo.');
    expect((input.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text.startsWith('<subagent-router')).toBe(true);
  });

  test('marker w drugiej linii, w tool_result i w drugiej wiadomości jest ignorowany', async () => {
    const input = body([], [
      { role: 'user', content: [{ type: 'text', text: 'Zbadaj repo.\n<subagent-router v="1" model="fast"/>' }] },
      { role: 'assistant', content: [{ type: 'text', text: '<subagent-router v="1" model="fast"/>' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '<subagent-router v="1" model="fast"/>' }] },
    ]);
    const result = await extractMarkers(input, 'agent-1', SECRET);
    expect(result.explicitAliases).toEqual([]);
    expect(result.ignored).toBe(3);
  });

  test('marker adaptera w system jest przyjęty tylko z poprawnym tokenem i zgodnym agentem', async () => {
    const token = await signRoleMarker(SECRET, 'reviewer', 'agent-1');
    const ok = body([{ type: 'text', text: `<subagent-router v="1" role="reviewer" agent="agent-1" token="${token}"/>` }], []);
    expect((await extractMarkers(ok, 'agent-1', SECRET, 'system')).roleFromAdapter).toBe('reviewer');
    const wrongAgent = await extractMarkers(ok, 'agent-2', SECRET, 'system');
    expect(wrongAgent.roleFromAdapter).toBeUndefined();
    expect(wrongAgent.ignored).toBe(1);
    const forged = body([{ type: 'text', text: '<subagent-router v="1" role="reviewer" agent="agent-1" token="0000"/>' }], []);
    expect((await extractMarkers(forged, 'agent-1', SECRET, 'system')).ignored).toBe(1);
  });

  test('marker adaptera w user wymaga zmierzonego profilu first-user, a unknown go nie autoryzuje', async () => {
    const token = await signRoleMarker(SECRET, 'reviewer', 'agent-1');
    const input = body([], [{ role: 'user', content: `<subagent-router v="1" role="reviewer" agent="agent-1" token="${token}"/>\nZadanie` }]);
    expect((await extractMarkers(input, 'agent-1', SECRET, 'unknown')).roleFromAdapter).toBeUndefined();
    expect((await extractMarkers(input, 'agent-1', SECRET, 'first-user')).roleFromAdapter).toBe('reviewer');
  });

  test('marker rodzica w system oraz marker z CLAUDE.md są ignorowane', async () => {
    const input = body([{ type: 'text', text: 'Instrukcje projektu\n<subagent-router v="1" model="fast"/>' }], []);
    const result = await extractMarkers(input, 'agent-1', SECRET);
    expect(result.explicitAliases).toEqual([]);
    expect(result.ignored).toBe(1);
  });

  test('niepoprawny marker w autoryzowanej pozycji to invalid-marker, dwa różne to conflicting-markers', async () => {
    const invalid = body([], [{ role: 'user', content: [{ type: 'text', text: '<subagent-router v="9" model="fast"/>' }] }]);
    expect((await extractMarkers(invalid, 'agent-1', SECRET)).markerError).toBe('invalid-marker');
    const conflicting = body([], [{ role: 'user', content: [{ type: 'text', text: '<subagent-router v="1" model="fast"/>' }, { type: 'text', text: '<subagent-router v="1" model="slow"/>' }] }]);
    const result = await extractMarkers(conflicting, 'agent-1', SECRET);
    expect(result.explicitAliases).toEqual(['fast']);
    expect(result.ignored).toBe(1);
  });
});
```

The last case shows that only the first line of the first block is authorized; the second block counts as ignored. `conflicting-markers` arises in Task 3 when the adapter passes two different `explicitIds`, which is possible only through the correlation channel or a future position extension; the Task 3 test covers this.

- [ ] **Step 2: Skeleton and RED**

Skeleton: `parseMarker` returns `null`, and `extractMarkers` returns empty values with `stripped` equal to the input. Run `bun test ./tests/adapters/markers.test.ts`; expected `toEqual` failures.

- [ ] **Step 3: Implement the parser, HMAC, and extraction**

Parser based on a single regular expression for the whole line: `^<subagent-router((?:\s+[a-z]+="[^"]*")+)\s*\/>$`, with attributes split out separately and checked against exactly two allowed sets. `stripped` is `structuredClone(body)` with the marker removed from the authorized position; the original stays untouched. A marker in `system` is accepted only after verifying the token with a constant-time comparison (`crypto.subtle.verify` with an HMAC key).

- [ ] **Step 4: GREEN**

```bash
bun test ./tests/adapters/markers.test.ts
```

Expected: all described cases pass, 0 fail.

- [ ] **Step 5: Write a failing correlation test and implement**

```ts
import { describe, expect, test } from 'bun:test';
import { CorrelationStore } from '../../src/adapters/correlation';

describe('CorrelationStore', () => {
  test('wpis wygasa po ttl liczonym od ostatniego użycia', () => {
    let clock = 0;
    const store = new CorrelationStore(() => clock, 1000);
    store.bind('agent-1', 'gateway/a');
    clock = 900;
    expect(store.get('agent-1')).toBe('gateway/a');
    clock = 1800;
    expect(store.get('agent-1')).toBe('gateway/a');
    clock = 2900;
    expect(store.get('agent-1')).toBeUndefined();
  });

  test('różne identyfikatory nie dzielą decyzji', () => {
    const store = new CorrelationStore(() => 0, 1000);
    store.bind('agent-1', 'gateway/a');
    expect(store.get('agent-2')).toBeUndefined();
  });

  test('conflicting-binding-never-reroutes', () => {
    const store = new CorrelationStore(() => 0, 1000);
    store.bind('agent-1', 'gateway/a');
    expect(() => store.bind('agent-1', 'gateway/b')).toThrow('correlation-conflict');
    expect(store.get('agent-1')).toBe('gateway/a');
  });
});
```

The skeleton returns `undefined`; RED on `toBe('gateway/a')`. Implementation: `Map<string, { modelId: string; lastUsed: number }>`; `get` refreshes `lastUsed` and removes expired entries; `bind` overwrites the same identifier only with the same model, and a different model throws `RouterError('correlation-conflict')`.

```bash
bun test ./tests/adapters/correlation.test.ts
```

Expected: all described cases pass, 0 fail.

- [ ] **Step 6: Write a failing Claude adapter test**

```ts
import { describe, expect, test } from 'bun:test';
import { enrichParentTools, normalizeClaudeRequest } from '../../src/adapters/claude-code';
import { CorrelationStore } from '../../src/adapters/correlation';
import { buildCatalog } from '../../src/core/catalog';
import type { CapabilityProfile } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

const profile: CapabilityProfile = { client: 'claude-code', version: '2.1.263', status: 'pending', correlation: false, correlationEntropy: 'pending', fork: false, adapterMarkerPosition: 'unknown', probes: {}, lifecycle: { 'next-turn': 'pending', resume: 'pending', compaction: 'pending', nested: 'pending', parallel: 'pending' } };

describe('enrichParentTools', () => {
  test('dodaje katalog tylko do narzędzi Agent, Task i Workflow, idempotentnie i bez modeli bez opisu', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/undescribed']));
    const body = { tools: [{ name: 'Agent', description: 'Launch agent', input_schema: { properties: { prompt: { description: 'Prompt' } } } }, { name: 'Bash', description: 'Run' }] };
    const once = enrichParentTools(body, catalog);
    const twice = enrichParentTools(once, catalog);
    const agent = (twice.tools as Array<{ name: string; description: string; input_schema: { properties: { prompt: { description: string } } } }>)[0];
    expect(agent?.description.startsWith('Launch agent')).toBe(true);
    expect(agent?.description).toContain('fast');
    expect(agent?.description).not.toContain('gateway/undescribed');
    expect(agent?.description.split('<subagent-router').length).toBe(2);
    expect(agent?.input_schema.properties.prompt.description).toContain('pierwsz');
    expect((twice.tools as Array<{ name: string; description: string }>)[1]?.description).toBe('Run');
    expect((body.tools[0] as { description: string }).description).toBe('Launch agent');
  });
});

describe('normalizeClaudeRequest', () => {
  test('request bez billing metadata jest rodzicem nawet z nagłówkiem agenta', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const result = await normalizeClaudeRequest({ model: 'claude', messages: [] }, new Headers({ 'x-claude-code-agent-id': 'agent-1' }), { profile, catalog, roles: configFixture().roles });
    expect(result.input.scope).toBe('parent');
  });

  test('dziecko z markerem rodzica dostaje explicitIds po dokładnym ID i clientModel z requestu', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const body = {
      model: 'claude-haiku',
      system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }],
      messages: [{ role: 'user', content: '<subagent-router v="1" model="fast"/>\nZadanie' }],
    };
    const result = await normalizeClaudeRequest(body, new Headers({ 'x-claude-code-agent-id': 'agent-1' }), { profile, catalog, roles: configFixture().roles });
    expect(result.input).toMatchObject({ scope: 'child', explicitIds: [FIXTURE_MODEL_ID], clientModel: 'claude-haiku', ignoredMarkers: 0 });
    expect(result.agentId).toBe('agent-1');
    expect((result.forwardBody.messages as Array<{ content: string }>)[0]?.content).toBe('Zadanie');
  });

  test('nieznany alias markera nie może zostać odczytany jako przypadkowe raw upstream ID', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture([FIXTURE_MODEL_ID, 'ghost']));
    const body = { model: 'x', system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }], messages: [{ role: 'user', content: '<subagent-router v="1" model="ghost"/>' }] };
    const result = await normalizeClaudeRequest(body, new Headers(), { profile, catalog, roles: configFixture().roles });
    expect(result.input.explicitIds).toEqual([]);
    expect(result.input.explicitError).toBe('unknown-model');
  });

  test('nie usuwa zwykłego pierwszego bloku system, a parent enrichment jest jedyną zmianą rodzica', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const body = { model: 'claude-opus', system: [{ type: 'text', text: 'zwykły system' }], tools: [{ name: 'Bash', description: 'Run', input_schema: {} }], messages: [] };
    const result = await normalizeClaudeRequest(body, new Headers(), { profile, catalog, roles: configFixture().roles });
    expect(result.input.scope).toBe('parent');
    expect(result.forwardBody.system).toEqual(body.system);
    expect(result.forwardBody.tools).toEqual(body.tools);
  });

  test('korelacja jest używana tylko przy profilu z correlation true', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const store = new CorrelationStore(() => 0, 1000);
    store.bind('agent-1', FIXTURE_MODEL_ID);
    const body = { model: 'x', system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }], messages: [{ role: 'user', content: 'bez markera' }] };
    const off = await normalizeClaudeRequest(body, new Headers({ 'x-claude-code-agent-id': 'agent-1' }), { profile, catalog, roles: configFixture().roles, correlation: store });
    expect(off.input.correlatedId).toBeUndefined();
    const on = await normalizeClaudeRequest(body, new Headers({ 'x-claude-code-agent-id': 'agent-1' }), { profile: { ...profile, status: 'supported', correlation: true, correlationEntropy: 'passed', probes: { M1: 'passed' } }, catalog, roles: configFixture().roles, correlation: store });
    expect(on.input.correlatedId).toBe(FIXTURE_MODEL_ID);
  });
});
```

- [ ] **Step 7: Skeleton, RED, implementation, GREEN**

Skeletons: `enrichParentTools` returns the input, `normalizeClaudeRequest` returns `scope: 'parent'`. Run `bun test ./tests/adapters/claude-code.test.ts`, and observe the failures. `enrichParentTools` implementation: clone the body; for tools named `Agent`, `Task`, or `Workflow` (case-insensitive comparison), append to `description` a block starting with `\n\n<subagent-router catalog>` with an `alias: description` list only for `enabled` models that have a description, plus an instruction to place the marker on the first line of the prompt; the `prompt` field's description gets a sentence about the first line; if the block already exists, do not append. `normalizeClaudeRequest`: recognize a child through a valid `cc_is_subagent=true` in the recognized billing metadata `system` block (handle both JSON and the `k=v;` format). From `forwardBody`, remove only that recognized child billing metadata block, never the first arbitrary `system` block of a parent or a child; for a parent, system, permissions, and schema stay unchanged, except for the idempotent description of the matched tool and its `prompt` field's description; `enrichParentTools` changes no other field. Call `extractMarkers` with `profile.adapterMarkerPosition`; use the `roleFromAdapter` result only when `profile.probes.M3 === 'passed'` and the position from the profile matches the marker position, otherwise treat it as `ignored-marker`. Map the parent alias only through `catalog.byAlias`; an unknown alias sets `explicitError: 'unknown-model'` and an empty `explicitIds` list, even if the same text is a raw upstream ID in `catalog.byId`. Also return `roleFromAdapter` as `adapterRole`, and map it through `roles[`claude-code:${role}`]?.routeOverride` to `roleDefaultId`. `normalizeClaudeRequest` always sets `freshDelegation: false`, because the request, the prompt, the marker, the HMAC `v|role|agent`, the header, and the tool result are not proof of freshness. Only the handler can replace this value with the result of an atomic `consumeFreshDelegation(agentId)` from its own, separate, trusted control state. Read correlation only when a `CorrelationStore` is passed, `profile.correlation === true`, `profile.probes.M1 === 'passed'`, `profile.correlationEntropy === 'passed'`, and `agentId` is present. Task 9 creates and passes the store only when `config.harness.claudeCode.correlation === 'auto'` and the M1 gate with entropy has passed; `clientModel` is `body.model`.

```bash
bun test ./tests/adapters/claude-code.test.ts
```

Expected: all described cases pass, 0 fail.

Add `normalizeClaudeRequest::adapter-system-marker-remains-ignored-until-m3` with a valid HMAC and a profile of `adapterMarkerPosition: 'system'`, but M3 `pending`; the test expects no `roleDefaultId` and `ignored-marker`, not role routing.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/markers.ts src/adapters/correlation.ts src/adapters/claude-code.ts tests/adapters
git commit -m "feat: add Claude Code marker parsing, tool catalog and correlation"
```

### Task 9: HTTP handler and Claude hook output

**Files:**
- Create: `src/transport/handler.ts`
- Create: `src/transport/hooks.ts`
- Create: `src/transport/claude-hook.ts`
- Test: `tests/transport/handler.test.ts`
- Test: `tests/transport/hooks.test.ts`
- Test: `tests/transport/claude-hook.test.ts`

**Interfaces:**
- Consumes: `normalizeClaudeRequest`, `enrichParentTools`, `resolveRoute`, `CorrelationStore`, `buildCatalog`, `SourceContext`, `signRoleMarker`, `assertCapability`, `TrustedLifecycleContext`, `TransportCapabilityProfile`.
- Produces: `createHandler(options: { config: OperatorConfig; snapshot: CatalogSnapshot; source: SourceContext; profile: CapabilityProfile; transportProfile: TransportCapabilityProfile; secret?: string; fetch: FetchLike; fetchAdapter: { id: string; runtimeVersion: string }; trustedContext: (request: Request) => TrustedLifecycleContext; now: () => number; nonce: () => string; instanceId: () => string }): (request: Request) => Promise<Response>`; `createClaudeStartOutput(input: { agent_id: string; agent_type: string }, options: { secret: string; roles: OperatorConfig['roles']; profile: CapabilityProfile; fresh: boolean }): Promise<Record<string, unknown>>`; `signFreshDelegation(secret: string, envelope: Omit<FreshDelegationEnvelope, 'proof'>): Promise<string>`; `class FreshDelegationStore { readonly handlerInstanceId: string; register(envelope: FreshDelegationEnvelope): Promise<void>; consumeFreshDelegation(agentId: string): FreshDelegationReceipt | undefined }`; `runClaudeSubagentStartHook(stdin: ReadableStream<Uint8Array>, stdout: WritableStream<Uint8Array>, deps: ClaudeHookDeps): Promise<void>`.

Handler scope: `POST /v1/messages` and `POST /v1/messages/count_tokens` go through normalization and the decision; other paths are forwarded without reading the body. `GET /subagent-router/control/instance` returns only the non-secret `handlerInstanceId`. `POST /subagent-router/control/delegations` accepts a `FreshDelegationEnvelope` and is never forwarded upstream. The freshness `proof` is an HMAC-SHA-256 over the canonical JSON `['subagent-router:freshness:v1', 1, handlerInstanceId, agentId, role, nonce, issuedAtMs]`, using the existing secret named by `harness.claudeCode.secretEnv`. This is a separate domain from the marker HMAC `v|role|agent`; a valid or replayed marker token cannot register freshness. The store ties the entry to a specific handler instance and child, has a short configurable TTL, keeps used nonces until they expire, consumes an entry atomically exactly once, and loses everything on restart. It is not a database and not a lifecycle manager.

Channel B uses the role from an authorized marker only together with a separately consumed receipt for the same `agentId` and role. Channel B2 uses the role from the receipt without a marker only when `config.harness.claudeCode.correlation === 'auto'`, the profile has `adapterMarkerPosition: 'b2'`, and M1, `M3-B2`, entropy, and `M10-freshness` are all `passed`. A role mismatch between the receipt, an authorized marker B, and the B2 state of the same child gives `conflicting-markers`. A receipt consumed before such an error does not go back into the store. Absence, expiry, replay, or an entry conflict must not recompute a new role default. A request with an existing correlation and a lost marker keeps the decision already bound. Gateway headers from `source.headers` are added to the upstream request, and `host` is removed.

`ClaudeHookDeps` contains `controlBaseUrl`, `secret`, `roles`, `profile`, `fetch`, `now`, `nonce`, and `resolveTrustedStart(input): TrustedLifecycleContext`. The last function is a separate adapter for the trusted native event. It does not read freshness from the event name, the prompt, or stdin fields without a passed M10-freshness. A hermetic test may inject a `freshDelegation: true` result only as `synthetic-trusted-start`; the production version remains unsupported until a real M10-freshness measurement confirms the producer.

- [ ] **Step 1: Write failing handler tests with a fake fetch**

```ts
import { describe, expect, test } from 'bun:test';
import { signRoleMarker } from '../../src/adapters/markers';
import type { CapabilityProfile, FetchLike, FreshDelegationEnvelope } from '../../src/core/types';
import { createHandler, signFreshDelegation } from '../../src/transport/handler';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

const source = { sourceId: 'test-gateway', effectiveGatewayUrl: 'http://127.0.0.1:8000/v1', effectiveModelsUrl: 'http://127.0.0.1:8000/v1/models', headers: { 'X-Team': 'router' } };
const FIXTURE_SUPPORTED_PROFILE: CapabilityProfile = { client: 'claude-code', version: 'synthetic-hermetic', status: 'supported', correlation: true, correlationEntropy: 'passed', fork: false, adapterMarkerPosition: 'b2', probes: { M1: 'passed', 'M3-B2': 'passed', M10: 'passed', 'M10-freshness': 'passed' }, lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' } };
const FIXTURE_TRANSPORT_PROFILE = { adapterId: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic', status: 'passed', gzipBytes: 'passed', responseHeaders: 'passed' } as const;
const CHILD_SYSTEM = [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }];

function upstream(): { fetch: FetchLike; seen: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> } {
  const seen: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  const fetch: FetchLike = async (request) => {
    seen.push({ url: request.url, body: (await request.json()) as Record<string, unknown>, headers: request.headers });
    return new Response(JSON.stringify({ id: 'msg', content: [{ type: 'text', text: 'ok' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, seen };
}

async function handlerWith(fetch: FetchLike, patch: Partial<Parameters<typeof createHandler>[0]> = {}) {
  return createHandler({
    config: configFixture(), snapshot: await snapshotFixture(), source,
    profile: FIXTURE_SUPPORTED_PROFILE,
    transportProfile: FIXTURE_TRANSPORT_PROFILE,
    secret: 'test-secret', fetch, fetchAdapter: { id: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic' },
    trustedContext: () => ({ freshDelegation: false }), now: () => 0,
    nonce: () => 'fixture-nonce', instanceId: () => 'fixture-handler-instance', ...patch,
  });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://router.local${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

describe('createHandler', () => {
  test('dziecko z markerem dostaje upstreamModel, marker znika, rodzic jest przekazywany bez zmian modelu', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch);
    const child = await handler(post('/v1/messages', { model: 'claude-haiku', system: CHILD_SYSTEM, messages: [{ role: 'user', content: '<subagent-router v="1" model="fast"/>\nZadanie' }] }));
    expect(child.status).toBe(200);
    expect(seen[0]?.body.model).toBe(FIXTURE_MODEL_ID);
    expect(JSON.stringify(seen[0]?.body)).not.toContain('subagent-router');
    expect(seen[0]?.headers.get('x-team')).toBe('router');
    expect(seen[0]?.url).toBe('http://127.0.0.1:8000/v1/messages');
    await handler(post('/v1/messages', { model: 'claude-opus', messages: [{ role: 'user', content: 'rodzic' }] }));
    expect(seen[1]?.body.model).toBe('claude-opus');
  });

  test('dziecko bez wskazania dostaje 422 z kodem missing-selection i brama nie jest wołana', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch);
    const response = await handler(post('/v1/messages', { model: 'x', system: CHILD_SYSTEM, messages: [{ role: 'user', content: 'bez markera' }] }));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('missing-selection');
    expect(seen).toHaveLength(0);
  });

  test('pending i nieznany profil odmawiają child przed upstream', async () => {
    for (const profile of [
      { ...FIXTURE_SUPPORTED_PROFILE, status: 'pending' as const },
      { ...FIXTURE_SUPPORTED_PROFILE, version: 'unmeasured', status: 'pending' as const, diagnostics: ['capability-unknown-version'] },
    ]) {
      const { fetch, seen } = upstream();
      const handler = await handlerWith(fetch, { profile });
      const response = await handler(post('/v1/messages', { model: 'x', system: CHILD_SYSTEM, messages: [{ role: 'user', content: '<subagent-router v="1" model="fast"/>\nZadanie' }] }));
      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('unsupported-path');
      expect(seen).toHaveLength(0);
    }
  });

  test('parent przechodzi i zachowuje model przy pending child profile', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch, { profile: { ...FIXTURE_SUPPORTED_PROFILE, status: 'pending' } });
    await handler(post('/v1/messages', { model: 'claude-opus', messages: [{ role: 'user', content: 'rodzic' }] }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body.model).toBe('claude-opus');
  });

  test('rodzic z cytowanym markerem w tool_result przechodzi bez zmian', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch);
    await handler(post('/v1/messages', { model: 'claude-opus', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '<subagent-router v="1" model="fast"/>' }] }] }));
    expect(seen[0]?.body.model).toBe('claude-opus');
  });

  test('B2 wymaga osobnego one-shot freshness proof i nie przekazuje control upstream', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch);
    const instance = await handler(new Request('http://router.local/subagent-router/control/instance'));
    const handlerInstanceId = ((await instance.json()) as { handlerInstanceId: string }).handlerInstanceId;
    const unsigned = { version: 1, handlerInstanceId, agentId: 'agent-1', role: 'explorer', nonce: 'fresh-1', issuedAtMs: 0 } as const;
    const bad = await handler(post('/subagent-router/control/delegations', { ...unsigned, proof: await signRoleMarker('test-secret', 'explorer', 'agent-1') }));
    expect(bad.status).toBe(401);
    const envelope: FreshDelegationEnvelope = { ...unsigned, proof: await signFreshDelegation('test-secret', unsigned) };
    expect((await handler(post('/subagent-router/control/delegations', envelope))).status).toBe(204);
    await handler(post('/v1/messages', { model: 'x', system: CHILD_SYSTEM, messages: [{ role: 'user', content: 'bez markera' }] }, { 'x-claude-code-agent-id': 'agent-1' }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body.model).toBe(FIXTURE_MODEL_ID);
    expect((await handler(post('/subagent-router/control/delegations', envelope))).status).toBe(409);
    expect(seen).toHaveLength(1);
  });

  test('system B default działa tylko z trusted one-shot freshness receipt tej samej roli', async () => {
    const { fetch, seen } = upstream();
    const systemProfile = { ...FIXTURE_SUPPORTED_PROFILE, adapterMarkerPosition: 'system' as const, probes: { ...FIXTURE_SUPPORTED_PROFILE.probes, M3: 'passed' as const } };
    const handler = await handlerWith(fetch, { profile: systemProfile });
    const instance = await handler(new Request('http://router.local/subagent-router/control/instance'));
    const handlerInstanceId = ((await instance.json()) as { handlerInstanceId: string }).handlerInstanceId;
    const unsigned = { version: 1, handlerInstanceId, agentId: 'agent-b', role: 'explorer', nonce: 'fresh-b', issuedAtMs: 0 } as const;
    const envelope = { ...unsigned, proof: await signFreshDelegation('test-secret', unsigned) };
    expect((await handler(post('/subagent-router/control/delegations', envelope))).status).toBe(204);
    const marker = await signRoleMarker('test-secret', 'explorer', 'agent-b');
    const system = [...CHILD_SYSTEM, { type: 'text', text: `<subagent-router v="1" role="explorer" agent="agent-b" token="${marker}"/>` }];
    expect((await handler(post('/v1/messages', { model: 'x', system, messages: [] }, { 'x-claude-code-agent-id': 'agent-b' }))).status).toBe(200);
    expect(seen[0]?.body.model).toBe(FIXTURE_MODEL_ID);
  });

  test('stary lub sam powtórzony marker B bez fresh receipt nie inicjuje defaultu', async () => {
    const { fetch, seen } = upstream();
    const systemProfile = { ...FIXTURE_SUPPORTED_PROFILE, adapterMarkerPosition: 'system' as const, probes: { ...FIXTURE_SUPPORTED_PROFILE.probes, M3: 'passed' as const } };
    const handler = await handlerWith(fetch, { profile: systemProfile });
    const marker = await signRoleMarker('test-secret', 'explorer', 'agent-stale');
    const system = [...CHILD_SYSTEM, { type: 'text', text: `<subagent-router v="1" role="explorer" agent="agent-stale" token="${marker}"/>` }];
    const response = await handler(post('/v1/messages', { model: 'x', system, messages: [] }, { 'x-claude-code-agent-id': 'agent-stale' }));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('missing-selection');
    expect(seen).toHaveLength(0);
  });

  test('strumień i anulowanie są przekazywane bez buforowania', async () => {
    let aborted = false;
    const fetch: FetchLike = async (request) => {
      request.signal.addEventListener('abort', () => { aborted = true; });
      const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); } });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const handler = await handlerWith(fetch);
    const controller = new AbortController();
    const request = new Request('http://router.local/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-opus', stream: true, messages: [] }), signal: controller.signal });
    const response = await handler(request);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(aborted).toBe(true);
  });

  test('inne ścieżki są przekazywane bez odczytu body', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch);
    await handler(post('/v1/models', {}));
    expect(seen[0]?.url).toBe('http://127.0.0.1:8000/v1/models');
  });
});
```

Add the following named transport tests to this file, without the AI SDK:

- `forwards-parent-enrichment-to-upstream-without-changing-parent-model`: a parent with the `Agent` tool reaches upstream with an enriched tool description and its `prompt` field; `model`, system, permissions, and the rest of the schema are byte-for-byte or structurally equal to the input, depending on the field.
- `passes-raw-request-bytes-on-non-routing-path`: for a path without parsing, the handler sends identical `Uint8Array` body bytes to upstream.
- `passes-through-sse-unknown-events-errors-content-and-usage`: a controlled gateway emits an SSE sequence with an unknown event and `error`, `content`, and `usage` fields; the client receives exactly those bytes, order, and status.
- `passes-through-error-body-and-headers`: a 4xx or 5xx response with unusual headers and a raw body is not replaced with router JSON.
- `preserves-backpressure-with-a-slow-consumer`: a deliberately slow client and an instrumented upstream check bounded pull or prefetch consistent with `highWaterMark`, without the producer running unboundedly ahead.
- `aborts-upstream-on-client-disconnect`: canceling or closing the reader propagates the `AbortSignal` to the upstream request and ends its stream.
- `measures-selected-fetch-compression-contract`: runs the selected real `fetch` adapter, not a fake, against a local gzip response with no transformation along the way. Compares the identity of the upstream body bytes with the bytes received by the client, and the matching `content-encoding` and `content-length`. Fixing the headers alone does not satisfy W42. The result is recorded in `TransportCapabilityProfile` for the exact `adapterId` and `runtimeVersion`. `pending` or `failed` blocks handler creation at `serve` or embed startup, without its own decode/re-encode and without a self-check on every operation.
- `rejects-unmeasured-or-mismatched-transport-profile-before-handler-start`: pending, failed, a different `adapterId`, or a different runtime version throw `unsupported-path` during `createHandler`, before a handler exists to serve a parent or child.

- [ ] **Step 2: Skeleton and RED**

The skeleton returns `new Response(null, { status: 501 })`. Run `bun test ./tests/transport/handler.test.ts`; expect failures on statuses and `seen`.

- [ ] **Step 3: Implement the handler**

Structure: `catalog = buildCatalog(config, snapshot)` once per instance. Still during `createHandler`, check that `transportProfile.adapterId` and `runtimeVersion` match `fetchAdapter` and that all three results are `passed`. Missing evidence for gzip bytes or headers throws `unsupported-path` and prevents `serve` from starting or embed from being used, before the handler serves any request. Do not run a hidden self-check request, and do not wait until a single parent request to block.

Create an ephemeral `FreshDelegationStore` with a random `handlerInstanceId`, a short TTL, and a registry of used nonces. Create a `CorrelationStore` and pass it into normalization only when `config.harness.claudeCode.correlation === 'auto'` and `assertCapability(profile, 'claude-correlation', trustedUnknown)` passes on M1, `correlation: true`, and `correlationEntropy: 'passed'`. With `off`, pending M1, or missing entropy, there is no store object. The same conditions plus M3-B2 and `adapterMarkerPosition: 'b2'` are mandatory for B2.

For routable paths, read the JSON, where bad JSON gives 400, then call `normalizeClaudeRequest`. A parent goes through normal pass-through or allowed enrichment without invoking the child gate. For a confirmed child, get the `TrustedLifecycleContext` through the separate `trustedContext(request)` and, immediately before `resolveRoute`, call `assertCapability(profile, 'claude-marker', context)`. Do not read `lifecyclePhase` from the body, the prompt, or tool input. A pending, failed, or unknown profile gives the child `unsupported-path` before upstream, but does not change the parent.

After confirming the child and before the decision, atomically call `consumeFreshDelegation(agentId)` at most once. A receipt can set `freshDelegation: true` only for the same handler instance and `agentId`, after M10-freshness. Channel B additionally requires M3, an authorized marker position, and an identical role between the marker and the receipt. Channel B2 additionally requires config `correlation === 'auto'`, M1, entropy, M3-B2, and the role from the receipt. A role mismatch between marker B, the receipt, or an existing B2 entry gives `conflicting-markers`; the receipt stays consumed even after the error. The marker HMAC alone never sets `freshDelegation`. Absence, expiry, replay, or a restart gives `freshDelegation: false`, so the default ends in `missing-selection` or `unsupported-path`. An existing correlation wins without reusing the default; a different route gives `correlation-conflict`.

For `scope === 'parent'`, set `forwardBody = enrichParentTools(normalized.forwardBody, catalog)` and send that clone. For `route`, swap only `forwardBody.model`; for `pass-through`, also send `forwardBody`, to keep the safe removal of the marker, billing metadata, and controlled enrichment. The upstream request keeps the configured gateway's `/v1` pathname: from an incoming `/v1/messages` it derives the relative segment `messages` and appends it to the base ending in `/v1/`. Do not use the absolute path `/messages`. Remove `host` and `content-length`, add `source.headers`, pass `request.signal`, and return the response with the same status, headers, and raw body, without reading, decoding, buffering, decompressing, or re-encoding it.

`GET /subagent-router/control/instance` requires no auth, because it returns only the instance identifier. `POST /subagent-router/control/delegations` checks the exact instance, a bounded time window, a role that exists in the config, the canonical freshness HMAC, and a unique nonce. A bad proof gives 401, a bad shape or role gives 422, and replay, a nonce conflict, or a stale instance gives 409. No control endpoint goes upstream.

- [ ] **Step 4: GREEN**

```bash
bun test ./tests/transport/handler.test.ts
```

Expected: all described cases pass, 0 fail.

- [ ] **Step 5: Write a failing hook test and implement**

```ts
import { describe, expect, test } from 'bun:test';
import { parseMarker } from '../../src/adapters/markers';
import { createClaudeStartOutput } from '../../src/transport/hooks';
import type { CapabilityProfile } from '../../src/core/types';
import { configFixture } from '../support/fixtures';

const markerProfile: CapabilityProfile = { client: 'claude-code', version: '2.1.263', status: 'supported', correlation: false, correlationEntropy: 'pending', fork: false, adapterMarkerPosition: 'system', probes: { M3: 'passed', M10: 'passed', 'M10-freshness': 'passed' }, lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' } };

describe('createClaudeStartOutput', () => {
  test('zwraca additionalContext z markerem adaptera dla roli znanej w konfiguracji', async () => {
    const output = await createClaudeStartOutput({ agent_id: 'agent-1', agent_type: 'explorer' }, { secret: 'test-secret', roles: configFixture().roles, profile: markerProfile, fresh: true });
    const context = (output.hookSpecificOutput as { hookEventName: string; additionalContext: string });
    expect(context.hookEventName).toBe('SubagentStart');
    const marker = parseMarker(context.additionalContext.split('\n')[0] ?? '');
    expect(marker).toMatchObject({ kind: 'adapter', role: 'explorer', agent: 'agent-1' });
    expect(context.additionalContext).not.toContain('test-secret');
  });

  test('rola bez trasy nie wstrzykuje markera', async () => {
    const output = await createClaudeStartOutput({ agent_id: 'agent-1', agent_type: 'unknown-role' }, { secret: 'test-secret', roles: configFixture().roles, profile: markerProfile, fresh: true });
    expect(output).toEqual({});
  });

  test('profil bez M3 albo M10-freshness nie otwiera kanału B', async () => {
    const profile = { ...markerProfile, probes: { M3: 'pending', M10: 'passed', 'M10-freshness': 'pending' } };
    const output = await createClaudeStartOutput({ agent_id: 'agent-1', agent_type: 'explorer' }, { secret: 'test-secret', roles: configFixture().roles, profile, fresh: false });
    expect(output).toEqual({});
  });
});
```

In `tests/transport/claude-hook.test.ts`, add complete given/when/then cases:

- `registers-synthetic-trusted-one-shot-before-writing-system-b-marker`: given an explicit synthetic supported profile and `resolveTrustedStart` returning fresh, when stdin describes a child fixture, then the entrypoint first fetches `handlerInstanceId`, registers a separate freshness envelope, and only after 204 writes marker B to stdout. A spy confirms the order. This is not runtime proof of `SubagentStart`.
- `writes-b2-output-only-after-m3-b2-m1-auto-and-freshness-registration`: given config auto and all required synthetic gates, when the profile position is `b2`, then the producer registers the envelope, does not emit a marker in the body, and finishes successfully.
- `producer-registration-failure-does-not-emit-default-marker-or-success`: given 401, 409, timeout, or an unreachable control endpoint, when the hook attempts registration, then it does not write a marker/default and returns an explicit hook error. B2 and B stay closed.
- `subagentstart-name-alone-never-sets-fresh`: given a production profile with `M10-freshness: pending` or a resolver without a trusted witness, when stdin has a `SubagentStart` event, then there is no registration and no default marker.

The skeleton returns `{}`; RED on `toBe('SubagentStart')`. The implementation requires a capability profile, builds the marker with `signRoleMarker` only after M3, a separately passed M10-freshness, and a trusted fresh receipt passed for the role, and returns a structure matching the Claude Code hook documentation. A profile without these gates returns `{}` and does not suggest a working channel B. The profile records the measured `additionalContext` position: the adapter accepts `system` or `first-user` only after M3 for the exact position. An M3 result that excludes body positions can lead only to B2, after mandatory M3-B2, M1, entropy, config auto, and M10-freshness. `runClaudeSubagentStartHook` reads a single JSON stdin, obtains the trusted context from `resolveTrustedStart`, fetches the instance endpoint, signs a separate freshness envelope, and registers it before stdout. The event name `SubagentStart` alone does not give fresh. A producer error closes the default and is not mapped to success without a marker.

```bash
bun test ./tests/transport/hooks.test.ts ./tests/transport/claude-hook.test.ts
```

Expected: all described cases pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/transport tests/transport
git commit -m "feat: add routing handler and Claude hook output"
```

### Task 10: OpenCode: agent variants and runtime selection validation

**Files:**
- Create: `src/adapters/opencode.ts`
- Create: `src/adapters/opencode-plugin.ts`
- Test: `tests/adapters/opencode.test.ts`
- Test: `tests/adapters/opencode-plugin.test.ts`

**Interfaces:**
- Consumes: `AgentInventory`, `getAgent`, `EffectiveCatalog`, `resolveRoute`, `CapabilityProfile`, `assertCapability`.
- Produces: `opencodeVariants(inventory: AgentInventory, config: OperatorConfig, catalog: EffectiveCatalog, snapshotGeneration: string): ExportFile[]`; `validateOpenCodeTask(args: unknown, inventory: AgentInventory, config: OperatorConfig, catalog: EffectiveCatalog, profile: CapabilityProfile, context: NativeRuntimeContext): RouteDecision`; `createOpenCodePlugin(deps: { inventory: AgentInventory; config: OperatorConfig; catalog: EffectiveCatalog; profile: CapabilityProfile; snapshotGeneration: string; resolveNativeRuntimeContext(input: unknown): Promise<NativeRuntimeContext | undefined> }): { 'tool.execute.before': (input: unknown) => Promise<unknown> }`.

The variant name is `ROLE@ALIAS`. A variant copies the `native` field of the base definition and overrides only `name`, `description`, `hidden: true`, and the model in the native config. The export generates one Markdown file per variant for roles with files, and one `opencode.agents.json` fragment for roles defined in `opencode.json`. Models without a description do not get a variant. The artifact stores `providerId`, the exact `upstreamModel`, and `snapshotGeneration` separately; the serialized native field can take the form `<providerId>/<upstreamModel>`, for example `gateway/gateway/fast-worker`. The comparison splits off only the known leading `providerId`, then compares the remaining literal upstream ID with `decision.upstreamModel`, with no stripping, normalization, or splitting on a further `/`.

`validateOpenCodeTask` takes the native `task` arguments (`subagent_type`, `description`, `prompt`), distinguishes a missing selection from a value that is present but invalid, and returns the core decision without changing the arguments. The lifecycle phase and freshness do not come from these args. The validator gets them only through the `NativeRuntimeContext` from the `resolveNativeRuntimeContext` dependency. For a `route` decision, it requires `context.nativeConfig.source === 'authoritative-native-resolver'`, `providerId === config.harness.opencode.providerId`, `effectiveModel === decision.upstreamModel`, `expectedGeneration === actualGeneration`, and a matching artifact hash. For a role or global default, it additionally requires `context.freshDelegation === true` and a passed `M10-freshness`; without a credible signal it refuses with `unsupported-path`. A missing effective native application of the default gives `unsupported-path`, not the success of an empty hook. Files-only inventory, a sidecar, a fixture declaration, or the caller alone are not runtime proof. A pure preview may return a decision without context, but the plugin runtime never claims it applied it without evidence.

The runtime guard is an executable `tool.execute.before` plugin that registers itself in the client's active configuration through the controlled artifact from Task 13. The plugin fetches context from the native resolver, calls the validator, and returns the native hook result. It does not run the task or the child; further execution belongs solely to the harness. M6-runtime must first confirm that this resolver hook is authoritative for the active version. Until that measurement, the production profile stays pending. A hermetic test may inject only an explicit `FIXTURE_NATIVE_CONTEXT` and a continuation spy, which tests the hook's shape, not a real client run.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from 'bun:test';
import { opencodeVariants, validateOpenCodeTask } from '../../src/adapters/opencode';
import { buildCatalog } from '../../src/core/catalog';
import type { AgentInventory, CapabilityProfile, NativeRuntimeContext } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

const inventory: AgentInventory = {
  entries: [{
    client: 'opencode', name: 'reviewer', scope: 'project', path: '/x/.opencode/agents/reviewer.md', declaredModel: 'inherit', hidden: false,
    body: 'Sprawdzaj regresje.', native: { description: 'Przegląd', tools: { bash: false }, permission: { edit: 'deny' }, mode: 'subagent' }, availability: 'available', shadowed: false,
  }],
  completeness: 'files-only',
  diagnostics: [],
};
const supported: CapabilityProfile = { client: 'opencode', version: '1.18.29', status: 'supported', correlation: false, correlationEntropy: 'pending', fork: false, adapterMarkerPosition: 'unknown', probes: { M6: 'passed', 'M6-runtime': 'passed', M10: 'passed', 'M10-freshness': 'passed' }, lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' } };
const pending: CapabilityProfile = { ...supported, status: 'pending', probes: {} };
const snapshotGeneration = 'fixture-generation';
const FIXTURE_NATIVE_CONTEXT: NativeRuntimeContext = {
  lifecyclePhase: 'next-turn', freshDelegation: true,
  nativeConfig: {
    source: 'authoritative-native-resolver', providerId: 'gateway', effectiveModel: FIXTURE_MODEL_ID,
    expectedGeneration: snapshotGeneration, actualGeneration: snapshotGeneration, artifactHash: 'fixture-artifact-hash',
  },
};

describe('opencodeVariants', () => {
  test('wariant zachowuje narzędzia, uprawnienia i treść, zmienia tylko nazwę, opis, hidden i model', async () => {
    const files = opencodeVariants(inventory, configFixture(), buildCatalog(configFixture(), await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/undescribed'])), snapshotGeneration);
    expect(files.map((f) => f.relativePath)).toEqual(['opencode/agents/reviewer@fast.md']);
    const content = files[0]?.content ?? '';
    expect(content).toContain('name: reviewer@fast');
    expect(content).toContain(`model: gateway/${FIXTURE_MODEL_ID}`);
    expect(content).toContain('hidden: true');
    expect(content).toContain('bash: false');
    expect(content).toContain("edit: deny");
    expect(content.trimEnd().endsWith('Sprawdzaj regresje.')).toBe(true);
    expect(content).not.toContain('undescribed');
  });
});

describe('validateOpenCodeTask', () => {
  test('wariant znany w katalogu daje route z dokładnym upstreamModel', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const decision = validateOpenCodeTask({ subagent_type: 'reviewer@fast', prompt: 'x', description: 'y' }, inventory, configFixture(), catalog, supported, FIXTURE_NATIVE_CONTEXT);
    expect(decision).toEqual({ kind: 'route', upstreamModel: FIXTURE_MODEL_ID, clientModel: 'haiku', source: 'explicit', ignoredMarkers: 0 });
  });

  test('wariant z aliasem spoza katalogu i nieznana rola dają błąd, bez zmiany args', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const args = { subagent_type: 'reviewer@ghost', prompt: 'x', description: 'y' };
    expect(validateOpenCodeTask(args, inventory, configFixture(), catalog, supported, FIXTURE_NATIVE_CONTEXT)).toMatchObject({ kind: 'error', code: 'unknown-model' });
    expect(validateOpenCodeTask({ subagent_type: 'nobody@fast', prompt: 'x', description: 'y' }, inventory, configFixture(), catalog, supported, FIXTURE_NATIVE_CONTEXT)).toMatchObject({ kind: 'error', code: 'unsupported-path' });
    expect(args.subagent_type).toBe('reviewer@ghost');
  });

  test('bazowa rola bez wariantu przechodzi jako pass-through dziedziczenia natywnego tylko przy jawnym inherit', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    expect(validateOpenCodeTask({ subagent_type: 'reviewer' }, inventory, configFixture(), catalog, supported, FIXTURE_NATIVE_CONTEXT)).toMatchObject({ kind: 'error', code: 'missing-selection' });
    const config = configFixture({ defaults: { child: null, unmarkedSubagent: 'inherit', unmarkedSubagentAcknowledged: true } });
    expect(validateOpenCodeTask({ subagent_type: 'reviewer' }, inventory, config, catalog, supported, FIXTURE_NATIVE_CONTEXT)).toMatchObject({ kind: 'pass-through', reason: 'inherit-allowed' });
  });

  test('profil pending odmawia z unsupported-path', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    expect(validateOpenCodeTask({ subagent_type: 'reviewer@fast' }, inventory, configFixture(), catalog, pending, FIXTURE_NATIVE_CONTEXT)).toMatchObject({ kind: 'error', code: 'unsupported-path' });
  });

  test('odrzuca present-but-invalid variant przed role defaultem i nie myli aliasu z raw ID', async () => {
    const config = configFixture({ roles: { 'opencode:reviewer': { routeOverride: FIXTURE_MODEL_ID } } });
    const catalog = buildCatalog(config, await snapshotFixture([FIXTURE_MODEL_ID, 'ghost']));
    for (const subagent_type of [null, '', 42, 'reviewer@ghost'] as const) {
      expect(validateOpenCodeTask({ subagent_type }, inventory, config, catalog, supported, FIXTURE_NATIVE_CONTEXT)).toMatchObject({ kind: 'error', code: 'unknown-model' });
    }
  });
});

```

Add `tests/adapters/opencode-plugin.test.ts` with complete given/when/then tests `denies-before-stubbed-opencode-continuation`, `allows-stubbed-continuation-with-synthetic-authoritative-context`, `requires-effective-native-model-and-artifact-generation`, and `compares-provider-separately-from-opaque-upstream-id`. An external test driver interprets the callback result and calls the continuation spy only after success. The first test calls the actually registered `tool.execute.before` callback with `reviewer@ghost` and checks the shape of the native denial, the validator call, and zero calls to the `continueNativeTask` spy. The second is a positive control: an explicit `FIXTURE_NATIVE_CONTEXT` and a synthetic supported profile cause exactly one continuation call with unchanged input. These two tests do not run OpenCode and cannot claim that no native request was made. A real denial plus zero child requests belong only to the opt-in `M6-runtime` scenario with a running client and a capture gateway in Task 15. The third test rejects a missing context, a witness that does not come from the authoritative resolver, a different effective model, generation, or artifact hash, even though a pure `route preview` returns a decision. The fourth supplies `providerId: 'gateway'` and `effectiveModel: 'gateway/fast-worker'` and checks both fields without splitting the opaque ID on the second slash. A separate case confirms that `lifecyclePhase` in the args is ignored and cannot replace the trusted context.

- [ ] **Step 2: Skeleton and RED**

Skeleton: `opencodeVariants` returns `[]`, `validateOpenCodeTask` returns `unsupported-path`. Run `bun test ./tests/adapters/opencode.test.ts`; expect failures on `toEqual` and `toMatchObject`.

- [ ] **Step 3: Implement**

`opencodeVariants`: for each `available` role with a `path` and each `enabled` model with a description, build the frontmatter with `Bun.YAML.stringify({ ...native, name, description, hidden: true, model })` and append `body`. Keep `providerId` separate from the exact `upstreamModel`, and tie the artifact manifest to `snapshotGeneration`.

`validateOpenCodeTask` calls `assertCapability(profile, 'opencode-native-runtime', context)`. `context.lifecyclePhase` comes only from `resolveNativeRuntimeContext`; a field of that name in `args` is untrusted and ignored. A known phase requires its own `passed`, an unknown phase requires all five. Check for the presence of `subagent_type` with `Object.hasOwn`, so that `null`, an empty string, a non-string value, or an invalid `ROLE@ALIAS` cannot fall through to the default. Split a valid `subagent_type` on the last `@`; the role must exist in the inventory. Map the alias only through `catalog.byAlias`; an unresolved alias sets `explicitError: 'unknown-model'`, even when the same text is a raw ID in `catalog.byId`. `roleDefaultId` from `config.roles[`opencode:${role}`]` gets `freshDelegation` only from the context. For a `route` result, check the authoritative native witness: provider separately, the literal effective model separately, expected and actual generation, and the artifact hash. Missing evidence, files-only inventory, or a mismatch gives `unsupported-path`, without modifying `args`. For the default, additionally require M10-freshness and `context.freshDelegation === true`.

`createOpenCodePlugin` is an executable plugin entrypoint: it registers `tool.execute.before`, filters for native `task` only, fetches the `NativeRuntimeContext` through the dependency, calls `validateOpenCodeTask`, and for an `error` decision emits the denial mechanism confirmed by M6-runtime. For `route`, it does not build an `updatedInput`, does not replace `subagent_type`, and just ends the hook. `continueNativeTask` is a spy only in the external test driver: the driver runs it after an accepted hook result, never the production adapter. Only M6-runtime with a real client proves that the callback is on the path before spawn, that the denial works, and that no child request reached the gateway.

- [ ] **Step 4: GREEN**

```bash
bun test ./tests/adapters/opencode.test.ts ./tests/adapters/opencode-plugin.test.ts
```

Expected: all described cases pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/opencode.ts src/adapters/opencode-plugin.ts tests/adapters/opencode.test.ts tests/adapters/opencode-plugin.test.ts
git commit -m "feat: add OpenCode variants and task validation"
```

### Task 11: Codex: mandatory hook validating model and role precedence

**Files:**
- Create: `src/adapters/codex.ts`
- Create: `src/adapters/codex-hook.ts`
- Test: `tests/adapters/codex.test.ts`
- Test: `tests/adapters/codex-hook.test.ts`

**Interfaces:**
- Consumes: `AgentInventory`, `EffectiveCatalog`, `resolveRoute`, `CapabilityProfile`, `assertCapability`.
- Produces: `validateCodexSpawn(args: unknown, inventory: AgentInventory, config: OperatorConfig, catalog: EffectiveCatalog, profile: CapabilityProfile, context: NativeRuntimeContext): RouteDecision`; `codexHookOutput(decision: RouteDecision): Record<string, unknown>`; `type CodexHookDeps = { inventory: AgentInventory; config: OperatorConfig; catalog: EffectiveCatalog; profile: CapabilityProfile; resolveNativeRuntimeContext(input: unknown): Promise<NativeRuntimeContext | undefined> }`; `runCodexPreToolUseHook(stdin: ReadableStream<Uint8Array>, stdout: WritableStream<Uint8Array>, deps: CodexHookDeps): Promise<void>`.

The `PreToolUse` hook with the `Agent` matcher gets the `tool_input` of the `spawn_agent` tool (`model?`, `role?` or `agent?`, `prompt`). `src/adapters/codex-hook.ts` is an executable stdin/stdout entrypoint that parses only the `PreToolUse` event for `Agent` and writes the `codexHookOutput` result to stdout under the hook contract. An `error` decision gives `permissionDecision: "deny"` with a reason containing the code. A `route` or `pass-through` decision writes an empty hook object; it does not issue an explicit `allow` or `updatedInput`. The hook does not run the child; execution stays in Codex. `continueNativeSpawn` is only a spy in the external test driver, not a dependency or a router function. A model given explicitly is accepted only as an exact ID present in `catalog.byId`; an alias is not accepted.

`tool_input` carries only model data and never supplies lifecycle or freshness. Before validation, the hook fetches the `NativeRuntimeContext` through `resolveNativeRuntimeContext`. The witness must contain the effective model, expected and actual generation, the artifact hash, and the source `authoritative-native-resolver`. For `route`, the exact `effectiveModel` must match the core decision, and the generation and artifact must agree. A role or the global default additionally requires `freshDelegation` from the adapter's trusted context and M10-freshness. Files-only inventory, a sidecar, or a caller fixture are not runtime proof. Whether the native resolver hook exists and where it sits before spawn must be measured in M7 before the `supported` profile; until then the production adapter is `unsupported-path`. A pure preview can still return the decision alone.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from 'bun:test';
import { codexHookOutput, validateCodexSpawn } from '../../src/adapters/codex';
import { buildCatalog } from '../../src/core/catalog';
import type { AgentInventory, CapabilityProfile, NativeRuntimeContext } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

const inventory: AgentInventory = {
  entries: [{ client: 'codex', name: 'reviewer', scope: 'user', path: '/h/.codex/agents/reviewer.toml', declaredModel: 'gateway/base', hidden: false, native: {}, availability: 'available', shadowed: false }],
  completeness: 'files-only',
  diagnostics: [],
};
const supported: CapabilityProfile = { client: 'codex', version: 'synthetic-hermetic', status: 'supported', correlation: false, correlationEntropy: 'pending', fork: false, adapterMarkerPosition: 'unknown', probes: { M5: 'passed', M7: 'passed', M9: 'passed', M10: 'passed', 'M10-freshness': 'passed' }, lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' } };

function nativeContext(effectiveModel = FIXTURE_MODEL_ID, patch: Partial<NativeRuntimeContext> = {}): NativeRuntimeContext {
  return {
    lifecyclePhase: 'next-turn', freshDelegation: true,
    nativeConfig: {
      source: 'authoritative-native-resolver', effectiveModel,
      expectedGeneration: 'fixture-generation', actualGeneration: 'fixture-generation', artifactHash: 'fixture-artifact-hash',
    },
    ...patch,
  };
}

describe('validateCodexSpawn', () => {
  test('jawny model z katalogu daje route, model spoza katalogu daje unknown-model', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    expect(validateCodexSpawn({ model: FIXTURE_MODEL_ID, prompt: 'x' }, inventory, configFixture(), catalog, supported, nativeContext())).toMatchObject({ kind: 'route', upstreamModel: FIXTURE_MODEL_ID, source: 'explicit' });
    expect(validateCodexSpawn({ model: 'gateway/ghost', prompt: 'x' }, inventory, configFixture(), catalog, supported, nativeContext())).toMatchObject({ kind: 'error', code: 'unknown-model' });
    expect(validateCodexSpawn({ model: 'fast', prompt: 'x' }, inventory, configFixture(), catalog, supported, nativeContext())).toMatchObject({ kind: 'error', code: 'unknown-model' });
  });

  test('rola bez modelu używa routeOverride, a jawny model wygrywa z rolą', async () => {
    const config = configFixture({ roles: { 'codex:reviewer': { routeOverride: FIXTURE_MODEL_ID } } });
    const catalog = buildCatalog(config, await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/other']));
    expect(validateCodexSpawn({ role: 'reviewer', prompt: 'x' }, inventory, config, catalog, supported, nativeContext())).toMatchObject({ kind: 'route', upstreamModel: FIXTURE_MODEL_ID, source: 'role-default' });
    expect(validateCodexSpawn({ role: 'reviewer', model: 'gateway/other', prompt: 'x' }, inventory, config, catalog, supported, nativeContext('gateway/other'))).toMatchObject({ kind: 'route', upstreamModel: 'gateway/other', source: 'explicit' });
  });

  test('spawn bez modelu i bez roli z trasą to missing-selection', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    expect(validateCodexSpawn({ prompt: 'x' }, inventory, configFixture(), catalog, supported, nativeContext())).toMatchObject({ kind: 'error', code: 'missing-selection' });
  });

  test('profil bez zaliczonego M7 odmawia całego adaptera', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const profile: CapabilityProfile = { ...supported, status: 'pending', probes: { M7: 'failed' } };
    expect(validateCodexSpawn({ model: FIXTURE_MODEL_ID, prompt: 'x' }, inventory, configFixture(), catalog, profile, nativeContext())).toMatchObject({ kind: 'error', code: 'unsupported-path' });
  });

  test('present-but-invalid model nie spada do defaultu roli', async () => {
    const config = configFixture({ roles: { 'codex:reviewer': { routeOverride: FIXTURE_MODEL_ID } } });
    const catalog = buildCatalog(config, await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/raw-fast-id']));
    for (const model of [null, '', 42, 'fast', 'gateway/ghost'] as const) {
      expect(validateCodexSpawn({ role: 'reviewer', model }, inventory, config, catalog, supported, nativeContext())).toMatchObject({ kind: 'error', code: 'unknown-model' });
    }
  });

  test('rola z jawnym modelem wymaga M9 przed natywną precedencją', async () => {
    const config = configFixture({ roles: { 'codex:reviewer': { routeOverride: FIXTURE_MODEL_ID } } });
    const profile = { ...supported, probes: { ...supported.probes, M9: 'pending' } };
    const catalog = buildCatalog(config, await snapshotFixture());
    expect(validateCodexSpawn({ role: 'reviewer', model: FIXTURE_MODEL_ID }, inventory, config, catalog, profile, nativeContext())).toMatchObject({ kind: 'error', code: 'unsupported-path' });
  });
});

describe('codexHookOutput', () => {
  test('błąd daje deny z kodem, sukces nie wystawia allow ani updatedInput', () => {
    const denied = codexHookOutput({ kind: 'error', code: 'model-not-allowed', ignoredMarkers: 0 });
    expect(denied).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'subagent-router: model-not-allowed' } });
    expect(codexHookOutput({ kind: 'route', upstreamModel: 'x', source: 'explicit', ignoredMarkers: 0 })).toEqual({});
  });
});
```

- [ ] **Step 2: Skeleton and RED**

The skeleton returns `unsupported-path` and `{}`. Run `bun test ./tests/adapters/codex.test.ts`; expect failures on `toMatchObject` and `toEqual`.

- [ ] **Step 3: Implement**

`validateCodexSpawn` calls `assertCapability(profile, 'codex-native-runtime', context)`. The phase comes only from `NativeRuntimeContext`; `tool_input.lifecyclePhase` or a prompt field is ignored. A known phase checks its own evidence, and an unknown phase requires all five. Read the role from `args.role` or `args.agent`; if a role is given, it must exist in the inventory. Detect the presence of `model` with `Object.hasOwn`: `null`, an empty string, a non-string value, an alias, or an exact ID absent from `catalog.byId` set `explicitError: 'unknown-model'`, so they cannot fall through to the default. A missing model field remains a missing selection and only then can use the role or the global default. For a role plus an explicit model, also call `assertCapability(profile, 'codex-explicit-over-role', context)`. Only a valid exact ID goes into `explicitIds`. For `route`, require the authoritative native witness, matching expected and actual generation, the artifact hash, and `effectiveModel === decision.upstreamModel`. The default additionally requires M10-freshness and `context.freshDelegation === true`. Any missing piece gives `unsupported-path`.

`runCodexPreToolUseHook` reads a single JSON stdin, validates the event, matcher, and `tool_input`, fetches the context through `resolveNativeRuntimeContext`, writes only JSON to stdout, and ends with no output for other events. The unit tests `reads-stdin-writes-pretooluse-deny`, `deny-skips-stubbed-native-continuation`, `synthetic-positive-calls-stubbed-native-continuation`, `rejects-present-but-invalid-model-before-role-default`, `requires-native-witness-generation-and-artifact`, and `requires-m9-for-explicit-model-with-role` check the hook output and the continuation spy, run only by the external test driver after reading that output. The production hook does not call the continuation. They do not run Codex and do not prove the absence of a native request. A real denial and a child request count of zero belong only to the opt-in M7 with a running client and a capture gateway. The entry point uses no AI SDK and creates no runtime.

- [ ] **Step 4: GREEN and full suite**

```bash
bun test ./tests/adapters/codex.test.ts ./tests/adapters/codex-hook.test.ts && bun run typecheck && bun test
```

Expected: all described cases pass, 0 fail globally.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/codex.ts src/adapters/codex-hook.ts tests/adapters/codex.test.ts tests/adapters/codex-hook.test.ts
git commit -m "feat: add Codex spawn validation hook logic"
```

### Task 12: Read-only CLI, route preview, and offline diagnostics

**Files:**
- Create: `src/cli/args.ts`
- Create: `src/cli/output.ts`
- Create: `src/cli/read.ts`
- Create: `src/cli/main.ts`
- Test: `tests/cli/read.test.ts`

**Interfaces:**
- Consumes: `loadState`, `buildCatalog`, `resolveModel`, `resolveRoute`, `readAgentInventory`, `getAgent`, `loadCapabilityProfile`, `resolveSource`, `validateSource`, typ `CliDeps`.
- Produces: `parseArgs(argv: readonly string[]): ParsedArgs` z `ParsedArgs = { command: string[]; options: Record<string, string | boolean>; positionals: string[] }`; `render(deps: CliDeps, payload: unknown, human: () => string): void`; `previewRoute(options: { client: ClientId; agent: string; model?: string; parentModel?: string }, state: LoadedState, inventory: AgentInventory, profile: CapabilityProfile): { mode: 'simulation'; generation: string; assumptions: { authenticatedChild: true; freshDelegation: true; runtimeCapabilityNotProven: true }; decision: RouteDecision; agent: { name: string; declaredModel: string | 'unknown'; scope: string } }`; `runCli(argv: readonly string[], deps: CliDeps): Promise<0 | 1 | 2>`.

Commands for this task: `models list`, `models show <id-or-alias>`, `agents list --client <c>`, `agents show <name> --client <c>`, `route preview --client <c> --agent <name> [--model <ref>] [--parent-model <m>]`, `config show`, `config check`, `doctor` (offline). `config check`, the export sidecar, and offline preview check files and references, but are never proof that the native runtime loaded the effective configuration or applied the default. The argument parser uses `parseArgs` from `node:util`, available in Bun and Node. Global options: `--config`, `--json`, `--no-color`, `--agents-dir` (repeatable), `--help`, `--version`. The default config is `<cwd>/subagent-router.json`. JSON output goes entirely to stdout; diagnostics go to stderr. Exit codes: 0 success, 1 operational error (`RouterError` from I/O or network), 2 usage, configuration, or selection error. Every string from the catalog, a description, or an agent name goes through `escapeControl` (control characters and ANSI sequences turned into `\uXXXX`) before being printed in text mode.

- [ ] **Step 1: Write failing read tests with fake dependencies**

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main';
import type { CliDeps } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

let dir = '';
let out: string[] = [];
let err: string[] = [];

function deps(patch: Partial<CliDeps> = {}): CliDeps {
  return {
    cwd: dir,
    home: join(dir, 'home'),
    env: { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 'secret-token', ROUTER_SECRET: 'hook-secret' },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    isTTY: false,
    fetch: async () => { throw new Error('sieć zabroniona w testach odczytu'); },
    fetchAdapter: { id: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic' },
    loadProfile: async (client, version) => ({ client, version, status: 'pending', correlation: false, correlationEntropy: 'pending', fork: false, adapterMarkerPosition: 'unknown', probes: {}, lifecycle: { 'next-turn': 'pending', resume: 'pending', compaction: 'pending', nested: 'pending', parallel: 'pending' } }),
    loadTransportProfile: async (adapterId, runtimeVersion) => ({ adapterId, runtimeVersion, status: 'pending', gzipBytes: 'pending', responseHeaders: 'pending' }),
    now: () => new Date('2026-09-06T12:00:00.000Z'),
    ...patch,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-cli-'));
  out = [];
  err = [];
  await mkdir(join(dir, 'home', '.claude', 'agents'), { recursive: true });
  await writeFile(join(dir, 'home', '.claude', 'agents', 'explorer.md'), '---\nname: explorer\nmodel: inherit\n---\nSzukaj.\n');
  await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(configFixture()));
  await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/undescribed'])));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function lastJson(): Record<string, unknown> {
  return JSON.parse(out.join('')) as Record<string, unknown>;
}

describe('read-only CLI', () => {
  test('models list --json pokazuje status, alias i brak opisu bez sięgania do sieci', async () => {
    expect(await runCli(['models', 'list', '--json'], deps())).toBe(0);
    const rows = lastJson().models as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.id, r.alias, r.status, r.description ?? null])).toEqual([
      [FIXTURE_MODEL_ID, 'fast', 'available', 'Szybkie zadania.'],
      ['gateway/undescribed', rows[1]?.alias, 'available', null],
    ]);
    expect(lastJson().fetchedAt).toBe('2026-09-06T00:00:00.000Z');
  });

  test('models show akceptuje alias, zwraca dokładne ID i nie normalizuje wielkości liter', async () => {
    expect(await runCli(['models', 'show', 'fast', '--json'], deps())).toBe(0);
    expect(lastJson().id).toBe(FIXTURE_MODEL_ID);
    out = [];
    expect(await runCli(['models', 'show', 'Fast', '--json'], deps())).toBe(2);
    expect(err.join('')).toContain('unknown-model');
  });

  test('agents show pokazuje declaredModel inherit, scope i router override', async () => {
    expect(await runCli(['agents', 'show', 'explorer', '--client', 'claude-code', '--json'], deps())).toBe(0);
    expect(lastJson()).toMatchObject({ name: 'explorer', declaredModel: 'inherit', scope: 'user', routeOverride: FIXTURE_MODEL_ID });
  });

  test('route preview symuluje decyzję z generacją plików, bez uruchamiania agenta i sieci', async () => {
    expect(await runCli(['route', 'preview', '--client', 'claude-code', '--agent', 'explorer', '--json'], deps())).toBe(0);
    const preview = lastJson();
    expect(preview.mode).toBe('simulation');
    expect(preview.assumptions).toEqual({ authenticatedChild: true, freshDelegation: true, runtimeCapabilityNotProven: true });
    expect(typeof preview.generation).toBe('string');
    expect(preview.decision).toMatchObject({ kind: 'route', upstreamModel: FIXTURE_MODEL_ID, source: 'role-default' });
    out = [];
    expect(await runCli(['route', 'preview', '--client', 'claude-code', '--agent', 'explorer', '--model', 'gateway/undescribed', '--json'], deps())).toBe(0);
    expect(lastJson().decision).toMatchObject({ kind: 'route', upstreamModel: 'gateway/undescribed', source: 'explicit' });
  });

  test('config show ukrywa wartości nagłówków i sekretów, także w JSON', async () => {
    expect(await runCli(['config', 'show', '--json'], deps())).toBe(0);
    const text = out.join('');
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain('hook-secret');
    expect(text).toContain('MODELS_AUTH');
  });

  test('config check zgłasza trasę do nieistniejącej roli i kończy kodem 2', async () => {
    const broken = configFixture({ roles: { 'claude-code:nobody': { routeOverride: FIXTURE_MODEL_ID } } });
    await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(broken));
    expect(await runCli(['config', 'check', '--json'], deps())).toBe(2);
    expect(JSON.stringify(lastJson().problems)).toContain('claude-code:nobody');
  });

  test('brak snapshotu nie blokuje agents list, ale blokuje preview z instrukcją sync', async () => {
    await rm(join(dir, 'models.lock.json'));
    expect(await runCli(['agents', 'list', '--client', 'claude-code', '--json'], deps())).toBe(0);
    out = [];
    expect(await runCli(['route', 'preview', '--client', 'claude-code', '--agent', 'explorer', '--json'], deps())).toBe(2);
    expect(err.join('')).toContain('models sync');
  });

  test('tryb tekstowy bez TTY nie zawiera ANSI, a znaki sterujące z opisu są escapowane', async () => {
    const config = configFixture();
    config.modelOverrides[FIXTURE_MODEL_ID] = { alias: 'fast', description: 'zły[31m opis' };
    await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(config));
    expect(await runCli(['models', 'list'], deps())).toBe(0);
    expect(out.join('')).not.toContain('');
    expect(out.join('')).toContain('\\u001b');
  });

  test('doctor offline raportuje stan configured, measured i pending bez sieci', async () => {
    expect(await runCli(['doctor', '--json'], deps())).toBe(0);
    const report = lastJson();
    expect(report.network).toBe(false);
    expect((report.clients as Array<Record<string, unknown>>).map((c) => c.status)).toEqual(['pending', 'pending', 'pending']);
  });

  test('nieznana komenda i błędne użycie dają kod 2 z pomocą na stderr', async () => {
    expect(await runCli(['models', 'explode'], deps())).toBe(2);
    expect(err.join('')).toContain('models');
  });
});
```

The base profile versions for `doctor` come from `tests/fixtures/capabilities` in tests and from the `capabilities` directory in the package at runtime; a missing profile for a detected version is reported as `unknown`, not as `supported`.

- [ ] **Step 2: Skeleton and RED**

The `runCli` skeleton returns `1` and writes nothing. Run `bun test ./tests/cli/read.test.ts`; expect failures on exit code and empty stdout.

- [ ] **Step 3: Implement the parser, output, and commands**

`args.ts`: `parseArgs` from `node:util` with options `config`, `json`, `no-color`, `agents-dir` (multiple), `client`, `agent`, `model`, `parent-model`, `help`, `version`, `allowUnknown: false`; the first two positionals are the command. `output.ts`: `escapeControl`, `render` choosing JSON or text, no ANSI when `!deps.isTTY` or `--no-color`. `read.ts`: one function per command, each returning `{ code, payload, human }`; `previewRoute` builds a `RouteInput` with `scope: 'child'`, `role` from `client:agent`, `explicitIds` from `--model` (alias mapped through the catalog), `roleDefaultId` from the roles, `clientModel` from `--parent-model`, and explicitly `freshDelegation: true` as a simulation assumption, then calls `resolveRoute`. The result always has `mode: 'simulation'`, `generation` from `LoadedState`, and `assumptions: { authenticatedChild: true, freshDelegation: true, runtimeCapabilityNotProven: true }`. It is not a runtime profile and not proof of M10-freshness. `main.ts`: error mapping: a `RouterError` with a code starting with `config-`, `snapshot-`, `unknown-model`, `agent-unknown`, `usage-` gives 2; other `RouterError`s give 1; an unknown exception gives 1 with a message and no stack.

- [ ] **Step 4: GREEN**

```bash
bun test ./tests/cli/read.test.ts
```

Expected: 10 pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/args.ts src/cli/output.ts src/cli/read.ts src/cli/main.ts tests/cli/read.test.ts
git commit -m "feat: add read-only CLI with route preview and doctor"
```

### Task 13: Write commands: sync, describe, export, doctor --connect, and serve

**Files:**
- Create: `src/cli/write.ts`
- Create: `src/cli/serve.ts`
- Create: `src/agents/export.ts`
- Modify: `src/cli/main.ts` (tylko dispatch nowych komend)
- Test: `tests/cli/write.test.ts`
- Test: `tests/cli/export.test.ts`
- Test: `tests/cli/serve.test.ts`

**Interfaces:**
- Consumes: `synchronize`, `loadState`, `commitState`, `opencodeVariants`, `readAgentInventory`, `createHandler`, `createClaudeStartOutput`, `runClaudeSubagentStartHook`, `createOpenCodePlugin`, `runCodexPreToolUseHook`, `discoverModels`, `resolveSource`.
- Produces: `describeModel(configPath: string, reference: string, description: string | null): Promise<void>`; `exportConfig(configPath: string, client: ClientId, outputDir: string, options: { dryRun: boolean; force: boolean; inventory: AgentInventory; catalogRequired: boolean }): Promise<ExportFile[]>`; `startServer(configPath: string, deps: CliDeps, options: { port: number; host: string }): Promise<{ url: string; generation: string; stop: () => Promise<void> }>`; `dumpToml(value: Record<string, unknown>): string` w `src/agents/export.ts`.

`exportConfig` calls `loadState` itself and derives `snapshotGeneration`, `configHash`, and `snapshotHash` from that single validated state. It does not accept a generation from the caller. It first builds the complete file plan with the target absolute paths or named operator env references, hashes the exact bytes of the planned artifacts, and only then atomically publishes the whole set into the output directory. The sidecar is outside the native schema.

TOML serialization: `Bun.TOML.stringify` does not exist in Bun 1.3.11 (measured). The Codex export uses its own `dumpToml` handling only strings, numbers, booleans, string arrays, and one layer of tables; any other value throws `RouterError('export-unsupported-value')`. A roundtrip test parses the result with `Bun.TOML.parse` and compares it with the input. Do not add a runtime dependency for TOML.

- [ ] **Step 1: Write failing tests for the write commands**

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main';
import { sha256 } from '../../src/core/hash';
import type { CapabilityProfile, CliDeps, FetchLike } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

let dir = '';
let out: string[] = [];
let err: string[] = [];

function listing(ids: string[]): FetchLike {
  return async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
}

function deps(fetch: FetchLike): CliDeps {
  return {
    cwd: dir, home: join(dir, 'home'),
    env: { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 'secret-token', ROUTER_SECRET: 'hook-secret' },
    stdout: (t) => out.push(t), stderr: (t) => err.push(t), isTTY: false, fetch,
    fetchAdapter: { id: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic' },
    loadProfile: async (client, version) => ({ client, version, status: 'pending', correlation: false, correlationEntropy: 'pending', fork: false, adapterMarkerPosition: 'unknown', probes: {}, lifecycle: { 'next-turn': 'pending', resume: 'pending', compaction: 'pending', nested: 'pending', parallel: 'pending' } }),
    loadTransportProfile: async (adapterId, runtimeVersion) => ({ adapterId, runtimeVersion, status: 'pending', gzipBytes: 'pending', responseHeaders: 'pending' }),
    now: () => new Date('2026-09-06T12:00:00.000Z'),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-write-'));
  out = [];
  err = [];
  await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(configFixture()));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('models sync', () => {
  test('dry-run pokazuje diff i nie tworzy snapshotu', async () => {
    expect(await runCli(['models', 'sync', '--dry-run', '--json'], deps(listing(['a'])))).toBe(0);
    expect(JSON.parse(out.join('')).added).toEqual(['a']);
    await expect(readFile(join(dir, 'models.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('pusta lista bez allow-empty kończy się kodem 1 i bez pliku', async () => {
    expect(await runCli(['models', 'sync'], deps(listing([])))).toBe(1);
    expect(err.join('')).toContain('sync-empty');
    await expect(readFile(join(dir, 'models.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('błąd auth nie wypisuje tokenu i zachowuje poprzedni snapshot', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    const before = await sha256(await readFile(join(dir, 'models.lock.json'), 'utf8'));
    const unauthorized: FetchLike = async () => new Response('nope', { status: 401 });
    expect(await runCli(['models', 'sync'], deps(unauthorized))).toBe(1);
    expect(err.join('')).not.toContain('secret-token');
    expect(await sha256(await readFile(join(dir, 'models.lock.json'), 'utf8'))).toBe(before);
  });
});

describe('models describe', () => {
  test('zapisuje opis w modelOverrides po dokładnym ID, nie w snapshotcie', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/other'])));
    const snapshotBefore = await readFile(join(dir, 'models.lock.json'), 'utf8');
    expect(await runCli(['models', 'describe', 'gateway/other', '--text', 'Wolny, dokładny.'], deps(listing([])))).toBe(0);
    const config = JSON.parse(await readFile(join(dir, 'subagent-router.json'), 'utf8'));
    expect(config.modelOverrides['gateway/other']).toEqual({ description: 'Wolny, dokładny.' });
    expect(await readFile(join(dir, 'models.lock.json'), 'utf8')).toBe(snapshotBefore);
  });

  test('tryby --text, --file i --clear są rozłączne, a --clear usuwa tylko opis', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    expect(await runCli(['models', 'describe', 'fast', '--text', 'a', '--clear'], deps(listing([])))).toBe(2);
    expect(await runCli(['models', 'describe', 'fast', '--clear'], deps(listing([])))).toBe(0);
    const config = JSON.parse(await readFile(join(dir, 'subagent-router.json'), 'utf8'));
    expect(config.modelOverrides[FIXTURE_MODEL_ID]).toEqual({ alias: 'fast', enabled: true, clientModel: 'haiku' });
  });

  test('opis modelu missing jest zapisywany, ale model pozostaje nieaktywny', async () => {
    const snapshot = await snapshotFixture([FIXTURE_MODEL_ID]);
    (snapshot.models[0] as { status: string }).status = 'missing';
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(snapshot));
    expect(await runCli(['models', 'describe', FIXTURE_MODEL_ID, '--text', 'nowy'], deps(listing([])))).toBe(0);
    out = [];
    expect(await runCli(['models', 'show', FIXTURE_MODEL_ID, '--json'], deps(listing([])))).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ description: 'nowy', status: 'missing', enabled: false });
  });

  test('równoległa zmiana configu między odczytem a zapisem jest odrzucona', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    const racingFetch: FetchLike = async () => new Response('{}', { status: 200 });
    const racing = deps(racingFetch);
    const original = racing.now;
    racing.now = () => {
      void writeFile(join(dir, 'subagent-router.json'), JSON.stringify(configFixture({ defaults: { child: null, unmarkedSubagent: 'error' } })) + '\n');
      return original();
    };
    const code = await runCli(['models', 'describe', 'fast', '--text', 'x'], racing);
    expect([0, 1]).toContain(code);
    if (code === 1) expect(err.join('')).toContain('store-conflict');
  });
});
```

The last test is non-deterministic in the `now` version; the implementer replaces it with a deterministic unit test of `commitState` with a `base` that has a stale hash, as in Task 4, and checks in the CLI only the mapping of `store-conflict` to exit code 1 with a message. Do not leave a test based on a race.

- [ ] **Step 2: Write failing export tests**

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dumpToml } from '../../src/agents/export';
import { runCli } from '../../src/cli/main';
import type { CliDeps } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

let dir = '';
let out: string[] = [];
let err: string[] = [];

function deps(): CliDeps {
  return {
    cwd: join(dir, 'project'), home: join(dir, 'home'),
    env: { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 't', ROUTER_SECRET: 's' },
    stdout: (t) => out.push(t), stderr: (t) => err.push(t), isTTY: false,
    fetch: async () => { throw new Error('sieć zabroniona'); },
    fetchAdapter: { id: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic' },
    loadProfile: async (client, version) => ({ client, version, status: 'pending', correlation: false, correlationEntropy: 'pending', fork: false, adapterMarkerPosition: 'unknown', probes: {}, lifecycle: { 'next-turn': 'pending', resume: 'pending', compaction: 'pending', nested: 'pending', parallel: 'pending' } }),
    loadTransportProfile: async (adapterId, runtimeVersion) => ({ adapterId, runtimeVersion, status: 'pending', gzipBytes: 'pending', responseHeaders: 'pending' }),
    now: () => new Date(),
  };
}

async function treeHash(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const entry of (await readdir(root, { recursive: true, withFileTypes: true })).filter((e) => e.isFile())) {
    const path = join(entry.parentPath ?? entry.path, entry.name);
    hash.update(path).update(await readFile(path));
  }
  return hash.digest('hex');
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-export-'));
  out = [];
  err = [];
  await mkdir(join(dir, 'project', '.opencode', 'agents'), { recursive: true });
  await mkdir(join(dir, 'home', '.codex', 'agents'), { recursive: true });
  await writeFile(join(dir, 'project', '.opencode', 'agents', 'reviewer.md'), '---\ndescription: Przegląd\nmodel: inherit\n---\nSprawdzaj.\n');
  await writeFile(join(dir, 'home', '.codex', 'agents', 'reviewer.toml'), 'name = "reviewer"\nmodel = "gateway/base"\n');
  await writeFile(join(dir, 'project', 'subagent-router.json'), JSON.stringify(configFixture({ roles: { 'codex:reviewer': { routeOverride: FIXTURE_MODEL_ID } } })));
  await writeFile(join(dir, 'project', 'models.lock.json'), JSON.stringify(await snapshotFixture()));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('config export', () => {
  test('eksport OpenCode zapisuje wariant do katalogu artefaktów i nie zmienia natywnych plików', async () => {
    const before = await treeHash(join(dir, 'project', '.opencode'));
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', join(dir, 'out'), '--json'], deps())).toBe(0);
    expect(await readFile(join(dir, 'out', 'opencode', 'agents', 'reviewer@fast.md'), 'utf8')).toContain('model: gateway/gateway/fast-worker');
    expect(await treeHash(join(dir, 'project', '.opencode'))).toBe(before);
  });

  test('eksport Codex generuje rolę TOML z routeOverride, którą Bun.TOML.parse czyta z powrotem', async () => {
    expect(await runCli(['config', 'export', '--client', 'codex', '--output', join(dir, 'out'), '--json'], deps())).toBe(0);
    const parsed = Bun.TOML.parse(await readFile(join(dir, 'out', 'codex', 'agents', 'reviewer.toml'), 'utf8')) as { model: string };
    expect(parsed.model).toBe(FIXTURE_MODEL_ID);
  });

  test('katalog źródłowy agentów i symlink do niego są odrzucane także z --force', async () => {
    const native = join(dir, 'project', '.opencode', 'agents');
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', native, '--force'], deps())).toBe(2);
    await symlink(native, join(dir, 'link'));
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', join(dir, 'link'), '--force'], deps())).toBe(2);
    expect(err.join('')).toContain('export-native-root');
  });

  test('kolizja artefaktu wymaga --force, a --dry-run niczego nie zapisuje', async () => {
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', join(dir, 'out'), '--dry-run', '--json'], deps())).toBe(0);
    await expect(readdir(join(dir, 'out'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', join(dir, 'out')], deps())).toBe(0);
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', join(dir, 'out')], deps())).toBe(2);
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', join(dir, 'out'), '--force'], deps())).toBe(0);
  });
});

describe('dumpToml', () => {
  test('roundtrip przez Bun.TOML.parse dla obsługiwanego podzbioru', () => {
    const value = { name: 'reviewer', model: 'gateway/x y', enabled: true, depth: 2, tags: ['a', 'b'], limits: { max: 3 } };
    expect(Bun.TOML.parse(dumpToml(value))).toEqual(value);
  });

  test('nieobsługiwana wartość rzuca RouterError', () => {
    expect(() => dumpToml({ nested: { deeper: { x: 1 } } })).toThrow('export-unsupported-value');
  });
});
```

Add the export tests `exports-claude-settings-fragment-with-read-only-subagentstart-hook-wiring`, `exports-opencode-plugin-entrypoint-and-tool-execute-before-wiring`, `exports-codex-pretooluse-stdin-stdout-hook-wiring`, and `sidecars-hash-the-actual-atomic-export-plan`. The Claude fragment points to the absolute path of the built `claude-hook` entrypoint, an absolute control URL passed by the operator or a named env reference, an absolute config, sidecar, and profile path, and only env names for the secret. It does not modify the active settings. The OpenCode fragment points to the absolute plugin entrypoint and a read-only metadata sidecar with `providerId`, the exact `upstreamModel`, generation, and artifact hashes. The Codex fragment points to an executable stdin/stdout hook with the `Agent` matcher, absolute paths to the program, config, sidecar, and profile. No fragment contains a secret.

When an offline export or `config check` cannot read the active effective configuration, it shows `unknown`, not runtime proof. Only M6-runtime or M7 with a real client can confirm the native resolver. The atomic plan test computes the expected hashes from the bytes of each final `ExportFile`, compares the sidecar, and checks that an error before the rename does not publish a partial set. All tests compare the hash of native files before and after the export.

- [ ] **Step 3: Write a failing serve test**

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/cli/serve';
import type { CapabilityProfile, CliDeps, FetchLike } from '../../src/core/types';
import { startCaptureGateway } from '../support/capture-gateway';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-serve-'));
  await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(configFixture()));
  await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('serve', () => {
  test('używa generacji z chwili startu i nie widzi późniejszej zmiany opisu', async () => {
    const gateway = await startCaptureGateway();
    const fetchLike: FetchLike = (request) => fetch(request);
    const deps: CliDeps = {
      cwd: dir, home: dir,
      env: { GATEWAY_URL: `${gateway.url}/v1`, GATEWAY_HEADERS: '{}', MODELS_AUTH: 't', ROUTER_SECRET: 's' },
      stdout: () => {}, stderr: () => {}, isTTY: false, fetch: fetchLike,
      fetchAdapter: { id: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic' },
      loadProfile: async () => ({ client: 'claude-code', version: 'synthetic-hermetic', status: 'supported', correlation: false, correlationEntropy: 'pending', fork: false, adapterMarkerPosition: 'unknown', probes: { M10: 'passed' }, lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' } }),
      loadTransportProfile: async () => ({ adapterId: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic', status: 'passed', gzipBytes: 'passed', responseHeaders: 'passed' }),
      now: () => new Date(),
    };
    const server = await startServer(join(dir, 'subagent-router.json'), deps, { port: 0, host: '127.0.0.1' });
    try {
      const changed = configFixture();
      changed.modelOverrides[FIXTURE_MODEL_ID] = { alias: 'quick', description: 'zmienione' };
      await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(changed));
      const response = await fetch(`${server.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku', system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }], messages: [{ role: 'user', content: '<subagent-router v="1" model="fast"/>\nZadanie' }] }),
      });
      expect(response.status).toBe(200);
      expect(gateway.requests[0]?.model).toBe(FIXTURE_MODEL_ID);
      expect(typeof server.generation).toBe('string');
    } finally {
      await server.stop();
      await gateway.close();
    }
  });
});
```

- [ ] **Step 4: Skeletons and RED**

Skeletons: `describeModel` and `exportConfig` do nothing, `startServer` starts a server returning 501, `dumpToml` returns an empty string. Run the three test files; expect failures on reading files, exit codes, and status 200.

- [ ] **Step 5: Implement**

`describeModel`: `loadState`, resolve the reference through the catalog, or, when the snapshot contains the ID with status `missing`, through `snapshot.models`; write `modelOverrides[id].description` or delete the key on `null`, leaving other fields alone; `commitState` with `config`.

`exportConfig` first loads and validates the state, and takes the generation from `LoadedState`. It resolves `outputDir` through the `realpath` of the parent directory and compares it with the realpath of all native roots; a match or containment gives `export-native-root` regardless of `force`. It builds the whole plan in memory, records absolute paths for the program, config, profile, and sidecar, or explicit operator env references without secret values, hashes the final artifact bytes, and then publishes the set through a staging directory and an atomic rename. `dryRun` returns the plan without writing.

For Claude, generate a read-only settings fragment with `SubagentStart` pointing to the built `dist/claude-hook.js`, a control URL reference, the config path, the profile path, and `secretEnv`. Do not change the active settings. For OpenCode, use the variants, the sidecar, and a fragment registering `dist/opencode-plugin.js` as `tool.execute.before`. For Codex, generate the roles, an optional directory, a sidecar, and a `PreToolUse` fragment with the `Agent` matcher pointing to `dist/codex-hook.js`. The sidecars contain the loaded configHash, snapshotHash, snapshotGeneration, and the final artifact hashes, but do not prove a native load.

`startServer` calls `loadState`, `resolveSource`, `validateSource`, then the explicit dependencies `deps.loadProfile` and `deps.loadTransportProfile` for `deps.fetchAdapter`. There is no production trust-me env flag forcing `supported`. The built-in profiles stay pending until Task 15 records real evidence. Hermetic tests inject `synthetic-hermetic` profiles. `startServer` passes both profiles to `createHandler`, along with the identity of `deps.fetchAdapter`, the clock, and nonce/instanceId generators based on `crypto.randomUUID`. The default trusted context has an unknown phase and `freshDelegation: false`; it never comes from the body. Only the measured control channel supplies freshness. `createHandler` checks the transport profile at startup; the same handler then goes to `Bun.serve`. The embed application imports exactly the same `createHandler`, with no additional implementation. `doctor --connect` performs only first-party discovery, with no writes. `main.ts` adds only the dispatch.

- [ ] **Step 6: GREEN and full suite**

```bash
bun test ./tests/cli/write.test.ts ./tests/cli/export.test.ts ./tests/cli/serve.test.ts && bun run typecheck && bun test
```

Expected: all pass, 0 fail globally.

- [ ] **Step 7: Commit**

```bash
git add src/cli/write.ts src/cli/serve.ts src/agents/export.ts src/cli/main.ts tests/cli
git commit -m "feat: add sync, describe, export and serve commands"
```

### Task 14: A single package, importing the core outside Bun, and a CLI smoke test

**Files:**
- Create: `src/index.ts`
- Create: `src/bun.ts`
- Create: `scripts/build.ts`
- Modify: `package.json` (pola `exports`, `bin`, `files`)
- Create: `tests/support/run-built-entrypoints.ts`
- Test: `tests/package.test.ts`

**Interfaces:**
- Consumes: all modules from earlier tasks.
- Produces: the `./core` export (`src/index.ts`: types, `resolveRoute`, `buildCatalog`, `resolveModel`, `parseOperatorConfig`, `parseSnapshot`, `sha256`, `modelAlias`, `sourceFingerprint`, `RouterError`), the `./handler` export (`createHandler`, `createClaudeStartOutput`), the executable exports `./claude-hook`, `./opencode-plugin`, `./codex-hook`, the `./bun` export (`runCli`, `startServer`, adapters, inventory); `bin.subagent-router` points to `dist/cli.js`. The package also contains capability profiles and export templates with explicit config/sidecar/profile paths.

- [ ] **Step 1: Write a failing package test**

```ts
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

function run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe('package', () => {
  test('build tworzy dist z ESM i deklaracjami', async () => {
    const built = await run('bun', ['run', 'build']);
    expect(built.code).toBe(0);
    expect(await readFile(join(ROOT, 'dist', 'core.js'), 'utf8')).toContain('resolveRoute');
    expect(await readFile(join(ROOT, 'dist', 'types', 'index.d.ts'), 'utf8')).toContain('RouteDecision');
  });

  test('rdzeń importuje się w Node bez Bun i podejmuje decyzję', async () => {
    const script = `import('./dist/core.js').then(async (m) => { const alias = await m.modelAlias('gateway/fast-worker'); console.log(JSON.stringify({ alias, kind: typeof m.resolveRoute })); })`;
    const result = await run('node', ['--input-type=module', '-e', script]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ alias: 'm-6414d01405c95a7bd2b2a13b415d7685a1673f800ca90dd031a5eeb1776dc81d', kind: 'function' });
  });

  test('dist/core.js nie zawiera odwołań do Bun ani do node:fs', async () => {
    const core = await readFile(join(ROOT, 'dist', 'core.js'), 'utf8');
    expect(core.includes('Bun.')).toBe(false);
    expect(core.includes('node:fs')).toBe(false);
  });

  test('CLI odpowiada na --version i --help z kodem 0, a nieznana komenda kodem 2', async () => {
    expect((await run('bun', ['dist/cli.js', '--version'])).code).toBe(0);
    expect((await run('bun', ['dist/cli.js', '--help'])).stdout).toContain('models sync');
    expect((await run('bun', ['dist/cli.js', 'nope'])).code).toBe(2);
  });

  test('build zawiera trzy wykonywalne entrypointy adapterów i uruchamia je na fixtures', async () => {
    for (const file of ['claude-hook.js', 'opencode-plugin.js', 'codex-hook.js']) {
      expect((await readFile(join(ROOT, 'dist', file), 'utf8')).length).toBeGreaterThan(0);
    }
    const smoke = await run('bun', ['tests/support/run-built-entrypoints.ts']);
    expect(smoke).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(smoke.stdout)).toEqual({ claude: 'synthetic-deny', opencode: 'synthetic-deny', codex: 'synthetic-deny' });
  });
});
```

- [ ] **Step 2: RED**

Without `scripts/build.ts`, the `bun run build` command fails; the test fails on `toBe(0)`. This is an assertion failure on the exit code, not on importing the test module.

- [ ] **Step 3: Implement the build and exports**

`scripts/build.ts` runs `Bun.build` with the basic entry points (`src/index.ts` to `dist/core.js`, `src/transport/handler.ts` to `dist/handler.js`, `src/bun.ts` to `dist/cli.js` with `target: 'bun'` and the shebang `#!/usr/bin/env bun`), `target: 'node'` for the core and the handler, `format: 'esm'`, no `splitting`; then `Bun.spawn(['bunx', 'tsc', '-p', 'tsconfig.json'])` for the declarations. `package.json` adds `exports` for `./core`, `./handler`, `./bun`, the `bin` field, `files: ['dist']`, `sideEffects: false`. `src/bun.ts` calls `runCli(process.argv.slice(2), realDeps())` only when `import.meta.main`. The build additionally maps `src/transport/claude-hook.ts` to `dist/claude-hook.js`, `src/adapters/opencode-plugin.ts` to `dist/opencode-plugin.js`, and `src/adapters/codex-hook.ts` to `dist/codex-hook.js`, along with declarations and the subpath exports `./claude-hook`, `./opencode-plugin`, `./codex-hook`. The hooks have a stdin/stdout entrypoint, and the plugin exports a module matching the measured OpenCode API. The smoke driver `tests/support/run-built-entrypoints.ts` runs the built hooks with synthetic stdin and imports the plugin with a test host. It checks the actual denial JSON or the absence of a freshness proof, plus a positive control for allowed input; the `synthetic-deny` labels come from these assertions, not from a fixed printout. It does not run native agents.

- [ ] **Step 4: GREEN**

```bash
bun test ./tests/package.test.ts && bun run typecheck && bun test
```

Expected: all described cases pass, 0 fail globally. The `dist` directory is in `.gitignore`.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/bun.ts scripts/build.ts package.json .gitignore tests/package.test.ts tests/support/run-built-entrypoints.ts
git commit -m "build: package core, handler and CLI entrypoints"
```

### Task 15: Integration gate, measurements M1 through M10, and block documentation

**Files:**
- Create: `tests/e2e/routing.test.ts`
- Create: `tests/e2e/cli-workflow.test.ts`
- Create: `docs/core/README.md`, `docs/core/CONTRACTS.md`, `docs/core/INVARIANTS.md`, `docs/core/GAPS.md`, `docs/core/OPERATIONS.md`
- Create: five analogous files in `docs/catalog`, `docs/agents`, `docs/transport`, `docs/cli`
- Modify: `docs/README.md`, `README.md`
- Modify: `tests/fixtures/capabilities/*.json` (only results from real trials)
- Modify: `tests/probes/evidence.test.ts` (validation of the M8 artifact)
- Create: `tests/e2e/native-routing.test.ts` (opt-in harnesses only)

**Interfaces:**
- Consumes: the whole package, `startCaptureGateway`, `tests/probes/run.ts`.
- Produces: a hermetic E2E test on a fake gateway, an opt-in test on real harnesses, a support matrix, and block documentation with the real evidence scope.

- [ ] **Step 1: Write the hermetic E2E test**

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/cli/serve';
import type { CliDeps } from '../../src/core/types';
import { startCaptureGateway } from '../support/capture-gateway';
import { configFixture, snapshotFixture } from '../support/fixtures';

const CHILD_SYSTEM = [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }];
let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-e2e-'));
  const config = configFixture();
  config.modelOverrides['gateway/model B'] = { alias: 'b', description: 'B' };
  config.modelOverrides['gateway/Model-C'] = { alias: 'c', description: 'C' };
  await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(config));
  await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture(['gateway/fast-worker', 'gateway/model B', 'gateway/Model-C'])));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

function syntheticE2eDeps(gatewayUrl: string): CliDeps {
  return {
    cwd: dir, home: dir,
    env: { GATEWAY_URL: `${gatewayUrl}/v1`, GATEWAY_HEADERS: '{}', MODELS_AUTH: 't', ROUTER_SECRET: 's' },
    stdout: () => {}, stderr: () => {}, isTTY: false,
    fetch: (request) => fetch(request),
    fetchAdapter: { id: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic' },
    loadProfile: async () => ({
      client: 'claude-code', version: 'synthetic-hermetic', status: 'supported',
      correlation: false, correlationEntropy: 'pending', fork: false,
      adapterMarkerPosition: 'unknown', probes: { M10: 'passed' },
      lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' },
    }),
    loadTransportProfile: async (adapterId, runtimeVersion) => ({ adapterId, runtimeVersion, status: 'passed', gzipBytes: 'passed', responseHeaders: 'passed' }),
    now: () => new Date(),
  };
}

describe('e2e routing przez fake gateway', () => {
  test('rodzic A oraz równoczesne dzieci B i C trafiają do właściwych modeli, marker nie wycieka', async () => {
    const gateway = await startCaptureGateway();
    const deps = syntheticE2eDeps(gateway.url);
    const server = await startServer(join(dir, 'subagent-router.json'), deps, { port: 0, host: '127.0.0.1' });
    try {
      await Promise.all([
        post(server.url, { model: 'claude-opus', messages: [{ role: 'user', content: 'rodzic' }] }),
        post(server.url, { model: 'claude-haiku', system: CHILD_SYSTEM, messages: [{ role: 'user', content: '<subagent-router v="1" model="b"/>\nB' }] }, { 'x-claude-code-agent-id': 'agent-b' }),
        post(server.url, { model: 'claude-haiku', system: CHILD_SYSTEM, messages: [{ role: 'user', content: '<subagent-router v="1" model="c"/>\nC' }] }, { 'x-claude-code-agent-id': 'agent-c' }),
      ]);
      const models = gateway.requests.map((r) => r.model).sort();
      expect(models).toEqual(['claude-opus', 'gateway/Model-C', 'gateway/model B']);
      expect(JSON.stringify(gateway.requests.map((r) => r.body))).not.toContain('subagent-router');
    } finally {
      await server.stop();
      await gateway.close();
    }
  });

  test('syntetyczny roundtrip zachowuje tool_use, tool_result i model transportu', async () => {
    const gateway = await startCaptureGateway();
    const deps = syntheticE2eDeps(gateway.url);
    const server = await startServer(join(dir, 'subagent-router.json'), deps, { port: 0, host: '127.0.0.1' });
    try {
      const first = await post(server.url, { model: 'claude-haiku', system: CHILD_SYSTEM, messages: [{ role: 'user', content: '<subagent-router v="1" model="b"/>\nUżyj narzędzia' }], tools: [{ name: 'read_fixture', input_schema: { type: 'object' } }] }, { 'x-claude-code-agent-id': 'agent-b' });
      const firstBody = await first.json() as { content: Array<{ type: string; id?: string; name?: string }> };
      const toolUse = firstBody.content.find((part) => part.type === 'tool_use');
      expect(toolUse?.name).toBe('read_fixture');
      expect(typeof toolUse?.id).toBe('string');
      const nonce = 'fixture-file-nonce-7c10';
      const second = await post(server.url, { model: 'claude-haiku', system: CHILD_SYSTEM, messages: [
        { role: 'user', content: '<subagent-router v="1" model="b"/>\nOdczytaj plik fixture przez narzędzie' },
        { role: 'assistant', content: firstBody.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse!.id, content: nonce }] },
      ] }, { 'x-claude-code-agent-id': 'agent-b' });
      const finalBody = await second.json() as { content: Array<{ type: string; text?: string }> };
      expect(second.status).toBe(200);
      expect(gateway.requests.map((r) => r.model)).toEqual(['gateway/model B', 'gateway/model B']);
      expect(finalBody.content.some((part) => part.type === 'text' && part.text?.includes(nonce))).toBe(true);
    } finally {
      await server.stop();
      await gateway.close();
    }
  });
});
```

The test shows an ID with a space and with an uppercase letter; the gateway must receive them unchanged. The hermetic roundtrip uses a fixed synthetic nonce: a scripted `tool_use` from the gateway, a matching `tool_result`, a response decoded by the test into the nonce text, and two `upstreamModel` captures are jointly required. It proves transport and message identifier correlation, not file reading, tool execution, or decoding by a native client. This test's profiles are explicitly synthetic and do not certify the runtime. `content.length`, the `model` declared in the client body, and a self-reported response are not evidence. A real roundtrip is done by the opt-in test.

In `tests/e2e/routing.test.ts`, also add `opaque-identifiers-survive-gateway-endpoint-swap`, `unrecognized-fork-pass-through-and-recognized-fork-follows-w19`, `core-and-handler-have-no-required-ai-sdk-or-kb-imports`, `no-vendor-branch-or-llm-selector`, and `package-has-no-ai-gateway-dependency-or-import`. The first checks an endpoint change without interpreting the ID, the second distinguishes an unrecognized fork from a recognized one without a selection, the third checks the import graph and the absence of MCP KB calls, the fourth searches the artifact for `providers/`, vendor code, and an automatic selector, and the fifth reads `package.json` and checks the absence of `@the-next-ai/ai-gateway` in `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`, then searches `src` for an import of that name. In `tests/e2e/cli-workflow.test.ts`, add `offline-preview-never-connects-to-kb-or-mcp`. In `tests/probes/evidence.test.ts`, add `m8-client-model-upstream-model-table-exists`: a fixture of a complete report with model pairs and observations passes, a missing table or a plain empty slot does not pass. Checking the real report after the opt-in M8 belongs to Task 15 Step 6, and without a run M8 the report stays pending and does not count as an observation.

- [ ] **Step 2: Write the CLI workflow test**

`tests/e2e/cli-workflow.test.ts` runs the sequence `models sync` (fake fetch), `models describe`, `route preview`, `config check`, `config export --dry-run` in a temporary directory and checks: preview sees the new model after sync, sees the description after describe, the generation changes after each write, and `config export --dry-run` creates no files. Every assertion step reads files from disk, not in-memory state.

- [ ] **Step 3: Observe the results and fix only through TDD cycles**

```bash
bun test ./tests/e2e
```

Expected: pass. Every failure is a defect in Task 1 through 14 and goes back to that task as a new RED test, not as a fix inside the E2E test.

- [ ] **Step 4: Opt-in test on real harnesses**

A test that runs only with `SUBAGENT_ROUTER_E2E=1` and the binaries present. Claude Code uses an isolated config directory, the capture gateway, and `serve`, because it is `marker-routed`. OpenCode and Codex use their own native guard artifacts and connect directly to the capture gateway, without the `serve` handler. For each client, the prompt delegates to a synthetic subagent and has it read a fixture file with a one-time nonce through a native tool. Criteria: the gateway received the child request with the exact `upstreamModel` from the catalog, the capture shows a real tool roundtrip with a `tool_result`, and the decoded final result of the native client contains that nonce. A declared `model`, `content.length`, or a self-reported model are not enough. The test reports the `claude --version`, `opencode --version`, `codex --version`, and gateway versions to stdout. The test writes no secrets and does not modify the operator's `HOME`. A missing binary gives `test.skip` with a message, not a pass.

In `tests/e2e/native-routing.test.ts`, plan the named cases `fork-client-model-upstream-model-separate`, `denies-before-opencode-task-spawn`, and `deny-prevents-codex-child-request`. The fork test is separate and opt-in after M4: the gateway must receive an `upstreamModel` different from the inherited `clientModel`, and the native client must finish the roundtrip. The other cases run a real harness with a positive control of an allowed child, then a negative control of a disallowed model: denial before spawn and no child request. A missing client or an unrun measurement is skip/pending, not a pass.

- [ ] **Step 5: Run the measurements and record the profiles**

Run `tests/probes/run.ts` for M1, M2, M3 and the `M3-B2` subcase, M4 (Claude Code), M6 and `M6-runtime` (OpenCode), M5, M7, M9 (Codex), and M10 with a separate result for `next-turn`, `resume`, `compaction`, `nested`, `parallel`, and `M10-freshness` for each client. Codex requires updating beforehand to at least release rust-v0.153.4; without it, Codex results stay `pending` and the adapter refuses to operate. Save the results to `tests/fixtures/capabilities/<client>-<version>.json` with the date, version, M1 source entropy evidence, M3 position, and the state of each phase. Changing `status` to `supported` does not replace the gate for a specific path: OpenCode requires M6 and `M6-runtime`, Codex requires M7, and a role with an explicit model requires M9. Claude Code requires M10 for the handler, M3 for the adapter marker or M1 plus `M3-B2` for B2, and `M3-A` together with an explicit `parentPromptPosition` for the parent marker slot behind the native context. `correlation: true` requires a passed M1. `fork: true` requires a passed M4 and a separate fork E2E test; until then an unrecognized fork stays pass-through, and a recognized one without a selection keeps D3 and requirement 19. Passing a single lifecycle phase does not raise the others.

- [ ] **Step 6: Write the block documentation**

Each of the five blocks (`core`, `catalog`, `agents`, `transport`, `cli`) gets a `README.md` with the YAML `block`, `doc`, `verified_against` (the commit SHA after Task 15), `verified_on`, `owns`, and `depends_on`; a `CONTRACTS.md` with an `enforcement:` field pointing to the test file; an `INVARIANTS.md`; a `GAPS.md` listing `pending` and `failed` measurements; an `OPERATIONS.md` with the commands. Mark facts `[verified]`, `[inferred]`, `[assumption]`. The support matrix in `docs/README.md`: client, version, status, result of each measurement, correlation, fork, and each lifecycle phase separately. M8 stays informational, but the table of `clientModel` and `upstreamModel` pairs with the long-context observation is a required artifact, even when it does not block the status. `README.md` gets install instructions only now, with the `pending` statuses noted.

- [ ] **Step 7: Full verification and commit**

```bash
bun run typecheck && bun test && bun run build
```

Expected: 0 fail. Then:

```bash
git add tests/e2e tests/fixtures/capabilities docs README.md
git commit -m "test: add e2e gates and document verified blocks"
```

- [ ] **Step 8: Review of the whole branch**

After the last commit, the coordinator runs an independent review of the range from the plan's base to HEAD. The reviewer checks compliance with the spec, the measurement results, the absence of secrets in fixtures and documentation, and that no adapter has `supported` status without evidence. Merging to `main`, pushing, and publishing the package require separate user approval.

## Specification coverage map

This map shows where the implementation lives, not that tests pass. The implementer fills in the evidence in the ledger only after running the listed cases.

### Revision 4 matrix: requirement to section, step, and test

| Requirement | Revision 4 spec section | Task / Step | Planned named test |
|---|---|---|---|
| 1-4 | Product and boundaries; Responsibility boundary matrix; Separation of the AI SDK, runtime, and forwarding | 1 / 1-2, 14 / 1-4, 15 / 6 | `package::rdzeń-importuje-się-w-Node-bez-Bun-i-podejmuje-decyzję`, `package::dist-core-js-nie-zawiera-odwołań-do-Bun-ani-do-node-fs`, `boundary::core-and-handler-have-no-required-ai-sdk-or-kb-imports` |
| 5-8 | Product and boundaries; Responsibility boundary matrix | 12 / 1-4, 13 / 1-6, 15 / 2 | `read-only CLI::doctor-offline-raportuje-stan-configured-measured-i-pending-bez-sieci`, `config export::katalog-źródłowy-agentów-i-symlink-do-niego-są-odrzucane-także-z-force`, `cli-workflow::offline-preview-never-connects-to-kb-or-mcp` |
| 9-11 | Model selection; Routing decision contract | 2 / 5-6, 3 / 1-4 | `resolveRoute::jawny-wybór-wygrywa-z-rolą`, `resolveRoute::globalny-default-działa-tylko-bez-roli-i-bez-jawnego-wyboru` |
| 12-17 | Model selection; Responsibility boundary matrix | 3 / 1-4, 6 / 2-5, 15 / 1, 6 | `resolveRoute::nieznany-jawny-model-nie-spada-do-roli`, `inventory::odczyt-nie-zmienia-żadnego-pliku-fixture`, `boundary::no-vendor-branch-or-llm-selector` |
| 18-23 | Deterministic decision rules; Routing decision contract | 3 / 1-4, 8 / 6-7, 9 / 1-4 | `resolveRoute::adapter-oznacza-nierozwiązany-jawny-token-jako-błąd-przed-defaultem`, `createHandler::dziecko-bez-wskazania-dostaje-422-z-kodem-missing-selection-i-brama-nie-jest-wołana`, `correlation::conflicting-binding-never-reroutes` |
| 24-30 | Client model and upstream model; D1; D3 | 3 / 1-4, 7 / 7, 15 / 1, 4-5 | `e2e routing przez fake gateway::rodzic-A-oraz-równoczesne-dzieci-B-i-C-trafiają-do-właściwych-modeli-marker-nie-wycieka`, `e2e::fork-client-model-upstream-model-separate` |
| 31-33 | Integration modes; Adapter, runtime checkpoint, and refusal matrix | 7 / 5-7, 10 / 1-4, 11 / 1-4, 13 / 2, 5, 15 / 4-5 | `native-e2e::denies-before-opencode-task-spawn`, `createOpenCodePlugin::requires-effective-native-model-and-artifact-generation`, `native-e2e::deny-prevents-codex-child-request` |
| 34-43 | Routing in front of the gateway; Routing handler; Test strategy assertions | 8 / 6-7, 9 / 1-5, 13 / 3-6, 15 / 1, 4 | `createHandler::forwards-parent-enrichment-to-upstream-without-changing-parent-model`, `createHandler::passes-through-sse-unknown-events-errors-content-and-usage`, `createHandler::measures-selected-fetch-compression-contract`, `createHandler::preserves-backpressure-with-a-slow-consumer` |
| 44-47 | Gateway independence; Responsibility boundary matrix | 2 / 7-8, 5 / 1-8, 15 / 1, 6 | `resolveSource::usuwa-końcowy-ukośnik-nie-dokleja-v1-dwa-razy-i-dodaje-nagłówek-auth`, `e2e::opaque-identifiers-survive-gateway-endpoint-swap`, `boundary::package-has-no-ai-gateway-dependency-or-import` |
| 48-51 | Catalog and inspection; D4 | 2 / 5-8, 3 / 1-4, 5 / 5-8, 12 / 1-4 | `buildCatalog::nakładka-dla-ID-spoza-snapshotu-nie-tworzy-modelu`, `resolveModel::rozwiązuje-po-dokładnym-ID-i-po-aliasie-ale-nie-po-innej-wielkości-liter`, `synchronize::zniknięty-model-zostaje-jako-missing-powrót-przywraca-available` |
| 52-53 | Catalog and inspection; D9; D11 | 6 / 2-5, 12 / 1-4, 13 / 1-5 | `readAgentInventory::odczyt-nie-zmienia-żadnego-pliku-fixture`, `config export::eksport-OpenCode-zapisuje-wariant-do-katalogu-artefaktów-i-nie-zmienia-natywnych-plików`, `read-only CLI::route-preview-symuluje-decyzję-z-generacją-plików-bez-uruchamiania-agenta-i-sieci` |
| D1-D4 | D1, D2, D3, D4 | 1 / 2, 3 / 1-4, 4 / 1-4, 8 / 1-7, 9 / 1-5 | `normalizeClaudeRequest::nieznany-alias-markera-nie-może-zostać-odczytany-jako-przypadkowe-raw-upstream-ID`, `createHandler::B2-wymaga-osobnego-one-shot-freshness-proof-i-nie-przekazuje-control-upstream` |
| D5-D6 | D5; D6; Adapter, runtime checkpoint, and refusal matrix | 10 / 1-4, 11 / 1-4, 13 / 2, 5 | `createOpenCodePlugin::compares-provider-separately-from-opaque-upstream-id`, `runCodexPreToolUseHook::reads-stdin-writes-pretooluse-deny`, `config export::exports-codex-pretooluse-stdin-stdout-hook-wiring` |
| D7-D8 | D7; D8 | 7 / 5-7, 12 / 1-4, 15 / 5-6 | `capabilities::znana-z-zaufanego-adaptera-faza-sprawdza-swój-dowód-a-nieznana-wymaga-wszystkich-pięciu`, `probes::keeps-lifecycle-phases-separate`, `probes::m8-client-model-upstream-model-table-exists` |
| D9-D11 | D9; D10; D11 | 5 / 1-8, 6 / 1-5, 12 / 1-4, 13 / 1-6 | `discoverModels::pozytywna-kontrola-dwie-strony-z-kursorem-dają-pełną-listę-w-kolejności`, `config export::katalog-źródłowy-agentów-i-symlink-do-niego-są-odrzucane-także-z-force`, `read-only CLI::config-show-ukrywa-wartości-nagłówków-i-sekretów-także-w-JSON` |
| M1-M4 | Measurements required before status `implemented`; D2; D3 | 7 / 5-7, 8 / 5-7, 9 / 1-5, 15 / 4-5 | `probes::rejects-m1-identifier-variety-without-entropy-evidence`, `markers::marker-adaptera-w-user-wymaga-zmierzonego-profilu-first-user-a-unknown-go-nie-autoryzuje`, `e2e::unrecognized-fork-pass-through-and-recognized-fork-follows-w19` |
| M5-M10 | Measurements required before status `implemented`; Test strategy assertions | 7 / 5-7, 10 / 1-4, 11 / 1-4, 15 / 4-6 | `probes::requires-opencode-hook-invocation-and-effective-model`, `probes::requires-codex-deny-without-child-request`, `validateCodexSpawn::requires-m9-for-explicit-model-with-role`, `probes::keeps-lifecycle-phases-separate` |

Names with `::` identify the group and the case; the Polish table row names are written as slugs, matching the case text in that task. The `native-e2e` scenarios belong only to the opt-in `tests/e2e/native-routing.test.ts`.

| Clarified contract | Spec section | Task / Step | Test and condition |
|---|---|---|---|
| W19, D2, M10-freshness | D2; M10 measurements | 7 / 7, 9 / 1-5, 15 / 4-5 | `tests/transport/handler.test.ts`: a fresh receipt initializes the default, replay/TTL/restart does not initialize it again; `tests/probes/run.ts`: a real new-delegation signal distinguished from resume and compaction. |
| D2, M3-B2 | D2; M3 measurements | 9 / 1-5, 13 / 2, 5, 15 / 4-5 | `tests/transport/claude-hook.test.ts`: the producer registers a separate proof before stdout; a real M3-B2 confirms the receipt and the child request. |
| W33, M6-runtime, M7 | Adapter, runtime checkpoint, and refusal matrix | 10 / 1-4, 11 / 1-4, 15 / 4-5 | The unit test uses a controlled continuation in the driver; native E2E separately proves an effective denial and the authoritative effective config. |
| W42-W43 | Routing handler; Test strategy assertions | 7 / 5-7, 9 / 1-4, 13 / 3-6 | `measures-selected-fetch-compression-contract`, `rejects-unmeasured-or-mismatched-transport-profile-before-handler-start`: byte and header agreement, or refusal to create the handler. |

| Normative requirements | Tasks | Observable outcome |
|---|---|---|
| 1-4 | 1, 14 | A single package, importing core in Node without Bun and without side effects |
| 5-8 | 4, 5, 12, 13, 14 | A small CLI, export outside native roots, no vendor SDKs, no request-time discovery |
| 9-17 | 2, 3, 6, 8, 10, 11 | Explicit selection from the catalog, validation, the parent's model and permissions preserved |
| 18-23 | 3, 8, 9, 10, 11 | Priorities and conflicts give an exact result or a visible error, with no fallback |
| 24-30 | 3, 7, 8, 15 | Separated models, a separate fork probe with no false guarantee |
| 31-33 | 7, 10, 11, 15 | The native model is subject to runtime control; the version certificate follows from evidence |
| 34-43 | 8, 9, 13, 15 | Embed and serve use the same handler; stream and abort are propagated |
| 44-47 | 2, 5, 9, 15 | Changing the configured endpoint does not change provider logic; no dependency on the CCR gateway package |
| 48-51 | 2, 3, 5, 12, 13 | A missing description hides the suggestion, it does not manually set the model; missing/disabled do not route |
| 52 | 6, 8, 10, 11, 13, 15 | The hash of native definitions does not change, including for inherit and symlinks |
| 53 | 4, 12, 13, 14 | Offline JSON, correct codes, concurrent write conflicts without data loss |

| Spec acceptance criteria | Tasks |
|---|---|
| 1-3 | 7, 8, 9, 10, 11, 15 |
| 4-5 | 3, 8, 9, 15 |
| 6-7 | 7, 8, 9, 10, 11, 15 |
| 8 | 2, 3, 8, 9, 10, 11, 15 |
| 9 | 9, 15 |
| 10 | 1, 14 |
| 11-12 | 5, 7, 9, 15 |
| 13 | 2, 12 |
| 14 | 6, 10, 11, 13, 15 |
| 15-18 | 1, 2, 4, 5, 13 |
| 19 | 6, 12 |
| 20-21 | 12, 14, 15 |
| 22 | 4, 13 |
| 23 | 2, 8, 13 |
| 24 | 2, 4, 5, 13 |
| 25 | 2, 6, 10, 13 |
| 26 | 9, 12, 13, 15 |

| Measurement | Tasks | When it blocks |
|---|---|---|
| M1 | 7, 8, 15 | Enabling Claude correlation |
| M2 | 7, 8, 15 | Using the full native model ID in a given version |
| M3 | 7, 8, 9, 15 | The selected path for passing the default role |
| M4 | 7, 8, 15 | Declaring fork support |
| M5 | 7, 11, 13, 15 | Export and use of the Codex catalog |
| M6 | 6, 7, 10, 13, 15 | Declaring support for OpenCode variants |
| M7 | 7, 11, 15 | The whole Codex adapter for this version |
| M8 | 15 | An informational measurement, not a gate; an observation description is required |
| M9 | 7, 11, 15 | An explicit model combined with a Codex role |
| M10 | 7, 9, 10, 11, 15 | Declaring a supported lifecycle transition |

| Spec decision | Tasks |
|---|---|
| D1 | 3, 7, 8, 9, 10, 11 |
| D2 | 3, 7, 8, 9 |
| D3 | 7, 8, 15 |
| D4 | 1, 2, 4, 5, 12, 13 |
| D5 | 6, 7, 10, 13, 15 |
| D6 | 6, 7, 11, 13, 15 |
| D7 | 3, 8, 12, 15 |
| D8 | 7, 12, 14, 15 |
| D9 | 6, 8, 10, 11, 12, 13 |
| D10 | 2, 4, 5, 12, 13 |
| D11 | 12, 13, 14, 15 |

## Completion condition for execution

- [ ] All implemented behaviors have an observed RED and GREEN, then a review of compliance and quality.
- [ ] The package works as a core import outside Bun and as a CLI in the required Bun version.
- [ ] The indicated client matrix contains real versions, probe results, and the status of each lifecycle transition.
- [ ] Pending or unsupported is not reported as full client support. If part of the adapter could not be enabled, the deployment result is explicitly partial.
- [ ] The broad review covers the range from MERGE_BASE to HEAD, not just the last commit.
- [ ] Block documentation gives real commits and results. Return every ledger decision with its cost of error.
- [ ] Merge, push, and publication are separate actions requiring the user's consent.

---
