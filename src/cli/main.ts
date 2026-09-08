import { RouterError } from '../core/errors';
import type { CliDeps } from '../core/types';
import { parseArgs } from './args';
import { render, writeDiagnostic } from './output';
import {
  agentsList,
  agentsShow,
  configCheck,
  configShow,
  doctor,
  modelsList,
  modelsShow,
  routePreview,
  type CommandResult,
} from './read';
import { doctorConnect, modelsDescribe, modelsSync, serveCommand } from './write';

const VERSION = '0.0.0';

const TOP_LEVEL_COMMANDS = ['models', 'agents', 'route', 'config', 'doctor', 'serve'] as const;

type CommandHandler = (deps: CliDeps, parsed: ReturnType<typeof parseArgs>) => Promise<CommandResult>;

// Task 12's read-only commands plus this worktree's Task 13 slice: models sync/describe and
// serve. `doctor` with --connect is handled separately below, since it needs the same offline
// report as plain `doctor` plus one extra check. `config export` stays unimplemented here: it is
// a follow-up once the exporter is repaired, so an unmatched command still falls through to the
// existing "not implemented yet" branch, unchanged.
const COMMANDS: Readonly<Record<string, CommandHandler>> = {
  'models list': modelsList,
  'models show': modelsShow,
  'models sync': modelsSync,
  'models describe': modelsDescribe,
  'agents list': agentsList,
  'agents show': agentsShow,
  'route preview': routePreview,
  'config show': configShow,
  'config check': configCheck,
  doctor,
  serve: serveCommand,
};

// RouterError codes starting with config-/snapshot-/usage-, plus the exact codes unknown-model
// and agent-unknown, are usage/config/selection problems (exit 2); every other RouterError is an
// operational failure (exit 1: I/O or network), per the CLI's documented exit-code contract.
function isUsageOrConfigCode(code: string): boolean {
  return (
    code.startsWith('config-') ||
    code.startsWith('snapshot-') ||
    code === 'unknown-model' ||
    code === 'agent-unknown' ||
    code.startsWith('usage-')
  );
}

const USAGE = `subagent-router <command> [options]

Commands:
  models list
  models show <id-or-alias>
  models sync [--dry-run] [--allow-empty]
  models describe <id-or-alias> (--text <t> | --file <path> | --clear)
  agents list --client <c>
  agents show <name> --client <c>
  route preview --client <c> --agent <name> [--model <ref>] [--parent-model <m>]
  config show
  config check
  config export --client <c> [--dry-run] [--force]
  doctor [--connect]
  serve [--port <n>] [--host <h>] [--claude-version <v>]

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
    writeDiagnostic(deps, error instanceof RouterError ? error.message : String(error));
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
    writeDiagnostic(deps, 'subagent-router: no command given');
    deps.stderr(USAGE);
    return 2;
  }

  if (!(TOP_LEVEL_COMMANDS as readonly string[]).includes(topLevel)) {
    writeDiagnostic(deps, `subagent-router: unknown command: ${topLevel}`);
    deps.stderr(USAGE);
    return 2;
  }

  const commandKey = parsed.command.join(' ');
  // doctor --connect adds one real check (a first-page discovery connectivity probe) on top of
  // the same offline report `doctor` already produces; it is not a distinct command name.
  const handler = commandKey === 'doctor' && parsed.options.connect === true ? doctorConnect : COMMANDS[commandKey];
  if (handler === undefined) {
    writeDiagnostic(deps, `subagent-router: '${parsed.command.join(' ')}' is not implemented yet`);
    return 2;
  }

  const json = parsed.options.json === true;
  try {
    const result = await handler(deps, parsed);
    render(deps, result.payload, result.human, json);
    return result.code;
  } catch (error) {
    if (error instanceof RouterError) {
      writeDiagnostic(deps, `subagent-router: ${error.code}: ${error.message}`);
      return isUsageOrConfigCode(error.code) ? 2 : 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    writeDiagnostic(deps, `subagent-router: ${message}`);
    return 1;
  }
}
