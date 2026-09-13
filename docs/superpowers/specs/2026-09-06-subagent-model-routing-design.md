# Subagent model routing

Date: 2026-09-07

Status: draft (revision 6, for review)

## Goal

`subagent-router` is meant to let the parent make an informed model selection for a specific native subagent without changing the parent's model. A single run can serve child subagents using different models and different providers at the same time, as long as the configured gateway supports them.

The project is meant to be a small Bun + TypeScript package. It should work both as a library imported by other tools and standalone through a CLI. This is one package, not a monorepo.

This document describes a proposed design. Status `draft` does not mean acceptance of every detail, nor consent to start implementation. Revision 2 closed the open design decisions from revision 1 and turned the remaining gaps into concrete measurements with criteria. Revision 3 adds a designed, unverified contract for the model catalog, discovery, route preview, and a small CLI. Revision 4 clarifies the small package's boundaries, effective enforcement by native adapters, decision continuity, and transparent transport. Revision 5 names an external gateway, primarily `9router` or OmniRoute, as the owner of the provider conversation, and forbids depending on the `@the-next-ai/ai-gateway` package used by CCR. This does not mean the CLI, discovery, or routing runtime exist.

### Changelog for revision 4

- Document date: 2026-09-07.
- Clarified the package's responsibility boundaries, independence from the KB, and the split between the AI SDK, the router's own runtime, and transparent forwarding.
- Strengthened the runtime requirements for the OpenCode and Codex adapters, including the M6-runtime negative and positive control, and evidence of an effective M7 guard.
- Detailed the D2 channels, behavior after losing the marker or identity state, and the transparent HTTP contract.
- Added the M10-freshness subcase for default initialization and a designed native export metadata sidecar that does not replace runtime evidence.
- Added boundary and adapter matrices and test strategy assertions. No implementation was added. No measurements were performed.

### Changelog for revision 6

- Document date: 2026-09-09.
- A measurement on Claude Code 2.1.266 showed that the child's first `user` message carries two text blocks: block 0 is the client's native context (one or more complete `<system-reminder>` sections with project memory and the date), block 1 is the parent's delegation prompt with the marker on the first line. D2 position 2 read block 0, so channel A ended in `missing-selection`.
- Added a narrow, profiled exception to position 2: an optional profile field `parentPromptPosition` with value `after-native-context-v1`, a separate measurement `M3-A`, and an exact binding of the client version from the request to the version of the loaded profile. The exception applies only to the parent variant. Channels B and B2, M3, and M10 do not change.
- Requirements 1-53, decision D1, D3-D11, and the remaining measurements are unchanged. No profile was promoted; `M3-A` stays `pending` for both measured versions.

### Changelog for revision 5

- Document date: 2026-09-08.
- The provider conversation is run by an external gateway, targeting `9router` or OmniRoute. LiteLLM or another gateway with the same HTTP contract remains acceptable.
- The package must not depend on `@the-next-ai/ai-gateway`, the gateway package used by CCR, nor embed any other gateway library. The gateway runs as a separate process and HTTP endpoint. The reason is the operator's observed low performance of that package with the OpenAI provider, and keeping gateway swaps as a configuration change.
- Added a decision rejecting embedding the gateway and a test strategy assertion for this boundary. Requirements 1-43 and 48-53, decisions D1-D11, and measurements M1-M10 are unchanged.

## Status and evidence scope

As of 2026-09-06: the repository contains documentation, with no router implementation and no tests. No E2E tests of the new behavior were run. [verified]

### Versions measured locally

Read via `--version` on the author's machine, 2026-09-06. [verified]

| Tool | Local version | Latest release (GitHub API, 2026-09-06) |
|---|---|---|
| Claude Code | 2.1.263 | not checked |
| OpenCode | 1.18.29 | v1.18.29, 2026-09-04 |
| Codex CLI | 0.150.0-alpha.8 | rust-v0.153.4, 2026-09-04 |
| Bun | 1.3.11 | not checked |

### Claude Code

[verified] CCR has an existing mechanism that inspired this design. The symbol [`resolveBuiltInClaudeCodeSubagentRouteDecision`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/src/gateway/claude-code-router-plugin.ts) selects a model based on a tag. The symbol [`extractAndRemoveClaudeCodeSubagentModelTag`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/src/gateway/claude-code-router-plugin.ts) looks for the tag in `system` blocks and in at most the first two `user`-role messages, then strips it from the request. The symbol [`removeClaudeCodeBillingSystemHeader`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/src/gateway/claude-code-router-plugin.ts) recognizes a child subagent by the `cc_is_subagent=true` metadata in the first `system` block.

[verified] The CCR test `"does not trust agent-id without billing metadata"` in [`router-builtins.test.mjs`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/test/unit/gateway/router-builtins.test.mjs) shows that CCR does not treat the `x-claude-code-agent-id` header alone as evidence of origin from a child.

[verified] The Claude Code 2.1.263 binary contains the strings `x-claude-code-agent-id`, `cc_is_subagent`, `CLAUDE_CODE_SUBAGENT_MODEL`, and `compact_boundary` (counted with `grep -ac` on the executable). The code fragment that builds API request headers adds `x-claude-code-agent-id` when the request context has `agentId`, and `x-claude-code-parent-agent-id` when it has `parentAgentId` (read via `grep -aoE` with context around the header name). This does not prove that `agentId` is set on every child request, including after compaction. That is the subject of measurement M1.

[verified] The [Claude Code sub-agents](https://code.claude.com/docs/en/sub-agents) documentation, read on 2026-09-06, gives the model selection order: the call's `model` parameter, the definition's frontmatter `model`, the `CLAUDE_CODE_SUBAGENT_MODEL` variable, the main conversation's model. A fork and a skill with `model: inherit` always run on the main conversation's model. Subagents get automatic compaction on the same rules as the main conversation. The call's `model` parameter also applies when resuming a subagent.

[verified] The [Claude Code hooks](https://code.claude.com/docs/en/hooks) documentation, read on 2026-09-06: the `PreToolUse` hook's `updatedInput` field does not apply to the `Agent` tool. The `SubagentStart` hook receives `agent_id` and `agent_type` and can return `additionalContext`, injected into the launched subagent's context. No hook receives or changes the subagent's model.

[verified] In the Claude Code 2.1.263 session that produced this document, the `Agent` tool schema visible to the model restricts the `model` parameter to the aliases `sonnet`, `opus`, `haiku`, `fable`. The documentation also allows full identifiers in frontmatter. The gap between the schema and the documentation is the subject of measurement M2.

[verified] CCR maps Claude Code aliases to arbitrary gateway identifiers through environment variables, see [`environment.ts`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/src/agents/claude-code/environment.ts)`::"ANTHROPIC_DEFAULT_HAIKU_MODEL"`. This mechanism gives at most a handful of model classes, not an arbitrary number of child models. [inferred]

### OpenCode

[verified] In OpenCode, the symbol [`TaskTool`](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/tool/task.ts) takes `subagent_type`, resolves it through the agent registry, and returns an `Unknown agent type` error for an unknown name. The child's model comes from the selected agent's configuration or from the parent's model. The tool has no `model` argument.

[verified] The symbol [`Provider.getModel`](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/provider/provider.ts) returns `ModelNotFoundError` when the model identifier is not present in the configured provider's `models`. [inferred] The Task path resolves the agent's model through the same lookup, so opaque gateway identifiers must be entered into the provider configuration. Measurement M6 confirms this on a running client.

[verified] The `chat.headers` plugin hook in [`request.ts`](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/session/llm/request.ts)`::"chat.headers"` receives `sessionID`, the agent name, the model, and the provider, and returns headers added to the request. The `tool.execute.before` hook receives the tool name, `sessionID`, `callID`, and modifiable `args`, see [`index.ts`](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/plugin/src/index.ts).

[verified] The [OpenCode agents](https://opencode.ai/docs/agents/) documentation: an agent's model has the format `provider/model`, a subagent without a model inherits the calling agent's model, definitions live in `opencode.json` or in Markdown files under `.opencode/agents/` or `~/.config/opencode/agents/`. The `hidden` option hides an agent from autocomplete but does not block its use through Task.

### Codex

[verified] The Codex source code has a `model` field in [`spawn_agent_common_properties_v1`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tools/handlers/multi_agents_spec.rs). In [`spawn.rs`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs)`::"effective_model"` the child's model is a plain string passed into the child thread's configuration. A role can override the model, see [`role.rs`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/agent/role.rs). No per-child `model_provider` override was found in this code, so the child uses the session's provider. [inferred]

[verified] The [Codex hooks](https://learn.chatgpt.com/docs/hooks) documentation, read on 2026-09-06: hooks are enabled by default, `PreToolUse` can return `hookSpecificOutput.updatedInput`, and the `Agent` matcher covers `spawn_agent`. The page notes that the schema on the `main` branch may contain fields absent from the current release.

[verified] The [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) documentation: `agents.default_subagent_model`, role files under `~/.codex/agents/` or `.codex/agents/` with a `model` field, explicit spawn values take precedence over defaults. A separate `model_provider` for the child is not documented.

[verified] The `config.schema.json` configuration schema at the pinned commit contains `ModelProviderInfo` with `base_url`, `wire_api`, `env_key`, `http_headers`, `env_http_headers`, `query_params`, and an agents section with `default_subagent_model`, `enabled`, `max_depth`. An optional `model_catalog` exists. Whether an unknown model identifier without a catalog is rejected is not established. That is measurement M5.

## Normative requirements

### Product and boundaries

1. The package MUST be a single small Bun + TypeScript package, not a monorepo, available both as an importable library and through a CLI.
2. Core MUST be pure and importable without a mandatory server process. It is responsible only for the model catalog, local descriptions and aliases, snapshots passed in by the caller, and the deterministic routing decision.
3. Core MUST NOT depend on harness SDKs or require an AI SDK. A dependency on an SDK client alone, if it is ever used by a separate integration, does not mean the router runs its own agent loop.
4. Bun is allowed in the CLI and standalone mode, but core MUST NOT require a Bun-specific API.
5. The designed `subagent-router` CLI is meant to be a small text interface for diagnostics, offline preview, controlled export, and explicit catalog discovery. IT DOES NOT INCLUDE a TUI, a daemon manager, or an installer.
6. No command MUST automatically change native harness files. Export writes only to a separate artifact directory, never to the agent source directory, even with `--force`.
7. The project MUST NOT create its own agent loop, tool execution, child lifecycle, MCP runner, embeddings, retrieval, code graph, knowledge store, scheduler, UI, daemon manager, or database.
8. The project DOES NOT COVER provider account auth, OAuth, protocol translation, provider-specific discovery, provider routing, or automatic fallback to another model. Catalog discovery through the CLI stays a separate operation, not a request-time dependency.

### Model selection

9. The parent MUST be able to select a model for a specific child from a description catalog based on the snapshot loaded by that instance.
10. Core MUST validate every explicit selection against the snapshot and `modelOverrides`.
11. Core MAY apply explicit route overrides for existing roles and a global default child model.
12. Core MUST NOT run an extra LLM or an automatic selector to classify the task, select the model, or generate a model description.
13. Different children MUST be able to use different models and providers in the same session, as long as the configured gateway supports them.
14. A child's selection MUST NOT change the parent's model.
15. The `upstreamModel` identifier MUST be opaque and compared case-sensitively. The package MUST NOT branch logic on the vendor name or define `providers/*`; a gateway swap must not introduce a vendor branch into core or the handler.
16. The allowlist catalog and role definitions MUST NOT be overridden by a prompt, history, or a tool result. The parent's explicit selection from the catalog is carried through the authorized D2 channel, and is not treated as a configuration edit.
17. A configured role by itself is NOT evidence that any given request comes from a child.

### Deterministic decision rules

18. For a child subject to routing, the decision order MUST be: explicit selection, the specific role's default model, the global default child model. An invalid explicit selection MUST NOT fall through to a default value.
19. A child is subject to routing when the adapter has confirmed its origin and either an explicit selection exists for it, or an earlier decision correlated with that same child exists. A role's default model or the global default child model may initiate a decision only after confirming a fresh delegation through the M10-freshness subcase. An invalid marker in an authorized position is an `invalid-marker` error, not a missing marker. A recognized child with no indication, and, for default initialization, also with no confirmed freshness signal, ends in a `missing-selection` error, because the router cannot distinguish a child never subject to routing from a child that lost its route after compaction, a TTL expiry, or a handler restart. Until M10-freshness passes, the default-initialization channel without an explicit selection or correlation is unsupported and returns `missing-selection` or `unsupported-path` depending on whether the request is a recognized child or the adapter is attempting to run an unverified path. The only exception is the explicit opt-in `defaults.unmarkedSubagent: "inherit"`, which lets such a child through with the code `inherit-allowed`. This opt-in is the operator's informed consent that a lost route will be invisible, and is documented in the configuration as such consent.
20. A parent with no match MUST pass through with no change to its model. The exception described in D9 may idempotently enrich only the copy of the parent request, adding the catalog and selection instructions to the `Agent`, `Task`, `Workflow` tool descriptions and the `description` field of their `prompt` parameter. Outside these text description fields, it does not change the tool schema, tool availability, permissions, `system` blocks, or historical content.
21. An explicitly routed child with an unknown model, a disallowed model, conflicting markers, or an unsupported path MUST end in an error.
22. In such cases, the parent's model MUST NOT be silently used.
23. The package MUST NOT automatically pick another model after a routing error.

### Client model and upstream model

24. Documentation and contracts MUST distinguish `clientModel` from `upstreamModel`.
25. `clientModel` is the setting used for validation, harness initialization, and, where supported, client-specific limits.
26. `upstreamModel` is the model actually sent to the configured gateway.
27. A native fork MAY inherit `clientModel`, and request routing MAY select a different `upstreamModel`.
28. In `marker-routed` mode, the selection of the actual model MUST NOT depend solely on the harness's native model field. In `native` mode, the selection is based on the exact resolved native model component equal to `upstreamModel` per requirement 31, and requirement 33 describes the mandatory validation.
29. The case of a fork with an inherited `clientModel` and a different `upstreamModel` MUST have its own acceptance case.
30. The specification does NOT claim that various forks are already tested.

### Integration modes

31. Every adapter MUST declare one of two modes: `native`, when the native resolver passes the exact `upstreamModel` as the effective model target, or `marker-routed`, when the handler in front of the gateway determines `upstreamModel`. The `native` representation may require a native provider prefix, for example OpenCode's `PROVIDER_ID/upstreamModel`; the prefix identifies only the configured native provider, and the model part, after the native resolver settles it, remains the literal, opaque `upstreamModel`.
32. OpenCode and Codex run in `native` mode. Claude Code runs in `marker-routed` mode. Changing an adapter's mode requires a specification revision.
33. In `native` mode, core still validates the selection against the allowlist and resolves defaults, but an HTTP handler is not required. Every `native` adapter MUST perform a runtime guard before the child launches: validation of the explicit model field must effectively stop a disallowed selection, and the model actually used by the child must match core's decision. A manually integrated export may apply a default, but a resolved default that is not shown as applied, whether a role default or a global default, is not support. An inherited parent model does not thereby become a new default. If the harness in a given version gives no effective hook point, the adapter MUST refuse to operate for that version with the code `unsupported-path`. A declarative restriction to roles, the export by itself, or a pure validating function do not replace runtime validation, because none of them stop the parent from supplying a model directly.

### Routing in front of the gateway

34. The routing layer in front of the gateway is part of the first implementation's scope for `marker-routed` mode.
35. Core, client adapters, and a thin HTTP handler or the CLI `serve` command MUST together provide marker routing for Claude Code.
36. An embedding application MUST be able to use the same handler without running an extra proxy process.
37. The handler MUST send upstream routing to the gateway configured by the caller or the environment.
38. The handler MUST NOT derive the upstream URL from the prompt or from request content.
39. The forwarding endpoint and header configuration MUST come from the caller or the environment.
40. Secrets MUST NOT end up in prompts, markers, or diagnostics.
41. The handler MAY read routing JSON only for supported requests.
42. Responses and streams MUST be a transparent pass-through: the handler preserves response bytes, status, end-to-end headers, SSE, and unknown frames, errors, tool calls, and usage, without decoding, regenerating, protocol translation, or full buffering.
43. Stream cancellation, disconnect, and backpressure MUST pass through to upstream with no semantic change. The handler only forwards existing requests; it does not make its own generative calls, retries, or model fallbacks. The exclusive list of changes to the upstream request copy separates three scopes: for every forwarded request, applying the endpoint and headers solely from the caller or the environment, plus necessary transport header changes; only for a recognized child, changing `model` to `upstreamModel`, removing the authorized marker, and removing the recognized technical billing block after reading its provenance; for a parent request, enriching only the description fields named in requirement 20 and D9. Removing the billing block from the child request copy prevents internal harness metadata from being passed to the gateway. Ordinary `system` blocks and the rest of the body and history remain unchanged. This list does not allow changing the response or the stream covered by requirement 42.

### Gateway independence

44. The provider conversation is run by an external gateway. The target gateways are `9router` or OmniRoute; LiteLLM or another gateway with the same HTTP forwarding and model listing contract is acceptable. The gateway owns the protocols, provider auth, OAuth, translation, and upstream selection.
45. `subagent-router` MUST be independent of the code and internal databases of every such gateway; it uses only the configured HTTP forwarding and discovery contract, not the gateway's modules or storage. Core and the offline CLI do not depend on gateway availability, but transparent forwarding and explicit discovery require an available, configured gateway. The router stays independent of the code, data, and availability of the separate Markdown/Git plus PostgreSQL plus Weaviate KB reached through CLI/MCP.
46. The package MUST NOT contain gateway adapters, provider auth implementations, vendor-based routing, KB code, context fetching, or MCP execution. The package also MUST NOT depend on `@the-next-ai/ai-gateway`, the gateway package used by CCR, or on any other package implementing a gateway, including as an optional or dev dependency used by production code. A native agent may use the KB outside the router.
47. Swapping the gateway endpoint while keeping the same opaque, case-sensitive model identifiers MUST NOT require a router code branch. Core passes `upstreamModel` through without interpreting the vendor.

### Catalog and inspection

48. A model present in the snapshot and enabled MAY be selected explicitly without a local description, but without a description it MUST NOT appear in suggestions shown to the parent.
49. `modelOverrides` MUST NOT activate a model absent from the fetched catalog. The description of a model marked `missing` stays preserved.
50. Upstream IDs and aliases are compared case-sensitively. An upstream ID MUST NOT be trimmed, normalized, or derived from an alias. The role name is supplied by the native resolver.
51. Choosing a `missing` or disabled model MUST end in an explicit error with no fallback.
52. Native agent definitions, including `model: inherit`, MUST stay unchanged. A preview does not replace measuring the model actually used by a running harness.
53. The CLI MUST provide offline inspection and machine-readable JSON output. Write commands have an explicit write scope and reject concurrent-edit conflicts.

## Architecture and responsibilities

### Responsibility boundary matrix

| Area | `subagent-router` responsibility | Out of scope or owner |
|---|---|---|
| Core | Model catalog, local descriptions, aliases, snapshots, explicit-selection validation, deterministic defaults, and decision codes. | The LLM selector, agent loop, tool execution, and child lifecycle belong to the native harness. |
| Claude Code, OpenCode, and Codex adapters | Trustworthy recognition of the child, a runtime guard before the child in `native` mode, and carrying core's decision. | Changing native UI, permissions, tools, lifecycle, or source agent definitions. |
| Marker and thin HTTP handler | Recognizing the authorized marker, ephemeral correlation, changing the model on an allowed request, and transparent forwarding. | Decoding or regenerating responses, retries, fallback, generative calls, protocol translation, and provider routing. |
| CLI | Diagnostics, offline preview, explicit snapshot sync, and controlled export to a separate directory. | TUI, scheduler, daemon manager, database, automatic installation, and changing active native configurations. |
| Gateway | Not implemented by the package. | An external process: targeting `9router` or OmniRoute, acceptably LiteLLM or another gateway with the same HTTP contract. Handles auth, OAuth, protocol, upstream, and vendor routing. The `@the-next-ai/ai-gateway` package from CCR is not a router dependency. |
| KB | The router does not depend on the KB's code, data, or availability. | The separate Markdown/Git plus PostgreSQL plus Weaviate KB reached through CLI/MCP, embeddings, retrieval, code graph, and knowledge storage. A native agent may use it outside the router. |

### Separation of the AI SDK, runtime, and forwarding

AI SDK means the SDK client used by the caller or a separate integration for model calls. A dependency on the SDK by itself does not mean the router runs its own agent loop, executes tools, manages lifecycle, or routes providers. Core and the handler do not require a mandatory AI SDK.

A router's own runtime built on the AI SDK would be a separate, unrequested scope. No implementation plan or runtime should be created for it, and the repository should not be renamed for it, within this project. The designed handler forwards the request it already received transparently. Decoding the SDK response and regenerating it cannot replace transparent transport, because that violates requirements 42 and 43.

### Core

[assumption] Core takes a normalized request context, the model catalog, and explicit information about the child's origin. It returns a deterministic decision: pass-through, route to an opaque `upstreamModel`, or a described error.

Core is responsible for:

- validating the catalog and the selection,
- resolving defaults,
- resolving conflicts among normalized model indications,
- rejecting indications whose origin the adapter did not confirm,
- having no state shared across sessions.

Recognizing messages, markers, and the child's identity belongs to the client adapter. Core does not parse a specific harness's raw history.

Core is not responsible for:

- calling the harness,
- HTTP transport,
- auth, OAuth, or protocol translation,
- detecting provider capabilities or provider routing,
- managing the agent loop, tool execution, and subagent lifecycle,
- the KB, embeddings, retrieval, code graph, knowledge storage, context fetching, or running MCP.

### Client adapters

[assumption] An adapter translates only the local contract of a native harness into core's input and output. It preserves that harness's native tools, permissions, UI, and lifecycle.

An adapter MUST:

- pass trustworthy data about the current child to core,
- carry the decision to the harness (`native` mode) or to the routing handler (`marker-routed` mode) in a supported way,
- explicitly refuse when it cannot safely preserve the selection,
- not change the parent's model or permissions.

An adapter DOES NOT GUARANTEE:

- the same model quality,
- equal model capabilities,
- matching context limits,
- a matching reasoning format.

The last two points are an accepted limitation, described in the section on limits, not grounds for silently changing `upstreamModel`.

### Routing handler

[assumption] The thin handler recognizes the current child's controlled marker, computes core's decision, applies only the changes listed in requirement 43 to a copy of the upstream request, and forwards the existing request to the configured gateway. This contract is designed, not measured at runtime.

The original client history and the parent's model MUST NOT be mutated. The handler MUST NOT treat as authorized any marker found in old history, tool results, or quoted text.

The handler preserves response bytes, status, end-to-end headers, and SSE, including unknown frames, errors, tool calls, and usage. It does not decode the response, does not regenerate it through an SDK, does not buffer the whole stream, does not initiate a generative call, and does not perform retries or fallback. It forwards abort, disconnect, and backpressure to upstream.

The handler keeps only the ephemeral routing state described in D2: correlation, one-time delegation proofs, and protection of their nonce against replay until expiry. It writes nothing to disk and does not manage agent lifecycle.

[assumption] Evidence of transparency for the passed-in `FetchLike` has its own `TransportCapabilityProfile` with the fields `adapterId`, `runtimeVersion`, `status`, `gzipBytes`, and `responseHeaders`. The profile applies to a specific transport implementation and runtime version, not to the model or vendor. Every result required by a given transport contract must be `passed`; a missing, `pending`, `failed`, or mismatched transport identity causes `unsupported-path` when the handler instance is created, that is, a refusal to start `serve` or to create an embedded handler. This is a condition on starting the transport, not a routing error imposed on an ordinary parent request. The measurement covers an actual gzip response and byte and header fidelity, not just a fake fetch or fixing up headers after decompression. Embed and the CLI pass the profile explicitly; a transport change requires its own evidence. The handler does not perform a hidden self-probe or discovery at request time. A hermetic test may inject a synthetic profile, but that does not count as evidence of production runtime support.

### Adapter, runtime checkpoint, and refusal matrix

| Adapter | Mode and runtime checkpoint | Required evidence | Refusal when evidence or effect is missing |
|---|---|---|---|
| Claude Code | `marker-routed`; handler before the child's upstream request, after trustworthy origin recognition. | M1 for correlation and identity, M3 for channel B, M10 and M10-freshness for lifecycle and default initialization. | `missing-selection`, `invalid-marker`, `correlation-conflict`, or `unsupported-path` matching the missing condition. |
| OpenCode | `native`; `tool.execute.before` before the child launches, with no modification of `args` or `subagent_type`; after the native resolver, compares the configured provider and the exact `upstreamModel` separately. | M6 and the M6-runtime subcase: an actual deny and a read of the authoritative effective config before the child on every supported path; M10 for every supported lifecycle transition and M10-freshness for default initialization. | `unsupported-path`; export, a role, or an unshown default are not a fallback. |
| Codex | `native`; a registered `PreToolUse` with the `Agent` matcher before `spawn_agent`. | M5, M7 with actual stdin/stdout, deny, and a read of the authoritative effective config, M9 for precedence, M10 for every supported lifecycle transition, and M10-freshness for the default. | `unsupported-path`; a role, export, or a computed default alone do not certify support. |

Core's default is a logic decision, not authorization to mutate `args`, `subagent_type`, or native files. Success of a `native` adapter requires evidence that the runtime loaded the authoritative effective definition or configuration matching the read-only metadata sidecar, its `snapshotGeneration`, and the artifact hash, that a confirmed native precedence leads to a model equal to core's decision, and that the guard runs before the child. Export may prepare an artifact for manual integration, which, once actually loaded, may apply a default. An unapplied or unverifiable export means a measurement gate and `unsupported-path`; an inherited parent model is not a new default.

### Configuration

The project separates the operator's `subagent-router.json` file from the generated `models.lock.json` snapshot. Core accepts these same already-loaded objects from the caller, so an embedding application does not need to read files or the environment. The exact format is described in "Decision D4".

The configuration MUST separate:

- `clientModel`, when the adapter needs it,
- the exact opaque `upstreamModel` from the snapshot,
- optional `routeOverrides` for existing effective agent names,
- operator descriptions, aliases, and model status,
- the endpoint and references to auth and headers, only in operator configuration or the environment,
- the catalog snapshot, with no secrets and no raw gateway response.

## Contracts and invariants

`enforcement: no implementation`. The contracts below describe requirements, not existing safeguards. In the end, core tests check the decision and the allowlist, adapter tests check origin and selection continuity, and handler and E2E tests check the actual model and transport.

### Routing decision contract

For every supported request, core returns exactly one result:

1. `pass-through` for a parent, or for a child covered by an explicit inheritance opt-in. The result carries the diagnostic code `parent` or `inherit-allowed` and a list of markers ignored from unauthorized positions, as `ignored-marker`.
2. `route` with one validated opaque `upstreamModel` for a recognized child. The result carries the decision source: `explicit`, `role-default`, `global-default`, `correlated`.
3. `error` for a child subject to routing, when the selection is invalid, missing, or unsupported. The result carries an error code: `unknown-model`, `model-not-allowed`, `invalid-marker`, `conflicting-markers`, `correlation-conflict`, `unsupported-path`, `missing-selection`.

There is no result meaning "try the parent's model."

### Parent isolation invariant

The parent's model, permissions, tools, and lifecycle stay unchanged. A model change applies only to a request qualified as a specific child. The D9 exception may idempotently enrich only the copy of the parent request, adding a fixed catalog and selection instructions to the `Agent`, `Task`, `Workflow` descriptions and the prompt description. It does not change other schema fields, tools, permissions, `system` blocks, or historical content.

### Trustworthy origin invariant

A marker is a transport-level signal placed in an authorized position by the parent or by the adapter for the current child. It is not a text instruction to the model, and it cannot be accepted when it only appears in an unauthorized part of the request data. A marker coming from the adapter carries an authentication token; a marker coming from the parent is bound to the position at the start of the delegation prompt. The authorized positions are enumerated in section "Decision D2". The effect of every accepted marker is limited to the allowlist, so the worst effect of abuse is selecting a different allowed model, never a model outside the catalog or a different gateway.

### No decision leakage invariant

Parallel and nested children, as well as independent sessions, do not share a model selection. Canceling one session cannot change another session's decision. The correlation memory is keyed by the specific child's identifier together with the handler instance identifier, and is never inherited by another child. An identifier collision with a different marker is a `correlation-conflict` error, not a silent takeover of the decision.

### Transparent failure invariant

For a child subject to routing, the absence of a safe route ends the request with an error before the upstream call. It does not cause the model to be replaced with the parent's model. Ordinary traffic from the parent and from children not subject to routing stays unchanged.

### Transport invariant

After making the decision, the handler applies only the changes to the upstream request copy listed in requirement 43. Beyond those, it forwards the body, response, stream, cancellation, and backpressure without protocol translation.

## Decisions resolving revision 1 gaps

### Decision D1: two integration modes instead of one mechanism for every harness

Resolves gap 6 and gap 7 in the design section.

In OpenCode, the agent's `provider/model` model is sent to the configured provider, and, according to the source reading, the identifier must exist in that provider's `models` catalog, which measurement M6 is meant to confirm. [assumption] The designed OpenCode adapter contract assumes a `PROVIDER_ID/upstreamModel` representation: `PROVIDER_ID` names the configured native provider, and the model returned by the available native resolver must be the exact opaque `upstreamModel`. The guard separately compares `PROVIDER_ID` against configuration and the exact model ID against core's decision. It does not compare the whole qualified string as the model, and it does not strip or normalize segments of `upstreamModel` itself; the example `gateway/gateway/fast-worker` means provider `gateway` and opaque ID `gateway/fast-worker`. M6-runtime must prove this representation, the availability of a native resolver for the guard, and an actual comparison before the child spawns. In Codex, the model given in `spawn_agent` or in a role is passed as a string to the session's provider. In both cases the effective model target after the native resolver is literally `upstreamModel`, so a marker and a handler are not needed. The gateway is a single configured provider: for OpenCode, an OpenAI-compatible provider entry with `baseURL`; for Codex, `model_providers.<id>` with `base_url`.

In Claude Code, the native model field is restricted to aliases or identifiers accepted by the client, and hooks cannot change a subagent's model. Because of this, Claude Code requires `marker-routed` mode: the parent selects from the catalog, the marker reaches the child, and the handler in front of the gateway swaps in `upstreamModel`.

Consequence: an HTTP handler is needed in the first implementation only for Claude Code. Core and the configuration are shared across all three harnesses.

### Decision D2: routing channels and marker syntax for Claude Code

Resolves gap 4 and gap 9.

The marker takes the form of a single tag on a single line and occurs in exactly two grammar variants:

```text
<subagent-router v="1" model="ALIAS"/>
<subagent-router v="1" role="NAME" agent="AGENT_ID" token="HMAC"/>
```

Rules:

- `v` is the syntax version. An unknown version in an authorized position is an `invalid-marker` error.
- The parent variant has only the `v` and `model` attributes. `model` is a safe local alias, not an upstream ID. The alias matches the regex `^[A-Za-z][A-Za-z0-9_-]{0,126}$` and is unique within the current snapshot. The adapter maps the alias to the exact opaque ID before calling core. This lets the marker accommodate upstream IDs containing spaces or Unicode, while the upstream ID itself is never changed.
- The adapter variant has only the `v`, `role`, `agent`, and `token` attributes. `role` is the role name from configuration, `agent` is the child identifier known to the hook, `token` is an HMAC computed from a secret shared by the adapter and the handler on the same machine, over the string `v|role|agent`. The token thus covers every field that affects routing. The secret comes from the environment, never from a configuration file or a prompt.
- Any deviation from these two grammars in an authorized position, including mixing attributes from both variants, disallowed characters, a missing close, or an unknown attribute, is an `invalid-marker` error, not a missing marker.
- Markers are classified by source: `explicit` for the parent variant, `role-default` for the adapter variant. Between sources, the order from requirement 18 applies, so a parent marker wins over a role marker. Two different markers from the same source are a `conflicting-markers` error. Identical markers are treated as one.
- The syntax is this project's own. There is no drop-in compatibility with the CCR tag.

Authorized marker positions:

1. The request's `system` blocks, only for the adapter variant with a correct `token` whose `agent` matches the child identifier in the request. The parent variant, or a marker with no token or an incorrect token, in a `system` block is ignored with the code `ignored-marker`. This rule guards against a marker smuggled in through `CLAUDE.md` content, project instructions, or other system text the adapter did not emit.
2. The first line of the first text block of the first `user`-role message, as long as that message contains no `tool_result` blocks. This is the start of the delegation prompt written by the parent, and only the parent variant is accepted here. The adapter variant in this position is accepted only after M3 passes, confirming exactly this position and a correct token. Before M3 passes, extraction classifies such an adapter variant as `ignored-marker`; a `pending` result, no path, or no evidence does not entitle it to be accepted. In that case the same token verification as in the `system` block applies. A marker later in this message is ignored with the code `ignored-marker`.

A marker in any other position, including in `tool_result` blocks, in later messages, and in the assistant's response content, is ignored. A parent with a quoted marker passes through.

Position 2 exception for the measured native prefix (revision 6). [verified 2026-09-09, Claude Code 2.1.266] The client inserts its own context into text block 0 of the first `user` message, and the parent's delegation prompt into block 1. A profile can declare this with the field `parentPromptPosition: "after-native-context-v1"`; the field being absent, or set to `first-text`, means only position 2 in its previous wording. The alternate slot is considered only when, at the same time: the profile has this explicit setting, `M3-A` has result `passed`, and the client version read from the request (the version token in `user-agent`, in the form `claude-cli/x.y.z`) is identical to the immutable version of the loaded profile. The handler does not reload the profile per request; a mismatch or a missing version falls back to the legacy position. The slot requires exactly two text blocks in this message, with no other blocks; block 0 must fully match the scaffold grammar: one or more complete, non-nested `<system-reminder>` sections, each with a second line that is the harness's introductory sentence and at least one context heading `# name`, with no text before the first opening tag or after the last closing tag other than blank lines. Only the parent variant from the first line of block 1 is accepted; the legacy position takes precedence when it itself carries a marker. Block 0 is forwarded unchanged; only the accepted marker line is stripped from block 1. A marker later in block 1, or inside block 0, is `ignored-marker`. The adapter variant is never accepted in this slot, regardless of `adapterMarkerPosition` and M3. Recognizing the public wrapper is format recognition, not authentication: an HTTP request of the same shape could indicate a model just as it could in the legacy position, and the effect stays limited to the allowlist per the residual risk above.

Position 2 exception for the measured native prefix, layout v2. [verified 2026-09-11, Claude Code 2.1.268] Client 2.1.268 moves its own context scaffold to text block 1, and inserts the operator instruction files into block 0 as exactly one complete `<system-reminder>` section, whose second line starts with the sentence `Codebase and user instructions are shown below.`; the parent's delegation prompt stays in block 2 with the marker on the first line. A profile declares this layout with the field `parentPromptPosition: "after-native-context-v2"`. The slot's opening conditions are identical to v1: an explicit setting in the profile, `M3-A` with result `passed`, and the client version read from the request identical to the immutable version of the loaded profile. The slot requires exactly three text blocks, with no other blocks; block 0 must match the instruction grammar: one complete, non-nested `<system-reminder>` section, a second line starting with that sentence as a prefix (the client appends further sentences on the same line), at least one heading `# name` inside, with nothing before the opening tag or after the closing tag other than blank lines. Block 1 must match the same scaffold grammar that v1 requires. Only the parent variant from the first line of block 2 is accepted; the legacy position takes precedence when it itself carries a marker. Blocks 0 and 1 are forwarded unchanged; only the accepted marker line is stripped from block 2. A marker later in block 2, or inside blocks 0 and 1, is `ignored-marker`. The adapter variant is never accepted in this slot, regardless of `adapterMarkerPosition` and M3. Each layout matches only its own block count: the v1 profile never reads a three-block message, and the v2 profile never reads a two-block one, so a mismatch falls back to the legacy position and ends in `missing-selection`. Recognizing either wrapper is format recognition, not authentication; the parent channel's residual risk is the same as in v1. `M3-A` for 2.1.268 was measured as `passed` (run `handler-yXSP4o`, `PROBE_LAYOUT=v2 PROBE_PROFILE_BASE=real`, two child pairs, all six conditions met). Status note, 2026-09-11 (English): the clause that `claude-code-2.1.268.json` has no `parentPromptPosition` field is historical, true only until 2026-09-11. That fixture now declares `"parentPromptPosition": "after-native-context-v2"`, added by hand, so the v2 slot is declared for this version. Production still refuses every 2.1.268 child request: `assertCapability` stops at `status: "pending"`, and `M10`, `M10-freshness`, `lifecycle.resume` and `lifecycle.compaction` stay `pending`.

Residual risk of the parent channel: a parent who copies someone else's text with a marker into the first line of its own delegation prompt chooses that model just as if it had done so itself. The effect is limited to the allowlist. The specification accepts this risk, because the parent is by design the choosing party, and the delegation tool's instructions require placing the marker as the first line of its own text.

Channels through which the selection reaches the child:

- Channel A, the parent's explicit selection: the parent places the marker as the first line of the delegation prompt. The delegation tool description, supplied by the adapter as an idempotent addition to the parent's context, lists only the active models with a local description, their aliases, and the syntax. The delegation prompt is the first `user` message of every subsequent turn of a fresh subagent, so the selection is visible on every request with no memory needed on the handler side. [inferred from the CCR parsing position and from how the subagent conversation is built]
- Channel B, the role's default model: the adapter's `SubagentStart` hook knows `agent_id` and `agent_type`, computes `token`, and injects the adapter variant of the marker through `additionalContext`. This gives a role a default model even when the parent did not indicate one. Channel B may be enabled only after M3 passes, confirming the exact authorized marker position and the token, and M10-freshness passes, confirming a fresh delegation before default initialization. Every use of B requires a matching `x-claude-code-agent-id` for the same `agent_id`; the header's presence and continuity must follow from M1 or from exact M3 evidence for the selected position. A missing matching header invalidates trust in the marker: extraction returns `ignored-marker`, and the recognized child still falls under requirement 19. A `pending` result, no path, or no evidence means `unsupported-path` only for the attempt to enable channel B, not a blanket refusal of every request. If M3 shows that `additionalContext` does not reach the `system` block or the first `user` message, the adapter may switch to channel B2: the hook registers the `agent_id` and role pair directly with the handler through a local endpoint authenticated with the same secret. B2 requires M1 already passed, M10-freshness, and `harness.claudeCode.correlation: "auto"` as evidence of a trustworthy `agent_id` identity and a fresh delegation; `off` cannot indirectly enable B2 state. Registration is not a substitute for, or a way around, channel C's guards. Every B2 request still requires confirmed child origin and identity match. Channel B2 does not depend on prompt content.
- Channel C, correlation by child identifier: on the first routed request, the handler remembers the pair of child identifier and decision in an ephemeral, time-limited process map. Subsequent requests with the same identifier and confirmed origin keep the already-bound decision with source `correlated`, even when compaction has removed the marker from history. The identifier comes from the `x-claude-code-agent-id` header. Claude Code does not send a separate session identifier, so the key cannot include the session, and the channel's security relies on the child identifier's randomness. Channel C is active only when measurement M1 confirms, for a given version, the header's presence on every child request and identifier randomness sufficient to make a cross-session collision practically impossible. The adapter keeps a list of versions with M1 passed, and has no setting that enables channel C without that pass. Without the pass, channel C is disabled, and losing the marker ends according to requirement 19.

Origin from a child is confirmed only by `cc_is_subagent=true` in billing metadata, as in CCR. The agent identifier header serves correlation, not origin authentication. A request with a correlated identifier that carries a valid marker with a different decision ends in a `correlation-conflict` error, because it points to an identifier collision or a takeover attempt.

Correlation memory: an in-process memory map, keyed by handler instance identifier and child identifier, whose value is the already-validated decision, its source, and a timestamp, with a configurable timeout defaulting to one hour since last use, and no disk writes. A handler restart loses the map. Losing the marker while the bound identity is preserved keeps the previous decision, and a marker with a different decision ends in `correlation-conflict`. Losing both the marker and identity state at the same time, after a restart, exposes a defaults gap: the router MUST NOT, after a restart, choose a new model for that same child from a role default or a global default. Recovering the old decision requires a fresh authorized indication. A fresh default requires evidence of a new delegation with no earlier selection. Merely identifying the current child, or the current path, is not such evidence. Otherwise, the adapter returns `missing-selection`; the only exception is the explicit, confirmed opt-in `defaults.unmarkedSubagent: "inherit"`. This is accepted as a visible error, not as a silent model change. Channel A reconstructs the decision from the delegation prompt, for as long as compaction has not removed it.

The M3-B2 subcase within M3 separately checks the hook's local registration: correct HMAC, matching `agent_id`, registration completing before the first request, and rejection of an incorrect token and a role conflict. It is still unexecuted. A negative M3 result about where `additionalContext` lands does not pass M3-B2. Channel B2 requires a positive M3-B2 in addition to M1, `correlation: "auto"`, and M10-freshness for default initialization; it does not require a positive result from the test of marker position in the body.

The M10-freshness subcase is a required, still-unverified gate for every adapter that wants to initiate a default with no explicit selection or correlation. [assumption] Before the first child request, the adapter must obtain, from a trustworthy harness event, evidence of a new delegation bound to a specific `agent_id`, distinguishable from resume, compaction, reuse of an entry after TTL, and a handler restart. History length alone, the absence of `compact_boundary`, the current path, or the presence of a request are not evidence of freshness. Until M10-freshness passes, the default-initialization channel with no explicit selection or correlation is unsupported under requirement 19. A role B marker preserved after the explicit marker disappears and after a restart cannot by itself re-initiate a default without a new, confirmed freshness signal.

The freshness proof is a separate adapter input, not a field of `args`, the prompt, history, or a tool result. The HMAC of an existing `v|role|agent` marker confirms only the role indication and does not authorize freshness. If the hook passes the proof to the handler through a control channel, it requires a separate authentication domain using the operator's secret, binding to the handler instance and the specific child, a short TTL, and single use. Replaying an old marker or proof after use, expiry, or a restart cannot initiate a new default. M10-freshness checks both the proof's producer in the native harness and its consumer in the adapter or handler. Until this measurement, neither `SubagentStart` alone nor a correctly signed submission may be treated as evidence of a new delegation. This does not change the D2 marker grammar and does not introduce persistent state storage.

[assumption] The designed producer is an executable Claude hook reading a native event from stdin, not a generative call. After M10-freshness passes, it passes a one-time proof to the handler consumer regardless of whether the role's default model carries marker B or the B2 registry. `GET /subagent-router/control/instance` exposes a non-secret `handlerInstanceId`; `POST /subagent-router/control/delegations` accepts `{ version, handlerInstanceId, agentId, role, nonce, issuedAtMs, proof }`. The signature is HMAC-SHA-256 over the canonical JSON array `["subagent-router:freshness:v1", version, handlerInstanceId, agentId, role, nonce, issuedAtMs]`, using the existing `secretEnv`. This domain differs from the role marker's signature. The handler checks the signature, instance, identity, time, and absence of replay, and `consumeFreshDelegation(agentId)` atomically consumes the proof on that child's first decision. A role mismatch between the freshness proof, an authorized marker B, or a B2 entry for the same `agentId` ends in `conflicting-markers`, never a selection of one of these sources. A proof consumed by an erroneous decision is not restored. An entry has a limited TTL, no longer than the correlation TTL; a consumed nonce is protected against reuse until the signed proof's expiry. A restart invalidates the previous instance. Control endpoints are never forwarded to the gateway, and `proof` never reaches diagnostics. Without a running, measured producer, the hook produces no freshness proof, even if it can generate a valid marker B. Exporting the hook and its configuration is subject to the unchanged read-only native files contract and the separate artifact directory.

### Decision D3: forks in Claude Code are outside the first implementation's guarantee

Resolves gap 2 in the design section.

A fork inherits the model, context, and history of the main conversation. A fork's delegation prompt is not the first `user` message, so channel A does not cover it. It is not known whether `SubagentStart` runs for a fork, or whether a fork's request carries `cc_is_subagent=true`. Without these facts, a fork cannot be safely distinguished from a parent.

Decision: the first implementation does not promise fork routing. A fork request with no recognized origin is treated as a parent and passes through. A fork request with recognized origin, but no indication, falls under requirement 19 like any other child. Acceptance criterion 6 stays in the specification as a second-stage goal, dependent on measurement M4. Requirements 27 through 30 remain in force as the target description.

### Decision D4: separate operator config and catalog snapshot

Resolves gap 8 and designs the discovery contract. This contract is required for a future implementation, but is not yet verified against a running gateway or CLI.

`subagent-router.json` is the operator's file. It contains references to the catalog source, local model overlays, and role routes, but no manual model list and no secrets:

```json
{
  "version": 1,
  "modelSource": {
    "sourceId": "primary-gateway",
    "baseUrlEnv": "SUBAGENT_ROUTER_GATEWAY_URL",
    "endpointPath": "/v1/models",
    "authEnv": "SUBAGENT_ROUTER_MODELS_AUTH",
    "headersEnv": ["SUBAGENT_ROUTER_MODELS_HEADERS"],
    "timeoutMs": 10000,
    "fetchLimit": 1000,
    "staleAfterSeconds": 86400
  },
  "modelOverrides": {
    "gateway/fast-worker": {
      "alias": "fast",
      "description": "Szybkie zadania mechaniczne i wyszukiwanie.",
      "enabled": true,
      "clientModel": "haiku"
    }
  },
  "roles": {
    "claude-code:explorer": { "routeOverride": "gateway/fast-worker" }
  },
  "defaults": {
    "child": null,
    "unmarkedSubagent": "error"
  },
  "agentRoots": {
    "claude-code": { "configRoot": null },
    "opencode": { "configRoot": null },
    "codex": { "configRoot": null }
  },
  "gateway": {
    "urlEnv": "SUBAGENT_ROUTER_GATEWAY_URL",
    "headersEnv": ["SUBAGENT_ROUTER_GATEWAY_HEADERS"]
  },
  "harness": {
    "claudeCode": { "correlation": "auto", "secretEnv": "SUBAGENT_ROUTER_SECRET" },
    "opencode": { "providerId": "gateway" },
    "codex": { "emitModelCatalog": false }
  }
}
```

`models.lock.json` is the generated, atomic snapshot produced after a successful `models sync`:

```json
{
  "version": 1,
  "sourceId": "primary-gateway",
  "sourceFingerprint": "96b80377b311dc1765bde8e0ec7bae4efa848497ad0245cfb927653ba2d0527b",
  "fetchedAt": "2026-09-06T12:00:00Z",
  "models": [
    {
      "id": "gateway/fast-worker",
      "alias": "m-6414d01405c95a7bd2b2a13b415d7685a1673f800ca90dd031a5eeb1776dc81d",
      "status": "available",
      "metadata": { "displayName": "Fast worker" }
    }
  ]
}
```

Rules:

- `sourceId` is a source identifier assigned by the operator. `sourceFingerprint` is the SHA-256 of the UTF-8 encoding of the compact JSON array `[sourceId, effectiveGatewayUrl, effectiveModelsUrl]`. Effective URLs are canonical, with no trailing `/`; a URL with userinfo, a query, or a fragment is rejected, and auth goes only into headers. This means an endpoint change with an unchanged `sourceId` also invalidates the snapshot. The example fingerprint is computed for `https://gateway.example/v1` and `https://gateway.example/v1/models`; this is not a gateway measurement.
- The snapshot stores the exact opaque `id`, a deterministic alias made of `m-` plus the SHA-256 UTF-8 hash of the ID, and minimal metadata. It does NOT store the whole gateway response, auth, headers, or environment variables. Gateway metadata is not a trusted description or an instruction for the parent.
- The default alias is `m-` plus the full SHA-256 UTF-8 hash of the exact ID. An overlay can replace it with an alias matching the marker regex. An alias collision, including with another model's ID, is a configuration error. The CLI accepts an ID or an alias, but writes references as the exact ID. Changing an alias does not change role references or source data. A manual alias is not required.
- `modelOverrides[id]` may set only `description`, `alias`, `enabled`, and `clientModel`. An overlay for an absent ID stays preserved as inactive; it does not add the model to the allowlist. `enabled` defaults to `true` only for `status: available`. A local description of a missing model can still be edited. `--clear` removes the description and excludes the model from suggestions, without taking over the provider's description. Missing `clientModel`, or the value `inherit`, does not block routing.
- `roles` contains optional entries for existing names in the format `<client>:<effective-name>`, for example `claude-code:explorer`. The `routeOverride` field names the exact upstream ID, never an alias or a new role definition. A reference to a non-existent role, or to a `missing` or disabled model, is a `config check` error; an orphaned description with no route is only a warning. Clients are `claude-code`, `opencode`, and `codex`.
- `agentRoots.<client>.configRoot` is an explicit root passed to the native resolver. `null` means the active harness's rules. It does not create its own precedence.
- `baseUrlEnv`, `endpointPath`, auth, and headers are exclusively operator configuration or environment values. A value from a prompt, a model entry, or a discovery response MUST NOT change the URL or headers.
- `endpointPath` defaults to `/v1/models`. Endpoint construction uses URL segments and does not append `/v1` a second time when `baseUrlEnv` already ends in `/v1`. A changed path stays literal operator configuration.
- The caller passes the library an already-parsed `operatorConfig`, `catalogSnapshot`, and the native resolver's result. Core reads no files, environment, or network.
- Unknown fields, an unknown `version`, inline header values, and a snapshot with a mismatched `sourceId` or `sourceFingerprint` are validation errors.
- `defaults.child` names the exact ID of the default model, or `null`. `defaults.unmarkedSubagent` accepts `error` or an explicit `inherit`, which requires `defaults.unmarkedSubagentAcknowledged: true`. The semantics of a lost route are set by requirement 19.
- `gateway.urlEnv` names the upstream URL. The `gateway.headersEnv` and `modelSource.headersEnv` fields name variables holding string-to-string JSON objects. The optional `modelSource.authEnv` holds a Bearer token for the models endpoint. Duplicate header names from different sources, regardless of case, are an error instead of an implicit override. The CLI prints no resolved auth values or headers.
- `harness.claudeCode.correlation` accepts `auto` or `off`; `auto` allows correlation only for versions with M1 passed. `secretEnv` names the hook secret, never its value, in the file. `harness.opencode.providerId` names the native provider for exported variants. `harness.codex.emitModelCatalog` enables exporting a catalog of available models, if the M5 result requires it.
- Changing `sourceId` or the endpoint requires an explicit full sync. A missing snapshot points to `models sync`; it never triggers a hidden fetch at request time.
- Sync does not change the operator file. A new ID becomes available only after a full successful sync. The snapshot keeps vanished entries as `status: missing`, with no routing rights. The exact ID reappearing restores `available`; the operator's description and alias stay preserved. `--allow-empty` allows no active entries, without removing their descriptions or routes.
- `models.lock.json` sits next to the file named by `--config`. The default config is `./subagent-router.json`, with no implicit merging of parent files. The reader loads and validates the full config/snapshot pair. A write checks the input version of both files before committing and rejects a conflict instead of overwriting a concurrent edit.
- An active `serve` loads an immutable config and snapshot at startup and shows their hash as `snapshotGeneration`. CLI preview shows the generation of the files, not of a running process. New descriptions, aliases, and models require a new instance; they do not switch current sessions. The project does not assume hot reload or a scheduler.
- [assumption] A `native` export writes a read-only metadata sidecar into the artifact directory, not an unknown field in the native agent file. The sidecar contains `snapshotGeneration` as a hash of the config/snapshot and a hash of every exported native artifact. The guard receives this sidecar through read-only export configuration. The sidecar by itself confirms only that the artifact matches the export, not that the harness actually loaded it. M6-runtime and M7 must, before spawn, read the harness's authoritative effective config or definition; the absence of such a hook point means `unsupported-path`.

### Decision D5: OpenCode uses existing roles and export for manual integration

Resolves gap 6.

The adapter reads OpenCode's existing native definitions as the role source. When a selection requires a `ROLE@ALIAS` variant, `config export --client opencode` can export such a variant together with a provider catalog fragment, only into the named artifact directory. The user integrates the artifact manually. Export never overwrites the base file, never appends models to the active `opencode.json`, and never creates a role in place of a deleted or unavailable file.

The variant preserves the source definition's prompt, tools, permissions, and mode; it changes only the name, description, `hidden`, and the `PROVIDER_ID/upstreamModel` model. The description may use only the local `description`, not the gateway's description. A missing native role definition is an explicit export or preview error, not a signal to generate a substitute.

The `chat.headers` plugin is optional, used only for a diagnostic header carrying the agent name on requests. The `tool.execute.before` plugin guard is mandatory for a supported OpenCode version, if the M6-runtime subcase shows it can effectively refuse before the child launches. After the native resolver, the guard validates the configured `PROVIDER_ID` and the exact model ID against core's decision separately, not the whole `PROVIDER_ID/upstreamModel`; it does not strip or normalize segments of `upstreamModel` and does not covertly swap `args` or `subagent_type`. No path, no evidence of an effective refusal, or no coverage of a supported route means `unsupported-path`, not support based solely on export or a role variant.

Export is an artifact for manual integration, and a manually integrated, actually active export may apply the native default. Before declaring support, the adapter must verify through M6-runtime that the authoritative effective definition or configuration was actually loaded, and that it matches the read-only metadata sidecar with the correct `snapshotGeneration` and artifact hash. Offline `config check` shows only correctness, a simulation, and a potential mismatch or `unknown`, not evidence of native application. If the variant's default was not applied, or cannot be verified, the adapter refuses with `unsupported-path`; an inherited parent model is not a new role default.

The pass condition covers M6 and M6-runtime: M6 confirms inheritance of the prompt, tools, and permissions, and that the variant's model survives resume; M6-runtime confirms an effective guard before the child.

### Decision D6: Codex uses existing roles, a validating hook, and export

Resolves gap 7.

The parent supplies `model` in `spawn_agent` as an opaque gateway identifier. The `PreToolUse` hook with the `Agent` matcher is a mandatory part of the adapter: it validates `model` against the snapshot and rejects a disallowed model through `permissionDecision: "deny"`. The hook does NOT use `updatedInput` to swap the model, because that would be a fallback contradicting requirement 23. M7 must confirm the hook registered in a released Codex, the actual stdin and stdout shape, and an effective refusal before the child launches and before the upstream request. A pure validating function, or just a correctly formatted hook file, are not evidence of a runtime guard.

`config export --client codex` can prepare roles with a default route and an optional `model_catalog` in a separate artifact directory, when M5 justifies it. It does not modify `config.toml`, the native role directory, or an existing role. A deleted or unavailable role cannot be replaced by a new role with the same name. A manually integrated, actually active export may apply the native default, but is not support until M7 confirms that the runtime read the authoritative effective definition or configuration matching the read-only metadata sidecar, its `snapshotGeneration`, and the artifact hash, and that the model after native precedence matches core's decision.

If M7 shows that the hook does not receive `model`, that the stdin or stdout shape does not allow an effective guard, or that `deny` does not stop the child from launching, the Codex adapter refuses to operate for that version with the code `unsupported-path`, per requirement 33. A "roles only" mode is not an acceptable substitute, because it does not stop a direct `spawn_agent` with a model outside the snapshot. A role or global default that is computed but not shown as applied at runtime ends in `unsupported-path`; an inherited parent model is not a new default.

The precedence between an explicit `model` in `spawn_agent` and a role's model does not follow unambiguously from the source. Measurement M9 settles it. Until M9 passes, this path is `pending` and does not certify support based on an assumption, even when the documentation suggests the explicit value takes precedence. No evidence for a supported version means `unsupported-path`; an M9 result other than core's decision also means `unsupported-path`.

Baseline version: the hooks documentation describes released behavior, so the adapter requires a released Codex of at least version `rust-v0.153.4`. The local version `0.150.0-alpha.8` is lower and must be updated before measurements M5, M7, and M9.

### Decision D7: context limits and reasoning format are an accepted limitation

Resolves gap 5.

The package does not manage context limits or reasoning format. In `marker-routed` mode, the client initializes limits according to `clientModel`, while the gateway handles `upstreamModel`. A mismatch is possible and is deliberately not corrected on the router's side. Mitigation: the `clientModel` field in the catalog lets you pick a client alias close to the upstream model's class, and the handler records the `clientModel` and `upstreamModel` pair in diagnostics for every decision.

This decision closes the gap as a knowingly accepted limitation. Measurement M8 is informational: it does not gate the `implemented` status, but its result must be a table in the Claude Code adapter's documentation block, with tested `clientModel` and `upstreamModel` pairs and observed behavior with long context.

### Decision D8: baseline versions

Resolves gap 1.

The first implementation's baseline versions are the versions measured in this document: Claude Code 2.1.263, OpenCode 1.18.29, Codex at least rust-v0.153.4, Bun 1.3.11. The adapter declares its baseline version in code and refuses to operate with the code `unsupported-path` when the detected version is lower. A newer version can get a warning in diagnostics, but the warning does not get around requirement 33, the relevant measurements, or the absence of evidence of support. An unverified path for a newer version stays `unsupported-path` until the relevant acceptance scenarios pass.

### Decision D9: native agent definitions are a read-only role source

This decision extends D5 and D6. The contract is required, but unverified against the running resolvers of every harness.

- Claude reads the project-level `.claude/agents` and the `agents` directory of the active configuration directory. By default this is `~/.claude/agents`, but the resolver respects `CLAUDE_CONFIG_DIR` and an explicit `configRoot`.
- OpenCode and Codex read their native sources only through the adapters.
- `--agents-dir` adds an explicit read-only root for inspection and export commands. It does not change files and does not define its own hierarchy.
- The exact precedence, namespace, and effective name belong to the harness's native resolver. The router does not invent a directory order. The frontmatter `name` or namespace may differ from the file name.
- Inspection shows the source path, scope, effective name, declared model, including `inherit`, and shadowed entries. When the adapter cannot confirm the runtime model, it shows `unknown` rather than guessing.
- Built-in, plugin, and dynamic agents with no file have limited visibility as `fileless`. An empty directory scan does not mean they do not exist. When a native tool schema is available, the adapter reads known roles from it.
- An unknown or deleted role must not be reconstructed by a generator. `hidden` means interface visibility, not that the role does not exist. A `fileless` role confirmed by the resolver may be shown and used in preview; an export requiring its unavailable full definition reports a limitation instead of reconstructing instructions.

For Claude, the router does not generate agent substitutes or a per-file `model`. It idempotently adds the catalog of described models and selection instructions only to the parent's `Agent`, `Task`, and `Workflow` tool descriptions, and to the prompt description field, if such a channel exists. The enrichment happens only in the copy of the parent request passed through the handler, and forms the fixed baseline for criteria 4 and 23. It preserves every other schema field, tool, permission, `system` block, and history. The parent records the selected alias in the marker, and the handler processes the child request's marker. This is the primary way of making an explicit selection, independent of whether `PreToolUse.updatedInput` is effective. Role hooks are only an optimization or a default.

### Decision D10: automatic discovery and offline snapshot

Discovery fetches the catalog only from the gateway's configurable models endpoint. The standard endpoint has path `/v1/models` and the JSON contract `{"data":[{"id":"nonempty string"}]}`. The project does not claim that any specific gateway has been checked against it.

- Synchronization requires a correct positive control, schema, and non-empty, unique IDs. Repeated IDs are an error.
- The designed pagination profile accepts `has_more: true` with a non-empty `next_cursor`; the next fetch to the same endpoint uses the `cursor` parameter. `has_more: false` ends the fetch. Plain `data` with no pagination metadata means a complete list under this contract. Conflicting or unrecognized further-page signals, a missing cursor, a repeated cursor, and a page cycle are errors. This is the adapter's selected profile, not a claim about a standard shared by every gateway.
- The fetch limit is configurable. Exceeding it is an error. Timeout, auth failure, bad JSON, incomplete pagination, and an unexpectedly empty catalog do not replace the last valid snapshot.
- A full snapshot is written atomically only on success. An empty snapshot can be written only with `--allow-empty`.
- A redirect to a different origin is rejected before credentials are forwarded. No value from the response controls the URL, auth, or headers.
- The last valid snapshot can operate offline, but `list`, `show`, `preview`, `doctor`, and `serve` show `fetchedAt` and a `stale` warning when the relevant configured threshold has been exceeded.
- Request-time core, `route preview`, and inspection commands do not perform network access by default. In the management layer, only explicit `models sync` or `doctor --connect` perform network access. Request transport through `serve` remains a separate handler function. The schema positive control is a discovery test requirement, not an extra hidden CLI request.

### Decision D11: designed CLI interface and route preview

The commands below are the designed interface. They do not exist yet and are not an instruction to run the runtime.

| Command | Reads | Network | Writes |
|---|---|---:|---:|
| `models sync [--dry-run] [--allow-empty]` | operator config and the models endpoint | yes | only `models.lock.json`, after a successful sync without `--dry-run`; shows `added`, `changed`, `missing` |
| `models list`, `models show <id-or-alias>` | config and snapshot | no | no; shows ID, alias, description, source, status, and snapshot time |
| `models describe <id-or-alias> --text "..." \| --file <path> \| --clear` | config and snapshot | no | only the description in `modelOverrides`, atomically; concurrent-edit conflicts are rejected |
| `agents list --client <client>`, `agents show <name> --client <client>` | native resolver and explicit roots | no | no; shows effective precedence, scope, declared model, and router override |
| `route preview --client <client> --agent <name> [--model <id-or-alias>] [--parent-model <model>]` | config, snapshot, native resolver, and core | no | no; simulates an authenticated child context |
| `config show`, `config check` | config, snapshot, and resolver | no | no; shows provenance, schema, refs, the metadata sidecar, and a potential mismatch or `unknown`, but not evidence of native application |
| `config export --client <client> --output <dir> [--dry-run]` | config, snapshot, and native definitions | no | only separate fragments, overlays, and examples for manual integration |
| `doctor [--connect]` | config, snapshot, paths, and availability | only with `--connect` | no; `--connect` checks the models endpoint and schema, with no completion and no agent launch |
| `serve` | config and snapshot at startup | per the designed handler | no automatic snapshot updates |

Additional rules of the designed CLI:

- `models describe` has exactly one of the modes `--text`, `--file`, or `--clear`. Editing the description of a missing ID with a preserved overlay is allowed, but does not activate the ID.
- `route preview` does not launch an agent, send a prompt, or call tools. The result is marked `simulation` and contains the selected model or default, the reason, the alias, the exact `upstreamModel`, `clientModel` or `unknown`, and the `missing` and `disabled` errors. `--parent-model` is a literal simulation input. Preview does not guess the parent's model and makes no claim about the current runtime.
- `config export` always rejects the agent source directory, including with `--force`. It compares actual paths after resolving symlinks and does not write through a link outside the export directory. `--force` only lets you overwrite a previously seen export artifact within the allowed directory. Export reads the snapshot offline and never modifies the global or native config.
- `doctor` distinguishes configured, measured, and `pending E2E` state. Success of `config check` or `doctor` is not a guarantee of model compatibility, nor evidence that the native harness loaded the export artifact.
- Global options are `--config`, `--json`, `--help`, `--version`, `--no-color`, and `--client` where applicable. `--client` accepts `claude-code`, `opencode`, or `codex`. `--agents-dir` applies to role inspection, preview, and export. ID arguments containing spaces must be quoted, for example `--model 'gateway/Model with spaces'`.
- `list`, `show`, and `agents` also show inactive entries and invalid references, instead of hiding them behind an error for the whole catalog. A missing snapshot does not block inspecting agent files by itself, but route selection requires a snapshot. `config check` also validates route references. No command prints resolved auth values, secrets, or headers, even on error or with `--json`.
- With `--json`, stdout contains only machine data. Progress and errors go to stderr, with no secrets. Exit code is `0` for success, including `--dry-run` with a diff, `1` for an operational error, and `2` for a usage, configuration, or selection error. When stdout is not a TTY, or `--no-color` was used, the CLI emits no ANSI. Catalog and description data are rendered with control characters escaped; the terminal representation does not change the stored upstream ID.

## Measurements required before status `implemented`

Every measurement has a deciding criterion. A negative result does not invalidate the design; it only disables the named channel or moves the feature to a second stage.

| Id | Question | Method | Criterion | Effect of a negative result |
|---|---|---|---|---|
| M1 | Does Claude Code 2.1.263 send `x-claude-code-agent-id` on every child request, including after compaction, and is the identifier random and unique across sessions and runs? | A controlled gateway records the headers of every subagent request across two parallel sessions, one resumed session, and one session with forced compaction. Separate evidence from the implementation or a controlled identifier generator confirms at least 64 bits of entropy, since the format alone is not such evidence. | The header is present and constant on every request of a given child; identifiers differ across children, sessions, and runs; the capture confirms continuity, and separate evidence confirms a generator with at least 64 bits of entropy. | Channel C is disabled for this version; losing the marker after compaction ends in `missing-selection`. Status (2026-09-12): `passed` for 2.1.268. A dd-verified generator proof for the pinned binary records four byte-exact sites, and `judgeM1` re-reads all four against that binary on every run, so a pass needs the proof to still describe the binary plus a collision-free sample of at least two ids matching `^a[0-9a-f]{16}$` from a generator drawing at least 64 bits (run `compaction-sbnVo0`, 4 of 4 sites verified; shifting one offset by a byte returns `pending` with `m1-proof-site-mismatch`). `pending` for 2.1.267, which has no proof on purpose because its compaction-continuity clause is unmeasured. `status` stays `pending`, so channel C stays closed in production. |
| M2 | Does the Agent call's `model` parameter accept a full identifier despite the alias schema? | A call with a full identifier and observation of `clientModel` in the request. | The request carries the given identifier. | `clientModel` in the catalog restricted to aliases. Status (2026-09-11): `failed` for 2.1.268. The client rejects a full id in the call parameter with a local `InputValidationError` (enum of four aliases) and spawns no child; an alias in the same parameter does override frontmatter (runs `delegate-8EiyAy`, `delegate-IiHhdB`, control `delegate-J6ctNL`). The negative-result effect applies: native per-child selection is limited to alias classes. |
| M3 | Where does `additionalContext` from `SubagentStart` land in the child's request, and does the request carry a matching `x-claude-code-agent-id`? | The hook injects a test marker with a token, the gateway records the body and the agent identifier header. | The marker is in a `system` block or on the first line of the first `user` message; the header present matches the marker's `agent_id`. | Channel B replaced by channel B2 with `agent_id` registration in the handler, but B2 can operate only after the M3-B2 subcase, M1, and M10-freshness pass, and with `correlation: "auto"`. |
| M3-A | In the child's first `user` message, does the parent's marker from the first line of the delegation prompt land in the last text block, after a recognizable native prefix (v1: scaffold in block 0, marker in block 1; v2: instructions in block 0, scaffold in block 1, marker in block 2), and does the handler, with the `after-native-context-v1` or `after-native-context-v2` profile bound to the exact client version, route the child to the model named by the alias? | An actual client in an isolated environment delegates to two `model: inherit` agents with different markers through a production handler in a loopback; the gateway records the request before the handler and the upstream request. | Both children receive an upstream request with a model matching the alias, block 0 is forwarded unchanged, the marker is removed from block 1, and the parent decodes both model echoes in `tool_result`. The request's version equals the profile's version. | The `parentPromptPosition` field stays unset for this version; channel A works only in the legacy position, and the measured layout ends in `missing-selection`. Status (2026-09-11): `passed` for 2.1.268 in layout v2 (run `handler-yXSP4o`) and `passed` for 2.1.267, `pending` for 2.1.266. The clause that no fixture declares `parentPromptPosition` is historical: `claude-code-2.1.268.json` now declares `after-native-context-v2`, while `status`, `M10` and the unmeasured lifecycle phases still keep the path closed in production. |
| M4 | Does a fork carry `cc_is_subagent=true`, and does `SubagentStart` run for a fork? | A fork with a hook and a gateway recording the body. | Both conditions met. | An unrecognized fork stays pass-through; a fork with recognized origin falls under requirement 19. Criterion 6 stays in the second stage. |
| M5 | Does Codex with its own `model_providers` and no `model_catalog` accept an unknown model identifier in `spawn_agent`? | A spawn with an opaque identifier against a gateway recording the body. | The child request carries the identifier unchanged. | The generator runs with `harness.codex.emitModelCatalog: true` and produces a catalog from the allowlist. |
| M6 | Does an OpenCode agent variant inherit the base agent's prompt, tools, and permissions; is a model outside the provider's `models` rejected; is the variant's model preserved after resume; and does the M6-runtime subcase effectively refuse before the child? | Comparison of the resolved variant and base configuration, a spawn with a model outside the provider, a resume test with the gateway, and a registered `tool.execute.before`. M6-runtime covers every route declared as supported: Task, direct, manual, nested, and resume. Before spawn, the guard reads the authoritative effective config or definition and compares it against the read-only metadata sidecar, its `snapshotGeneration`, and the artifact hash. The negative control supplies a disallowed provider or model and must stop the child before the upstream request; the positive control supplies an allowed `PROVIDER_ID/upstreamModel` and must launch the child with the configured provider and the exact `upstreamModel` actually received. | The only difference is in `model`, `name`, `description`, `hidden`; a model outside the provider is rejected; the model is unchanged after resume; the guard effectively refuses before the child after reading an authoritative effective config matching the metadata sidecar, and the positive control passes for every supported route with the configured provider and the exact model. | The generator explicitly copies missing fields, or the adapter refuses. No path, no evidence, or an ineffective refusal means `unsupported-path` for that route, not assumed support. |
| M7 | Does a registered `PreToolUse` hook with the `Agent` matcher in a released Codex receive `model`, have the actual expected stdin and stdout shape, and honor `deny`? | A released Codex runs a registered hook that processes raw stdin and stdout only ephemerally, reports only an allowlist of fields, the model validation result and decision with no body, prompt, or token, reads, before spawn, an authoritative effective config or definition matching the read-only metadata sidecar, its `snapshotGeneration`, and the artifact hash, and rejects a disallowed model; a control gateway checks that no child request occurs. | The call is rejected by the running hook with no child launch and no upstream request. A pure function, or a file with no registration, does not pass the measurement. | The Codex adapter refuses to operate for that version with the code `unsupported-path`. |
| M9 | What is the precedence between an explicit `model` in `spawn_agent` and a role's model in a released Codex? | A role with model B, a spawn of that role with an explicit model C, the gateway records the child's model. | The gateway receives C and the result matches core's decision. | The adapter reports this path as `unsupported-path`; before the M9 result it stays `pending`, not certified support. |
| M10 | Is the child's `upstreamModel` constant across every supported lifecycle transition in every harness: subsequent turns, resume, compaction, a nested child, a parallel child, and does the M10-freshness subcase recognize a fresh delegation before the first request? | For every harness, a scenario with a gateway recording the model of every request and the child identifier. M10-freshness records a trustworthy harness event of a new delegation and compares it against resume, compaction, TTL, and a handler restart. History length alone, the absence of `compact_boundary`, or the presence of a request are not a positive signal. | Every request of a given child carries the same `upstreamModel`; children differ from each other; the parent is unchanged. M10-freshness, before the first request, distinguishes a new delegation from every state-reconstruction scenario. | An untested transition is marked unsupported in the adapter's documentation, and the adapter reports it as `unsupported-path` when it can detect it. Missing M10-freshness disables default initialization with no explicit selection or correlation, per requirement 19. Status (2026-09-12): `compaction` is `passed` for 2.1.268, measured on the real profile with no correlation scaffold (run `compaction-3slJXF`, `correlationScaffold: false`): both children compacted three times each, every post-compaction request was forwarded on the child's own upstream model, nothing was refused. The compacted history drops the marker, so the agent-id correlation binding is what carries the child; the earlier marker-only run `compaction-sbnVo0` measured `failed` and stays the record of what the marker-only path does. `resume` stays `pending` for 2.1.268 (the client issues a fresh child id on re-delegation), and `M10` itself plus `M10-freshness` stay `pending`, so this is not a support promotion. Status note (2026-09-12): direct native checks `resume-3STpCB`, `next-turn-RKA2N4`, `nested-a4QSXS`, and `compaction-WH9nKg`, plus packaged-serve checks `handler-ezphM0`, `next-turn-iscAxQ`, `nested-IWrTVw`, `compaction-Sroc4G`, and accepted resume `resume-0FieA7`, support Claude Code 2.1.268 for the measured explicit-marker and correlation paths. The packaged checks used the built `dist/cli.js serve` process, real Bun raw fetch transport, a pinned real client, recording proxy, and scripted loopback upstream. They passed routing, completion, executable identity, and capture pairing. `resume-0FieA7` observed the same child ids across parent resume through native `SendMessage`, with `PARENT_FINAL_OK` for both invocations; M3-A and explicit zero scaffold declaration also passed. M2 failed. M3, M3-B2, M4, and M10-freshness remain unmeasured or closed. Correlation remains in memory, idle-expiring, and unavailable after restart. Claude Code 2.1.269 is unmeasured. `M10-freshness` therefore still prevents default initialisation without an explicit choice or correlation under requirement 19. |

The lifecycle phase MAY come only from confirmed native harness context, not from tool arguments supplied by the model. When the adapter does not recognize it, it MUST NOT assume `next-turn`: allowing this path requires passing all M10 transitions that can reach it. When it can reliably recognize the phase, it MAY allow only the passed transition and refuse the rest. The separate fork restriction from D3 and M4 is unchanged.

Informational measurement, outside the status gate:

| Id | Question | Method | Required artifact |
|---|---|---|---|
| M8 | What effect does a `clientModel`/`upstreamModel` mismatch have on limits and reasoning? | A child with alias `haiku` and an upstream model with a different limit, a long-context test. | A table of pairs and observations in the Claude Code adapter block documentation. |

Diagnostics MAY contain the adapter name, correlation identifier, the selected model identifier, `clientModel`, the decision source, the decision code, and a list of ignored markers without their content. It MUST NOT contain prompts, tool results, response content, the token secret, or authorization header values.

Measurements M1 through M7, M9, and M10 still remain unperformed. Revision 3 adds the catalog, resolver, and CLI criteria below; adding them is not evidence that the mechanism works. A client version can be marked supported only after the corresponding adapter's scenarios pass.

## Alternatives and decisions

### Custom agent loop

Rejected. It would duplicate native tools, permissions, UI, and lifecycle, which the project must preserve.

### Selection only through the native model field

Rejected for Claude Code. The field does not accept arbitrary gateway identifiers, hooks cannot change it, and a fork ignores it. Accepted for OpenCode and Codex as the `native` mode, because the resolved native model component there is exactly `upstreamModel`, per requirement 31.

### A PreToolUse hook that swaps the model in Claude Code

Rejected. The documentation excludes `updatedInput` for the Agent tool.

### Environment aliases `ANTHROPIC_DEFAULT_*_MODEL` as the only mechanism

Rejected as the only mechanism. They give a few model classes, not an arbitrary number of child models. They can supplement `clientModel` in the catalog.

### An optional proxy after deployment

Rejected. Routing before the gateway is part of the scope for `marker-routed` mode, and an embed must use the handler with no extra process.

### A marker accepted anywhere in the prompt or in a system block

Rejected. The content of `CLAUDE.md`, files read by tools, and quotes land in the same blocks. Without a binding to the prompt's start position or to the adapter token, a marker has no trustworthy origin.

### Durable on-disk correlation memory

Rejected. Requirement 7 excludes a database. A volatile, time-limited process map is sufficient, because channel A reconstructs the decision from the delegation prompt.

### An OpenCode plugin that swaps `subagent_type`

Rejected. A hidden swap takes the explicit selection away from the parent and complicates diagnosis. Agent variants are visible in the configuration.

### Routing by provider name

Rejected. Model identifiers stay opaque, and provider auth and protocols belong to the external gateway.

### An LLM classifier for model assignment

Rejected. It introduces a nondeterministic decision and extra cost. Selection must come from explicit delegation, role, and configuration.

### Silent fallback to the parent's model

Rejected. It hides the error and breaks the intent of explicit child routing.

### Drop-in compatibility with CCR

Not required. CCR is the inspiration for the marker plus routing pattern, not a public contract for marker syntax.

### Embedding the `@the-next-ai/ai-gateway` gateway in the router

Rejected. The main reason is performance: the operator observes clearly slower OpenAI provider handling by this package in CCR. [assumption] There is no measurement in this project; it is not established whether the cause is the package itself, its configuration, or the network layer. The selection of gateway is therefore an operational decision, not a conclusion from a benchmark.

The second reason is architectural. CCR uses this package as its own gateway. The router stays a thin layer in front of the external gateway, `9router` or OmniRoute in the target design. A dependency on the gateway package would couple the router to its protocols, auth, performance, and release cycle, and would violate requirements 45, 46, and 47.

Design consequence: since the router does not decide the performance of the conversation with the provider, swapping the gateway for a faster one MUST be an endpoint configuration change, with no router code branch. This is already requirement 47 and its test `e2e::opaque-identifiers-survive-gateway-endpoint-swap`.

### Mandatory discovery or fetch at request time

Rejected. Discovery is an explicit operator command and is not a provider integration. Core and preview use only the existing offline snapshot.

### Generating or replacing native agents

Rejected. Native definitions are a read-only source of roles. Export is a separate artifact for manual integration and does not reconstruct a missing definition.

### Hot reload of the catalog and a sync scheduler

Rejected. An active handler uses the snapshot from its start time. Changing the catalog requires an explicit sync and a new instance.

## Acceptance criteria

The following criteria are requirements for a future implementation. They are not currently met or tested.

1. The parent uses model A, and concurrent children use models B and C. The controlled gateway confirms the actually received `upstreamModel` for each request. The criterion holds separately for each of the three harnesses.
2. The test uses arbitrary opaque identifiers, and after a gateway endpoint change it adds no vendor-based routing branch.
3. A child calls a tool, receives its result, and the native client returns a correctly decoded final response. The handler does not decode or regenerate the response. A model's self-reported name is not evidence of correct routing.
4. The parent stays unchanged relative to the baseline after the D9-permitted, constant enrichment of the `Agent`, `Task`, `Workflow` descriptions and the prompt description. A quoted marker in history, a tool result, an assistant response, a later part of the delegation prompt, or a `system` block without a valid token, for example smuggled through `CLAUDE.md`, changes nothing relative to this baseline. A child with such a marker outside the authorized position is handled as if the marker were not there, with code `ignored-marker`.
5. Nested children and independent parallel sessions have no decision or state leakage. Two children with different identifiers and different markers receive different `upstreamModel` values in the same handler process. A forced identifier collision with a different marker ends in `correlation-conflict`, not the first child's decision.
6. A fork with an inherited `clientModel` and a different `upstreamModel` is checked separately by the controlled gateway. A second-stage criterion, dependent on M4.
7. For a supported client version, a child's multi-turn work, resume, and compaction preserve its model selection, confirmed by measurement M10 for each harness. M10-freshness separately distinguishes a new delegation from resume, compaction, TTL, and a restart before default initialization. Separate tests for loss of route information require preservation per requirement 19. An `unsupported-path` error alone does not count as a working integration scenario.
8. An unknown, ambiguous, or disallowed target of a recognized, routed child causes an error with no gateway call. A foreign or quoted parent marker, including with an unknown model, does not trigger this validation and does not block its request.
9. Cancellation, disconnect, and stream backpressure pass through the handler with no change in semantics. The fake gateway confirms byte-identical response, status, end-to-end headers, and SSE, including unknown frames, errors, tool, and usage, with no decoding, regenerating, or full buffering by the handler.
10. Core builds and runs in an environment without a Bun-only dependency.
11. Fake-gateway tests are hermetic and form the first line of validation.
12. Opt-in real-harness tests run against the external gateway, store no secrets, and report harness versions.
13. The configuration validator rejects a file with an unknown version, an unknown field, or an inline-supplied header value.
14. `config export` changes no native file. The SHA-256 sum of native agent files before and after export is identical, and an existing `inherit` declaration stays unchanged.
15. The fake models endpoint has a positive control with a valid `data[].id`, and separate scenarios reject a bad schema, auth failure, malformed JSON, duplicates, unsupported incomplete pagination, an exceeded limit, and an unexpectedly empty catalog without `--allow-empty`.
16. A failed sync preserves the hash of the previous `models.lock.json`. A successful sync writes the whole new snapshot atomically and shows `added`, `changed`, `missing`.
17. A local description, alias, and role routing survive an ID's disappearance and reappearance. A disappeared, disabled, or absent ID does not route and does not use a fallback.
18. The fixture covers upstream IDs with spaces, Unicode, and case differences. An alias maps to the exact ID, an alias collision is an error, and a marker does not carry the raw ID.
19. The resolver fixture covers scope collisions, effective naming other than the file name, `inherit`, shadowed entries, and fileless roles. An empty directory scan does not remove a role exposed by the native tool schema.
20. `route preview` performs no network activity, runs no tools or agent, and shows a simulation with the alias, the actual `upstreamModel`, `clientModel`, or `unknown`. It makes no claim about the current runtime.
21. All inspection commands support `--json`, run offline by default, print no secrets, and return correct exit codes. The networked `doctor --connect` is tested as an explicit exception with no write. The absence of color on non-TTY is tested.
22. Concurrent edits of `subagent-router.json` through `models describe` are detected, and the second edit is rejected without overwriting the first.
23. Adding a local description to a model from the snapshot does not define the model manually, and the parent's existing tool descriptions are preserved after an idempotent catalog addition. The comparison uses the baseline after the D9-permitted, constant enrichment and confirms no change to the remaining schema fields, tools, permissions, `system` blocks, or history.
24. An endpoint change with the same `sourceId` rejects the old snapshot. A sync with `--dry-run` changes no config or snapshot hashes. A cursor cycle, contradictory pagination, and a redirect between origins do not write a partial catalog.
25. Changing an alias preserves role assignments stored as an ID. `hidden` is not confused with a missing role, and a symlink leading from the export directory to the native config is rejected, including with `--force`.
26. The preview result states the generation of the loaded files. It does not present this as the generation of a running process, which still uses the configuration from its own start.

## Test strategy

[assumption] Test layers should separate the deterministic core, the HTTP handler, and the harness adapters.

- Core tests check the catalog, decision priority, allowlist, marker conflicts, absence of fallback, session isolation, and decision codes.
- Handler tests with a fake gateway capture the request, `upstreamModel`, the body without a marker, cancellation, backpressure, and correlation map behavior after the time limit.
- Offline export tests compare artifacts and the metadata sidecar against the expected result, reject a source directory and an output collision, and compare the SHA-256 of native definitions before and after the operation. They do not claim that the native harness loaded the artifact.
- Discovery tests use a fake endpoint with a positive control and fixtures for schema, auth, pagination, limit, and empty-catalog errors. The tests confirm snapshot atomicity and preservation of the previous version's hash after an error.
- CLI tests cover offline mode, `--json`, stderr with no secrets, exit codes, non-TTY, concurrent-edit conflicts, and preview with no network or tools.
- Resolver tests check the effective name, scope, shadowing, `inherit`, aliases, and fileless roles supplied by the native schema.
- Adapter tests confirm passing trustworthy child context, idempotent preservation of existing tool descriptions, and an explicit error on an unsupported path.
- Adapter E2E tests, not the offline export tests, confirm that the harness read the authoritative effective definition or configuration before spawn, and confirm agreement with the metadata sidecar, `snapshotGeneration`, and the artifact hash.
- E2E tests are opt-in, store no secrets, report the harness and gateway version, and carry out measurements M1 through M7, M9, and M10 as separate, named gating scenarios. M6 contains the M6-runtime subcase for the OpenCode guard's negative and positive control, and M10 contains M10-freshness for the new-delegation signal. Measurement M8 is a separate informational scenario, whose result goes into the block documentation.

### Test strategy assertions

- Core tests check that alias and description do not change the exact, case-sensitive `upstreamModel`, and that explicit selection and a role default or global default already authorized by M10-freshness give exactly one result, per requirement 18.
- D2 tests check that an adapter marker in the `user` position is `ignored-marker`, until M3 confirms this exact position and token. Tests for the `after-native-context-v1` slot check separately: the measured layout, absence of `M3-A`, no explicit setting, a mismatched or missing client version, a corrupted scaffold, extra blocks, a marker further in block 1, a marker inside block 0, and a signed adapter marker in this slot; the legacy position stays green with no change. Tests for the `after-native-context-v2` slot check the same for the three-block layout, plus the disjointness of the layouts: the v1 profile does not accept a three-block message, the v2 profile does not accept a two-block one, and a run evaluated by the second layout's rules ends `pending`, never `passed`. Every use of B requires an `agent_id` matching the header. Channel B2 requires the M1 result, `correlation: "auto"`, confirmed origin of every request, and must not bypass the channel C guard.
- Correlation tests check that a bound decision survives losing the marker while identity is preserved, a conflict ends in an error, and after a restart with no marker and no identity state, no new default is created. M10-freshness distinguishes a new delegation from resume, compaction, TTL, and a restart, without using history length or the absence of `compact_boundary` as evidence. They separately test explicit opt-in `inherit`.
- `native` tests run the real runtime checkpoint before the child. The negative control observes refusal and no upstream request, and the positive control observes a running child with a model equal to core's decision. A path with neither piece of evidence is `unsupported-path`.
- OpenCode tests cover every path declared supported, Task, direct, manual, nested, and resume, with no modification of `args` or `subagent_type`. Codex tests confirm `PreToolUse` registration, real stdin/stdout, `deny`, native precedence, and M9 before certifying a path with a role.
- Offline export tests check the metadata sidecar, `snapshotGeneration`, and the artifact hash, but do not claim that the harness loaded anything. Adapter E2E checks the authoritative effective definition or configuration before spawn. The export artifact alone, an unapplied default, or an unverifiable configuration are not success.
- Handler tests compare the response and stream frames byte for byte, and check status, end-to-end headers, unknown SSE, errors, tool, usage, abort, disconnect, and backpressure. They also check for the absence of full buffering, decoding, regenerating, retry, fallback, and an extra generative call.
- Boundary tests check that core and handler import no mandatory AI SDK, run no MCP or KB, and contain no vendor branch. The boundary test also checks that `package.json` contains no `@the-next-ai/ai-gateway` dependency in any section, and that `src` imports no module of that name. A mock gateway, `9router`, OmniRoute, or LiteLLM remain interchangeable endpoints outside the router.

E2E success requires both a capture from the controlled gateway and a meaningful child tool roundtrip and final result decoded by the native client. The model's response text alone is not enough.

## Related

- [Documentation index](../../README.md)
- [Documentation conventions](../../CONVENTIONS.md)
- [Model routing rollout plan](../plans/2026-09-06-subagent-model-routing.md)
- [CCR, pinned commit `c49733678660f726540fca3fff20bbd7d6cab032`](https://github.com/kolezka/claude-code-router/tree/c49733678660f726540fca3fff20bbd7d6cab032)
- [Claude Code sub-agents documentation](https://code.claude.com/docs/en/sub-agents)
- [Claude Code hooks documentation](https://code.claude.com/docs/en/hooks)
- [OpenCode, pinned commit `337fd144d2ba144743368f78d9579a99cce175bd`](https://github.com/anomalyco/opencode/tree/337fd144d2ba144743368f78d9579a99cce175bd)
- [OpenCode agents documentation](https://opencode.ai/docs/agents/)
- [Codex, pinned commit `ac192cd7937b0d73edc6dffe009940ae53782dd4`](https://github.com/openai/codex/tree/ac192cd7937b0d73edc6dffe009940ae53782dd4)
- [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
- [Codex subagents documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
