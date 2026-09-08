import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAgent, readAgentInventory } from '../../src/agents/inventory';
import { parseAgentMarkdown } from '../../src/agents/claude-code';
import { RouterError } from '../../src/core/errors';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'agents');

async function treeHash(root: string): Promise<string> {
  const hash = createHash('sha256');
  // node's readdir(recursive) does not guarantee a stable traversal order, so paths
  // are sorted before hashing; otherwise this hash would flap across runs even with
  // zero file changes and mask real mutations as "just reordered".
  const entries = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();
  for (const path of entries) {
    hash.update(path).update(await readFile(path));
  }
  return hash.digest('hex');
}

describe('readAgentInventory claude-code', () => {
  const options = {
    cwd: join(FIXTURES, 'claude-code', 'project'),
    home: join(FIXTURES, 'claude-code', 'home'),
    env: {},
    additionalRoots: [],
  };

  test('wpis projektowy przesłania domowy, a inherit jest zachowane w declaredModel', async () => {
    const inventory = await readAgentInventory('claude-code', options);
    const reviewer = getAgent(inventory, 'reviewer');
    expect(reviewer.declaredModel).toBe('sonnet');
    expect(reviewer.scope).toBe('project');
    const shadowed = inventory.entries.filter((e) => e.name === 'reviewer' && e.shadowed);
    expect(shadowed.map((e) => e.declaredModel)).toEqual(['inherit']);
    expect(inventory.completeness).toBe('files-only');
  });

  test('nazwa efektywna pochodzi z frontmatteru, nie z nazwy pliku', async () => {
    const inventory = await readAgentInventory('claude-code', options);
    expect(getAgent(inventory, 'file-explorer').path?.endsWith('explorer.md')).toBe(true);
    expect(() => getAgent(inventory, 'explorer')).toThrow(RouterError);
  });

  test('CLAUDE_CONFIG_DIR zastępuje katalog domowy', async () => {
    const inventory = await readAgentInventory('claude-code', { ...options, env: { CLAUDE_CONFIG_DIR: join(FIXTURES, 'empty-config') } });
    expect(inventory.entries.some((e) => e.name === 'file-explorer')).toBe(false);
  });

  test('nativeInventory dodaje role fileless bez usuwania plików', async () => {
    const native = { entries: [{ client: 'claude-code' as const, name: 'Explore', scope: 'builtin', hidden: false, native: {}, availability: 'fileless' as const, shadowed: false }], completeness: 'native' as const, diagnostics: [] };
    const inventory = await readAgentInventory('claude-code', { ...options, nativeInventory: native });
    expect(inventory.completeness).toBe('native');
    expect(getAgent(inventory, 'Explore').availability).toBe('fileless');
    expect(getAgent(inventory, 'reviewer').availability).toBe('available');
  });

  test('odczyt nie zmienia żadnego pliku fixture', async () => {
    const before = await treeHash(FIXTURES);
    await readAgentInventory('claude-code', options);
    await readAgentInventory('opencode', { ...options, cwd: join(FIXTURES, 'opencode', 'project'), home: join(FIXTURES, 'opencode', 'home') });
    await readAgentInventory('codex', { ...options, cwd: join(FIXTURES, 'codex', 'project'), home: join(FIXTURES, 'codex', 'home') });
    expect(await treeHash(FIXTURES)).toBe(before);
  });
});

describe('readAgentInventory opencode i codex', () => {
  test('plik Markdown przesłania blok agent z opencode.json i zachowuje hidden', async () => {
    const inventory = await readAgentInventory('opencode', { cwd: join(FIXTURES, 'opencode', 'project'), home: join(FIXTURES, 'opencode', 'home'), env: {}, additionalRoots: [] });
    const planner = getAgent(inventory, 'planner');
    expect(planner.declaredModel).toBe('gateway/from-file');
    expect(inventory.entries.find((e) => e.name === 'planner' && e.shadowed)?.hidden).toBe(true);
  });

  test('rola Codex z TOML ma model i ścieżkę', async () => {
    const inventory = await readAgentInventory('codex', { cwd: join(FIXTURES, 'codex', 'project'), home: join(FIXTURES, 'codex', 'home'), env: {}, additionalRoots: [] });
    expect(getAgent(inventory, 'reviewer').declaredModel).toBe('gateway/base');
  });

  test('additionalRoots jest tylko dodatkowym źródłem odczytu', async () => {
    const inventory = await readAgentInventory('codex', { cwd: join(FIXTURES, 'empty-config'), home: join(FIXTURES, 'empty-config'), env: {}, additionalRoots: [join(FIXTURES, 'codex', 'home', '.codex', 'agents')] });
    expect(getAgent(inventory, 'reviewer').scope).toBe('additional');
  });
});

describe('readAgentInventory nativeInventory merge integrity', () => {
  const options = {
    cwd: join(FIXTURES, 'claude-code', 'project'),
    home: join(FIXTURES, 'claude-code', 'home'),
    env: {},
    additionalRoots: [],
  };

  test('nativeInventory z completeness files-only nie może promować wyniku do native', async () => {
    const filesOnlyNative = {
      entries: [{ client: 'claude-code' as const, name: 'Explore', scope: 'builtin', hidden: false, native: {}, availability: 'fileless' as const, shadowed: false }],
      completeness: 'files-only' as const,
      diagnostics: [],
    };
    const inventory = await readAgentInventory('claude-code', { ...options, nativeInventory: filesOnlyNative });
    expect(inventory.completeness).toBe('files-only');
    expect(inventory.entries.some((e) => e.name === 'Explore')).toBe(false);
  });

  test('native entry innego klienta nie przecieka do wyniku', async () => {
    const native = {
      entries: [{ client: 'opencode' as const, name: 'planner', scope: 'builtin', hidden: false, native: {}, availability: 'available' as const, shadowed: false }],
      completeness: 'native' as const,
      diagnostics: [],
    };
    const inventory = await readAgentInventory('claude-code', { ...options, nativeInventory: native });
    expect(inventory.entries.some((e) => e.name === 'planner')).toBe(false);
  });

  test('native entry z tą samą nazwą co plik jest autorytatywny, plik zostaje shadowed z prawdziwym declaredModel', async () => {
    const native = {
      entries: [{ client: 'claude-code' as const, name: 'reviewer', scope: 'builtin', hidden: false, native: {}, declaredModel: 'opus', availability: 'available' as const, shadowed: false }],
      completeness: 'native' as const,
      diagnostics: [],
    };
    const inventory = await readAgentInventory('claude-code', { ...options, nativeInventory: native });
    const reviewer = getAgent(inventory, 'reviewer');
    expect(reviewer.declaredModel).toBe('opus');
    expect(reviewer.availability).toBe('available');
    const shadowedFileEntries = inventory.entries.filter((e) => e.name === 'reviewer' && e.shadowed);
    expect(shadowedFileEntries.map((e) => e.declaredModel).sort()).toEqual(['inherit', 'sonnet']);
  });

  test('native entry bez pliku jest wymuszony na fileless niezależnie od availability przekazanej przez wywołującego', async () => {
    const native = {
      entries: [{ client: 'claude-code' as const, name: 'ghost', scope: 'builtin', hidden: false, native: {}, availability: 'available' as const, shadowed: false }],
      completeness: 'native' as const,
      diagnostics: [],
    };
    const inventory = await readAgentInventory('claude-code', { ...options, nativeInventory: native });
    expect(getAgent(inventory, 'ghost').availability).toBe('fileless');
  });
});

describe('body and parser errors do not modify or leak source content', () => {
  test('body preserves CRLF and blank lines exactly as in the file', async () => {
    // Expected body is the fixture's literal tail, typed independently of the parser.
    const inventory = await readAgentInventory('claude-code', {
      cwd: join(FIXTURES, 'claude-code', 'project'),
      home: join(FIXTURES, 'claude-code', 'home'),
      env: {},
      additionalRoots: [],
    });
    const agent = getAgent(inventory, 'crlf-agent');
    expect(agent.body).toBe('\r\n\r\nLinia z pustymi liniami przed.\r\nDruga linia.\r\n');
  });

  test('malformed YAML frontmatter error does not leak file contents (sentinel secret)', async () => {
    const options = {
      cwd: join(FIXTURES, 'claude-code', 'malformed'),
      home: join(FIXTURES, 'claude-code', 'malformed'),
      env: {},
      additionalRoots: [],
    };
    let caught: unknown;
    try {
      await readAgentInventory('claude-code', options);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RouterError);
    const message = (caught as RouterError).message;
    expect(message.includes('SENTINEL_YAML_9f3a')).toBe(false);
    expect(message).toContain('broken.md');
  });

  test('YAML parse error does not leak the underlying parser exception message (fault injection)', async () => {
    // The fixture test above passing is not proof this path is safe, since Bun.YAML.parse may
    // just never echo source text. This forces a sentinel-bearing error to prove the catch
    // itself never forwards the parser's message.
    const original = Bun.YAML.parse;
    let caught: unknown;
    try {
      Bun.YAML.parse = () => {
        throw new Error('SENTINEL_YAML_FAULT_8c21');
      };
      parseAgentMarkdown('---\nname: x\n---\nbody', '/fake/agent.md');
    } catch (error) {
      caught = error;
    } finally {
      Bun.YAML.parse = original;
    }
    expect(caught).toBeInstanceOf(RouterError);
    expect((caught as RouterError).message.includes('SENTINEL_YAML_FAULT_8c21')).toBe(false);
  });

  test('malformed opencode.json error does not leak file contents (sentinel secret)', async () => {
    let caught: unknown;
    try {
      await readAgentInventory('opencode', {
        cwd: join(FIXTURES, 'opencode', 'malformed'),
        home: join(FIXTURES, 'opencode', 'malformed'),
        env: {},
        additionalRoots: [],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RouterError);
    const message = (caught as RouterError).message;
    expect(message.includes('SENTINEL_JSON_7d2c')).toBe(false);
    expect(message).toContain('opencode.json');
  });

  test('malformed TOML error does not leak file contents (sentinel secret)', async () => {
    let caught: unknown;
    try {
      await readAgentInventory('codex', {
        cwd: join(FIXTURES, 'codex', 'malformed'),
        home: join(FIXTURES, 'codex', 'malformed'),
        env: {},
        additionalRoots: [],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RouterError);
    const message = (caught as RouterError).message;
    expect(message.includes('SENTINEL_TOML_4a1b')).toBe(false);
    expect(message).toContain('broken.toml');
  });
});

describe('parseAgentMarkdown boundaries', () => {
  test('LF body with leading blank lines is preserved exactly', () => {
    const { body } = parseAgentMarkdown('---\nname: x\n---\n\n\nBody line\n', '/fake/agent.md');
    expect(body).toBe('\n\nBody line\n');
  });

  test('closing delimiter at EOF (no trailing newline) yields an empty body', () => {
    const { body } = parseAgentMarkdown('---\nname: x\n---', '/fake/agent.md');
    expect(body).toBe('');
  });

  test('a newline right after the closing delimiter with nothing after it yields an empty body', () => {
    const { body } = parseAgentMarkdown('---\nname: x\n---\n', '/fake/agent.md');
    expect(body).toBe('');
  });

  test('no frontmatter passes the text through unchanged', () => {
    const text = 'no frontmatter\njust plain text\n';
    const { native, body } = parseAgentMarkdown(text, '/fake/agent.md');
    expect(native).toEqual({});
    expect(body).toBe(text);
  });
});
