import { describe, expect, test } from 'bun:test';
import { escapeControl, render } from '../../src/cli/output';
import type { CliDeps } from '../../src/core/types';

describe('escapeControl', () => {
  test('replaces ESC (the byte that starts every ANSI/CSI sequence) with its \\uXXXX form', () => {
    expect(escapeControl('a\x1b[31mb')).toBe('a\\u001b[31mb');
  });

  test('replaces a C0 control character (newline)', () => {
    expect(escapeControl('a\nb')).toBe('a\\u000ab');
  });

  test('replaces DEL (0x7F)', () => {
    expect(escapeControl('a\x7fb')).toBe('a\\u007fb');
  });

  test('leaves ordinary text, including non-ASCII, untouched', () => {
    expect(escapeControl('Szybkie zadania. 日本語')).toBe('Szybkie zadania. 日本語');
  });
});

function deps(patch: Partial<CliDeps> = {}): CliDeps {
  return {
    cwd: '/tmp',
    home: '/tmp/home',
    env: {},
    stdout: () => {},
    stderr: () => {},
    isTTY: false,
    fetch: async () => {
      throw new Error('unused');
    },
    fetchAdapter: { id: 'fixture', runtimeVersion: '0' },
    loadProfile: async () => {
      throw new Error('unused');
    },
    loadTransportProfile: async () => {
      throw new Error('unused');
    },
    now: () => new Date(0),
    ...patch,
  };
}

describe('render', () => {
  test('json:true writes JSON.stringify(payload) plus a trailing newline, never calling human()', () => {
    const out: string[] = [];
    let humanCalled = false;
    render(
      deps({ stdout: (t) => out.push(t) }),
      { a: 1 },
      () => {
        humanCalled = true;
        return 'human text';
      },
      true,
    );
    expect(out).toEqual(['{"a":1}\n']);
    expect(humanCalled).toBe(false);
  });

  test('json:false writes exactly what human() returns, ignoring the payload', () => {
    const out: string[] = [];
    render(deps({ stdout: (t) => out.push(t) }), { a: 1 }, () => 'human text\n', false);
    expect(out).toEqual(['human text\n']);
  });
});
