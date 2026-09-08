// Second traversal layer, independent of any adapter's name rule: every planned export path must
// stay strictly under the client target directory or the plan is invalid. Exercised directly
// because once the adapters validate their names, no public CLI path reaches this guard.
import { describe, expect, test } from 'bun:test';
import { assertPlanPathContained } from '../../src/agents/export';

const target = '/tmp/export-target/opencode';

describe('assertPlanPathContained', () => {
  test('accepts a plain nested path and returns it relative to the client dir', () => {
    expect(assertPlanPathContained(target, 'opencode', 'opencode/agents/reviewer@fast.md')).toBe('agents/reviewer@fast.md');
    expect(assertPlanPathContained(target, 'opencode', 'opencode/sidecar.json')).toBe('sidecar.json');
  });

  test('rejects a path that is not rooted under the client dir', () => {
    expect(() => assertPlanPathContained(target, 'opencode', 'codex/sidecar.json')).toThrow('export-plan-invariant');
    expect(() => assertPlanPathContained(target, 'opencode', 'opencodex/sidecar.json')).toThrow('export-plan-invariant');
    expect(() => assertPlanPathContained(target, 'opencode', 'opencode')).toThrow('export-plan-invariant');
  });

  test('rejects .. segments, . segments, empty segments, absolute paths and backslashes', () => {
    expect(() => assertPlanPathContained(target, 'opencode', 'opencode/agents/../../../home/x.md')).toThrow('export-plan-invariant');
    expect(() => assertPlanPathContained(target, 'opencode', 'opencode/agents/./x.md')).toThrow('export-plan-invariant');
    expect(() => assertPlanPathContained(target, 'opencode', 'opencode/agents//x.md')).toThrow('export-plan-invariant');
    expect(() => assertPlanPathContained(target, 'opencode', 'opencode//etc/passwd')).toThrow('export-plan-invariant');
    expect(() => assertPlanPathContained(target, 'opencode', 'opencode/agents\\..\\x.md')).toThrow('export-plan-invariant');
    expect(() => assertPlanPathContained(target, 'opencode', 'opencode/')).toThrow('export-plan-invariant');
  });
});
