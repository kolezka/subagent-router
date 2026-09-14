// CLI entry point for the web console. Like `serve`, it returns once the listener is open and the
// process stays alive because of the open socket; no signal handling or daemonizing lives here.
import type { ParsedArgs } from '../cli/args';
import type { CommandResult } from '../cli/read';
import type { CliDeps } from '../core/types';
import { resolveWebOptions, startWebServer, type WebHandle } from './server';

export async function startWebCommand(deps: CliDeps, parsed: ParsedArgs): Promise<{ result: CommandResult; server: WebHandle }> {
  const options = resolveWebOptions(parsed);
  const server = await startWebServer(deps, parsed, options);
  const payload = { url: server.url, host: options.host, port: options.port, readOnly: options.readOnly };
  const human = () => `console on ${server.url}${options.readOnly ? ' (read-only)' : ''}\n`;
  return { result: { code: 0, payload, human }, server };
}

export async function webCommand(deps: CliDeps, parsed: ParsedArgs): Promise<CommandResult> {
  const { result } = await startWebCommand(deps, parsed);
  return result;
}

export { createWebHandler, createSession, resolveWebOptions, startWebServer, DEFAULT_WEB_HOST, DEFAULT_WEB_PORT } from './server';
export type { WebHandle, WebOptions } from './server';
