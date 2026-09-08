import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentDefinition, ClientId, ResolverOptions } from '../core/types';
import { RouterError } from '../core/errors';
import { listMarkdownAgents } from './claude-code';

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RouterError('agent-file-malformed', `${path}: invalid JSON (${(error as Error).message})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RouterError('agent-file-malformed', `${path}: must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function agentBlockEntries(path: string, config: Record<string, unknown>, scope: string): AgentDefinition[] {
  const agentBlock = config.agent;
  if (agentBlock === undefined) return [];
  if (typeof agentBlock !== 'object' || agentBlock === null || Array.isArray(agentBlock)) {
    throw new RouterError('agent-file-malformed', `${path}: "agent" field must be an object`);
  }

  const definitions: AgentDefinition[] = [];
  for (const [name, raw] of Object.entries(agentBlock as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new RouterError('agent-file-malformed', `${path}: agent.${name} must be an object`);
    }
    const native = raw as Record<string, unknown>;
    const declaredModel = typeof native.model === 'string' ? native.model : undefined;
    definitions.push({
      client: 'opencode',
      name,
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

function userConfigDir(options: ResolverOptions): string {
  return options.configRoot ?? join(options.home, '.config', 'opencode');
}

// Root order, first wins (later roots become `shadowed: true` in inventory.ts):
//   1. cwd/.opencode/agents/*.md                       (scope 'project')
//   2. <userConfigDir>/agents/*.md                      (scope 'user')
//   3. additionalRoots, as extra Markdown agent dirs    (scope 'additional')
//   4. cwd/opencode.json "agent" block                  (scope 'project-config')
//   5. <userConfigDir>/opencode.json "agent" block       (scope 'user-config')
// A Markdown file precedes both `opencode.json` blocks so it always shadows the
// `agent` entry of the same name, per the task brief. As with claude-code.ts, this
// order is Task 6's declaration for Task 7's M-probe to confirm, not a verified fact
// about OpenCode's own resolver (D9).
//
// Only the Markdown directory roots (1-3) are exposed here, not the two `opencode.json` file
// paths (4-5): export.ts's native-root protection (inventory.ts's candidateAgentRoots) protects
// agent DIRECTORIES a client scans, matching claude-code.ts/codex.ts's own root shape.
export function opencodeAgentRoots(options: ResolverOptions): Array<{ dir: string; scope: string }> {
  const configDir = userConfigDir(options);
  return [
    { dir: join(options.cwd, '.opencode', 'agents'), scope: 'project' },
    { dir: join(configDir, 'agents'), scope: 'user' },
    ...options.additionalRoots.map((dir) => ({ dir, scope: 'additional' })),
  ];
}

export async function readOpencodeAgents(options: ResolverOptions): Promise<AgentDefinition[]> {
  const client: ClientId = 'opencode';
  const configDir = userConfigDir(options);

  const definitions: AgentDefinition[] = [];
  for (const root of opencodeAgentRoots(options)) {
    definitions.push(...(await listMarkdownAgents(client, root.dir, root.scope)));
  }

  const projectConfigPath = join(options.cwd, 'opencode.json');
  const projectConfig = await readJsonObject(projectConfigPath);
  if (projectConfig !== undefined) {
    definitions.push(...agentBlockEntries(projectConfigPath, projectConfig, 'project-config'));
  }

  const userConfigPath = join(configDir, 'opencode.json');
  const userConfig = await readJsonObject(userConfigPath);
  if (userConfig !== undefined) {
    definitions.push(...agentBlockEntries(userConfigPath, userConfig, 'user-config'));
  }

  return definitions;
}
