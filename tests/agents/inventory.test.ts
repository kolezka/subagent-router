import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAgent, readAgentInventory } from '../../src/agents/inventory';
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
