import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../../src/cli/args';

describe('parseArgs', () => {
  test('splits the first two positionals into command, keeps the rest as positionals', () => {
    const parsed = parseArgs(['models', 'show', 'fast', '--json']);
    expect(parsed.command).toEqual(['models', 'show']);
    expect(parsed.positionals).toEqual(['fast']);
    expect(parsed.options.json).toBe(true);
  });

  test('a single-word command (doctor) is not padded with an empty second element', () => {
    const parsed = parseArgs(['doctor', '--json']);
    expect(parsed.command).toEqual(['doctor']);
    expect(parsed.positionals).toEqual([]);
  });

  test('repeated --agents-dir is lifted into additionalRoots, not into options', () => {
    const parsed = parseArgs(['agents', 'list', '--client', 'claude-code', '--agents-dir', '/a', '--agents-dir', '/b']);
    expect(parsed.additionalRoots).toEqual(['/a', '/b']);
    expect(parsed.options['agents-dir']).toBeUndefined();
    expect(parsed.options.client).toBe('claude-code');
  });

  test('an unknown flag is rejected (strict), never silently ignored', () => {
    expect(() => parseArgs(['models', 'list', '--typo'])).toThrow();
  });

  test('--no-color and --json parse as booleans', () => {
    const parsed = parseArgs(['config', 'show', '--no-color', '--json']);
    expect(parsed.options['no-color']).toBe(true);
    expect(parsed.options.json).toBe(true);
  });
});
