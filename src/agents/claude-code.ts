import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentDefinition, ClientId, ResolverOptions } from '../core/types';
import { RouterError } from '../core/errors';

interface ParsedAgentMarkdown {
  native: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_DELIM = /^---\s*$/;

// Shared by claude-code.ts and opencode.ts: both clients define subagents as Markdown
// files with an optional YAML frontmatter block. Exported so opencode.ts (same file
// format) does not duplicate the parser.
export function parseAgentMarkdown(text: string, path: string): ParsedAgentMarkdown {
  const lines = text.split(/\r?\n/);
  if (lines[0] === undefined || !FRONTMATTER_DELIM.test(lines[0])) {
    return { native: {}, body: text };
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && FRONTMATTER_DELIM.test(line));
  if (closingIndex === -1) {
    throw new RouterError('agent-file-malformed', `${path}: unterminated frontmatter block`);
  }

  const yamlText = lines.slice(1, closingIndex).join('\n');
  let parsed: unknown;
  try {
    parsed = yamlText.trim().length === 0 ? {} : Bun.YAML.parse(yamlText);
  } catch {
    // Never interpolate the parser's own exception message: it can echo raw source
    // content back into the router's error output.
    throw new RouterError('agent-file-malformed', `${path}: invalid YAML frontmatter`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RouterError('agent-file-malformed', `${path}: frontmatter must be a YAML mapping`);
  }

  return { native: parsed as Record<string, unknown>, body: bodyAfterLine(text, closingIndex) };
}

// Returns the exact original substring after line `lineIndex`, preserving CRLF/LF and blank
// lines as written. Unlike lines.slice().join('\n'), this never rewrites the file's bytes.
function bodyAfterLine(text: string, lineIndex: number): string {
  const terminator = /\r?\n/g;
  let occurrence = 0;
  let match: RegExpExecArray | null;
  while ((match = terminator.exec(text)) !== null) {
    if (occurrence === lineIndex) return text.slice(match.index + match[0].length);
    occurrence++;
  }
  return '';
}

function effectiveName(native: Record<string, unknown>, filename: string, stripLength: number): string {
  return typeof native.name === 'string' && native.name.length > 0 ? native.name : filename.slice(0, -stripLength);
}

// Reads one directory of `*.md` agent definitions. A missing directory is a normal,
// expected outcome (an optional root that simply was not configured) and yields no
// entries; any other filesystem failure (permission denied, not-a-directory, ...) is
// never swallowed and propagates to the caller.
export async function listMarkdownAgents(client: ClientId, dir: string, scope: string): Promise<AgentDefinition[]> {
  let filenames: string[];
  try {
    filenames = (await readdir(dir)).filter((name) => name.endsWith('.md'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const definitions: AgentDefinition[] = [];
  for (const filename of filenames.sort()) {
    const path = join(dir, filename);
    const text = await readFile(path, 'utf8');
    const { native, body } = parseAgentMarkdown(text, path);
    const declaredModel = typeof native.model === 'string' ? native.model : undefined;
    definitions.push({
      client,
      name: effectiveName(native, filename, 3),
      scope,
      path,
      ...(declaredModel !== undefined ? { declaredModel } : {}),
      hidden: native.hidden === true,
      body,
      native,
      availability: 'available',
      shadowed: false,
    });
  }
  return definitions;
}

// Root order, first wins (later roots become `shadowed: true` in inventory.ts):
//   1. cwd/.claude/agents                                            (scope 'project')
//   2. CLAUDE_CONFIG_DIR, else configRoot, else home/.claude/agents  (scope 'user')
//   3. additionalRoots, in the order given                           (scope 'additional')
// This order is the spec's stated intent for Task 7's M-probe to confirm against a real
// harness, not a verified fact about how Claude Code itself resolves agent directories.
//
// Exported (not just inlined into readClaudeAgents) so export.ts's native-root protection can
// compute the same candidate directories without duplicating this recipe -- see
// inventory.ts's candidateAgentRoots.
export function claudeCodeAgentRoots(options: ResolverOptions): Array<{ dir: string; scope: string }> {
  const configDirEnv = options.env.CLAUDE_CONFIG_DIR;
  const userDir =
    configDirEnv !== undefined && configDirEnv.length > 0
      ? join(configDirEnv, 'agents')
      : options.configRoot !== undefined
        ? join(options.configRoot, 'agents')
        : join(options.home, '.claude', 'agents');

  return [
    { dir: join(options.cwd, '.claude', 'agents'), scope: 'project' },
    { dir: userDir, scope: 'user' },
    ...options.additionalRoots.map((dir) => ({ dir, scope: 'additional' })),
  ];
}

export async function readClaudeAgents(options: ResolverOptions): Promise<AgentDefinition[]> {
  const client: ClientId = 'claude-code';
  const definitions: AgentDefinition[] = [];
  for (const root of claudeCodeAgentRoots(options)) {
    definitions.push(...(await listMarkdownAgents(client, root.dir, root.scope)));
  }
  return definitions;
}
