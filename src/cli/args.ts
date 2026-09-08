import { parseArgs as nodeParseArgs } from 'node:util';
import { RouterError } from '../core/errors';

export interface ParsedArgs {
  command: string[];
  options: Record<string, string | boolean>;
  positionals: string[];
  additionalRoots: string[];
}

// node:util's parseArgs multiple-value string options always return string[], and its boolean
// options always return boolean; no option here is declared multiple except agents-dir, which is
// carried separately as additionalRoots (see the module doc below), so every remaining value is a
// plain string or boolean once agents-dir is removed.
const OPTIONS = {
  config: { type: 'string' as const },
  json: { type: 'boolean' as const },
  'no-color': { type: 'boolean' as const },
  'agents-dir': { type: 'string' as const, multiple: true },
  client: { type: 'string' as const },
  agent: { type: 'string' as const },
  model: { type: 'string' as const },
  'parent-model': { type: 'string' as const },
  help: { type: 'boolean' as const },
  version: { type: 'boolean' as const },
  // models sync
  'dry-run': { type: 'boolean' as const },
  'allow-empty': { type: 'boolean' as const },
  // models describe
  text: { type: 'string' as const },
  file: { type: 'string' as const },
  clear: { type: 'boolean' as const },
  // doctor --connect
  connect: { type: 'boolean' as const },
  // serve
  port: { type: 'string' as const },
  host: { type: 'string' as const },
  'claude-version': { type: 'string' as const },
  // config export
  output: { type: 'string' as const },
  force: { type: 'boolean' as const },
};

/**
 * Parses CLI argv with node:util's parseArgs (strict:true — an unknown flag throws, it is never
 * silently ignored). `--agents-dir` may repeat; those values are lifted into `additionalRoots`
 * (a plain string[], matching ResolverOptions.additionalRoots) rather than forced into the
 * uniform `Record<string, string | boolean>` options bag, which cannot hold a repeated flag.
 * The first two positionals are treated as the command path (e.g. ["models", "list"]); any
 * further positionals (e.g. an id/name argument) remain in `positionals`.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let parsed: { values: Record<string, string | boolean | string[] | undefined>; positionals: string[] };
  try {
    parsed = nodeParseArgs({ args: [...argv], options: OPTIONS, strict: true, allowPositionals: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RouterError('usage-parse', message);
  }

  const { 'agents-dir': agentsDir, ...rest } = parsed.values;
  const options: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) options[key] = value as string | boolean;
  }

  const command = parsed.positionals.slice(0, 2);
  const positionals = parsed.positionals.slice(2);

  return {
    command,
    options,
    positionals,
    additionalRoots: Array.isArray(agentsDir) ? agentsDir : [],
  };
}
