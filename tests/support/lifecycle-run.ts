import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LifecyclePhase } from '../../src/core/types';
import { writeSyntheticRunCapture } from './native-run-capture';
import { COMPACTION_SUMMARY_PREFIX } from '../probes/evidence-m10';

// Test-only captures with explicit expected models, parent control and a same-child boundary.
export async function writeSyntheticLifecycleRun(runDir: string, phase: LifecyclePhase): Promise<void> {
  await writeSyntheticRunCapture(runDir, { agentId: 'agent-a' });
  const dir = join(runDir, 'capture');
  const originalPre = JSON.parse(await readFile(join(dir, '002-pre-handler.json'), 'utf8'));
  const originalPost = JSON.parse(await readFile(join(dir, '003-post-handler-upstream.json'), 'utf8'));
  const write = (name: string, value: unknown) => writeFile(join(dir, name), JSON.stringify(value));
  for (const seq of [2, 4, 6, 8]) {
    const pre = structuredClone(originalPre);
    const post = structuredClone(originalPost);
    const beta = seq === 4 || seq === 8;
    pre.headers['x-claude-code-agent-id'] = beta ? 'agent-b' : 'agent-a';
    post.headers['x-claude-code-agent-id'] = pre.headers['x-claude-code-agent-id'];
    post.body.model = beta ? 'gateway/smart-worker' : 'gateway/fast-worker';
    pre.captureRequestId = `request-${seq}`;
    post.captureRequestId = `request-${seq}`;
    if (beta && phase === 'nested') pre.headers['x-claude-code-parent-agent-id'] = 'agent-a';
    if (seq >= 6 && phase === 'compaction') {
      pre.body.messages = [{ role: 'user', content: `${COMPACTION_SUMMARY_PREFIX}\nSynthetic summary.` }];
      post.body.messages = structuredClone(pre.body.messages);
    }
    await write(`${String(seq).padStart(3, '0')}-pre-handler.json`, pre);
    await write(`${String(seq + 1).padStart(3, '0')}-post-handler-upstream.json`, post);
  }
  const parent = {
    url: '/v1/messages',
    headers: {},
    captureRequestId: 'parent-request',
    body: {
      model: 'probe-parent-model',
      messages: phase === 'resume'
        ? [{ role: 'assistant', content: [
            { type: 'tool_use', id: 'toolu-resume-a', name: 'SendMessage', input: { to: 'agent-a', message: 'continue' } },
            { type: 'tool_use', id: 'toolu-resume-b', name: 'SendMessage', input: { to: 'agent-b', message: 'continue' } },
          ] }]
        : [{ role: 'user', content: 'parent control' }],
    },
  };
  await write('010-pre-handler.json', parent);
  await write('011-post-handler-upstream.json', parent);
  await write('hook-subagentstart-2.json', { agent_id: 'agent-b', agent_type: 'native-probe-beta', hook_event_name: 'SubagentStart' });
  await write('000-run-manifest.json', {
    mode: phase,
    phasesExercised: [phase],
    correlationScaffold: false,
    resumeStrategy: phase === 'resume' ? 'message-existing' : 'unknown',
  });
  if (phase === 'resume') await write('invocation-boundary.json', { afterSeq: 5 });
  await write('route-expectations.json', { client: 'claude-code', version: '2.1.266', parentModel: 'probe-parent-model', childModelsByType: { 'native-probe-alpha': 'gateway/fast-worker', 'native-probe-beta': 'gateway/smart-worker' } });
  const completion = { subtype: 'success', is_error: false, result: 'PARENT_FINAL_OK', session_id: 'synthetic-parent-session' };
  await writeFile(join(runDir, 'cli-exit-status'), '0\n');
  await writeFile(join(runDir, 'cli-stdout.json'), JSON.stringify(completion));
  if (phase === 'resume') {
    await writeFile(join(runDir, 'cli2-exit-status'), '0\n');
    await writeFile(join(runDir, 'cli2-stdout.json'), JSON.stringify(completion));
  }
}
