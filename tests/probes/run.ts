import { spawn } from 'node:child_process';
import { RouterError } from '../../src/core/errors';
import type { ClientId, Env, ProbeResult } from '../../src/core/types';
import { startCaptureGateway } from '../support/capture-gateway';
import type { CapturedRequest } from '../support/capture-gateway';

const CLIENT_IDS: readonly ClientId[] = ['claude-code', 'opencode', 'codex'];

export interface ProbeArgs {
  client: ClientId;
  probe: string;
  configRoot: string;
  binary: string;
}

function isClientId(value: string): value is ClientId {
  return (CLIENT_IDS as readonly string[]).includes(value);
}

function readFlag(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

/**
 * Parses the manual probe driver's CLI flags. Fails closed: an unknown --client or a missing
 * required flag throws rather than falling back to a default that could silently run the wrong
 * probe against the wrong client.
 */
export function parseProbeArgs(argv: readonly string[]): ProbeArgs {
  const client = readFlag(argv, '--client');
  const probe = readFlag(argv, '--probe');
  const configRoot = readFlag(argv, '--config-root');
  const binary = readFlag(argv, '--binary');
  if (client === undefined || !isClientId(client)) {
    throw new RouterError('probe-invalid-args', `--client must be one of ${CLIENT_IDS.join(', ')}, got ${client ?? '(missing)'}`);
  }
  if (probe === undefined || configRoot === undefined || binary === undefined) {
    throw new RouterError('probe-invalid-args', '--probe, --config-root and --binary are required');
  }
  return { client, probe, configRoot, binary };
}

/**
 * Isolates a manual probe run's HOME and every client config dir under configRoot, so running a
 * real client binary for a probe never touches the operator's real HOME or credentials.
 */
export function isolatedHarnessEnv(configRoot: string): Env {
  return {
    HOME: configRoot,
    CLAUDE_CONFIG_DIR: `${configRoot}/claude`,
    XDG_CONFIG_HOME: `${configRoot}/xdg`,
    CODEX_HOME: `${configRoot}/codex`,
  };
}

export interface Evidence {
  childRequests: number;
  distinctAgentIds: number;
  requestsByModel: Readonly<Record<string, number>>;
}

/** Pure counter over captured requests. Never itself proof that any gate should open. */
export function summarizeEvidence(requests: readonly CapturedRequest[]): Evidence {
  const agentIds = new Set<string>();
  let childRequests = 0;
  const requestsByModel: Record<string, number> = {};
  for (const request of requests) {
    if (request.agentId !== undefined) agentIds.add(request.agentId);
    if (request.isChild === true) childRequests += 1;
    if (request.model !== undefined) {
      requestsByModel[request.model] = (requestsByModel[request.model] ?? 0) + 1;
    }
  }
  return { childRequests, distinctAgentIds: agentIds.size, requestsByModel };
}

export interface EntropyProof {
  source: string;
  sampleCount: number;
  // Optional fields carried by a statistical-sample proof (see evidence-m1.ts's
  // buildEntropyProof). distinctCount and totalEntropyBitsEstimate are the sample's own
  // measurements; generatorInspected is only ever true when a human has directly linked the id
  // generator to a real >=64-bit entropy source by reading the compiled client bundle --
  // a statistical sample can never set it true on its own. limitation names why a sample-based
  // proof falls short.
  distinctCount?: number;
  totalEntropyBitsEstimate?: number;
  generatorInspected?: boolean;
  limitation?: string;
  // Carried only by a generator-inspection proof (evidence-m1.ts's buildGeneratorEntropyProof):
  // the generator's own bit count, the client version it was read out of, and how many of the
  // proof's recorded byte sites still matched that binary, as 'n/m'.
  bits?: number;
  version?: string;
  sitesVerified?: string;
}

// judgeM1 used to live here, judging M1 from capture-gateway aggregate counts (childRequests,
// distinctAgentIds) plus an unchecked EntropyProof, and could never return 'passed'. It was
// removed when the real judge landed in evidence-m1.ts: that one reads the run's own id sample
// and a generator-inspection proof re-checked against the client binary, and it is the single
// home of the M1 verdict so two judges can never disagree about the same run.

export interface OpencodeHookEvidence {
  hookRegistered: boolean;
  invokedBeforeSpawn: boolean;
  deniedWithoutRequest: boolean;
  effectiveModelObserved: boolean;
}

/** Every flag must be independently proven true; any missing or false flag fails the probe. */
export function judgeOpencodeHook(hook: OpencodeHookEvidence | undefined): ProbeResult {
  if (hook === undefined) return 'pending';
  const allTrue = hook.hookRegistered && hook.invokedBeforeSpawn && hook.deniedWithoutRequest && hook.effectiveModelObserved;
  return allTrue ? 'passed' : 'failed';
}

export interface CodexHookEvidence {
  receivedModelField: boolean;
  permissionDecision?: 'deny' | 'allow';
}

/**
 * Codex must actually deny the spawn (not merely receive the model field) and no child request
 * may have reached the capture gateway despite the deny, or the probe failed to prove enforcement.
 */
export function judgeCodexDeny(evidence: Evidence, hook: CodexHookEvidence | undefined): ProbeResult {
  if (hook === undefined || hook.permissionDecision !== 'deny') return 'pending';
  if (!hook.receivedModelField || evidence.childRequests > 0) return 'failed';
  // Aggregate counts alone cannot prove the required native behavior: a model field plus
  // zero captured requests is not a registered-hook, allowed-child positive control.
  return 'pending';
}

const LIFECYCLE_PHASES = ['next-turn', 'resume', 'compaction', 'nested', 'parallel'] as const;
type LifecyclePhaseName = (typeof LIFECYCLE_PHASES)[number];

/** Fills every unreported phase with 'pending'. A pass proven for one phase never spreads to another. */
export function summarizeLifecycle(results: Partial<Record<LifecyclePhaseName, ProbeResult>>): Record<LifecyclePhaseName, ProbeResult> {
  const summary = {} as Record<LifecyclePhaseName, ProbeResult>;
  for (const phase of LIFECYCLE_PHASES) {
    summary[phase] = results[phase] ?? 'pending';
  }
  return summary;
}

/**
 * Manual, opt-in probe entry point: starts the real capture gateway, spawns the real client
 * binary against it in an isolated harness env, and reports the captured evidence. This never
 * fabricates a probe verdict — it has no harness-specific proof extractor wired for any client,
 * so it always reports 'failed' with a diagnostic explaining why, leaving a human to attach real
 * proof (EntropyProof / OpencodeHookEvidence / CodexHookEvidence) out of band before a fixture may
 * be promoted toward 'passed'. Never exercised by the automated test suite.
 */
async function main(): Promise<void> {
  const args = parseProbeArgs(process.argv.slice(2));
  const gateway = await startCaptureGateway();
  try {
    const child = spawn(args.binary, [], {
      env: { ...isolatedHarnessEnv(args.configRoot), ANTHROPIC_BASE_URL: gateway.url },
      stdio: 'inherit',
    });
    const exitCode = await new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? 1));
    });
    const evidence = summarizeEvidence(gateway.requests);
    // 'pending', not 'failed': the probe was not actually run against the real proof it needs.
    // No harness-specific extractor is wired to attach an EntropyProof / OpencodeHookEvidence /
    // CodexHookEvidence to this evidence, so nothing here has been proven false -- it has simply
    // not been checked. Reporting 'failed' would be a false claim of a completed, failing probe.
    process.stderr.write(
      `probe ${args.probe} for ${args.client}: exitCode=${exitCode} evidence=${JSON.stringify(evidence)}\n` +
        'result: pending -- no harness-specific proof extractor wired for this client/probe; ' +
        'a real verdict requires attaching manually reviewed proof (EntropyProof / ' +
        'OpencodeHookEvidence / CodexHookEvidence) to this evidence before promoting or failing any fixture.\n',
    );
  } finally {
    await gateway.close();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
