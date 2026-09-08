# Graph Report - subagent-router  (2026-09-08)

## Corpus Check
- 62 files · ~73,564 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 374 nodes · 903 edges · 26 communities (14 shown, 12 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.85)
- Token cost: 128,134 input · 6,710 output

## Community Hubs (Navigation)
- Capability & Lifecycle Gating
- Correlation & Transport Handler
- PoC Serve CLI
- PoC Demo Test Harness
- Claude Code Adapter
- Codex Hook Evidence Capture
- Operator Config Parsing
- Model Catalog & Routing
- TypeScript Build Config
- Package Manifest & Scripts
- Bun Fetch Transport Adapter
- CLI Interface Design Docs
- Router Core Architecture Docs
- Subagent Routing Plan & Spec
- Codex Spawn Validation
- OpenCode Variant Export
- OpenCode Plugin Creation
- Marker-Routed Integration Mode
- Native Integration Mode
- Documentation Conventions
- Measurement: Claude Code Agent ID
- Measurement: additionalContext Injection
- Measurement: OpenCode Variant Inheritance
- Measurement: Codex PreToolUse Hook
- External AI Gateway
- Route Preview

## God Nodes (most connected - your core abstractions)
1. `RouterError` - 58 edges
2. `CapabilityProfile` - 18 edges
3. `parseOperatorConfig()` - 15 edges
4. `OperatorConfig` - 15 edges
5. `createHandler()` - 15 edges
6. `configFixture()` - 14 edges
7. `compilerOptions` - 13 edges
8. `assertCapability()` - 12 edges
9. `extractMarkers()` - 11 edges
10. `record()` - 11 edges

## Surprising Connections (you probably didn't know these)
- `parsePocServeArgs()` --calls--> `RouterError`  [EXTRACTED]
  scripts/poc-serve.ts → src/core/errors.ts
- `assertProductionCapabilityProfile()` --calls--> `RouterError`  [EXTRACTED]
  scripts/poc-serve.ts → src/core/errors.ts
- `assertProductionTransportProfile()` --calls--> `RouterError`  [EXTRACTED]
  scripts/poc-serve.ts → src/core/errors.ts
- `parseProbeArgs()` --calls--> `RouterError`  [EXTRACTED]
  tests/probes/run.ts → src/core/errors.ts
- `snapshotFixture()` --calls--> `modelAlias()`  [EXTRACTED]
  tests/support/fixtures.ts → src/core/hash.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Native Runtime Guard Pattern** — src_adapters_opencode_validateopencodetask, src_adapters_codex_validatecodexspawn, src_agents_export_exportconfig [EXTRACTED 0.95]
- **Harness Validation Measurements** — docs_superpowers_specs_2026_09_06_subagent_model_routing_design_m1, docs_superpowers_specs_2026_09_06_subagent_model_routing_design_m3, docs_superpowers_specs_2026_09_06_subagent_model_routing_design_m6, docs_superpowers_specs_2026_09_06_subagent_model_routing_design_m7, docs_superpowers_specs_2026_09_06_subagent_model_routing_design_m10 [EXTRACTED 1.00]
- **Test Strategy Layers** — docs_superpowers_specs_2026_09_06_subagent_model_routing_design_core, docs_superpowers_specs_2026_09_06_subagent_model_routing_design_handler, docs_superpowers_specs_2026_09_06_subagent_model_routing_design_fake_gateway [EXTRACTED 1.00]

## Communities (26 total, 12 thin omitted)

### Community 0 - "Capability & Lifecycle Gating"
Cohesion: 0.08
Nodes (39): assertCapability(), gateProbesSatisfied(), lifecycleSatisfied(), AgentDefinition, AgentInventory, CapabilityGate, CapabilityProfile, ConsumeFreshDelegation (+31 more)

### Community 1 - "Correlation & Transport Handler"
Cohesion: 0.09
Nodes (33): RFC-7230, CorrelationEntry, CorrelationStore, FreshDelegationEnvelope, FreshDelegationReceipt, assertTransportProfileReady(), boundedPassThrough(), buildUpstreamHeaders() (+25 more)

### Community 2 - "PoC Serve CLI"
Cohesion: 0.09
Nodes (34): assertProductionCapabilityProfile(), assertProductionTransportProfile(), exitCodeForError(), isHelpRequested(), KNOWN_FLAGS, parsePocServeArgs(), PocServeArgs, run() (+26 more)

### Community 3 - "PoC Demo Test Harness"
Cohesion: 0.13
Nodes (26): anthropicMessageBody(), assertEqual(), CAPABILITY_FIXTURES_DIR, fail(), main(), SYNTHETIC_CLAUDE_PROFILE, TESTS_TMP_ROOT, WORKTREE_ROOT (+18 more)

### Community 4 - "Claude Code Adapter"
Cohesion: 0.12
Nodes (30): billingValueSaysSubagent(), ENRICHED_TOOL_NAMES, enrichParentTools(), findBillingBlockIndex(), isBillingMetadataText(), isRecord(), normalizeClaudeRequest(), NormalizedClaudeRequest (+22 more)

### Community 5 - "Codex Hook Evidence Capture"
Cohesion: 0.09
Nodes (26): ClientId, ProbeResult, CLIENT_IDS, CodexHookEvidence, EntropyProof, Evidence, isClientId(), isolatedHarnessEnv() (+18 more)

### Community 6 - "Operator Config Parsing"
Cohesion: 0.21
Nodes (25): CLIENTS, envNames(), onlyKeys(), optionalString(), parseAgentRoots(), parseDefaults(), parseGateway(), parseHarness() (+17 more)

### Community 7 - "Model Catalog & Routing"
Cohesion: 0.15
Nodes (19): buildCatalog(), resolveModel(), inheritIsAllowed(), lookup(), resolveRoute(), RouteSource, EffectiveCatalog, ResolvedModel (+11 more)

### Community 8 - "TypeScript Build Config"
Cohesion: 0.10
Nodes (20): bun-types, DOM, ES2022, scripts, src, tests, compilerOptions, declaration (+12 more)

### Community 9 - "Package Manifest & Scripts"
Cohesion: 0.11
Nodes (17): devDependencies, @types/bun, typescript, engines, bun, name, private, scripts (+9 more)

### Community 10 - "Bun Fetch Transport Adapter"
Cohesion: 0.15
Nodes (6): BUN_RAW_FETCH_ADAPTER, bunRawFetch(), CHILD_SYSTEM, FIXTURE_SUPPORTED_PROFILE, FIXTURE_TRANSPORT_PROFILE, source

### Community 11 - "CLI Interface Design Docs"
Cohesion: 0.40
Nodes (5): CLI Interface Design, config export, doctor, models sync, route preview

### Community 12 - "Router Core Architecture Docs"
Cohesion: 0.50
Nodes (4): Router Core, Fake Gateway, HTTP Handler, Measurement M10: Upstream Model Stability

### Community 13 - "Subagent Routing Plan & Spec"
Cohesion: 0.67
Nodes (3): Subagent Model Routing Implementation Plan, Subagent Model Routing Design Specification, subagent-router

## Knowledge Gaps
- **115 isolated node(s):** `name`, `version`, `private`, `type`, `bun` (+110 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 142 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **12 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `RouterError` connect `Operator Config Parsing` to `Capability & Lifecycle Gating`, `Correlation & Transport Handler`, `PoC Serve CLI`, `PoC Demo Test Harness`, `Codex Hook Evidence Capture`, `Model Catalog & Routing`?**
  _High betweenness centrality (0.133) - this node is a cross-community bridge._
- **Why does `CapabilityProfile` connect `Capability & Lifecycle Gating` to `Correlation & Transport Handler`, `PoC Serve CLI`, `PoC Demo Test Harness`, `Claude Code Adapter`, `Model Catalog & Routing`, `Bun Fetch Transport Adapter`?**
  _High betweenness centrality (0.028) - this node is a cross-community bridge._
- **Why does `CorrelationStore` connect `Correlation & Transport Handler` to `Capability & Lifecycle Gating`, `Claude Code Adapter`, `Model Catalog & Routing`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _115 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Capability & Lifecycle Gating` be split into smaller, more focused modules?**
  _Cohesion score 0.08405797101449275 - nodes in this community are weakly interconnected._
- **Should `Correlation & Transport Handler` be split into smaller, more focused modules?**
  _Cohesion score 0.08970099667774087 - nodes in this community are weakly interconnected._
- **Should `PoC Serve CLI` be split into smaller, more focused modules?**
  _Cohesion score 0.09230769230769231 - nodes in this community are weakly interconnected._