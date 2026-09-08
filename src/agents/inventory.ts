import type { AgentDefinition, AgentInventory, ClientId, ResolverOptions } from '../core/types';
import { RouterError } from '../core/errors';
import { claudeCodeAgentRoots, readClaudeAgents } from './claude-code';
import { opencodeAgentRoots, readOpencodeAgents } from './opencode';
import { codexAgentRoots, readCodexAgents } from './codex';

// Every directory a given client's file scanner would consult for agent definitions, in the
// same root order each reader uses -- computed without touching the filesystem, so a caller can
// protect a root that holds no files (or does not exist) yet. Scope is dropped since callers
// (export.ts's native-root protection) only need the directory itself, and this must stay in
// lockstep with claude-code.ts/opencode.ts/codex.ts's own root recipes, never a separate copy of
// them, so the two can never drift apart.
export function candidateAgentRoots(client: ClientId, options: ResolverOptions): string[] {
  switch (client) {
    case 'claude-code':
      return claudeCodeAgentRoots(options).map((root) => root.dir);
    case 'opencode':
      return opencodeAgentRoots(options).map((root) => root.dir);
    case 'codex':
      return codexAgentRoots(options).map((root) => root.dir);
  }
}

// Scan is `files-only` unless the caller passes `nativeInventory`; the file scan never
// invents completeness it cannot back with either files or a caller-supplied native
// resolver result. Marks every entry but the first-seen name as shadowed, in scan
// order (roots are already ordered client-first: project before user before
// additional, per each client module's documented root order).
function markShadowed(definitions: readonly AgentDefinition[]): AgentDefinition[] {
  const seen = new Set<string>();
  return definitions.map((definition) => {
    if (seen.has(definition.name)) {
      return { ...definition, shadowed: true };
    }
    seen.add(definition.name);
    return definition;
  });
}

async function readClientDefinitions(client: ClientId, options: ResolverOptions): Promise<AgentDefinition[]> {
  switch (client) {
    case 'claude-code':
      return readClaudeAgents(options);
    case 'opencode':
      return readOpencodeAgents(options);
    case 'codex':
      return readCodexAgents(options);
  }
}

export async function readAgentInventory(client: ClientId, options: ResolverOptions): Promise<AgentInventory> {
  const fileDefinitions = markShadowed(await readClientDefinitions(client, options));
  const nativeInventory = options.nativeInventory;

  if (nativeInventory === undefined || nativeInventory.completeness !== 'native') {
    // Completeness is propagated as given, never upgraded: a caller-supplied inventory
    // that is itself only 'files-only' carries no more authority than our own file scan
    // already provides, so it contributes nothing and must not promote the result to
    // 'native' just because *some* AgentInventory object was passed in.
    return {
      entries: fileDefinitions,
      completeness: nativeInventory?.completeness ?? 'files-only',
      diagnostics: nativeInventory?.diagnostics ?? [],
    };
  }

  // nativeInventory.completeness === 'native' from here: only entries recorded for
  // this exact client are ever consulted — a probe captured for another client must
  // never leak into this client's result.
  const nativeEntries = nativeInventory.entries.filter((entry) => entry.client === client);
  const nativeNames = new Set(nativeEntries.map((entry) => entry.name));
  const fileNames = new Set(fileDefinitions.map((entry) => entry.name));

  // A native entry with a same-named file counterpart is authoritative over it: every
  // file-based row for that name is demoted to shadowed/informational (kept, never
  // dropped — still visible as precedence evidence) instead of the file scan's own
  // project/user/additional order deciding the effective entry.
  const demotedFileEntries = fileDefinitions.map((entry) =>
    nativeNames.has(entry.name) ? { ...entry, shadowed: true } : entry,
  );

  const effectiveNative = nativeEntries.map((entry) => ({
    ...entry,
    shadowed: false,
    // A native entry with no on-disk counterpart is, by construction, not backed by a
    // file this layer can read: force `fileless` rather than trust whatever the
    // caller's probe happened to set, so a mislabeled probe cannot claim file backing
    // that does not exist. An entry that does have a file counterpart keeps whatever
    // availability the native probe reported for it.
    availability: fileNames.has(entry.name) ? entry.availability : ('fileless' as const),
  }));

  return {
    entries: [...demotedFileEntries, ...effectiveNative],
    completeness: 'native',
    diagnostics: nativeInventory.diagnostics,
  };
}

export function getAgent(inventory: AgentInventory, name: string): AgentDefinition {
  const found = inventory.entries.find((entry) => entry.name === name && !entry.shadowed);
  if (found === undefined) throw new RouterError('agent-unknown', `agent ${name} is not known`);
  return found;
}
