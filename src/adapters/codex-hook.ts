import { codexHookOutput, validateCodexSpawn } from './codex';
import { RouterError } from '../core/errors';
import type { AgentInventory, CapabilityProfile, EffectiveCatalog, NativeRuntimeContext, OperatorConfig } from '../core/types';

export interface CodexHookDeps {
  inventory: AgentInventory;
  config: OperatorConfig;
  catalog: EffectiveCatalog;
  profile: CapabilityProfile;
  /**
   * Produces the trusted native runtime context for one PreToolUse call, or `undefined` when no
   * authoritative resolver is available. A missing witness is indistinguishable from an unmeasured
   * runtime and must become an `unsupported-path` decision, never permission to proceed -- the
   * same rule the OpenCode plugin applies to its own resolver.
   *
   * No measured production implementation exists for Codex: `M7` (whether a native resolver hook
   * can even run, and where relative to spawn) is unmeasured for every shipped profile (see
   * `tests/fixtures/capabilities/codex-pending.json`), so the real bootstrap below always passes
   * `async () => undefined` here. Only a hermetic test may inject a witness, and only as an
   * explicit synthetic stand-in, never derived from `tool_input` or any other hook field.
   */
  resolveNativeRuntimeContext: (input: unknown) => Promise<NativeRuntimeContext | undefined>;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

async function writeAll(stream: WritableStream<Uint8Array>, text: string): Promise<void> {
  const writer = stream.getWriter();
  await writer.write(new TextEncoder().encode(text));
  await writer.close();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const INVALID_HOOK_INPUT_MESSAGE = 'subagent-router received invalid hook input';

function invalidHookInput(): RouterError {
  return new RouterError('invalid-hook-input', INVALID_HOOK_INPUT_MESSAGE);
}

// The PreToolUse matcher this hook is registered under. `tool_input` on a matching event carries
// the spawn_agent-shaped args (model?, role?/agent?, prompt) that validateCodexSpawn consumes.
const MATCHED_TOOL_NAME = 'Agent';

/**
 * Entry point for Codex's `PreToolUse` hook (matcher `Agent`). Reads exactly one JSON document
 * from stdin and writes exactly one JSON document to stdout; it never launches Codex's child agent
 * itself and never calls any "continuation" function -- execution of the underlying spawn (or its
 * refusal) stays entirely with Codex, the only process that reads this decision and acts on it.
 *
 * Unparseable or non-object stdin is rejected with `RouterError('invalid-hook-input')`, mirroring
 * the Claude Code SubagentStart hook: a caller that cannot parse its own input must not be told
 * anything was decided cleanly. An event that is not `PreToolUse` for the matched tool, or whose
 * `tool_input` is not an object, ends with the neutral empty hook object and validates nothing
 * further -- this hook has no opinion about events it was not built to gate.
 *
 * The native runtime context comes exclusively from `deps.resolveNativeRuntimeContext`, given the
 * WHOLE parsed hook event (never only `tool_input`, so a resolver can use event-level fields a
 * real Codex integration might carry). A missing context is turned into an `unsupported-path`
 * decision without ever calling `validateCodexSpawn`, since that function requires a concrete
 * witness and cannot itself represent "no witness available".
 */
export async function runCodexPreToolUseHook(
  stdin: ReadableStream<Uint8Array>,
  stdout: WritableStream<Uint8Array>,
  deps: CodexHookDeps,
): Promise<void> {
  const raw = await readAll(stdin);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidHookInput();
  }
  if (!isPlainObject(parsed)) {
    throw invalidHookInput();
  }

  if (parsed.hook_event_name !== 'PreToolUse' || parsed.tool_name !== MATCHED_TOOL_NAME || !isPlainObject(parsed.tool_input)) {
    await writeAll(stdout, JSON.stringify({}));
    return;
  }

  const context = await deps.resolveNativeRuntimeContext(parsed);
  const decision =
    context === undefined
      ? ({ kind: 'error', code: 'unsupported-path', ignoredMarkers: 0 } as const)
      : validateCodexSpawn(parsed.tool_input, deps.inventory, deps.config, deps.catalog, deps.profile, context);

  await writeAll(stdout, JSON.stringify(codexHookOutput(decision)));
}

// A fixed, unmeasured stand-in for config/catalog/inventory/profile. None of it is ever consulted
// for a real decision below: `resolveNativeRuntimeContext` always returns `undefined` (no
// production Codex resolver exists yet -- see the `CodexHookDeps` docstring above), so
// `runCodexPreToolUseHook` denies with `unsupported-path` before either is read. Reading real
// operator config, a real catalog, or real on-disk agent inventory here would need a CLI contract
// (flags, config discovery, native inventory resolution) this task never specifies -- that is
// packaging/integration work for a separate task, not something to invent silently here.
const UNMEASURED_CONFIG: OperatorConfig = {
  version: 1,
  modelSource: {
    sourceId: 'unconfigured',
    baseUrlEnv: 'GATEWAY_URL',
    endpointPath: '/v1/models',
    headersEnv: [],
    timeoutMs: 10000,
    fetchLimit: 1000,
    staleAfterSeconds: 86400,
  },
  modelOverrides: {},
  roles: {},
  defaults: { child: null, unmarkedSubagent: 'error' },
  agentRoots: { 'claude-code': { configRoot: null }, opencode: { configRoot: null }, codex: { configRoot: null } },
  gateway: { urlEnv: 'GATEWAY_URL', headersEnv: [] },
  harness: { claudeCode: { correlation: 'off', secretEnv: 'ROUTER_SECRET' }, opencode: { providerId: 'unconfigured' }, codex: { emitModelCatalog: false } },
};

// Mirrors the shipped tests/fixtures/capabilities/codex-pending.json: every probe unmeasured,
// status 'pending'. Never a claim that Codex is supported.
const UNMEASURED_PROFILE: CapabilityProfile = {
  client: 'codex',
  version: 'unmeasured',
  status: 'pending',
  correlation: false,
  correlationEntropy: 'pending',
  fork: false,
  adapterMarkerPosition: 'unknown',
  probes: {},
  lifecycle: { 'next-turn': 'pending', resume: 'pending', compaction: 'pending', nested: 'pending', parallel: 'pending' },
};

const EMPTY_CATALOG: EffectiveCatalog = { byId: new Map(), byAlias: new Map() };
const EMPTY_INVENTORY: AgentInventory = { entries: [], completeness: 'files-only', diagnostics: [] };

/**
 * Executable bootstrap for the published `./codex-hook` entrypoint. It takes no flags and reads no
 * files: with no authoritative native resolver available for Codex, every real invocation denies
 * with `unsupported-path` regardless of config/catalog/inventory contents, so those are fixed,
 * unmeasured stand-ins rather than real disk state this task has no specified contract for reading.
 * The stdin/stdout wiring and the event/tool/tool_input validation inside
 * `runCodexPreToolUseHook` are real and exercised, not stubbed.
 */
export async function main(): Promise<number> {
  const stdout = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        process.stdout.write(chunk, (error) => (error ? reject(error) : resolve()));
      });
    },
  });

  try {
    await runCodexPreToolUseHook(Bun.stdin.stream(), stdout, {
      inventory: EMPTY_INVENTORY,
      config: UNMEASURED_CONFIG,
      catalog: EMPTY_CATALOG,
      profile: UNMEASURED_PROFILE,
      resolveNativeRuntimeContext: async () => undefined,
    });
  } catch (error) {
    const message = error instanceof RouterError ? error.message : 'subagent-router codex-hook failed';
    process.stderr.write(`${message}\n`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
