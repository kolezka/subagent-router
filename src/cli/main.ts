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
import { uiCommand } from './ui';
import { configExport, doctorConnect, modelsDescribe, modelsSync, serveCommand } from './write';

const VERSION = '0.0.0';

const TOP_LEVEL_COMMANDS = ['models', 'agents', 'route', 'config', 'doctor', 'serve', 'ui'] as const;

type CommandHandler = (deps: CliDeps, parsed: ReturnType<typeof parseArgs>) => Promise<CommandResult>;

// Task 12's read-only commands plus Task 13's write slice: models sync/describe, config export,
// serve. `doctor` with --connect is handled separately below, since it needs the same offline
// report as plain `doctor` plus one extra check.
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
  'config export': configExport,
  doctor,
  serve: serveCommand,
  // Read-only local web console. A separate listener from `serve`, never a routing path.
  ui: uiCommand,
};

// A handful of export- codes are user-input problems (bad client, a target that overlaps a
// native agent root, a collision without --force, an unsafe name, an unsupported native shape, a
// missing snapshot) and map to exit 2 like config-/snapshot-/usage- codes do. The remaining
// export- codes (a plan invariant, a missing package root) are unexpected internal/environment
// failures, not something the caller's input can fix, so they fall through to exit 1 below.
const EXPORT_USAGE_CODES = new Set([
  'export-native-root',
  'export-collision',
  'export-unsafe-name',
  'export-unsupported-value',
  'export-snapshot-missing',
]);

// config-/snapshot-/usage- codes, plus unknown-model, model-not-allowed and agent-unknown, are
// usage/config problems (exit 2); everything else is exit 1. model-not-allowed comes from
// config export refusing a codex role routed to a disabled catalog model.
function isUsageOrConfigCode(code: string): boolean {
  return (
    code.startsWith('config-') ||
    code.startsWith('snapshot-') ||
    code === 'unknown-model' ||
    code === 'model-not-allowed' ||
    code === 'agent-unknown' ||
    code.startsWith('usage-') ||
    EXPORT_USAGE_CODES.has(code)
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
  config export --client <c> --output <dir> [--dry-run] [--force]
  doctor [--connect]
  serve [--port <n>] [--host <h>] [--claude-version <v>]
  ui [--port <n>] [--host <h>]

Global options:
  --config <file>  --json  --no-color  --agents-dir <dir>  --help  --version
`;

/**
 * Dispatches `--version`, `--help`, command-name validation and every implemented command in
 * `COMMANDS`. A recognized but still-unmatched command path (none exist today) falls through to
 * the "not implemented yet" branch below, exit code 2, rather than silently doing nothing.
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
