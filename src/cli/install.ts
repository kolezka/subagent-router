// `subagent-router install`: writes the Claude Code integration artifacts into a directory the
// operator names. It never edits an installed client configuration, so the only way these files
// take effect is the operator passing them to Claude Code themselves.
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { allCandidateNativeRoots, assertNoOverlapWithResolvedRoots, findPackageRoot, resolveProtectedRoots, resolveRealPath } from '../agents/export';
import { RouterError } from '../core/errors';
import type { CliDeps } from '../core/types';
import { loadState } from '../io/store';
import { planClaudeCodeInstall, routerUrlFor, type InstallFile } from '../install/claude-code';
import type { ParsedArgs } from './args';
import { escapeControl } from './output';
import { resolveConfigPath, type CommandResult } from './read';
import { VERSION } from './version';
import { resolveServeOptions } from './write';

function stringOption(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options[name];
  return typeof value === 'string' ? value : undefined;
}

const USAGE = 'install --output <dir> [--client claude-code] [--port <n>] [--host <h>] [--claude-version <v>] [--parent-model <m>] [--dry-run] [--force]';

async function writePlannedFile(outputDir: string, file: InstallFile, force: boolean): Promise<void> {
  const target = join(outputDir, file.relativePath);
  if (!force && existsSync(target)) {
    throw new RouterError('install-collision', `install-collision: ${file.relativePath} already exists; pass --force to replace it`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, file.content, 'utf8');
  if (file.executable === true) await chmod(target, 0o755);
}

/**
 * Generates the integration bundle: a settings file for `claude --settings`, a launcher, a small
 * plugin (session check plus a status command) and a README. The client only ever learns a
 * loopback router URL, so the same bundle works with any gateway the router is configured against.
 */
export async function installCommand(deps: CliDeps, parsed: ParsedArgs): Promise<CommandResult> {
  const client = stringOption(parsed, 'client') ?? 'claude-code';
  if (client !== 'claude-code') {
    throw new RouterError(
      'install-unsupported-client',
      `install only supports --client claude-code; ${client} integration is unmeasured and is not generated`,
    );
  }

  const outputRaw = stringOption(parsed, 'output');
  if (outputRaw === undefined || outputRaw.length === 0) {
    throw new RouterError('install-missing-output', `${USAGE}: --output <dir> is required`);
  }
  const outputDir = resolve(deps.cwd, outputRaw);

  const configPath = resolveConfigPath(deps, parsed);
  // Loaded for its agent-root overrides only. It also fails early and clearly when `install` is
  // pointed at a config that does not exist, rather than generating a bundle nothing can run.
  const state = await loadState(configPath);
  const protectedRoots = await resolveProtectedRoots(
    allCandidateNativeRoots({ cwd: deps.cwd, home: deps.home, env: deps.env, additionalRoots: parsed.additionalRoots }, state.config),
  );
  assertNoOverlapWithResolvedRoots(await resolveRealPath(outputDir), protectedRoots);

  const serve = resolveServeOptions(deps, parsed);
  const parentModel = stringOption(parsed, 'parent-model');
  const plan = planClaudeCodeInstall(outputDir, {
    routerUrl: routerUrlFor(serve.host, serve.port),
    configPath,
    cliPath: join(findPackageRoot(import.meta.dir), 'dist', 'cli.js'),
    version: VERSION,
    ...(parentModel !== undefined ? { parentModel } : {}),
    ...(serve.claudeVersion !== undefined ? { claudeVersion: serve.claudeVersion } : {}),
  });

  const dryRun = parsed.options['dry-run'] === true;
  const force = parsed.options.force === true;
  if (!dryRun) {
    for (const file of plan.files) await writePlannedFile(outputDir, file, force);
  }

  const payload = { client, output: outputDir, routerUrl: plan.routerUrl, dryRun, force, files: plan.files.map((file) => file.relativePath) };
  const human = () =>
    `${[
      `client: ${client}`,
      `output: ${escapeControl(outputDir)}`,
      `router: ${plan.routerUrl}`,
      ...(dryRun ? ['dry-run: no files written'] : []),
      ...plan.files.map((file) => `  ${escapeControl(file.relativePath)}`),
      '',
      `next: read ${escapeControl(join(outputDir, 'README.md'))}`,
    ].join('\n')}\n`;
  return { code: 0, payload, human };
}
