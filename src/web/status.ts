// Builds the one payload every console view shows in its header. It answers the question an
// operator asks first: is there a config, is the snapshot usable, is a router running, and does
// the environment hold what routing needs. Everything here is derived per request, never cached,
// because the operator may be editing the config in another window.
import { isSnapshotStale } from '../core/config';
import { RouterError } from '../core/errors';
import type { CliDeps } from '../core/types';
import { configCheck } from '../cli/read';
import type { ParsedArgs } from '../cli/args';
import { VERSION } from '../cli/version';
import { loadState } from '../io/store';
import type { ConfigHealth, SystemStatus } from './api-types';
import { envReport } from './detect';
import type { RouterSupervisor } from './supervisor';

export interface SystemStatusOptions {
  deps: CliDeps;
  parsed: ParsedArgs;
  configPath: string;
  supervisor: RouterSupervisor;
  console: SystemStatus['console'];
}

interface CheckPayload {
  problems: string[];
  warnings: string[];
}

// `config check` fails outright when the config is missing or unreadable, which is a state the
// console has to render rather than error on: a fresh machine starts exactly there. Its findings
// then become empty and the header falls back to configHealth.
async function checkFindings(deps: CliDeps, parsed: ParsedArgs): Promise<CheckPayload> {
  try {
    const result = await configCheck(deps, parsed);
    const payload = result.payload as CheckPayload;
    return { problems: payload.problems, warnings: payload.warnings };
  } catch {
    return { problems: [], warnings: [] };
  }
}

export async function systemStatus(options: SystemStatusOptions): Promise<SystemStatus> {
  const { deps, parsed, configPath, supervisor } = options;

  let health: ConfigHealth = 'ok';
  let configError: string | null = null;
  let state: Awaited<ReturnType<typeof loadState>> | undefined;
  try {
    state = await loadState(configPath);
  } catch (error) {
    // 'missing' and 'invalid' drive different UI: one offers the setup wizard, the other tells the
    // operator to fix a file. Anything that is not a RouterError is reported by a fixed label,
    // because raw failure text can quote a configured URL with credentials in it.
    const code = error instanceof RouterError ? error.code : 'config-unreadable';
    health = code === 'config-missing' ? 'missing' : 'invalid';
    configError = code;
  }

  const findings = state === undefined ? { problems: [], warnings: [] } : await checkFindings(deps, parsed);
  const snapshot = state?.snapshot;

  return {
    version: VERSION,
    configPath,
    configHealth: health,
    configError,
    generation: state?.generation ?? null,
    snapshot: {
      present: snapshot !== undefined,
      fetchedAt: snapshot?.fetchedAt ?? null,
      modelCount: snapshot?.models.length ?? null,
      stale: state !== undefined && isSnapshotStale(snapshot, state.config.modelSource.staleAfterSeconds, deps.now()),
    },
    env: envReport(state?.config, deps.env),
    router: await supervisor.status(),
    console: options.console,
    problems: findings.problems,
    warnings: findings.warnings,
  };
}
