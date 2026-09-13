# Subagent model routing

Date: 2026-09-06

Status: draft (revision 3, for review)

## Purpose

`subagent-router` is meant to let a parent make a conscious model choice for a specific native subagent without changing the parent's model. A single run can serve child subagents using different models and different providers at the same time, as long as the configured gateway supports them.

The project is meant to be a small Bun + TypeScript package. It should work as a library imported by other tools and standalone through a CLI. It is one package, not a monorepo.

The document describes a proposed design. Status `draft` does not mean every detail is accepted or that implementation is approved to start. Revision 2 closed the open design decisions from revision 1 and turned the remaining gaps into concrete measurements with criteria. Revision 3 adds a designed, unverified contract for the model catalog, discovery, route preview, and a small CLI. This does not mean the CLI, discovery, or routing runtime exist.

## State and evidence scope

State as of 2026-09-06: the repository contains documentation, with no router implementation and no tests. No E2E tests of the new behavior have been run. [verified]

### Versions measured locally

`--version` read on the author's machine, 2026-09-06. [verified]

| Tool | Local version | Latest release (GitHub API, 2026-09-06) |
|---|---|---|
| Claude Code | 2.1.263 | not checked |
| OpenCode | 1.18.29 | v1.18.29, 2026-09-04 |
| Codex CLI | 0.150.0-alpha.8 | rust-v0.153.4, 2026-09-04 |
| Bun | 1.3.11 | not checked |

### Claude Code

[verified] CCR has an existing mechanism that serves as inspiration. The symbol [`resolveBuiltInClaudeCodeSubagentRouteDecision`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/src/gateway/claude-code-router-plugin.ts) picks the model based on a tag. The symbol [`extractAndRemoveClaudeCodeSubagentModelTag`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/src/gateway/claude-code-router-plugin.ts) looks for the tag in `system` blocks and in at most the first two messages with role `user`, then removes it from the request. The symbol [`removeClaudeCodeBillingSystemHeader`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/src/gateway/claude-code-router-plugin.ts) recognizes a child subagent by the `cc_is_subagent=true` metadata in the first `system` block.

[verified] The CCR test `"does not trust agent-id without billing metadata"` in [`router-builtins.test.mjs`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/test/unit/gateway/router-builtins.test.mjs) shows that CCR does not treat the `x-claude-code-agent-id` header alone as evidence that a request came from a child subagent.

[verified] The Claude Code 2.1.263 binary contains the strings `x-claude-code-agent-id`, `cc_is_subagent`, `CLAUDE_CODE_SUBAGENT_MODEL`, and `compact_boundary` (counted with `grep -ac` on the executable file). A code fragment that builds API request headers adds `x-claude-code-agent-id` when the request context has `agentId`, and `x-claude-code-parent-agent-id` when it has `parentAgentId` (read with `grep -aoE` with context around the header name). This does not prove that `agentId` is set on every child request, including after compaction. That is the subject of measurement M1.

[verified] The [Claude Code sub-agents](https://code.claude.com/docs/en/sub-agents) documentation, read 2026-09-06, states the model selection order: the call's `model` parameter, the definition's `model` frontmatter, the `CLAUDE_CODE_SUBAGENT_MODEL` variable, the main conversation's model. A fork and a skill with `model: inherit` always run on the main conversation's model. Subagents get automatic compaction under the same rules as the main conversation. The call's `model` parameter also applies when resuming a subagent.

[verified] The [Claude Code hooks](https://code.claude.com/docs/en/hooks) documentation, read 2026-09-06: the `PreToolUse` hook's `updatedInput` field does not apply to the `Agent` tool. The `SubagentStart` hook receives `agent_id` and `agent_type` and can return `additionalContext`, injected into the context of the subagent being launched. No hook receives or changes the subagent's model.

[verified] In the Claude Code 2.1.263 session that produced this document, the `Agent` tool schema visible to the model restricts the `model` parameter to the aliases `sonnet`, `opus`, `haiku`, `fable`. The documentation also allows full identifiers in frontmatter. The discrepancy between the schema and the documentation is the subject of measurement M2.

[verified] CCR maps Claude Code aliases to arbitrary gateway identifiers through environment variables, see [`environment.ts`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/src/agents/claude-code/environment.ts)`::"ANTHROPIC_DEFAULT_HAIKU_MODEL"`. This mechanism gives at most a few model classes, not an arbitrary number of child models. [inferred]

### OpenCode

[verified] In OpenCode the symbol [`TaskTool`](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/tool/task.ts) accepts `subagent_type`, resolves it through the agent registry, and returns an `Unknown agent type` error for an unknown name. The child's model comes from the selected agent's configuration or from the parent's model. The tool has no `model` argument.

[verified] The symbol [`Provider.getModel`](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/provider/provider.ts) returns `ModelNotFoundError` when the model identifier is not present in the configured provider's `models`. [inferred] The Task path resolves the agent's model through the same lookup, so opaque gateway identifiers must be entered into the provider configuration. Measurement M6 confirms this against a working client.

[verified] The `chat.headers` plugin hook in [`request.ts`](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/session/llm/request.ts)`::"chat.headers"` receives `sessionID`, the agent name, model, and provider, and returns headers added to the request. The `tool.execute.before` hook receives the tool name, `sessionID`, `callID`, and modifiable `args`, see [`index.ts`](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/plugin/src/index.ts).

[verified] The [OpenCode agents](https://opencode.ai/docs/agents/) documentation: an agent's model has the format `provider/model`, a subagent with no model inherits the calling agent's model, definitions live in `opencode.json` or in Markdown files under `.opencode/agents/` or `~/.config/opencode/agents/`. The `hidden` option hides an agent from autocomplete but does not block use through Task.

### Codex

[verified] The Codex source code contains a `model` field in [`spawn_agent_common_properties_v1`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tools/handlers/multi_agents_spec.rs). In [`spawn.rs`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs)`::"effective_model"` the child's model is a plain string passed into the child thread's configuration. A role can override the model, see [`role.rs`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/agent/role.rs). No per-child `model_provider` override was found in this code, so the child uses the session's provider. [inferred]

[verified] The [Codex hooks](https://learn.chatgpt.com/docs/hooks) documentation, read 2026-09-06: hooks are enabled by default, `PreToolUse` can return `hookSpecificOutput.updatedInput`, and the `Agent` matcher covers `spawn_agent`. The page notes that the schema on the `main` branch may contain fields absent from the current release.

[verified] The [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) documentation: `agents.default_subagent_model`, role files under `~/.codex/agents/` or `.codex/agents/` with a `model` field, explicit spawn values take precedence over defaults. A separate `model_provider` for the child is not documented.

[verified] The `config.schema.json` configuration schema at the pinned commit contains `ModelProviderInfo` with `base_url`, `wire_api`, `env_key`, `http_headers`, `env_http_headers`, `query_params`, and an agents section with `default_subagent_model`, `enabled`, `max_depth`. An optional `model_catalog` exists. It is not established whether an unknown model identifier without a catalog is rejected. That is measurement M5.

## Normative requirements

### Product and boundaries

1. The package MUST be a single Bun + TypeScript package, no monorepo.
2. The core MUST be clean and importable without a mandatory server process.
3. The core MUST NOT depend on harness SDKs.
4. Bun is allowed in the CLI and standalone mode, but the core MUST NOT require Bun-specific APIs.
5. The designed `subagent-router` CLI is meant to be a small text interface. It DOES NOT INCLUDE a TUI, a daemon manager, or an installer.
6. Commands MUST NOT automatically change native harness files. Export writes only to a separate artifact directory, never to the agent source directory, even with `--force`.
7. The project MUST NOT create its own agent loop, MCP runner, scheduler, UI, or database.
8. The project DOES NOT INCLUDE provider account auth, protocol translation, provider-specific discovery, or automatic fallback to another model. CLI catalog discovery stays a separate operation, not a request-time dependency.

### Model selection

9. The parent MUST be able to select a model for a specific child from a catalog of descriptions based on the snapshot loaded by that instance.
10. The core MUST validate every explicit choice against the snapshot and `modelOverrides`.
11. The core MAY apply explicit route overrides for existing roles and a global default model for children.
12. The core MUST NOT run an additional LLM to classify the task, choose the model, or create the model description.
13. Different children MUST be able to use different models and providers in the same session, as long as the configured gateway supports them.
14. A child's selection MUST NOT change the parent's model.
15. The upstream identifier MUST be opaque. The package MUST NOT branch logic on vendor name or define `providers/*`.
16. The allowlist catalog and role definitions MUST NOT be overridden by a prompt, history, or a tool result. The parent's explicit choice from the catalog is passed through the authorized channel from D2, and is not treated as a configuration edit.
17. A configured role by itself is NOT evidence that any given request comes from a child.

### Deterministic decision rules

18. For a child covered by routing, the decision order MUST be: explicit choice, the specific role's default model, the global default model for children. An invalid explicit choice MUST NOT fall through to a default value.
19. A child is covered by routing when the adapter confirmed its origin and there is an explicit choice for it, a role with a default model, a global default model for children, or a prior decision correlated with the same child. An invalid marker in an authorized position is the error `invalid-marker`, not a missing marker. A child recognized with no indication at all ends in the error `missing-selection`, because the router cannot distinguish a child never covered by routing from a child that lost its route after compaction or a handler restart. The only exception is the explicit opt-in `defaults.unmarkedSubagent: "inherit"`, which lets such a child through with the code `inherit-allowed`. This opt-in is the operator's conscious consent that losing the route will be invisible, and it is described in the configuration as such consent.
20. A parent with no match MUST go pass-through.
21. An explicitly routed child with an unknown model, a disallowed model, conflicting markers, or an unsupported path MUST end in an error.
22. In these cases the parent's model MUST NOT be used silently.
23. The package MUST NOT automatically pick a different model after a routing error.

### Client model and upstream model

24. Documentation and contracts MUST distinguish `clientModel` from `upstreamModel`.
25. `clientModel` is the setting used for validation, harness initialization, and, where supported, client-specific limits.
26. `upstreamModel` is the model actually sent to the configured gateway.
27. A native fork MAY inherit `clientModel`, and request routing MAY select a different `upstreamModel`.
28. In `marker-routed` mode, selecting the actual model MUST NOT depend solely on the harness's native model field. In `native` mode the native field is by definition `upstreamModel`, and requirement 33 describes the mandatory validation.
29. The case of a fork with an inherited `clientModel` and a different `upstreamModel` MUST have a separate acceptance case.
30. The specification does NOT claim that different forks are already tested.

### Integration modes

31. Every adapter MUST declare one of two modes: `native`, when the harness's native model field is literally `upstreamModel`, or `marker-routed`, when a handler in front of the gateway sets `upstreamModel`.
32. OpenCode and Codex run in `native` mode. Claude Code runs in `marker-routed` mode. Changing an adapter's mode requires a specification revision.
33. In `native` mode the core still validates the choice against the allowlist and resolves defaults, but an HTTP handler is not required. Validation of the explicit model field MUST run at execution time, before the child is launched. If the harness in a given version provides no effective hook point, the adapter MUST refuse to operate for that version with the code `unsupported-path`. A declarative restriction to roles does not replace runtime validation, because it does not stop the parent from directly supplying a model.

### Routing in front of the gateway

34. The routing layer in front of the gateway is part of the first implementation's scope for `marker-routed` mode.
35. The core, client adapters, and a thin HTTP handler or CLI `serve` MUST together provide marker routing for Claude Code.
36. An embedding application MUST be able to use the same handler without running an additional proxy process.
37. The handler MUST send upstream routing to the gateway configured by the caller or the environment.
38. The handler MUST NOT derive the upstream URL from the prompt or from request content.
39. Forwarding endpoint and header configuration MUST come from the caller or the environment.
40. Secrets MUST NOT reach prompts, markers, or diagnostics.
41. The handler MAY read routing JSON only for supported requests.
42. Responses and streams MUST be pass-through. The package MUST NOT perform protocol translation.
43. Stream cancellation and backpressure MUST pass through to upstream without a semantic change.

### Gateway independence

44. `9router` and `omnirouter` are the external layer for protocols, provider auth, and provider handling.
45. `subagent-router` MUST be independent of both of these projects.
46. The package MUST NOT contain gateway adapters, provider auth implementations, or vendor-based routing.
47. Swapping the gateway endpoint while keeping the same opaque model identifiers MUST NOT require a router code branch.

### Catalog and inspection

48. A model present in the snapshot and enabled MAY be selected explicitly with no local description, but without a description it MUST NOT reach the suggestions shown to the parent.
49. `modelOverrides` MUST NOT activate a model absent from the fetched catalog. The description of a model marked `missing` stays preserved.
50. Upstream IDs and aliases are compared case-sensitively. An upstream ID MUST NOT be trimmed, normalized, or derived from an alias. The role name is supplied by the native resolver.
51. Selecting a `missing` or disabled model MUST end in an explicit error with no fallback.
52. Native agent definitions, including `model: inherit`, MUST stay unchanged. Preview does not replace measuring the model actually used by a running harness.
53. The CLI MUST provide offline inspection and machine-readable JSON output. Writing commands have an explicit write scope and reject a concurrent edit conflict.

## Architecture and responsibilities

### Core

[assumption] The core accepts a normalized request context, the model catalog, and explicit information about the child's origin. It returns a deterministic decision: pass-through, route to an opaque `upstreamModel`, or a described error.

The core is responsible for:

- validating the catalog and the choice,
- resolving defaults,
- resolving conflicts among normalized model indications,
- rejecting indications whose origin the adapter did not confirm,
- holding no state shared across sessions.

Recognizing messages, markers, and child identity belongs to the client adapter. The core does not analyze the raw history of a specific harness.

The core is not responsible for:

- invoking the harness,
- HTTP transport,
- auth,
- protocol translation,
- detecting provider capabilities,
- managing subagent lifecycle.

### Client adapters

[assumption] An adapter translates only the native harness's local contract into core input and output. It preserves that harness's native tools, permissions, UI, and lifecycle.

An adapter MUST:

- pass credible data about the current child to the core,
- carry the decision to the harness (`native` mode) or to the routing handler (`marker-routed` mode) in a supported way,
- explicitly refuse when it cannot safely preserve the choice,
- not change the parent's model or permissions.

An adapter does NOT GUARANTEE:

- the same model quality,
- equal model capabilities,
- matching context limits,
- a matching reasoning format.

The last two points are an accepted limitation, described in the section on limits, not a basis for silently changing `upstreamModel`.

### Routing handler

[assumption] The thin handler recognizes the current child's controlled marker, computes the core decision, removes the marker only from the copy of the request sent upstream, and forwards the request to the configured gateway.

The client's original history MUST NOT be mutated. The handler MUST NOT treat as authorized any marker found in past history, tool results, or quoted text.

The handler holds only the ephemeral correlation memory described in the section on routing channels. It writes nothing to disk.

### Configuration

The project separates the operator file `subagent-router.json` from the generated snapshot `models.lock.json`. The core accepts these same already-loaded objects from the caller, so an embedding application does not need to read files or the environment. The exact format is described in "Decision D4".

Configuration MUST separate:

- `clientModel`, when the adapter needs it,
- the exact opaque `upstreamModel` from the snapshot,
- optional `routeOverrides` of existing effective agent names,
- operator descriptions, aliases, and model status,
- the endpoint and references to auth and headers only in operator configuration or the environment,
- the catalog snapshot with no secrets and no raw gateway response.

## Contracts and invariants

`enforcement: no implementation`. The contracts below describe requirements, not existing safeguards. Eventually the decision and allowlist are checked by core tests, origin and choice continuity by adapter tests, and the actual model and transport by handler and E2E tests.

### Routing decision contract

For every supported request the core returns exactly one result:

1. `pass-through` for the parent or for a child covered by an explicit inheritance opt-in. The result carries the diagnostic code `parent` or `inherit-allowed` and a list of markers ignored from unauthorized positions as `ignored-marker`.
2. `route` with a single validated opaque `upstreamModel` for a recognized child. The result carries the decision source: `explicit`, `role-default`, `global-default`, `correlated`.
3. `error` for a child covered by routing, when the choice is invalid, missing, or unsupported. The result carries an error code: `unknown-model`, `model-not-allowed`, `invalid-marker`, `conflicting-markers`, `correlation-conflict`, `unsupported-path`, `missing-selection`.

There is no result meaning "try the parent's model".

### Parent isolation invariant

The parent's model, its permissions, tools, and lifecycle stay unchanged. The change applies only to a request qualified as a specific child.

### Credible origin invariant

The marker is a transport signal placed in an authorized position by the parent or the adapter for the current child. It is not a text instruction for the model, and it cannot be accepted when it appears only in an unauthorized part of the request data. A marker coming from the adapter carries an authentication token, a marker coming from the parent is bound to the position at the start of the delegation prompt. The authorized positions are listed in the "Decision D2" section. The effect of every accepted marker is bounded by the allowlist, so the worst outcome of abuse is selecting a different allowed model, never a model outside the catalog or a different gateway.

### No decision leakage invariant

Parallel and nested children, as well as independent sessions, do not share a model choice. Canceling one session cannot change another session's decision. Correlation memory is keyed by the specific child's identifier together with the handler instance identifier, and is never inherited by another child. An identifier collision with a different marker is the error `correlation-conflict`, not a silent takeover of the decision.

### Transparent failure invariant

For a child covered by routing, the absence of a safe route ends handling with an error before the upstream call. It does not cause the model to be replaced by the parent's model. Ordinary traffic from the parent and from children not covered by routing stays unchanged.

### Transport invariant

After making the decision, the handler removes the marker from the upstream copy of the request. Apart from the required routing changes, it forwards the body, response, stream, cancellation, and backpressure with no protocol translation.

## Decisions resolving revision 1 gaps

### Decision D1: two integration modes instead of one mechanism for all harnesses

Resolves gap 6 and gap 7 in the design part.

In OpenCode the agent model `provider/model` is sent to the configured provider, and per the source read, the identifier must exist in that provider's `models` catalog, which measurement M6 confirms. In Codex the model given in `spawn_agent` or in the role is passed as a string to the session's provider. In both cases the native model field is literally `upstreamModel`, so a marker and a handler are not needed. The gateway is a single configured provider: for OpenCode an OpenAI-compatible provider entry with `baseURL`, for Codex `model_providers.<id>` with `base_url`.

In Claude Code the native model field is restricted to aliases or identifiers accepted by the client, and hooks cannot change the subagent's model. That is why Claude Code requires `marker-routed` mode: the parent chooses from the catalog, the marker reaches the child, a handler in front of the gateway swaps in `upstreamModel`.

Consequence: an HTTP handler is needed in the first implementation only for Claude Code. The core and configuration are shared across all three harnesses.

### Decision D2: routing channels and marker syntax for Claude Code

Resolves gap 4 and gap 9.

The marker takes the form of a single tag on a single line and comes in exactly two grammar variants:

```text
<subagent-router v="1" model="ALIAS"/>
<subagent-router v="1" role="NAME" agent="AGENT_ID" token="HMAC"/>
```

Rules:

- `v` is the syntax version. An unknown version in an authorized position is the error `invalid-marker`.
- The parent variant has only the attributes `v` and `model`. `model` is a safe local alias, not an upstream ID. The alias matches the regex `^[A-Za-z][A-Za-z0-9_-]{0,126}$` and is unique within the current snapshot. The adapter maps the alias to the exact opaque ID before calling the core. This lets the marker cover upstream IDs containing spaces or Unicode, while the upstream ID is never changed.
- The adapter variant has only the attributes `v`, `role`, `agent`, and `token`. `role` is the role name from the configuration, `agent` is the child identifier known to the hook, `token` is an HMAC computed from a secret shared by the adapter and the handler on the same machine, over the string `v|role|agent`. The token therefore covers every field that affects routing. The secret comes from the environment, never from a configuration file or the prompt.
- Any deviation from these two grammars in an authorized position, including mixing attributes from both variants, disallowed characters, an unclosed tag, or an unknown attribute, is the error `invalid-marker`, not a missing marker.
- Markers are classified by source: `explicit` for the parent variant, `role-default` for the adapter variant. Between sources, the order from requirement 18 applies, so a parent marker wins over a role marker. Two different markers from the same source are the error `conflicting-markers`. Identical markers are treated as one.
- The syntax belongs to this project. There is no drop-in compatibility with the CCR tag.

Authorized marker positions:

1. The request's `system` blocks, only for the adapter variant with a valid `token` whose `agent` matches the child identifier in the request. A parent variant, a marker with no token, or one with an invalid token in a `system` block is ignored with the code `ignored-marker`. This rule guards against a marker smuggled in through `CLAUDE.md` content, project instructions, or other system text that the adapter did not issue.
2. The first line of the first text block of the first message with role `user`, provided that message contains no `tool_result` blocks. This is the start of the delegation prompt written by the parent, and only the parent variant is accepted here. The adapter variant in this position is accepted only if measurement M3 shows that `additionalContext` lands there; then the same token verification as in the `system` block applies. A marker further into this message is ignored with the code `ignored-marker`.

A marker in any other position, including in `tool_result` blocks, in later messages, and in the assistant's response content, is ignored. A parent with a quoted marker goes pass-through.

Residual risk of the parent channel: a parent who copies foreign text containing a marker into the first line of their own delegation prompt selects that model as if they had done it themselves. The effect is bounded by the allowlist. The specification accepts this risk, because the parent is by design the choosing party, and the delegation tool's instructions require placing the marker as the first line of their own text.

Channels through which the choice reaches the child:

- Channel A, explicit parent choice: the parent places the marker as the first line of the delegation prompt. The delegation tool description, supplied by the adapter as an idempotent addition to the parent's context, lists only active models with a local description, their aliases, and the syntax. The delegation prompt is the first `user` message of every subsequent turn of a fresh subagent, so the choice is visible in every request with no memory on the handler's side. [inferred from CCR's parsing position and from how a subagent conversation is built]
- Channel B, role default model: the adapter's `SubagentStart` hook knows `agent_id` and `agent_type`, computes `token`, and injects the adapter variant of the marker through `additionalContext`. This gives a role a default model even when the parent did not specify one. If measurement M3 shows that `additionalContext` does not land in the `system` block or in the first `user` message, the adapter switches to channel B2: the hook registers the `agent_id` and role pair directly with the handler through a local endpoint authenticated with the same secret. Channel B2 does not depend on prompt content.
- Channel C, correlation by child identifier: on the first routed request, the handler remembers the pair of child identifier and decision in an ephemeral process map with a time limit. Subsequent requests with the same identifier and confirmed origin get the same decision with source `correlated`, even when compaction removed the marker from history. The identifier comes from the `x-claude-code-agent-id` header. Claude Code does not send a separate session identifier, so the key cannot include the session, and the channel's security rests on the randomness of the child identifier. Channel C is active only when measurement M1 confirms, for a given version, that the header is present in every child request and that the identifier's randomness is sufficient to make a collision between sessions practically impossible. The adapter keeps a list of versions that passed M1, and there is no setting that enables channel C without that pass. Without a pass, channel C is disabled, and losing the marker ends according to requirement 19.

Only `cc_is_subagent=true` in the billing metadata confirms a child's origin, as in CCR. The agent identifier header serves correlation, not origin authentication. A request with a correlated identifier that carries a valid marker with a different decision ends in the error `correlation-conflict`, because it points to an identifier collision or a takeover attempt.

Correlation memory: a map in process memory, keyed by handler instance identifier and child identifier, with a value of decision, source, and timestamp, a configurable time limit defaulting to one hour since last use, no disk writes. A handler restart loses the map. A child whose marker disappeared after compaction and whose entry died with a restart ends in the error `missing-selection` per requirement 19. This is accepted as a visible error, not as a silent model change. Channel A recreates the decision from the delegation prompt until compaction removes it.

### Decision D3: forks in Claude Code are outside the first implementation's guarantee

Resolves gap 2 in the design part.

A fork inherits the model, context, and history of the main conversation. A fork's delegation prompt is not the first `user` message, so channel A does not cover it. It is not known whether `SubagentStart` fires for a fork or whether a fork's request carries `cc_is_subagent=true`. Without these facts, a fork cannot be safely distinguished from the parent.

Decision: the first implementation does not promise fork routing. A fork request with no recognized origin is treated as a parent and goes pass-through. A fork request with a recognized origin but no indication is subject to requirement 19 like any other child. Acceptance criterion 6 stays in the specification as a second-stage goal and depends on measurement M4. Requirements 27 through 30 remain in force as the target description.

### Decision D4: separate operator config and catalog snapshot

Resolves gap 8 and designs the discovery contract. This contract is required for a future implementation but is not yet verified against a working gateway or the CLI.

`subagent-router.json` is the operator file. It contains references to the catalog source, local model overlays, and role routes, but contains no manual model list and no secrets:

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

`models.lock.json` is a generated, atomic snapshot after a successful `models sync`:

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

- `sourceId` is the source identifier assigned by the operator. `sourceFingerprint` is the SHA-256 UTF-8 hash of the compact JSON array `[sourceId, effectiveGatewayUrl, effectiveModelsUrl]`. Effective URLs are canonical, with no trailing `/`; URLs with userinfo, a query, or a fragment are rejected, and auth goes only into headers. This means changing the endpoint while `sourceId` stays the same also invalidates the snapshot. The example fingerprint was computed for `https://gateway.example/v1` and `https://gateway.example/v1/models`; this is not a gateway measurement.
- The snapshot stores the exact opaque `id`, a deterministic `m-` alias plus a SHA-256 UTF-8 hash of the ID, and minimal metadata. It does NOT store the full gateway response, auth, headers, or environment variables. Gateway metadata is not a trusted description or an instruction for the parent.
- The default alias is `m-` plus the full SHA-256 UTF-8 hash of the exact ID. An overlay can replace it with an alias matching the marker regex. An alias collision, including with another model's ID, is a configuration error. The CLI accepts an ID or an alias, but stores references as the exact ID. Changing an alias does not change role references or source data. A manual alias is not required.
- `modelOverrides[id]` can set only `description`, `alias`, `enabled`, and `clientModel`. An overlay for an absent ID stays preserved as inactive; it does not add the model to the allowlist. `enabled` defaults to `true` only for `status: available`. A missing model's local description can still be edited. `--clear` removes the description and excludes the model from suggestions, without taking over the provider's description. No `clientModel` or a value of `inherit` does not block routing.
- `roles` contains optional entries for existing names in the format `<client>:<effective-name>`, for example `claude-code:explorer`. The `routeOverride` field points to the exact upstream ID, never an alias or a new role definition. A reference to a nonexistent role, a `missing` model, or a disabled model is a `config check` error; an orphaned description with no route is only a warning. The clients are `claude-code`, `opencode`, and `codex`.
- `agentRoots.<client>.configRoot` is an explicit root passed to the native resolver. `null` means the active harness's rules. It does not create its own precedence.
- `baseUrlEnv`, `endpointPath`, auth, and headers are exclusively operator configuration or environment. A value from the prompt, a model entry, or a discovery response MUST NOT change the URL or the headers.
- `endpointPath` defaults to `/v1/models`. Endpoint construction uses URL segments and does not append `/v1` a second time when `baseUrlEnv` already ends in `/v1`. A changed path stays literal operator configuration.
- The caller passes the library already-parsed `operatorConfig`, `catalogSnapshot`, and the native resolver's result. The core does not read files, the environment, or the network.
- Unknown fields, an unknown `version`, inline header values, and a snapshot with a mismatched `sourceId` or `sourceFingerprint` are validation errors.
- `defaults.child` points to the exact ID of the default model or `null`. `defaults.unmarkedSubagent` accepts `error` or an explicit `inherit`, which requires `defaults.unmarkedSubagentAcknowledged: true`. The semantics of losing a route are set by requirement 19.
- `gateway.urlEnv` points to the upstream URL. The `gateway.headersEnv` and `modelSource.headersEnv` fields point to variables holding string-to-string JSON objects. The optional `modelSource.authEnv` holds a Bearer token for the models endpoint. Duplicate header names from different sources, regardless of case, are an error instead of an implicit override. The CLI prints no resolved auth or header values.
- `harness.claudeCode.correlation` accepts `auto` or `off`; `auto` allows correlation only for versions that passed M1. `secretEnv` points to the hook secret, never its value in a file. `harness.opencode.providerId` points to the native provider for exported variants. `harness.codex.emitModelCatalog` enables exporting a catalog of available models, if the M5 result requires it.
- Changing `sourceId` or the endpoint requires an explicit full sync. A missing snapshot points to `models sync`; it never causes a hidden fetch at request time.
- Sync does not change the operator file. A new ID is available only after a full successful sync. The snapshot keeps disappeared entries as `status: missing`, with no routing right. The exact ID reappearing restores `available`; the operator's description and alias stay preserved. `--allow-empty` allows no active entries; it does not remove their descriptions or routes.
- `models.lock.json` sits next to the pointed-to `--config` file. The default config is `./subagent-router.json`, with no implicit merging of parent files. The reader loads and validates the full config/snapshot pair. A write checks both files' input version before committing and rejects a conflict instead of overwriting a concurrent edit.
- An active `serve` loads an immutable config and snapshot at startup and shows their hash as `snapshotGeneration`. The CLI preview shows the file generation, not that of a running process. New descriptions, aliases, and models require a new instance; they do not switch current sessions. The project does not assume hot reload or a scheduler.

### Decision D5: OpenCode uses existing roles and export for manual integration

Resolves gap 6.

The adapter reads existing native OpenCode definitions as the role source. When a choice requires a `ROLE@ALIAS` variant, `config export --client opencode` can export such a variant, together with a fragment of the provider catalog, only into the pointed-to artifact directory. The user integrates the artifact manually. Export never swaps the base file, never appends models to the active `opencode.json`, and never creates a role in place of a deleted or unavailable file.

The variant preserves the source definition's prompt, tools, permissions, and mode, changing only the name, description, `hidden`, and the model `PROVIDER_ID/upstreamModel`. The description can use only the local `description`, not the gateway's description. A missing native role definition is an explicit export or preview error, not a signal to generate a substitute.

A plugin is not required in the first implementation. An optional `chat.headers` plugin can add a diagnostic header with the agent name to requests. `tool.execute.before` is NOT used for a hidden swap of `subagent_type`.

The pass condition stays unchanged: M6 confirms inheritance of prompt, tools, and permissions, and that the variant's model is preserved after resume.

### Decision D6: Codex uses existing roles, a validating hook, and export

Resolves gap 7.

The parent supplies `model` in `spawn_agent` as an opaque gateway identifier. The `PreToolUse` hook with the `Agent` matcher is a mandatory part of the adapter: it validates `model` against the snapshot and rejects a disallowed model through `permissionDecision: "deny"`. The hook does NOT apply `updatedInput` to swap the model, because that would be a fallback contrary to requirement 23.

`config export --client codex` can prepare roles with a default route and an optional `model_catalog` in a separate artifact directory, when M5 justifies it. It does not modify `config.toml`, the native roles directory, or an existing role. A deleted or unavailable role cannot be replaced by a new role with the same name.

If M7 shows that the hook does not receive `model` or that `deny` does not stop the child from launching, the Codex adapter refuses to operate for that version with the code `unsupported-path`, per requirement 33. A "roles only" mode is not an acceptable substitute, because it does not stop a direct `spawn_agent` with a model outside the snapshot.

The precedence between an explicit `model` in `spawn_agent` and the role's model does not follow unambiguously from the source. Measurement M9 settles it. Until the result is in, the adapter assumes the explicit value wins, per the subagents documentation, and reports `unsupported-path` when M9 shows otherwise for a supported version.

Baseline version: the hooks documentation describes released behavior, so the adapter requires a released Codex at version at least `rust-v0.153.4`. The local version `0.150.0-alpha.8` is lower and must be updated before measurements M5, M7, and M9.

### Decision D7: context limits and reasoning format are an accepted limitation

Resolves gap 5.

The package does not manage context limits or the reasoning format. In `marker-routed` mode the client initializes limits according to `clientModel`, while the gateway serves `upstreamModel`. A mismatch is possible and is deliberately not corrected on the router's side. Mitigation: the `clientModel` field in the catalog lets you pick a client alias close to the upstream model's class, and the handler records the `clientModel` and `upstreamModel` pair in diagnostics for every decision.

This decision closes the gap as a consciously accepted limitation. Measurement M8 is informational: it does not gate the `implemented` status, but its result must be a table in the adapter block's documentation with tested `clientModel` and `upstreamModel` pairs and observed behavior with long context.

### Decision D8: baseline versions

Resolves gap 1.

The first implementation's baseline versions are the versions measured in this document: Claude Code 2.1.263, OpenCode 1.18.29, Codex at least rust-v0.153.4, Bun 1.3.11. An adapter declares its baseline version in code and refuses to operate with the code `unsupported-path` when the detected version is lower. A newer version is allowed with a warning in diagnostics until the acceptance scenarios pass.

### Decision D9: native agent definitions are a read-only role source

This decision extends D5 and D6. The contract is required, but unverified against working resolvers for all harnesses.

- Claude reads the project's `.claude/agents` and the `agents` directory of the active config directory. By default this is `~/.claude/agents`, but the resolver respects `CLAUDE_CONFIG_DIR` and an explicit `configRoot`.
- OpenCode and Codex read their native sources only through adapters.
- `--agents-dir` adds an explicit read-only root for inspection and export commands. It does not change files or define its own hierarchy.
- Exact precedence, namespace, and effective name belong to the harness's native resolver. The router does not invent a directory order. The frontmatter `name` or namespace may differ from the file name.
- Inspection shows source path, scope, effective name, declared model, including `inherit`, and shadowed entries. When the adapter cannot confirm the runtime model, it shows `unknown`, it does not guess.
- Built-in, plugin, and dynamic agents with no file have limited visibility as `fileless`. An empty directory scan does not mean they do not exist. When a native tool schema is available, the adapter pulls known roles from it.
- A generator must not recreate an unknown or deleted role. `hidden` means interface visibility, not that the role does not exist. A `fileless` role confirmed by the resolver can be shown and used in preview; an export that needs its unavailable full definition reports a limitation instead of recreating the instructions.

For Claude, the router does not generate agent replacements or a `model` per file. It idempotently adds a catalog of described models and a selection instruction to the parent's `Agent`, `Task`, and `Workflow` tool descriptions, and also to the prompt description, if such a channel exists. It preserves existing tool descriptions, permissions, and tools. The parent writes the chosen alias into the marker, and the handler processes the child request's marker. This is the primary way of making an explicit choice, independent of whether `PreToolUse.updatedInput` works. Role hooks are only an optimization or a default.

### Decision D10: automatic discovery and offline snapshot

Discovery fetches the catalog only from the gateway's configurable models endpoint. The standard endpoint has the path `/v1/models` and the JSON contract `{"data":[{"id":"nonempty string"}]}`. The project does not claim that any specific gateway has been checked against it.

- Sync requires a correct positive control, schema, and non-empty, unique IDs. Repeated IDs are an error.
- The designed pagination profile accepts `has_more: true` with a non-empty `next_cursor`; the next fetch to the same endpoint uses the `cursor` parameter. `has_more: false` ends the fetch. Plain `data` with no pagination metadata means a full list under this contract. Conflicting or unrecognized further-page signals, a missing cursor, a repeated cursor, and a page cycle are errors. This is the adapter's chosen profile, not a claim about a standard shared by every gateway.
- The fetch limit is configurable. Exceeding it is an error. A timeout, auth failure, bad JSON, incomplete pagination, and an unexpectedly empty catalog do not replace the last valid snapshot.
- A full snapshot is written atomically only after success. An empty snapshot can be written only with `--allow-empty`.
- A redirect to a different origin is rejected before credentials are passed. No value from the response controls the URL, auth, or headers.
- The last valid snapshot can work offline, but `list`, `show`, `preview`, `doctor`, and `serve` show `fetchedAt` and a `stale` warning when the relevant configuration threshold has been exceeded.
- Core request-time, `route preview`, and inspection commands do not hit the network by default. In the management layer, the network is only used by an explicit `models sync` or `doctor --connect`. Request transport through `serve` stays a separate handler function. A positive schema control is a requirement of the discovery tests, not an additional hidden CLI request.

### Decision D11: designed CLI interface and route preview

The commands below are the designed interface. They do not exist yet and are not instructions to run a runtime.

| Command | Read | Network | Write |
|---|---|---:|---:|
| `models sync [--dry-run] [--allow-empty]` | operator config and models endpoint | yes | only `models.lock.json` after a successful sync with no `--dry-run`; shows `added`, `changed`, `missing` |
| `models list`, `models show <id-or-alias>` | config and snapshot | no | no; shows ID, alias, description, source, status, and snapshot time |
| `models describe <id-or-alias> --text "..." \| --file <path> \| --clear` | config and snapshot | no | only the description in `modelOverrides`, atomically; concurrent edit conflicts are rejected |
| `agents list --client <client>`, `agents show <name> --client <client>` | native resolver and explicit roots | no | no; shows effective precedence, scope, declared model, and router override |
| `route preview --client <client> --agent <name> [--model <id-or-alias>] [--parent-model <model>]` | config, snapshot, native resolver, and core | no | no; simulates an authenticated child context |
| `config show`, `config check` | config, snapshot, and resolver | no | no; shows provenance, schema, and refs |
| `config export --client <client> --output <dir> [--dry-run]` | config, snapshot, and native definitions | no | only separate fragments, overlays, and examples for manual integration |
| `doctor [--connect]` | config, snapshot, paths, and availability | only with `--connect` | no; `--connect` checks the models endpoint and schema with no completion and no agent launch |
| `serve` | config and snapshot at startup | per the designed handler | no automatic snapshot updates |

Additional rules of the designed CLI:

- `models describe` has exactly one of the modes `--text`, `--file`, or `--clear`. Editing the description of a missing ID with a preserved overlay is allowed, but does not activate the ID.
- `route preview` does not launch an agent, does not send a prompt, and does not call tools. The result is marked `simulation` and contains the selected model or default, the reason, the alias, the exact `upstreamModel`, `clientModel` or `unknown`, and the errors `missing` and `disabled`. `--parent-model` is a literal simulation input. Preview does not guess the parent's model and does not make a claim about the current runtime.
- `config export` always rejects the agent source directory, even with `--force`. It compares real paths after resolving symlinks and does not write through a link outside the export directory. `--force` only lets you replace a previously reviewed export artifact in the allowed directory. Export reads the offline snapshot and never modifies the global or native config.
- `doctor` distinguishes configured, measured, and `pending E2E` state. Success of `config check` or `doctor` is not a guarantee of model compatibility.
- Global options are `--config`, `--json`, `--help`, `--version`, `--no-color`, and `--client` where relevant. `--client` accepts `claude-code`, `opencode`, or `codex`. `--agents-dir` applies to role inspection, preview, and export. ID arguments containing spaces must be quoted, for example `--model 'gateway/Model with spaces'`.
- `list`, `show`, and `agents` also show inactive entries and invalid references, instead of hiding them behind a whole-catalog error. A missing snapshot does not block inspecting agent files by itself, but route selection requires a snapshot. `config check` also validates route references. No command prints resolved auth values, a secret, or headers, even on error or with `--json`.
- With `--json`, stdout contains only machine data. Progress and errors go to stderr with no secrets. The exit code is `0` for success, including `--dry-run` with a diff, `1` for an operational error, and `2` for a usage, configuration, or selection error. When stdout is not a TTY or `--no-color` was used, the CLI emits no ANSI. Catalog and description data is rendered with control characters escaped; the terminal representation does not change the stored upstream ID.

## Measurements required before `implemented` status

Every measurement has a deciding criterion. A negative result does not invalidate the project, it only disables the indicated channel or moves the feature to a second stage.

| Id | Question | Method | Criterion | Effect of a negative result |
|---|---|---|---|---|
| M1 | Does Claude Code 2.1.263 send `x-claude-code-agent-id` on every child request, including after compaction, and is the identifier random and unique across sessions and runs? | A controlled gateway records the headers of all subagent requests in two parallel sessions, one resumed, and one with forced compaction. | The header is present and stable in every request of a given child; identifiers differ between children, sessions, and runs; the format indicates at least 64 bits of randomness. | Channel C disabled for this version; losing the marker after compaction ends in `missing-selection`. |
| M2 | Does the Agent call's `model` parameter accept a full identifier despite the alias-only schema? | A call with a full identifier and observing `clientModel` in the request. | The request carries the given identifier. | `clientModel` in the catalog restricted to aliases. |
| M3 | Where does `additionalContext` from `SubagentStart` land in the child's request? | The hook injects a test marker with a token, the gateway records the body. | Marker in the `system` block or in the first line of the first `user` message. | Channel B replaced by channel B2 with `agent_id` registration in the handler. |
| M4 | Does a fork carry `cc_is_subagent=true`, and does `SubagentStart` fire for a fork? | A fork with the hook and a gateway recording the body. | Both conditions met. | The fork stays pass-through, criterion 6 stays in the second stage. |
| M5 | Does Codex with its own `model_providers` and no `model_catalog` accept an unknown model identifier in `spawn_agent`? | Spawn with an opaque identifier against a gateway recording the body. | The child request carries the identifier unchanged. | The generator runs with `harness.codex.emitModelCatalog: true` and produces a catalog from the allowlist. |
| M6 | Does the OpenCode agent variant inherit the base agent's prompt, tools, and permissions, is a model outside the provider's `models` rejected, and is the variant's model preserved after resume? | Comparing the resolved configuration of the variant and the base, a spawn with a model outside the provider, a resume test with the gateway. | Difference only in `model`, `name`, `description`, `hidden`; model outside the provider rejected; model unchanged after resume. | The generator explicitly copies the missing fields, or the adapter refuses. |
| M7 | Does the `PreToolUse` hook with the `Agent` matcher in released Codex receive `model` and respect `deny`? | A hook logging the input and rejecting a disallowed model. | The call is rejected with no child launch. | The Codex adapter refuses to operate for that version with the code `unsupported-path`. |
| M9 | What is the precedence between an explicit `model` in `spawn_agent` and the role's model in released Codex? | A role with model B, spawning that role with explicit model C, the gateway records the child's model. | The gateway receives C. | The adapter reports an explicit field alongside a role as `unsupported-path` and instructs the parent to choose the role instead. |
| M10 | Is a child's `upstreamModel` stable across every supported lifecycle transition in each harness: successive turns, resume, compaction, nested child, parallel child? | For each harness, a scenario with a gateway recording the model of every request and the child identifier. | Every request of a given child carries the same `upstreamModel`; children differ from each other; the parent unchanged. | A failing transition is marked unsupported in the adapter's documentation, and the adapter reports it as `unsupported-path` when it can detect it. |

Informational measurement, outside the status gate:

| Id | Question | Method | Required artifact |
|---|---|---|---|
| M8 | What effects does a `clientModel`/`upstreamModel` mismatch have on limits and reasoning? | A child with the `haiku` alias and an upstream model with a different limit, a long-context test. | A table of pairs and observations in the Claude Code adapter block's documentation. |

Diagnostics MAY contain the adapter name, the correlation identifier, the selected model identifier, `clientModel`, the decision source, the decision code, and a list of ignored markers with no content. It MUST NOT contain prompts, tool results, response content, the token secret, or authorization header values.

Measurements M1 through M7, M9, and M10 remain unrun. Revision 3 adds the catalog, resolver, and CLI criteria below; adding them is not evidence that they work. A client version can be marked as supported only after the corresponding adapter's scenarios pass.

## Alternatives and decisions

### A custom agent loop

Rejected. It would duplicate native tools, permissions, UI, and lifecycle, which the project is meant to preserve.

### Selection only through the native model field

Rejected for Claude Code. The field does not accept arbitrary gateway identifiers, hooks cannot change it, and a fork ignores it. Accepted for OpenCode and Codex as `native` mode, because there the field is literally `upstreamModel`.

### A PreToolUse hook swapping the model in Claude Code

Rejected. The documentation excludes `updatedInput` for the Agent tool.

### Environment aliases `ANTHROPIC_DEFAULT_*_MODEL` as the only mechanism

Rejected as the sole mechanism. They give a few model classes, not an arbitrary number of child models. They can supplement `clientModel` in the catalog.

### An optional proxy after deployment

Rejected. Routing in front of the gateway is part of the scope for `marker-routed` mode, and an embedder must use the handler with no additional process.

### A marker accepted anywhere in the prompt or the system block

Rejected. `CLAUDE.md` content, files read by tools, and quotes land in the same blocks. Without binding to the start-of-prompt position or to the adapter token, a marker has no credible origin.

### Persistent correlation memory on disk

Rejected. Requirement 7 excludes a database. An ephemeral process map with a time limit is enough, because channel A recreates the decision from the delegation prompt.

### An OpenCode plugin swapping `subagent_type`

Rejected. A hidden swap takes the explicit choice away from the parent and makes diagnosis harder. Agent variants are visible in configuration.

### Routing by provider name

Rejected. Model identifiers stay opaque, and provider auth and protocols belong to the external gateway.

### An LLM classifier for model assignment

Rejected. It introduces a nondeterministic decision and extra cost. The choice must follow from explicit delegation, role, and configuration.

### Silent fallback to the parent's model

Rejected. It hides the error and breaks the intent of explicit child routing.

### Drop-in compatibility with CCR

Not required. CCR is inspiration for the marker plus routing pattern, not a public contract for the marker syntax.

### Mandatory discovery or a fetch at request time

Rejected. Discovery is an explicit operator command and is not provider integration. The core and preview use only the existing offline snapshot.

### Generating or swapping native agents

Rejected. Native definitions are a read-only role source. Export is a separate artifact for manual integration and does not recreate a missing definition.

### Catalog hot reload and a sync scheduler

Rejected. An active handler uses the snapshot from its start moment. Changing the catalog requires an explicit sync and a new instance.

## Acceptance criteria

The following criteria are requirements for a future implementation. They are not currently met or tested.

1. The parent uses model A, while concurrent children use models B and C. A controlled gateway confirms the `upstreamModel` actually received for every request. The criterion applies separately for each of the three harnesses.
2. The test uses arbitrary opaque identifiers and, after changing the gateway endpoint, adds no vendor-based routing branch.
3. A child calls a tool, receives its result, and returns a correctly decoded final answer. A model declaring its own name is not evidence of correct routing.
4. The parent stays unchanged when the marker is only quoted in history, in a tool result, in the assistant's response, further into the delegation prompt, or in a `system` block with no valid token, for example smuggled through `CLAUDE.md`. A child with such a marker outside the authorized position is handled as if the marker were absent, with the code `ignored-marker`.
5. Nested children and independent parallel sessions have no leakage of decision or state. Two children with different identifiers and different markers get different `upstreamModel` values in the same handler process. A forced identifier collision with a different marker ends in `correlation-conflict`, not the first child's decision.
6. A fork with an inherited `clientModel` and a different `upstreamModel` is checked separately by a controlled gateway. A second-stage criterion, dependent on M4.
7. For a supported client version, a child's multi-turn work, resume, and compaction preserve its model choice, confirmed by measurement M10 for each harness. Separate tests of losing route information require the behavior set out in requirement 19. The `unsupported-path` error alone does not count as a passing scenario for a working integration.
8. An unknown, ambiguous, or disallowed target for a recognized child covered by routing causes an error with no gateway call. A foreign or quoted parent marker, even with an unknown model, does not trigger this validation and does not block its request.
9. Cancellation and stream backpressure pass through the handler with no change in semantics.
10. The core builds and runs in an environment with no Bun-only dependency.
11. Fake gateway tests are hermetic and form the first line of validation.
12. Opt-in tests of real harnesses run against an external gateway, store no secrets, and report harness versions.
13. The configuration validator rejects a file with an unknown version, an unknown field, or an inline header value.
14. `config export` changes no native file. The SHA-256 sum of native agent files is identical before and after export, and an existing `inherit` declaration stays unchanged.
15. The fake models endpoint has a positive control with a valid `data[].id`, and separate scenarios reject a bad schema, an auth failure, malformed JSON, duplicates, unsupported incomplete pagination, an exceeded limit, and an unexpectedly empty catalog with no `--allow-empty`.
16. A failed sync preserves the previous `models.lock.json`'s hash. A successful sync writes the whole new snapshot atomically and shows `added`, `changed`, `missing`.
17. A local description, alias, and role routing survive an ID disappearing and reappearing. A disappeared, disabled, or absent ID does not route and does not use a fallback.
18. The fixture covers upstream IDs with spaces, Unicode, and case differences. An alias maps to the exact ID, an alias collision is an error, and a marker carries no raw ID.
19. The resolver fixture covers scope collisions, effective naming other than the file name, `inherit`, shadowed entries, and fileless roles. An empty directory scan does not remove a role exposed by the native tool schema.
20. `route preview` performs no network access, launches no tools or agent, and shows a simulation with an alias, the actual `upstreamModel`, `clientModel` or `unknown`. It makes no claim about the current runtime.
21. All inspection commands support `--json`, run offline by default, print no secrets, and return correct exit codes. Networked `doctor --connect` is tested as an explicit exception with no write. No color for non-TTY is tested.
22. Concurrent edits of `subagent-router.json` through `models describe` are detected, and the second edit is rejected without overwriting the first.
23. Adding a local description to a model from the snapshot does not manually define the model, and existing parent tool descriptions are preserved after an idempotent catalog addition.
24. Changing the endpoint while keeping the same `sourceId` rejects the old snapshot. Sync with `--dry-run` changes no config or snapshot hashes. A cursor cycle, conflicting pagination, and a redirect between origins do not write a partial catalog.
25. Changing an alias preserves role assignments stored as an ID. `hidden` is not confused with a missing role, and a symlink leading from the export directory to the native config is rejected, even with `--force`.
26. The preview result states the generation of the loaded files. It does not present it as the generation of a running process, which still uses the configuration from its own startup.

## Test strategy

[assumption] Test layers should separate the deterministic core, the HTTP handler, and the harness adapters.

- Core tests check the catalog, decision priority, allowlist, marker conflicts, absence of fallback, session isolation, and decision codes.
- Handler tests with a fake gateway capture the request, `upstreamModel`, the body with no marker, cancellation, backpressure, and correlation map behavior after the time limit.
- Export tests compare artifacts against the expected result, reject the source directory and an output collision, and compare SHA-256 of native definitions before and after the operation.
- Discovery tests use a fake endpoint with a positive control and fixtures for schema, auth, pagination, limit, and empty-catalog errors. Tests confirm snapshot atomicity and that the previous version's hash is preserved after an error.
- CLI tests cover offline mode, `--json`, stderr with no secrets, exit codes, non-TTY, concurrent edit conflicts, and preview with no network or tools.
- Resolver tests check effective name, scope, shadowing, `inherit`, aliases, and fileless roles supplied by the native schema.
- Adapter tests confirm passing a credible child context, idempotent preservation of existing tool descriptions, and an explicit error on an unsupported path.
- E2E tests are opt-in, store no secrets, report the harness and gateway version, and carry out measurements M1 through M7, M9, and M10 as separate, named gating scenarios. Measurement M8 is a separate informational scenario whose result goes into the block's documentation.

E2E success requires both a capture from the controlled gateway and a meaningful, decoded roundtrip of the child's tool and its final result. The model's response text alone is not enough.

## Related

- [Documentation index](../../README.md)
- [Documentation conventions](../../CONVENTIONS.md)
- [CCR, pinned commit `c49733678660f726540fca3fff20bbd7d6cab032`](https://github.com/kolezka/claude-code-router/tree/c49733678660f726540fca3fff20bbd7d6cab032)
- [Claude Code sub-agents documentation](https://code.claude.com/docs/en/sub-agents)
- [Claude Code hooks documentation](https://code.claude.com/docs/en/hooks)
- [OpenCode, pinned commit `337fd144d2ba144743368f78d9579a99cce175bd`](https://github.com/anomalyco/opencode/tree/337fd144d2ba144743368f78d9579a99cce175bd)
- [OpenCode agents documentation](https://opencode.ai/docs/agents/)
- [Codex, pinned commit `ac192cd7937b0d73edc6dffe009940ae53782dd4`](https://github.com/openai/codex/tree/ac192cd7937b0d73edc6dffe009940ae53782dd4)
- [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
- [Codex subagents documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
