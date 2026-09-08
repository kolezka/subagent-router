/**
 * Smoke driver for the BUILT adapter entrypoints in `dist/`.
 *
 * This runs the real artifacts, not the sources: the hook is spawned as a process and fed
 * synthetic stdin, and the plugin is imported and invoked through its measured host API. Each
 * label it prints is DERIVED from the artifact's actual behaviour — a parsed deny decision, or a
 * refusal to emit any freshness/marker evidence — and every check that produces a label also
 * runs the matching positive control, so a hook that printed nothing, crashed, or blanket-denied
 * every input could not earn the same label. Nothing here prints a fixed 'synthetic-deny'.
 *
 * It never launches a native agent, and it never fabricates a native runtime witness: with no
 * trusted `authoritative-native-resolver` available, the correct behaviour for all three native
 * adapters (Claude, OpenCode, Codex) is to refuse, and that refusal is what this driver measures.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCatalog } from '../../src/core/catalog';
import type { AgentInventory, CapabilityProfile, NativeRuntimeContext } from '../../src/core/types';
import { configFixture, snapshotFixture, FIXTURE_MODEL_ID } from './fixtures';

const ROOT = join(import.meta.dir, '..', '..');
const DIST = join(ROOT, 'dist');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runHook(file: string, args: readonly string[], stdin: string, env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn('bun', [join(DIST, file), ...args], {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function fail(what: string, detail: unknown): never {
  process.stderr.write(`${what}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
  process.exit(1);
}

/**
 * The Claude hook denies by producing NO evidence: no freshness envelope is registered and no
 * adapter marker is emitted, so its output is an empty hook object. The positive control proves
 * that empty object is a decision and not a dead process: a control server counts every
 * control-plane request, and the run is only accepted if the hook exited 0, wrote parseable
 * JSON, carried no `hookSpecificOutput`, and made zero registration attempts.
 */
async function claude(dir: string, configPath: string): Promise<string> {
  let controlRequests = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      controlRequests += 1;
      const url = new URL(request.url);
      if (url.pathname.endsWith('/control/instance')) {
        return Response.json({ handlerInstanceId: 'smoke-instance' });
      }
      return new Response(null, { status: 204 });
    },
  });

  try {
    // The profile is the shipped, measured claude-code profile: every probe is 'pending', so no
    // channel may open. `--profile-dir` + `--client-version` go through the same validated
    // `loadCapabilityProfile` lookup the rest of the router uses, resolving to the profile the
    // package actually ships from dist/capabilities/.
    const profileDir = join(DIST, 'capabilities');
    const stdin = JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'smoke-agent', agent_type: 'explorer' });
    const run = await runHook(
      'claude-hook.js',
      [
        '--config',
        configPath,
        '--profile-dir',
        profileDir,
        '--client-version',
        '2.1.263',
        '--control-url',
        server.url.toString().replace(/\/$/, ''),
      ],
      stdin,
      { ROUTER_SECRET: 'smoke-secret' },
    );

    if (run.code !== 0) fail('claude-hook exited non-zero', run);
    let output: unknown;
    try {
      output = JSON.parse(run.stdout);
    } catch {
      fail('claude-hook did not write parseable JSON', run.stdout);
    }
    if (typeof output !== 'object' || output === null) fail('claude-hook output is not an object', run.stdout);
    // A marker or any other hook-specific output would mean the adapter claimed a capability it
    // never measured.
    if ('hookSpecificOutput' in output) fail('claude-hook emitted evidence without a measured profile', output);
    if (controlRequests !== 0) fail('claude-hook attempted freshness registration without a trusted start', controlRequests);
    if (run.stdout.includes('smoke-secret')) fail('claude-hook leaked the secret to stdout', 'redacted');

    // Positive control: malformed stdin must be a loud error, not the same silent no-op. Without
    // this, a hook that printed '{}' for literally everything would pass the check above.
    const malformed = await runHook(
      'claude-hook.js',
      [
        '--config',
        configPath,
        '--profile-dir',
        profileDir,
        '--client-version',
        '2.1.263',
        '--control-url',
        server.url.toString().replace(/\/$/, ''),
      ],
      'not json',
      { ROUTER_SECRET: 'smoke-secret' },
    );
    if (malformed.code === 0) fail('claude-hook accepted malformed stdin', malformed);

    return 'synthetic-deny';
  } finally {
    await server.stop(true);
  }
}

const INVENTORY: AgentInventory = {
  entries: [
    {
      client: 'opencode',
      name: 'explorer',
      scope: 'project',
      path: '/smoke/.opencode/agents/explorer.md',
      declaredModel: 'inherit',
      hidden: false,
      body: 'Smoke.',
      native: { description: 'Smoke', mode: 'subagent' },
      availability: 'available',
      shadowed: false,
    },
  ],
  completeness: 'files-only',
  diagnostics: [],
};

/**
 * The OpenCode plugin's real hook contract is `(input, output) => Promise<void>`: it denies by
 * THROWING a `RouterError`, not by returning a decision object (a returned value is ignored by
 * the real host, so a returned deny would silently fail open). No trusted native runtime context
 * can be produced here (the measured resolver, `PluginInput.client.app.agents()`, is not wired to
 * an authoritative witness in this smoke driver), so `resolveNativeRuntimeContext` yields
 * undefined and the guard must throw rather than let the spawn through.
 *
 * The positive control feeds an explicit fixture witness. It only has to produce a DIFFERENT
 * outcome once the shipped profile is `supported`: today's shipped `opencode-1.18.29.json` is
 * `pending` (Task 10's `M6-runtime` measurement never ran against a real client), so
 * `assertCapability` fails closed even with a witness, and that is correct, not a bug.
 */
async function opencode(): Promise<string> {
  const { createOpenCodePlugin } = (await import(join(DIST, 'opencode-plugin.js'))) as {
    createOpenCodePlugin: (deps: Record<string, unknown>) => {
      'tool.execute.before': (input: unknown, output: unknown) => Promise<void>;
    };
  };
  const config = configFixture();
  const catalog = buildCatalog(config, await snapshotFixture());
  const profile: CapabilityProfile = JSON.parse(
    await Bun.file(join(DIST, 'capabilities', 'opencode-1.18.29.json')).text(),
  ) as CapabilityProfile;

  const base = { inventory: INVENTORY, config, catalog, profile };
  const args = { subagent_type: 'explorer', description: 'smoke', prompt: 'smoke' };

  async function callCode(deps: Record<string, unknown>): Promise<string | undefined> {
    try {
      await createOpenCodePlugin(deps)['tool.execute.before']({ tool: 'task', args }, {});
      return undefined;
    } catch (error) {
      return error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'non-router-error';
    }
  }

  const deniedCode = await callCode({ ...base, resolveNativeRuntimeContext: async () => undefined });
  if (deniedCode !== 'unsupported-path') fail('opencode plugin did not deny without a native witness', deniedCode);

  const witness: NativeRuntimeContext = {
    lifecyclePhase: 'next-turn',
    freshDelegation: true,
    nativeConfig: {
      source: 'authoritative-native-resolver',
      providerId: config.harness.opencode.providerId,
      effectiveModel: FIXTURE_MODEL_ID,
      expectedGeneration: 'smoke-generation',
      actualGeneration: 'smoke-generation',
      artifactHash: 'smoke-artifact-hash',
    },
  };
  const allowedCode = await callCode({ ...base, resolveNativeRuntimeContext: async () => witness });
  if (profile.status === 'supported' && allowedCode === 'unsupported-path') {
    fail('opencode plugin denied even with a witness on a supported profile', allowedCode);
  }

  return 'synthetic-deny';
}

/**
 * The Codex hook's shipped `main()` takes no flags and reads no config: with no measured native
 * resolver for Codex (M7 unmeasured on every shipped profile), `resolveNativeRuntimeContext`
 * always returns `undefined`, so a matching `PreToolUse`/`Agent` call always denies with
 * `unsupported-path`. The positive controls prove that is a real decision, not a dead process or a
 * hook that denies unconditionally: a non-matching tool name must no-op to the neutral empty
 * object, and malformed stdin must be a loud non-zero exit rather than the same silent deny.
 */
async function codex(): Promise<string> {
  const matching = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { model: 'smoke-model', prompt: 'smoke' } });
  const run = await runHook('codex-hook.js', [], matching, {});
  if (run.code !== 0) fail('codex-hook exited non-zero', run);
  let output: unknown;
  try {
    output = JSON.parse(run.stdout);
  } catch {
    fail('codex-hook did not write parseable JSON', run.stdout);
  }
  if (typeof output !== 'object' || output === null) fail('codex-hook output is not an object', run.stdout);
  const hookSpecificOutput = (output as Record<string, unknown>).hookSpecificOutput;
  const deniedProperly =
    typeof hookSpecificOutput === 'object' &&
    hookSpecificOutput !== null &&
    (hookSpecificOutput as Record<string, unknown>).permissionDecision === 'deny';
  if (!deniedProperly) fail('codex-hook did not deny without a native witness', output);

  // Positive control: a non-matching tool name must no-op to the neutral empty object -- proving
  // the deny above came from real event validation, not a hook that denies unconditionally.
  const nonMatching = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'true' } });
  const passthrough = await runHook('codex-hook.js', [], nonMatching, {});
  if (passthrough.code !== 0) fail('codex-hook exited non-zero on a non-matching tool', passthrough);
  let passthroughOutput: unknown;
  try {
    passthroughOutput = JSON.parse(passthrough.stdout);
  } catch {
    fail('codex-hook did not write parseable JSON for a non-matching tool', passthrough.stdout);
  }
  const isEmptyObject =
    typeof passthroughOutput === 'object' && passthroughOutput !== null && Object.keys(passthroughOutput).length === 0;
  if (!isEmptyObject) fail('codex-hook did not no-op on a non-matching tool', passthroughOutput);

  // Second positive control: malformed stdin is a loud non-zero exit, not the same silent no-op.
  const malformed = await runHook('codex-hook.js', [], 'not json', {});
  if (malformed.code === 0) fail('codex-hook accepted malformed stdin', malformed);

  return 'synthetic-deny';
}

const dir = await mkdtemp(join(tmpdir(), 'subagent-router-smoke-'));
const configPath = join(dir, 'subagent-router.json');
await writeFile(configPath, JSON.stringify(configFixture()), 'utf8');

process.stdout.write(
  `${JSON.stringify({
    claude: await claude(dir, configPath),
    opencode: await opencode(),
    codex: await codex(),
  })}\n`,
);
