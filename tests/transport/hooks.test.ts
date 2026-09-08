import { describe, expect, test } from 'bun:test';
import { parseMarker } from '../../src/adapters/markers';
import { createClaudeStartOutput } from '../../src/transport/hooks';
import type { CapabilityProfile } from '../../src/core/types';
import { configFixture } from '../support/fixtures';

const markerProfile: CapabilityProfile = { client: 'claude-code', version: '2.1.263', status: 'supported', correlation: false, correlationEntropy: 'pending', fork: false, adapterMarkerPosition: 'system', probes: { M3: 'passed', M10: 'passed', 'M10-freshness': 'passed' }, lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' } };

describe('createClaudeStartOutput', () => {
  test('zwraca additionalContext z markerem adaptera dla roli znanej w konfiguracji', async () => {
    const output = await createClaudeStartOutput({ agent_id: 'agent-1', agent_type: 'explorer' }, { secret: 'test-secret', roles: configFixture().roles, profile: markerProfile, fresh: true });
    const context = (output.hookSpecificOutput as { hookEventName: string; additionalContext: string });
    expect(context.hookEventName).toBe('SubagentStart');
    const marker = parseMarker(context.additionalContext.split('\n')[0] ?? '');
    expect(marker).toMatchObject({ kind: 'adapter', role: 'explorer', agent: 'agent-1' });
    expect(context.additionalContext).not.toContain('test-secret');
  });

  test('rola bez trasy nie wstrzykuje markera', async () => {
    const output = await createClaudeStartOutput({ agent_id: 'agent-1', agent_type: 'unknown-role' }, { secret: 'test-secret', roles: configFixture().roles, profile: markerProfile, fresh: true });
    expect(output).toEqual({});
  });

  test('profil bez M3 albo M10-freshness nie otwiera kanału B', async () => {
    const profile = { ...markerProfile, probes: { M3: 'pending' as const, M10: 'passed' as const, 'M10-freshness': 'pending' as const } };
    const output = await createClaudeStartOutput({ agent_id: 'agent-1', agent_type: 'explorer' }, { secret: 'test-secret', roles: configFixture().roles, profile, fresh: false });
    expect(output).toEqual({});
  });
});
