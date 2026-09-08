# Subagent Router Code Graph (2026-09-09)

## Corpus Check
- 113 AST-supported files from a committed source archive.
- Code-only scope: semantic Markdown documentation and unsupported file formats were not indexed.
- No provider calls or native-client probes were used. See [README.md](README.md) for scope and rebuild instructions.

## Summary
- 779 nodes · 2190 edges · 41 communities (34 shown, 7 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 22 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `008ed4b0`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Rebuild from an explicit committed archive as described in [README.md](README.md).

## Community Hubs (Navigation)
- Core Types
- Cli Read
- Agents Export
- Transport Handler
- Adapters Markers
- Package
- Core Config
- Agents Claude Code
- Probes Run
- Integration Cliproxyapi.Test
- Tsconfig
- Adapters Capabilities
- Io Environment
- Transport Handler.Test
- Adapters Opencode Plugin.Test
- E2E Routing.Test
- Scripts Poc Serve
- Support Fixtures
- Support Run Built Entrypoints
- Scripts Build
- Catalog Sync
- Core Hash
- Tsconfig.Build
- Probes Opencode Mock Gateway
- Scripts Poc Demo
- Adapters Capabilities.Test
- E2E Cli Workflow.Test
- Src Bun
- Cli Export Dispatch.Test
- Probes Native Claude Gateway
- Cli Diagnostics.Test
- Probes Native Claude Handler
- Adapters Opencode.Test
- Cli Export Catalog.Test
- Cli Write.Test
- Probes Native Opencode.Test
- Adapters Codex.Test
- Cli Read Additional.Test
- Cli Read.Test
- Probes Opencode Deny Plugin
- Probes Native Claude Run

## God Nodes (most connected - your core abstractions)
1. `RouterError` - 112 edges
2. `configFixture()` - 38 edges
3. `CapabilityProfile` - 35 edges
4. `snapshotFixture()` - 30 edges
5. `OperatorConfig` - 29 edges
6. `loadState()` - 26 edges
7. `buildCatalog()` - 24 edges
8. `FetchLike` - 23 edges
9. `exportConfig()` - 23 edges
10. `CliDeps` - 21 edges

## Surprising Connections (you probably didn't know these)
- `codexInventory()` --calls--> `readAgentInventory()`  [EXTRACTED]
  tests/cli/export-catalog.test.ts → src/agents/inventory.ts
- `inventoryFor()` --calls--> `readAgentInventory()`  [EXTRACTED]
  tests/cli/export.test.ts → src/agents/inventory.ts
- `buildHandler()` --indirect_call--> `bunRawFetch()`  [INFERRED]
  tests/integration/cliproxyapi.test.ts → src/transport/bun-fetch.ts
- `assertProductionCapabilityProfile()` --calls--> `RouterError`  [EXTRACTED]
  scripts/poc-serve.ts → src/core/errors.ts
- `assertProductionTransportProfile()` --calls--> `RouterError`  [EXTRACTED]
  scripts/poc-serve.ts → src/core/errors.ts

## Import Cycles
- None detected.

## Communities (41 total, 7 thin omitted)

### Core Types - "Core Types"
Cohesion: 0.06
Nodes (71): codexHookOutput(), CodexHookDeps, EMPTY_CATALOG, EMPTY_INVENTORY, invalidHookInput(), isPlainObject(), main(), readAll() (+63 more)

### Cli Read - "Cli Read"
Cohesion: 0.08
Nodes (62): getAgent(), readAgentInventory(), checkDiscoveryConnectivity(), OPTIONS, parseArgs(), ParsedArgs, CommandHandler, COMMANDS (+54 more)

### Agents Export - "Agents Export"
Cohesion: 0.06
Nodes (46): opencodeVariants(), ALL_CLIENTS, allCandidateNativeRoots(), assertNoOverlapWithResolvedRoots(), assertPlanPathContained(), buildClaudeFiles(), buildCodexFiles(), buildOpencodeFiles() (+38 more)

### Transport Handler - "Transport Handler"
Cohesion: 0.08
Nodes (39): RFC-7230, billingValueSaysSubagent(), ENRICHED_TOOL_NAMES, enrichParentTools(), findBillingBlockIndex(), isBillingMetadataText(), isRecord(), normalizeClaudeRequest() (+31 more)

### Adapters Markers - "Adapters Markers"
Cohesion: 0.08
Nodes (38): classifyPositionTwo(), collectMessageLines(), collectSystemLines(), countMarkerLines(), ExtractedMarkers, extractMarkers(), firstAuthorizedUserMessage(), firstLine() (+30 more)

### Package - "Package"
Cohesion: 0.05
Nodes (41): bin, subagent-router, import, types, import, types, import, types (+33 more)

### Core Config - "Core Config"
Cohesion: 0.15
Nodes (31): DiscoveredModel, DiscoveryConnectivityCheck, fetchPage(), ParsedPage, parsePage(), schemaError(), CLIENTS, envNames() (+23 more)

### Agents Claude Code - "Agents Claude Code"
Cohesion: 0.14
Nodes (25): bodyAfterLine(), claudeCodeAgentRoots(), effectiveName(), listMarkdownAgents(), parseAgentMarkdown(), ParsedAgentMarkdown, readClaudeAgents(), codexAgentRoots() (+17 more)

### Probes Run - "Probes Run"
Cohesion: 0.11
Nodes (23): CLIENT_IDS, CodexHookEvidence, EntropyProof, Evidence, isClientId(), isolatedHarnessEnv(), judgeCodexDeny(), judgeM1() (+15 more)

### Integration Cliproxyapi.Test - "Integration Cliproxyapi.Test"
Cohesion: 0.09
Nodes (11): transportProfile(), buildHandler(), CHILD_SYSTEM, CliProxyApiFixture, EXAMPLE_CONFIG_PATH, FixtureRequest, PROFILE, REST_FRAMES (+3 more)

### Tsconfig - "Tsconfig"
Cohesion: 0.10
Nodes (20): bun-types, DOM, ES2022, scripts, tests, compilerOptions, declaration, emitDeclarationOnly (+12 more)

### Adapters Capabilities - "Adapters Capabilities"
Cohesion: 0.18
Nodes (19): assertSafeIdentifier(), compareVersionParts(), GATE_CLIENT, highestKnownVersion(), isEnoent(), isProbeResult(), loadCapabilityProfile(), loadTransportCapabilityProfile() (+11 more)

### Io Environment - "Io Environment"
Cohesion: 0.22
Nodes (10): assertClientProfileSupported(), ServeHandle, startServer(), canonicalUrl(), headersFromEnv(), modelsUrl(), requiredEnvironmentValue(), resolveSource() (+2 more)

### Transport Handler.Test - "Transport Handler.Test"
Cohesion: 0.15
Nodes (6): BUN_RAW_FETCH_ADAPTER, bunRawFetch(), CHILD_SYSTEM, FIXTURE_SUPPORTED_PROFILE, FIXTURE_TRANSPORT_PROFILE, source

### Adapters Opencode Plugin.Test - "Adapters Opencode Plugin.Test"
Cohesion: 0.21
Nodes (7): buildCatalog(), profile, baseDeps(), inventory, supported, taskInput, FIXTURE_MODEL_ID

### E2E Routing.Test - "E2E Routing.Test"
Cohesion: 0.16
Nodes (8): CHILD_SYSTEM, collectImportGraph(), extractImportSpecifiers(), ImportGraphResult, resolveRelativeSpecifier(), ROOT, SRC_DIR, TESTS_TMP_DIR

### Scripts Poc Serve - "Scripts Poc Serve"
Cohesion: 0.29
Nodes (10): assertProductionCapabilityProfile(), assertProductionTransportProfile(), exitCodeForError(), isHelpRequested(), KNOWN_FLAGS, parsePocServeArgs(), PocServeArgs, run() (+2 more)

### Support Fixtures - "Support Fixtures"
Cohesion: 0.22
Nodes (8): CatalogSnapshot, writeState(), env, FIXTURE_GATEWAY_URL, FIXTURE_MODELS_URL, FIXTURE_SOURCE_ID, snapshotFixture(), handlerWith()

### Support Run Built Entrypoints - "Support Run Built Entrypoints"
Cohesion: 0.24
Nodes (10): claude(), codex(), configPath, DIST, fail(), INVENTORY, opencode(), ROOT (+2 more)

### Scripts Build - "Scripts Build"
Cohesion: 0.33
Nodes (10): assertSourcesPresent(), bundle(), copyCapabilityProfiles(), DIST, emitDeclarations(), Entrypoint, ENTRYPOINTS, fail() (+2 more)

### Catalog Sync - "Catalog Sync"
Cohesion: 0.29
Nodes (7): discoverModels(), byId(), compareCodepoints(), synchronize(), SynchronizeDeps, Env, env

### Core Hash - "Core Hash"
Cohesion: 0.38
Nodes (7): encoder, modelAlias(), sha256(), sourceFingerprint(), toHex(), writeFixtureState(), writeFixtureState()

### Tsconfig.Build - "Tsconfig.Build"
Cohesion: 0.20
Nodes (9): ./tsconfig.json, compilerOptions, declaration, emitDeclarationOnly, outDir, rootDir, extends, include (+1 more)

### Scripts Poc Demo - "Scripts Poc Demo"
Cohesion: 0.33
Nodes (8): anthropicMessageBody(), assertEqual(), CAPABILITY_FIXTURES_DIR, fail(), main(), SYNTHETIC_CLAUDE_PROFILE, TESTS_TMP_ROOT, WORKTREE_ROOT

### Adapters Capabilities.Test - "Adapters Capabilities.Test"
Cohesion: 0.22
Nodes (8): assertCapability(), gateProbesSatisfied(), lifecycleSatisfied(), ALL_LIFECYCLE_PASSED, FIXTURES, INVALID_FIXTURES, TRUSTED_NEXT, TRUSTED_UNKNOWN

### E2E Cli Workflow.Test - "E2E Cli Workflow.Test"
Cohesion: 0.31
Nodes (7): configCheckGeneration(), deps(), err, networkForbidden(), out, run(), TESTS_TMP_DIR

### Src Bun - "Src Bun"
Cohesion: 0.39
Nodes (5): capabilitiesDir(), realDeps(), detectClientVersion(), VERSION_PROBE_TIMEOUT_MS, started

### Cli Export Dispatch.Test - "Cli Export Dispatch.Test"
Cohesion: 0.29
Nodes (5): deps(), err, networkForbidden(), out, TESTS_TMP_ROOT

### Probes Native Claude Gateway - "Probes Native Claude Gateway"
Cohesion: 0.50
Nodes (7): classify(), msgId(), record(), server, sse(), taskReply(), textReply()

### Cli Diagnostics.Test - "Cli Diagnostics.Test"
Cohesion: 0.29
Nodes (3): err, out, TESTS_TMP_ROOT

### Probes Native Claude Handler - "Probes Native Claude Handler"
Cohesion: 0.43
Nodes (6): front, handler, rec(), seen, SYNTHETIC_PROFILE, upstreamFetch()

### Adapters Opencode.Test - "Adapters Opencode.Test"
Cohesion: 0.33
Nodes (5): filesOnlyInventory, FIXTURE_NATIVE_CONTEXT, inventory, pending, supported

### Cli Export Catalog.Test - "Cli Export Catalog.Test"
Cohesion: 0.40
Nodes (4): codexInventory(), TESTS_TMP_ROOT, writeConfigAndSnapshot(), configFixture()

### Adapters Codex.Test - "Adapters Codex.Test"
Cohesion: 0.40
Nodes (3): filesOnlyInventory, inventory, supported

## Knowledge Gaps
- **196 isolated node(s):** `OpenCodePlugin`, `TrustedExportExpectations`, `RouteSource`, `CommandHandler`, `ServeOptions` (+191 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 276 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **7 thin communities (<3 nodes) omitted from report** : run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `RouterError` connect `Core Config` to `Core Types`, `Cli Read`, `Agents Export`, `Transport Handler`, `Adapters Markers`, `Cli Read Additional.Test`, `Agents Claude Code`, `Probes Run`, `Adapters Capabilities`, `Io Environment`, `Adapters Opencode Plugin.Test`, `Scripts Poc Serve`, `Support Fixtures`, `Catalog Sync`, `Adapters Capabilities.Test`?**
  _High betweenness centrality (0.137) - this node is a cross-community bridge._
- **Why does `CapabilityProfile` connect `Core Types` to `Adapters Opencode.Test`, `Cli Read`, `Transport Handler`, `Adapters Markers`, `Adapters Codex.Test`, `Agents Claude Code`, `Integration Cliproxyapi.Test`, `Adapters Capabilities`, `Io Environment`, `Transport Handler.Test`, `Adapters Opencode Plugin.Test`, `Scripts Poc Serve`, `Support Run Built Entrypoints`, `Scripts Poc Demo`, `Probes Native Claude Handler`?**
  _High betweenness centrality (0.028) - this node is a cross-community bridge._
- **Why does `configFixture()` connect `Cli Export Catalog.Test` to `Core Types`, `Cli Read`, `Agents Export`, `Adapters Markers`, `Core Config`, `Integration Cliproxyapi.Test`, `Io Environment`, `Transport Handler.Test`, `Adapters Opencode Plugin.Test`, `E2E Routing.Test`, `Support Fixtures`, `Support Run Built Entrypoints`, `Catalog Sync`, `Core Hash`, `E2E Cli Workflow.Test`, `Cli Export Dispatch.Test`, `Cli Diagnostics.Test`, `Probes Native Claude Handler`, `Adapters Opencode.Test`, `Cli Write.Test`, `Adapters Codex.Test`, `Cli Read Additional.Test`, `Cli Read.Test`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **What connects `OpenCodePlugin`, `TrustedExportExpectations`, `RouteSource` to the rest of the system?**
  _196 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Core Types` be split into smaller, more focused modules?**
  _Cohesion score 0.06388888888888888 - nodes in this community are weakly interconnected._
- **Should `Cli Read` be split into smaller, more focused modules?**
  _Cohesion score 0.07578947368421053 - nodes in this community are weakly interconnected._
- **Should `Agents Export` be split into smaller, more focused modules?**
  _Cohesion score 0.06412583182093164 - nodes in this community are weakly interconnected._