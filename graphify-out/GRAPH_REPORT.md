# Graph Report - subagent-router  (2026-09-12)

Source commit: `4ca2e7a73beaf7baf43de937fc3e43a761dd9d63`. Code-only AST extraction; no semantic provider calls.

This is a simple undirected navigation graph. It is not an exhaustive audit; graph construction can merge relation variants. Generated and built-in module references are not parsed source files.

## Corpus Check
- 127 committed code files from `4ca2e7a73beaf7baf43de937fc3e43a761dd9d63`; docs, settings, captures and generated outputs excluded

## Summary
- 1065 nodes · 3030 edges · 55 communities (48 shown, 7 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 21 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- src/cli/read.ts
- tests/probes/evidence-m1.ts
- src/agents/export.ts
- src/transport/handler.ts
- tests/probes/handler-fixture.test.ts
- src/agents/claude-code.ts
- tests/probes/evidence-m3a.ts
- tests/probes/run.ts
- tests/probes/judge-run.ts
- tests/probes/resume-proof.ts
- tests/cli/staleness.test.ts
- tests/probes/native-claude-launcher.test.ts
- src/core/hash.ts
- tests/probes/evidence-m10.ts
- src/transport/claude-hook.ts
- src/adapters/codex-hook.ts
- tests/probes/native-claude-handler.ts
- src/adapters/markers.ts
- src/core/types.ts
- tests/integration/cliproxyapi.test.ts
- src/adapters/capabilities.ts
- src/adapters/opencode.ts
- src/adapters/opencode-plugin.ts
- src/core/config.ts
- tests/probes/evidence-freshness.test.ts
- tests/cli/write.test.ts
- tests/probes/evidence-m10.test.ts
- src/bun.ts
- tests/probes/fixture-writer.ts
- tests/e2e/routing.test.ts
- src/adapters/claude-code.ts
- tests/support/native-layout.ts
- scripts/build.ts
- scripts/poc-serve.ts
- tests/probes/run-binary.ts
- tests/support/run-built-entrypoints.ts
- tests/support/resume-proof-fixture.ts
- tests/adapters/codex-hook.test.ts
- tests/transport/handler.test.ts
- scripts/poc-demo.ts
- tests/e2e/cli-workflow.test.ts
- tests/adapters/capabilities.test.ts
- tests/cli/export-dispatch.test.ts
- tests/probes/native-claude-gateway.mjs
- tests/probes/native-claude-handler.ts
- src/adapters/correlation.ts
- tests/cli/diagnostics.test.ts
- tests/probes/packaged-serve-capture.ts
- tests/probes/native-claude-handler-redaction.test.ts
- tests/probes/native-opencode.test.ts
- tests/cli/read.test.ts
- tests/catalog/sync.test.ts
- tests/probes/native-claude-packaged-front.mjs
- tests/probes/opencode-deny-plugin.js
- tests/probes/packaged-capture.test.ts

## God Nodes (most connected - your core abstractions)
1. `RouterError` - 132 edges
2. `configFixture()` - 43 edges
3. `CapabilityProfile` - 38 edges
4. `snapshotFixture()` - 33 edges
5. `OperatorConfig` - 29 edges
6. `loadState()` - 26 edges
7. `buildCatalog()` - 24 edges
8. `FetchLike` - 24 edges
9. `judgeRun()` - 24 edges
10. `exportConfig()` - 23 edges

## Surprising Connections (you probably didn't know these)
- `codexInventory()` --calls--> `readAgentInventory()`  [EXTRACTED]
  tests/cli/export-catalog.test.ts → src/agents/inventory.ts
- `inventoryFor()` --calls--> `readAgentInventory()`  [EXTRACTED]
  tests/cli/export.test.ts → src/agents/inventory.ts
- `CorrelationCompleteness` --references--> `ProbeResult`  [EXTRACTED]
  tests/probes/evidence-m3a.ts → src/core/types.ts
- `HandlerFixtureOptions` --references--> `CapabilityProfile`  [EXTRACTED]
  tests/probes/native-claude-handler.ts → src/core/types.ts
- `buildHandler()` --indirect_call--> `bunRawFetch()`  [INFERRED]
  tests/integration/cliproxyapi.test.ts → src/transport/bun-fetch.ts

## Import Cycles
- None detected.

## Communities (55 total, 7 thin omitted)

### src/cli/read.ts - "src/cli/read.ts"
Cohesion: 0.06
Nodes (91): getAgent(), readAgentInventory(), checkDiscoveryConnectivity(), DiscoveredModel, discoverModels(), DiscoveryConnectivityCheck, fetchPage(), ParsedPage (+83 more)

### tests/probes/evidence-m1.ts - "tests/probes/evidence-m1.ts"
Cohesion: 0.07
Nodes (53): analyzeIdSample(), buildEntropyProof(), buildGeneratorEntropyProof(), collectAgentIds(), CollectedAgentIds, GeneratorEntropyProof, IdSampleAnalysis, isRecord() (+45 more)

### src/agents/export.ts - "src/agents/export.ts"
Cohesion: 0.06
Nodes (46): opencodeVariants(), ALL_CLIENTS, allCandidateNativeRoots(), assertNoOverlapWithResolvedRoots(), assertPlanPathContained(), buildClaudeFiles(), buildCodexFiles(), buildOpencodeFiles() (+38 more)

### src/transport/handler.ts - "src/transport/handler.ts"
Cohesion: 0.11
Nodes (30): RFC-7230, assertTransportProfileReady(), boundedPassThrough(), buildUpstreamHeaders(), buildUpstreamUrl(), correlationStoreFor(), createHandler(), encoder (+22 more)

### tests/probes/handler-fixture.test.ts - "tests/probes/handler-fixture.test.ts"
Cohesion: 0.09
Nodes (26): COMPACTION_SUMMARY_PREFIX, assertLayoutContract(), buildParentFinalRequest(), CAPABILITIES_FIXTURES, childContinuationRequest(), childRequest(), compactedRequest(), continuation() (+18 more)

### src/agents/claude-code.ts - "src/agents/claude-code.ts"
Cohesion: 0.14
Nodes (25): bodyAfterLine(), claudeCodeAgentRoots(), effectiveName(), listMarkdownAgents(), parseAgentMarkdown(), ParsedAgentMarkdown, readClaudeAgents(), codexAgentRoots() (+17 more)

### tests/probes/evidence-m3a.ts - "tests/probes/evidence-m3a.ts"
Cohesion: 0.13
Nodes (28): isNativeContextScaffoldV1(), isNativeInstructionsBlockV2(), CapturedHookRecord, CaptureRecord, CLIENT_IDS, CorrelationCompleteness, diffCapturedAgainstReal(), evaluatePair() (+20 more)

### tests/probes/run.ts - "tests/probes/run.ts"
Cohesion: 0.11
Nodes (21): CLIENT_IDS, CodexHookEvidence, EntropyProof, Evidence, isClientId(), isolatedHarnessEnv(), judgeCodexDeny(), judgeOpencodeHook() (+13 more)

### tests/probes/judge-run.ts - "tests/probes/judge-run.ts"
Cohesion: 0.15
Nodes (24): AgentFreshnessEvidence, DelegationConsumeRecord, DelegationRegisterRecord, DelegationReplayRecord, extractFreshnessEvidence(), FreshnessCapture, FreshnessExtraction, InstanceFetchRecord (+16 more)

### tests/probes/resume-proof.ts - "tests/probes/resume-proof.ts"
Cohesion: 0.14
Nodes (23): LifecycleJudgeOptions, loadProof(), assertSafeIdentifier(), GeneratorProofSite, isEnoent(), loadGeneratorProof(), REQUIRED_SITE_NAMES, schemaError() (+15 more)

### tests/cli/staleness.test.ts - "tests/cli/staleness.test.ts"
Cohesion: 0.11
Nodes (16): baseDeps(), inventory, supported, taskInput, codexInventory(), TESTS_TMP_ROOT, writeConfigAndSnapshot(), err (+8 more)

### tests/probes/native-claude-launcher.test.ts - "tests/probes/native-claude-launcher.test.ts"
Cohesion: 0.08
Nodes (22): decoyBinDir, decoyClaudePath, failingReadlinkPath, fakeClaude2Path, fakeClaudePath, fixtureHome, fixtureProbesDir, fixtureRoot (+14 more)

### src/core/hash.ts - "src/core/hash.ts"
Cohesion: 0.15
Nodes (15): encoder, modelAlias(), sha256(), sourceFingerprint(), toHex(), writeFixtureState(), writeFixtureState(), ROOT (+7 more)

### tests/probes/evidence-m10.ts - "tests/probes/evidence-m10.ts"
Cohesion: 0.14
Nodes (23): agentsWithAtLeastTwoRequests(), agentUpstreamDrifted(), checkDeclaredMode(), checkDriftAndForwarding(), checkEveryRequestForwarded(), extractLifecycleEvidence(), FRESHNESS_HOOK_VALUES, hasCompactionContinuationMessage() (+15 more)

### src/transport/claude-hook.ts - "src/transport/claude-hook.ts"
Cohesion: 0.14
Nodes (18): assertCapability(), gateProbesSatisfied(), lifecycleSatisfied(), HOOK_FLAGS, HookFlag, invalidHookInput(), isPlainObject(), main() (+10 more)

### src/adapters/codex-hook.ts - "src/adapters/codex-hook.ts"
Cohesion: 0.15
Nodes (19): codexHookOutput(), EMPTY_CATALOG, EMPTY_INVENTORY, invalidHookInput(), isPlainObject(), main(), readAll(), runCodexPreToolUseHook() (+11 more)

### tests/probes/native-claude-handler.ts - "tests/probes/native-claude-handler.ts"
Cohesion: 0.12
Nodes (21): COMPACTION_PROMPT_MARKERS, CONTROL_URL_PREFIX, ExtractedToolResult, ExtractedToolResultWithIndex, extractToolResults(), extractToolResultsWithIndex(), HandlerFixture, HandlerFixtureOptions (+13 more)

### src/adapters/markers.ts - "src/adapters/markers.ts"
Cohesion: 0.19
Nodes (21): classifyPositionTwo(), collectMessageLines(), collectSystemLines(), countMarkerLines(), ExtractedMarkers, extractMarkers(), firstAuthorizedUserMessage(), firstLine() (+13 more)

### src/core/types.ts - "src/core/types.ts"
Cohesion: 0.20
Nodes (19): CapabilityGate, CatalogSnapshot, ConsumeFreshDelegation, ExportFile, FreshDelegationEnvelope, FreshDelegationReceipt, HeaderMap, LoadedState (+11 more)

### tests/integration/cliproxyapi.test.ts - "tests/integration/cliproxyapi.test.ts"
Cohesion: 0.09
Nodes (11): transportProfile(), buildHandler(), CHILD_SYSTEM, CliProxyApiFixture, EXAMPLE_CONFIG_PATH, FixtureRequest, PROFILE, REST_FRAMES (+3 more)

### src/adapters/capabilities.ts - "src/adapters/capabilities.ts"
Cohesion: 0.17
Nodes (20): assertSafeIdentifier(), compareVersionParts(), GATE_CLIENT, highestKnownVersion(), isEnoent(), isProbeResult(), loadCapabilityProfile(), loadTransportCapabilityProfile() (+12 more)

### src/adapters/opencode.ts - "src/adapters/opencode.ts"
Cohesion: 0.16
Nodes (16): isRecord(), roleExists(), splitVariantName(), unsupported(), validateOpenCodeTask(), inheritIsAllowed(), lookup(), resolveRoute() (+8 more)

### src/adapters/opencode-plugin.ts - "src/adapters/opencode-plugin.ts"
Cohesion: 0.19
Nodes (17): CodexHookDeps, createOpenCodePlugin(), deny(), isRecord(), OpenCodePlugin, OpenCodePluginDeps, TrustedExportExpectations, BuildContext (+9 more)

### src/core/config.ts - "src/core/config.ts"
Cohesion: 0.30
Nodes (17): CLIENTS, envNames(), onlyKeys(), optionalString(), parseAgentRoots(), parseDefaults(), parseGateway(), parseHarness() (+9 more)

### tests/probes/evidence-freshness.test.ts - "tests/probes/evidence-freshness.test.ts"
Cohesion: 0.14
Nodes (17): hashNonce(), applyCompactionSignal(), B2_PROFILE, CHILD_SYSTEM, collectingWritableStream(), CompactionSignal, jsonReadableStream(), pair() (+9 more)

### tests/cli/write.test.ts - "tests/cli/write.test.ts"
Cohesion: 0.14
Nodes (8): err, out, err, out, FIXTURE_GATEWAY_URL, FIXTURE_MODEL_ID, FIXTURE_MODELS_URL, FIXTURE_SOURCE_ID

### tests/probes/evidence-m10.test.ts - "tests/probes/evidence-m10.test.ts"
Cohesion: 0.17
Nodes (9): RunManifest, nestedPair(), pair(), TWO_AGENTS_TWO_REQUESTS_INTERLEAVED, CapturedPair, RunCapture, isMessagesEndpointUrl(), isRecord() (+1 more)

### src/bun.ts - "src/bun.ts"
Cohesion: 0.23
Nodes (7): capabilitiesDir(), realDeps(), detectClientVersion(), VERSION_PROBE_TIMEOUT_MS, BUN_RAW_FETCH_ADAPTER, bunRawFetch(), started

### tests/probes/fixture-writer.ts - "tests/probes/fixture-writer.ts"
Cohesion: 0.20
Nodes (12): LifecyclePhase, assertNoForeignKeys(), assertSafeIdentifier(), CORRELATION_GATE_PATHS, isProbeResult(), JUDGED_ALLOWED_KEYS, JudgedFixtureUpdate, LIFECYCLE_PHASES (+4 more)

### tests/e2e/routing.test.ts - "tests/e2e/routing.test.ts"
Cohesion: 0.16
Nodes (8): CHILD_SYSTEM, collectImportGraph(), extractImportSpecifiers(), ImportGraphResult, resolveRelativeSpecifier(), ROOT, SRC_DIR, TESTS_TMP_DIR

### src/adapters/claude-code.ts - "src/adapters/claude-code.ts"
Cohesion: 0.26
Nodes (12): ALTERNATE_PARENT_PROMPT_POSITIONS, billingValueSaysSubagent(), effectiveParentPromptPosition(), ENRICHED_TOOL_NAMES, enrichParentTools(), findBillingBlockIndex(), isBillingMetadataText(), isRecord() (+4 more)

### tests/support/native-layout.ts - "tests/support/native-layout.ts"
Cohesion: 0.32
Nodes (10): layoutBody(), profile, body(), v2(), NATIVE_CONTEXT_LEAD_IN, NATIVE_INSTRUCTIONS_LEAD_IN, nativeContextBlockV1(), nativeInstructionsBlockV2() (+2 more)

### scripts/build.ts - "scripts/build.ts"
Cohesion: 0.32
Nodes (11): assertSourcesPresent(), BUILD_HISTORY, bundle(), copyCapabilityProfiles(), emitDeclarations(), Entrypoint, ENTRYPOINTS, fail() (+3 more)

### scripts/poc-serve.ts - "scripts/poc-serve.ts"
Cohesion: 0.32
Nodes (9): assertProductionCapabilityProfile(), assertProductionTransportProfile(), exitCodeForError(), isHelpRequested(), KNOWN_FLAGS, parsePocServeArgs(), PocServeArgs, run() (+1 more)

### tests/probes/run-binary.ts - "tests/probes/run-binary.ts"
Cohesion: 0.24
Nodes (11): ProbeResult, LifecycleJudgement, judgeM3A(), InvocationCompletion, RunJudgement, RoutingJudgement, digestFile(), isInsideRun() (+3 more)

### tests/support/run-built-entrypoints.ts - "tests/support/run-built-entrypoints.ts"
Cohesion: 0.24
Nodes (10): claude(), codex(), configPath, DIST, fail(), INVENTORY, opencode(), ROOT (+2 more)

### tests/support/resume-proof-fixture.ts - "tests/support/resume-proof-fixture.ts"
Cohesion: 0.25
Nodes (9): RESUME_INSPECTION_CLAIM, loadOrThrow(), REAL_PROOFS, SyntheticProofSite, SYNTHETIC_RESUME_CLAIM, SYNTHETIC_RESUME_SITES, SyntheticResumeProofOptions, writeSyntheticResumeBinary() (+1 more)

### tests/adapters/codex-hook.test.ts - "tests/adapters/codex-hook.test.ts"
Cohesion: 0.29
Nodes (7): collectStdout(), concat(), drive(), inventory, isRecord(), jsonStdin(), supported

### tests/transport/handler.test.ts - "tests/transport/handler.test.ts"
Cohesion: 0.20
Nodes (4): CHILD_SYSTEM, FIXTURE_SUPPORTED_PROFILE, FIXTURE_TRANSPORT_PROFILE, source

### scripts/poc-demo.ts - "scripts/poc-demo.ts"
Cohesion: 0.33
Nodes (8): anthropicMessageBody(), assertEqual(), CAPABILITY_FIXTURES_DIR, fail(), main(), SYNTHETIC_CLAUDE_PROFILE, TESTS_TMP_ROOT, WORKTREE_ROOT

### tests/e2e/cli-workflow.test.ts - "tests/e2e/cli-workflow.test.ts"
Cohesion: 0.31
Nodes (7): configCheckGeneration(), deps(), err, networkForbidden(), out, run(), TESTS_TMP_DIR

### tests/adapters/capabilities.test.ts - "tests/adapters/capabilities.test.ts"
Cohesion: 0.25
Nodes (5): ALL_LIFECYCLE_PASSED, FIXTURES, INVALID_FIXTURES, TRUSTED_NEXT, TRUSTED_UNKNOWN

### tests/cli/export-dispatch.test.ts - "tests/cli/export-dispatch.test.ts"
Cohesion: 0.29
Nodes (5): deps(), err, networkForbidden(), out, TESTS_TMP_ROOT

### tests/probes/native-claude-gateway.mjs - "tests/probes/native-claude-gateway.mjs"
Cohesion: 0.50
Nodes (7): classify(), msgId(), record(), server, sse(), taskReply(), textReply()

### tests/probes/native-claude-handler.ts - "tests/probes/native-claude-handler.ts"
Cohesion: 0.39
Nodes (8): agentToolUseSse(), childToolUseSse(), createScriptedUpstream(), nestedAgentToolUseSse(), resumeToolSse(), sseFrom(), startScriptedUpstreamServer(), textSse()

### tests/cli/diagnostics.test.ts - "tests/cli/diagnostics.test.ts"
Cohesion: 0.29
Nodes (3): err, out, TESTS_TMP_ROOT

### tests/probes/packaged-serve-capture.ts - "tests/probes/packaged-serve-capture.ts"
Cohesion: 0.33
Nodes (5): CHANNEL_A_AGENTS, PARENT_CLIENT_MODEL, [captureDir, upstreamCaptureDir, profilePath, clientVersion], postDir, preDir

### tests/probes/native-claude-packaged-front.mjs - "tests/probes/native-claude-packaged-front.mjs"
Cohesion: 0.50
Nodes (3): preDir, server, targetUrl

## Knowledge Gaps
- **240 isolated node(s):** `ROOT`, `BUILD_HISTORY`, `Entrypoint`, `ENTRYPOINTS`, `WORKTREE_ROOT` (+235 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 345 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **7 thin communities (<3 nodes) omitted from report** : run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `RouterError` connect `src/cli/read.ts` to `tests/probes/evidence-m1.ts`, `src/agents/export.ts`, `src/transport/handler.ts`, `src/agents/claude-code.ts`, `tests/probes/evidence-m3a.ts`, `tests/probes/run.ts`, `tests/probes/resume-proof.ts`, `tests/cli/staleness.test.ts`, `src/transport/claude-hook.ts`, `src/adapters/codex-hook.ts`, `src/core/types.ts`, `src/adapters/capabilities.ts`, `src/adapters/opencode.ts`, `src/adapters/opencode-plugin.ts`, `src/core/config.ts`, `tests/cli/write.test.ts`, `tests/probes/fixture-writer.ts`, `scripts/poc-serve.ts`, `tests/support/resume-proof-fixture.ts`, `tests/adapters/codex-hook.test.ts`, `tests/adapters/capabilities.test.ts`, `src/adapters/correlation.ts`?**
  _High betweenness centrality (0.168) - this node is a cross-community bridge._
- **Why does `CapabilityProfile` connect `src/adapters/opencode-plugin.ts` to `src/cli/read.ts`, `src/transport/handler.ts`, `tests/probes/handler-fixture.test.ts`, `src/agents/claude-code.ts`, `tests/cli/staleness.test.ts`, `src/transport/claude-hook.ts`, `src/adapters/codex-hook.ts`, `tests/probes/native-claude-handler.ts`, `src/adapters/markers.ts`, `src/core/types.ts`, `tests/integration/cliproxyapi.test.ts`, `src/adapters/capabilities.ts`, `src/adapters/opencode.ts`, `tests/probes/evidence-freshness.test.ts`, `src/adapters/claude-code.ts`, `tests/support/native-layout.ts`, `scripts/poc-serve.ts`, `tests/support/run-built-entrypoints.ts`, `tests/adapters/codex-hook.test.ts`, `tests/transport/handler.test.ts`, `scripts/poc-demo.ts`?**
  _High betweenness centrality (0.028) - this node is a cross-community bridge._
- **Why does `configFixture()` connect `tests/cli/staleness.test.ts` to `src/cli/read.ts`, `src/agents/export.ts`, `src/core/hash.ts`, `src/transport/claude-hook.ts`, `src/adapters/codex-hook.ts`, `tests/probes/native-claude-handler.ts`, `tests/integration/cliproxyapi.test.ts`, `src/adapters/opencode.ts`, `src/adapters/opencode-plugin.ts`, `src/core/config.ts`, `tests/probes/evidence-freshness.test.ts`, `tests/cli/write.test.ts`, `tests/e2e/routing.test.ts`, `tests/support/native-layout.ts`, `tests/support/run-built-entrypoints.ts`, `tests/adapters/codex-hook.test.ts`, `tests/transport/handler.test.ts`, `tests/e2e/cli-workflow.test.ts`, `tests/cli/export-dispatch.test.ts`, `tests/cli/diagnostics.test.ts`, `tests/cli/read.test.ts`, `tests/catalog/sync.test.ts`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **What connects `ROOT`, `BUILD_HISTORY`, `Entrypoint` to the rest of the system?**
  _240 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `src/cli/read.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05577211394302849 - nodes in this community are weakly interconnected._
- **Should `tests/probes/evidence-m1.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06853146853146853 - nodes in this community are weakly interconnected._
- **Should `src/agents/export.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06412583182093164 - nodes in this community are weakly interconnected._