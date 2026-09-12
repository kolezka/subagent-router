import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunCapture } from './evidence-m3a';
import type { ProbeResult } from '../../src/core/types';

export interface RoutingJudgement {
  result: ProbeResult;
  diagnostic?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isMessagesEndpointUrl(url: string): boolean {
  return new URL(url, 'http://probe.invalid').pathname === '/v1/messages';
}

// Expectations come from the fixture's configured targets, never from the observed upstream.
export async function judgeRouting(capture: RunCapture): Promise<RoutingJudgement> {
  if ((capture.invalidEvidence?.length ?? 0) > 0) return { result: 'pending', diagnostic: 'routing-capture-pairing-invalid' };
  const dir = join(capture.runDir, 'capture');
  let expected: unknown;
  try {
    expected = JSON.parse(await readFile(join(dir, 'route-expectations.json'), 'utf8'));
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { result: 'pending', diagnostic: 'routing-expectations-missing' };
    throw error;
  }
  if (!isRecord(expected) || expected.client !== capture.profileRaw.client || expected.version !== capture.clientVersionFile ||
      typeof expected.parentModel !== 'string' || expected.parentModel.length === 0 || !isRecord(expected.childModelsByType)) {
    return { result: 'pending', diagnostic: 'routing-expectations-invalid: expected targets must name this run\'s client and version' };
  }
  const models = expected.childModelsByType;
  if (!Object.values(models).every((model) => typeof model === 'string' && model.length > 0)) {
    return { result: 'pending', diagnostic: 'routing-expectations-invalid: child targets must be nonempty model ids' };
  }
  const types = new Map<string, string>();
  for (const file of await readdir(dir)) {
    if (!file.startsWith('hook-subagentstart-') || !file.endsWith('.json')) continue;
    const hook: unknown = JSON.parse(await readFile(join(dir, file), 'utf8'));
    if (isRecord(hook) && hook.hook_event_name === 'SubagentStart' && typeof hook.agent_id === 'string' && typeof hook.agent_type === 'string') {
      const previous = types.get(hook.agent_id);
      if (previous !== undefined && previous !== hook.agent_type) return { result: 'failed', diagnostic: 'routing-conflicting-child-type' };
      types.set(hook.agent_id, hook.agent_type);
    }
  }

  if (capture.unforwarded.some((entry) => isMessagesEndpointUrl(entry.pre.url))) {
    return { result: 'failed', diagnostic: 'routing-request-not-forwarded' };
  }
  let parents = 0;
  const children = new Set<string>();
  const observedTypes = new Set<string>();
  for (const pair of capture.pairs) {
    if (!isMessagesEndpointUrl(pair.pre.url)) continue;
    if (pair.agentId === undefined) {
      if (pair.pre.body.model !== expected.parentModel || pair.post.body.model !== expected.parentModel) {
        return { result: 'failed', diagnostic: `routing-parent-model-changed: sequence ${pair.seq}` };
      }
      parents++;
      continue;
    }
    const agentType = types.get(pair.agentId);
    const target = agentType === undefined ? undefined : models[agentType];
    if (target === undefined) return { result: 'pending', diagnostic: `routing-child-expectation-missing: sequence ${pair.seq}` };
    if (pair.post.body.model !== target) return { result: 'failed', diagnostic: `routing-child-model-mismatch: sequence ${pair.seq}` };
    children.add(pair.agentId);
    observedTypes.add(agentType!);
  }
  if (parents === 0 || children.size < 2 || observedTypes.size < 2 || new Set([...observedTypes].map((type) => models[type])).size < 2) {
    return { result: 'pending', diagnostic: 'routing-controls-incomplete: need a parent and distinct child model targets' };
  }
  return { result: 'passed' };
}
