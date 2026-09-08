import { RouterError } from '../core/errors';
import type { CliDeps } from '../core/types';
import { parseArgs } from './args';

const VERSION = '0.0.0';

const TOP_LEVEL_COMMANDS = ['models', 'agents', 'route', 'config', 'doctor'] as const;

const USAGE = `subagent-router <command> [options]

Commands:
  models list
  models show <id-or-alias>
  models sync
  models describe <id-or-alias> <description>
  agents list --client <c>
  agents show <name> --client <c>
  route preview --client <c> --agent <name> [--model <ref>] [--parent-model <m>]
  config show
  config check
  config export --client <c> [--dry-run] [--force]
  doctor

Global options:
  --config <file>  --json  --no-color  --agents-dir <dir>  --help  --version
`;

/**
 * Dispatches `--version`, `--help` and command-name validation. The commands themselves
 * (`models list`, `agents show`, `route preview`, `config export`, ...) are NOT implemented yet:
 * this is argument scaffolding only, so a recognized-but-unimplemented command still fails with
 * exit code 2 rather than silently doing nothing or fabricating a result.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<0 | 1 | 2> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    deps.stderr(`${error instanceof RouterError ? error.message : String(error)}\n`);
    return 2;
  }

  if (parsed.options.version === true) {
    deps.stdout(`${VERSION}\n`);
    return 0;
  }

  if (parsed.options.help === true) {
    deps.stdout(USAGE);
    return 0;
  }

  const [topLevel] = parsed.command;
  if (topLevel === undefined) {
    deps.stderr('subagent-router: no command given\n');
    deps.stderr(USAGE);
    return 2;
  }

  if (!(TOP_LEVEL_COMMANDS as readonly string[]).includes(topLevel)) {
    deps.stderr(`subagent-router: unknown command: ${topLevel}\n`);
    deps.stderr(USAGE);
    return 2;
  }

  deps.stderr(`subagent-router: '${parsed.command.join(' ')}' is not implemented yet\n`);
  return 2;
}
