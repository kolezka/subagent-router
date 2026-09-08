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

  test('covers the whole C0 range, ESC and DEL, and nothing printable', () => {
    for (let code = 0; code < 0x20; code += 1) {
      expect(escapeControl(String.fromCharCode(code))).toBe(`\\u${code.toString(16).padStart(4, '0')}`);
    }
    expect(escapeControl('\x7f')).toBe('\\u007f');
    for (let code = 0x20; code < 0x7f; code += 1) {
      expect(escapeControl(String.fromCharCode(code))).toBe(String.fromCharCode(code));
    }
  });

  test('the regex source is written with escape text, never raw control bytes', async () => {
    // Raw NUL/US/DEL bytes inside a regex literal are invisible in most editors and silently
    // dropped or rewritten by some encoders; the pattern must be expressed as \x escapes.
    const source = await Bun.file(new URL('../../src/cli/output.ts', import.meta.url)).text();
    // eslint-disable-next-line no-control-regex
    expect(source).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
    expect(source).toContain('\\x00-\\x1f\\x7f');
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
