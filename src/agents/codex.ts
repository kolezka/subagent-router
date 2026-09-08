import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentDefinition, ResolverOptions } from '../core/types';
import { RouterError } from '../core/errors';

// Reads one directory of `*.toml` role files. A missing directory yields no entries
// (that root simply was not configured); any other filesystem failure propagates.
async function listTomlAgents(dir: string, scope: string): Promise<AgentDefinition[]> {
  let filenames: string[];
  try {
    filenames = (await readdir(dir)).filter((name) => name.endsWith('.toml'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const definitions: AgentDefinition[] = [];
  for (const filename of filenames.sort()) {
    const path = join(dir, filename);
    const text = await readFile(path, 'utf8');
    let parsed: unknown;
    try {
      parsed = Bun.TOML.parse(text);
    } catch (error) {
      throw new RouterError('agent-file-malformed', `${path}: invalid TOML (${(error as Error).message})`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new RouterError('agent-file-malformed', `${path}: must be a TOML table`);
    }
    const native = parsed as Record<string, unknown>;
    const declaredModel = typeof native.model === 'string' ? native.model : undefined;
    definitions.push({
      client: 'codex',
      name: typeof native.name === 'string' && native.name.length > 0 ? native.name : filename.slice(0, -5),
      scope,
      path,
      ...(declaredModel !== undefined ? { declaredModel } : {}),
      hidden: native.hidden === true,
      native,
      availability: 'available',
      shadowed: false,
    });
  }
  return definitions;
}

// Root order, first wins (later roots become `shadowed: true` in inventory.ts):
//   1. cwd/.codex/agents/*.toml      (scope 'project')
//   2. home/.codex/agents/*.toml     (scope 'user')
//   3. additionalRoots, as given     (scope 'additional')
// Per the task brief, Codex has only these two role directories (no configRoot/env
// override distinct from `.codex` itself). This order is Task 6's declaration for
// Task 7's M-probe to confirm, not a verified fact about Codex's own resolver.
//
// Exported so export.ts's native-root protection can compute the same candidate
// directories without duplicating this recipe -- see inventory.ts's candidateAgentRoots.
export function codexAgentRoots(options: ResolverOptions): Array<{ dir: string; scope: string }> {
  return [
    { dir: join(options.cwd, '.codex', 'agents'), scope: 'project' },
    { dir: join(options.home, '.codex', 'agents'), scope: 'user' },
    ...options.additionalRoots.map((dir) => ({ dir, scope: 'additional' })),
  ];
}

export async function readCodexAgents(options: ResolverOptions): Promise<AgentDefinition[]> {
  const definitions: AgentDefinition[] = [];
  for (const root of codexAgentRoots(options)) {
    definitions.push(...(await listTomlAgents(root.dir, root.scope)));
  }
  return definitions;
}
