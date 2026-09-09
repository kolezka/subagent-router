// Sanitized, synthetic builder for a native-claude-handler.ts probe run capture directory.
// Writes the same file shapes native-claude-handler.ts writes to `capture/` (see its `rec()`
// helper): NNN-profile.json (+ optional NNN-profile-scaffold.json sibling), a `client-version`
// file, one NNN-pre-handler.json / (NNN+1)-post-handler-upstream.json pair, and an optional
// hook-subagentstart-*.json. Block 0 is built from tests/support/native-layout.ts's small
// stand-in scaffold, never the real ~27KB captured context. Each knob below flips exactly one
// M3APairEvidence boolean false, for negative-test construction; all knobs default to the
// "everything genuine" shape.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeContextBlockV1, nativeLayoutUserMessage } from './native-layout';

export function syntheticMarkerLine(alias: string): string {
  return `<subagent-router v="1" model="${alias}"/>`;
}

// The declared-override set that exactly matches the default profile built below relative to
// the real claude-code-2.1.266.json fixture: status, the two overridden probes, all five
// lifecycle phases (via the wildcard), and the alternate-layout position flag.
export const DEFAULT_SCAFFOLD_OVERRIDDEN_PATHS: readonly string[] = ['status', 'probes.M10', 'probes.M3-A', 'lifecycle.*', 'parentPromptPosition'];

export interface SyntheticRunCaptureOptions {
  // Client version carried by the profile, the client-version file and (unless userAgentVersion
  // overrides it) the pre-handler request's user-agent header. Default '2.1.266'.
  clientVersion?: string;
  alias?: string;
  agentId?: string;
  agentType?: string;
  // false: write no NNN-pre-handler.json / post-handler-upstream.json pair at all -- exercises
  // the "no child pairs" path.
  includePair?: boolean;
  // false: omit the NNN-profile-scaffold.json sibling entirely.
  includeScaffoldManifest?: boolean;
  // Overrides the manifest's declared paths. Defaults to DEFAULT_SCAFFOLD_OVERRIDDEN_PATHS.
  scaffoldOverriddenPaths?: readonly string[];
  // false: omit the hook-subagentstart-*.json record for this agent id.
  includeHookRecord?: boolean;
  // true: mutates block 0 on the upstream (post) request only, so it no longer byte-matches
  // the pre-handler block 0.
  mutateBlock0Upstream?: boolean;
  // true: block 0 is plain text that does not satisfy isNativeContextScaffoldV1.
  useNonScaffoldBlock0?: boolean;
  // true: block 1 carries no marker line at all on either side of the pair.
  omitMarkerOnBlock1?: boolean;
  // true: the upstream (post) request still carries the marker line on block 1 (never stripped).
  leaveMarkerUpstream?: boolean;
  // Overrides the version reported in the pre-handler request's user-agent header, independent
  // of clientVersion/profile.version, to create a mismatch.
  userAgentVersion?: string;
  // Shallow-merged over the built profile object, applied last (so e.g. { version:
  // 'synthetic-hermetic' } overrides the profile's own version field).
  profilePatch?: Record<string, unknown>;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeSyntheticRunCapture(runDir: string, options: SyntheticRunCaptureOptions = {}): Promise<void> {
  const clientVersion = options.clientVersion ?? '2.1.266';
  const alias = options.alias ?? 'fast';
  const agentId = options.agentId ?? 'agent-synthetic-1';
  const agentType = options.agentType ?? 'native-probe-alpha';
  const captureDir = join(runDir, 'capture');
  await mkdir(captureDir, { recursive: true });

  const profile: Record<string, unknown> = {
    client: 'claude-code',
    version: clientVersion,
    status: 'supported',
    correlation: false,
    correlationEntropy: 'pending',
    fork: false,
    adapterMarkerPosition: 'unknown',
    probes: { M10: 'passed', 'M3-A': 'passed' },
    lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' },
    parentPromptPosition: 'after-native-context-v1',
    ...options.profilePatch,
  };
  await writeJson(join(captureDir, '001-profile.json'), profile);

  if (options.includeScaffoldManifest !== false) {
    const manifest = { overriddenPaths: options.scaffoldOverriddenPaths ?? DEFAULT_SCAFFOLD_OVERRIDDEN_PATHS };
    await writeJson(join(captureDir, '001-profile-scaffold.json'), manifest);
  }

  await writeFile(join(captureDir, 'client-version'), clientVersion, 'utf8');

  if (options.includePair === false) return;

  const block0 = options.useNonScaffoldBlock0 === true ? 'plain non-scaffold prefix text, no system-reminder wrapper' : nativeContextBlockV1();
  const promptLine = 'do the synthetic probe task';
  const preBlock1 = options.omitMarkerOnBlock1 === true ? promptLine : `${syntheticMarkerLine(alias)}\n${promptLine}`;
  const postBlock1 = options.leaveMarkerUpstream === true ? preBlock1 : promptLine;
  const postBlock0 = options.mutateBlock0Upstream === true ? `${block0}\nMUTATED-BETWEEN-PRE-AND-POST` : block0;

  const userAgentVersion = options.userAgentVersion ?? clientVersion;
  const preHeaders: Record<string, string> = {
    'user-agent': `claude-cli/${userAgentVersion} (external, sdk-cli)`,
    'x-claude-code-agent-id': agentId,
  };
  const preBody = { model: 'probe-parent-model', messages: [nativeLayoutUserMessage(preBlock1, block0)] };
  await writeJson(join(captureDir, '002-pre-handler.json'), { url: '/v1/messages', headers: preHeaders, body: preBody });

  const postHeaders: Record<string, string> = {
    'user-agent': 'stainless-node/1',
    'x-claude-code-agent-id': agentId,
  };
  const postBody = { model: 'gateway/fast-worker', messages: [nativeLayoutUserMessage(postBlock1, postBlock0)] };
  await writeJson(join(captureDir, '003-post-handler-upstream.json'), { url: 'http://127.0.0.1:1/v1/messages', headers: postHeaders, body: postBody });

  if (options.includeHookRecord !== false) {
    const hook = {
      session_id: 'synthetic-session',
      transcript_path: '/tmp/synthetic-run/synthetic.jsonl',
      cwd: '/tmp/synthetic-run/work',
      prompt_id: 'synthetic-prompt',
      agent_id: agentId,
      agent_type: agentType,
      hook_event_name: 'SubagentStart',
    };
    await writeJson(join(captureDir, 'hook-subagentstart-1.json'), hook);
  }
}
