import { describe, expect, test } from 'bun:test';
import { CorrelationStore } from '../../src/adapters/correlation';

describe('CorrelationStore', () => {
  test('wpis wygasa po ttl liczonym od ostatniego użycia', () => {
    let clock = 0;
    const store = new CorrelationStore(() => clock, 1000);
    store.bind('agent-1', 'gateway/a');
    clock = 900;
    expect(store.get('agent-1')).toBe('gateway/a');
    clock = 1800;
    expect(store.get('agent-1')).toBe('gateway/a');
    clock = 2900;
    expect(store.get('agent-1')).toBeUndefined();
  });

  test('różne identyfikatory nie dzielą decyzji', () => {
    const store = new CorrelationStore(() => 0, 1000);
    store.bind('agent-1', 'gateway/a');
    expect(store.get('agent-2')).toBeUndefined();
  });

  test('conflicting-binding-never-reroutes', () => {
    const store = new CorrelationStore(() => 0, 1000);
    store.bind('agent-1', 'gateway/a');
    expect(() => store.bind('agent-1', 'gateway/b')).toThrow('correlation-conflict');
    expect(store.get('agent-1')).toBe('gateway/a');
  });
});
