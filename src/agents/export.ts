// Task 13 export subsystem. Turns one validated operator state into a read-only artifact tree
// for one client, plus a sidecar describing exactly what was written. Never touches a native
// config file (settings.json, opencode.json, config.toml) and never writes outside `outputDir`.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { candidateAgentRoots, getAgent } from './inventory';
import { opencodeVariants } from '../adapters/opencode';
import { buildCatalog } from '../core/catalog';
import { RouterError } from '../core/errors';
import { sha256 } from '../core/hash';
import { assertSafePathSegment } from '../core/path-segment';
import { loadState } from '../io/store';
import type { AgentInventory, ClientId, EffectiveCatalog, Env, ExportFile, LoadedState, OperatorConfig, ResolverOptions } from '../core/types';

const ALL_CLIENTS: readonly ClientId[] = ['claude-code', 'opencode', 'codex'];

// Named operator env references. exportConfig has no way to know the real control URL (the
// server binds an ephemeral port at `serve` time) or the real client version at export time, so
// both are always emitted as env-var names for the operator to set, never as literal values.
// This is the "or named env reference" branch of the brief; the "operator-supplied absolute URL"
// branch has no way to reach this function, since exportConfig's options carry no such field.
export const CONTROL_URL_ENV_REF = 'SUBAGENT_ROUTER_CONTROL_URL';
export const CLAUDE_VERSION_ENV_REF = 'SUBAGENT_ROUTER_CLAUDE_VERSION';

const CODEX_ROLE_PREFIX = 'codex:';

function clientDirName(client: ClientId): string {
  switch (client) {
    case 'claude-code':
      return 'claude';
    case 'opencode':
      return 'opencode';
    case 'codex':
      return 'codex';
  }
}

// Second layer of traversal protection, after the adapters' own name checks: every planned file
// must land strictly under `target` (the concrete `<outputDir>/<clientDir>` directory). Checks
// the lexical shape first (rooted under clientDir, no empty/`.`/`..` segments, no backslashes),
// then re-derives the absolute path and requires it to stay below `target` with a separator, so
// a plan can never name a file this module would write outside the output directory, whether
// the run is real or --dry-run. Returns the path relative to the client dir, the exact string
// the write loop joins into the staging directory. Throws export-plan-invariant (exit 1): a plan
// that reaches here with a bad path is an internal contract violation, not user input.
export function assertPlanPathContained(target: string, clientDir: string, relativePath: string): string {
  const invalid = (reason: string): RouterError =>
    new RouterError('export-plan-invariant', `export-plan-invariant: ${relativePath} ${reason}`);

  const prefix = `${clientDir}/`;
  if (!relativePath.startsWith(prefix)) throw invalid(`is not rooted under ${prefix}`);
  const relativeToClient = relativePath.slice(prefix.length);
  if (relativeToClient.length === 0) throw invalid('names the client directory itself');
  if (relativeToClient.includes('\\')) throw invalid('contains a backslash');
  for (const segment of relativeToClient.split('/')) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw invalid(`contains an empty, "." or ".." path segment`);
    }
  }

  const absolute = resolve(target, relativeToClient);
  const targetWithSep = target.endsWith(sep) ? target : `${target}${sep}`;
  if (!absolute.startsWith(targetWithSep)) throw invalid(`resolves outside ${target}`);
  return relativeToClient;
}

// POSIX single-quotes a literal path for shell command generation: wraps it in `'...'` and
// escapes any embedded `'` as `'\''` (close quote, literal escaped quote, reopen quote). Every
// generated command is a plain string a hook's shell config will run verbatim, so a path with a
// space or an apostrophe must survive tokenization as ONE argument. Never apply this to the
// operator env-var references (`"${VAR}"`): those are meant to expand at hook run time, and
// single-quoting would suppress that expansion entirely.
function posixQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

// Resolves the real, symlink-free location `path` occupies, even when it (or an arbitrary number
// of its trailing segments) does not exist yet: walks up to the nearest EXISTING ancestor,
// resolves that ancestor with `realpath`, then rejoins the never-existing suffix unchanged. Only
// ENOENT triggers the walk-up; any other failure (permission, ENOTDIR, ...) is a real problem and
// must propagate, never be treated as "nothing here to resolve or protect".
async function resolveRealPath(path: string): Promise<string> {
  const target = resolve(path);
  try {
    return await realpath(target);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  const parent = dirname(target);
  if (parent === target) return target; // filesystem root and it does not exist; nothing more to resolve
  return join(await resolveRealPath(parent), basename(target));
}

// Comparison-only normalization for the native-root overlap guard: folds letter case and
// canonicalizes Unicode composition (NFC), so two spellings of the same filesystem path can never
// be told apart by this guard just because they differ in case or accent composition. This
// matters because `resolveRealPath` above only canonicalizes case/composition for a path segment
// that already EXISTS on disk (the real syscall does that); for a segment that does not exist yet,
// it rejoins the caller's original spelling verbatim (see that function's own comment), so a
// not-yet-created output directory spelled e.g. ".CLAUDE/AGENTS" would otherwise still compare
// unequal, byte for byte, to the real, lowercase ".claude/agents" root -- even though macOS and
// Windows would treat them as the exact same directory the moment either is created. This is
// deliberately conservative: on a case-sensitive filesystem (most Linux setups) two genuinely
// distinct directories that merely share a case-folded/NFC-normalized spelling would also be
// rejected as overlapping. That is an accepted false positive for a guard whose only job is to
// refuse writing into (or over) a native agent directory; it never applies to anything else in
// this module -- upstream model IDs, exported/written file paths, and model aliases are never run
// through this function and keep their exact original bytes everywhere else.
function pathComparisonKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

function isSameOrNested(a: string, b: string): boolean {
  const keyA = pathComparisonKey(a);
  const keyB = pathComparisonKey(b);
  if (keyA === keyB) return true;
  const aWithSep = keyA.endsWith(sep) ? keyA : `${keyA}${sep}`;
  const bWithSep = keyB.endsWith(sep) ? keyB : `${keyB}${sep}`;
  return keyB.startsWith(aWithSep) || keyA.startsWith(bWithSep);
}

// Builds one client's ResolverOptions from the caller-supplied context plus that client's
// configRoot override from OperatorConfig.agentRoots -- the exact recipe cli/read.ts's own
// resolverOptionsFor uses, so a root computed here can never disagree with one a real CLI
// invocation would compute for the same config.
function resolverOptionsForClient(context: ExportOptions['resolverContext'], config: OperatorConfig, client: ClientId): ResolverOptions {
  const configRoot = config.agentRoots[client].configRoot;
  return {
    cwd: context.cwd,
    home: context.home,
    env: context.env,
    ...(configRoot !== null ? { configRoot } : {}),
    additionalRoots: context.additionalRoots,
  };
}

// Every directory ANY client's native config could occupy -- not only the client being exported,
// so exporting for opencode still refuses to land inside a claude-code or codex root -- per the
// same root-selection rules the file scanners themselves use (agents/inventory.ts's
// candidateAgentRoots). Includes roots that hold no files, or do not exist, yet: absence of a
// scanned entry is never treated as absence of the directory's protection.
function allCandidateNativeRoots(context: ExportOptions['resolverContext'], config: OperatorConfig): string[] {
  const roots: string[] = [];
  for (const client of ALL_CLIENTS) {
    roots.push(...candidateAgentRoots(client, resolverOptionsForClient(context, config, client)));
  }
  return roots;
}

// Resolves every candidate root to its real, symlink-free (or virtual, if not yet created)
// location once, so repeated collision checks (parent output dir, then the concrete per-client
// target) do not re-walk the filesystem for the same root twice.
async function resolveProtectedRoots(candidates: readonly string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const root of candidates) resolved.push(await resolveRealPath(root));
  return resolved;
}

// A resolved directory must never equal, contain, or be contained by any protected native root.
// Runs unconditionally, before --force is even consulted and before dry-run short-circuits
// anything, against BOTH the parent output directory and (separately, at the call site) the
// concrete per-client target -- a target that is itself a symlink into a native root can collide
// even when its parent directory does not.
function assertNoOverlapWithResolvedRoots(resolvedDir: string, resolvedRoots: readonly string[]): void {
  for (const root of resolvedRoots) {
    if (isSameOrNested(resolvedDir, root)) {
      throw new RouterError('export-native-root', `export-native-root: output directory overlaps a native agent directory (${root})`);
    }
  }
}

// Walks up from `startDir` looking for the nearest package.json. Works the same whether this
// code is running from source (src/agents/export.ts, two levels below the repo root) or bundled
// into dist/*.js (one level below the package root), because it locates the root by the marker
// file rather than by a hardcoded number of `..` segments.
export function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new RouterError('export-package-root-missing', `export-package-root-missing: no package.json found above ${startDir}`);
    }
    dir = parent;
  }
}

// --- dumpToml -----------------------------------------------------------------------------
// Bun 1.3.11 has no Bun.TOML.stringify. This handles exactly the subset the brief specifies:
// strings, numbers, booleans, arrays of strings, and one level of tables. Anything else
// (nested tables, mixed/non-string arrays, functions, etc.) is a RouterError, never a silent
// best-effort serialization a later Bun.TOML.parse could fail to round-trip.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

const BARE_TOML_KEY = /^[A-Za-z0-9_-]+$/;

function tomlKey(key: string): string {
  return BARE_TOML_KEY.test(key) ? key : tomlString(key);
}

function tomlScalar(value: unknown): string {
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RouterError('export-unsupported-value', 'export-unsupported-value: numbers must be finite');
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === 'string')) {
      throw new RouterError('export-unsupported-value', 'export-unsupported-value: arrays may only contain strings');
    }
    return `[${(value as string[]).map((item) => tomlString(item)).join(', ')}]`;
  }
  throw new RouterError('export-unsupported-value', `export-unsupported-value: unsupported value type ${typeof value}`);
}

export function dumpToml(value: Record<string, unknown>): string {
  const scalarLines: string[] = [];
  const tableSections: string[] = [];

  for (const [key, raw] of Object.entries(value)) {
    if (isPlainObject(raw)) {
      const innerLines: string[] = [];
      for (const [innerKey, innerRaw] of Object.entries(raw)) {
        if (isPlainObject(innerRaw)) {
          throw new RouterError('export-unsupported-value', `export-unsupported-value: ${key}.${innerKey} exceeds the supported one level of tables`);
        }
        innerLines.push(`${tomlKey(innerKey)} = ${tomlScalar(innerRaw)}`);
      }
      tableSections.push(`[${tomlKey(key)}]\n${innerLines.join('\n')}`);
    } else {
      scalarLines.push(`${tomlKey(key)} = ${tomlScalar(raw)}`);
    }
  }

  const blocks = [...(scalarLines.length > 0 ? [scalarLines.join('\n')] : []), ...tableSections];
  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`;
}

// --- per-client artifact builders ---------------------------------------------------------

interface BuildContext {
  config: OperatorConfig;
  catalog?: EffectiveCatalog;
  inventory: AgentInventory;
  generation: string;
  absoluteConfigPath: string;
  packageRoot: string;
  profileDir: string;
  clientDir: string;
  targetDir: string; // resolvedOutputDir/clientDir -- where the sidecar will actually live
}

function buildClaudeFiles(ctx: BuildContext): ExportFile[] {
  const programPath = join(ctx.packageRoot, 'dist', 'claude-hook.js');
  const command = [
    posixQuote(programPath),
    '--config', posixQuote(ctx.absoluteConfigPath),
    '--profile-dir', posixQuote(ctx.profileDir),
    // Intentionally NOT posixQuote'd: these are shell parameter expansions the operator's own
    // shell resolves at hook run time, not literal paths this module controls.
    '--client-version', `"\${${CLAUDE_VERSION_ENV_REF}}"`,
    '--control-url', `"\${${CONTROL_URL_ENV_REF}}"`,
  ].join(' ');

  const fragment = {
    _readOnly: true,
    _note: 'Reference only. subagent-router never writes to the real settings.json; merge this fragment in by hand.',
    hooks: {
      SubagentStart: [{ hooks: [{ type: 'command', command }] }],
    },
    // Only the env VAR NAMES, never values: the secret and the control URL are both resolved by
    // the operator's shell/process manager at hook run time, not baked in here.
    secretEnv: ctx.config.harness.claudeCode.secretEnv,
    controlUrlEnv: CONTROL_URL_ENV_REF,
    clientVersionEnv: CLAUDE_VERSION_ENV_REF,
  };

  return [{ relativePath: `${ctx.clientDir}/settings-fragment.json`, content: `${JSON.stringify(fragment, null, 2)}\n` }];
}

function opencodeModelsSummary(catalog: EffectiveCatalog): Record<string, { upstreamModel: string }> {
  const out: Record<string, { upstreamModel: string }> = {};
  for (const model of catalog.byId.values()) {
    if (!model.enabled || model.description === undefined) continue;
    out[model.alias] = { upstreamModel: model.id };
  }
  return out;
}

function buildOpencodeFiles(ctx: BuildContext, catalog: EffectiveCatalog): ExportFile[] {
  const variants = opencodeVariants(ctx.inventory, ctx.config, catalog, ctx.generation);

  const programPath = join(ctx.packageRoot, 'dist', 'opencode-plugin.js');
  const pluginFragment = { plugin: [programPath] };
  const pluginFile: ExportFile = {
    relativePath: `${ctx.clientDir}/plugin-fragment.json`,
    content: `${JSON.stringify(pluginFragment, null, 2)}\n`,
  };

  return [...variants, pluginFile];
}

// Only roles actually exported (a TOML file was written for them) are listed: a role that was
// skipped for lack of a native counterpart must never appear here as if its artifact existed.
function codexRolesSummary(config: OperatorConfig, exportedRoles: ReadonlySet<string>): Record<string, { model: string }> {
  const out: Record<string, { model: string }> = {};
  for (const [roleKey, role] of Object.entries(config.roles)) {
    if (!roleKey.startsWith(CODEX_ROLE_PREFIX)) continue;
    const name = roleKey.slice(CODEX_ROLE_PREFIX.length);
    if (exportedRoles.has(name)) out[name] = { model: role.routeOverride };
  }
  return out;
}

interface CodexBuildResult {
  files: ExportFile[];
  exportedRoles: ReadonlySet<string>;
}

function buildCodexFiles(ctx: BuildContext, catalog: EffectiveCatalog | undefined): CodexBuildResult {
  const files: ExportFile[] = [];
  const exportedRoles = new Set<string>();

  for (const [roleKey, role] of Object.entries(ctx.config.roles)) {
    if (!roleKey.startsWith(CODEX_ROLE_PREFIX)) continue;
    const name = roleKey.slice(CODEX_ROLE_PREFIX.length);
    assertSafePathSegment(name, 'codex role name');

    let nativeEntry;
    try {
      nativeEntry = getAgent(ctx.inventory, name);
    } catch (error) {
      // Only "no native counterpart" is expected and silently skippable; anything else (a bug in
      // getAgent, a future error type) must fail loudly rather than quietly drop the role.
      if (error instanceof RouterError && error.code === 'agent-unknown') continue;
      throw error;
    }
    if (nativeEntry.client !== 'codex') continue;

    const merged: Record<string, unknown> = { ...nativeEntry.native, model: role.routeOverride };
    files.push({ relativePath: `${ctx.clientDir}/agents/${name}.toml`, content: dumpToml(merged) }); // dumpToml throws loudly on an unsupported native shape
    exportedRoles.add(name);
  }

  // Optional: only when the operator opted in AND a snapshot was actually available to draw
  // models from. `emitModelCatalog` is a real OperatorConfig field, not an invented flag.
  if (ctx.config.harness.codex.emitModelCatalog && catalog !== undefined) {
    const models = [...catalog.byId.values()]
      .filter((model) => model.enabled)
      .map((model) => ({ id: model.id, alias: model.alias, ...(model.description === undefined ? {} : { description: model.description }) }));
    files.push({ relativePath: `${ctx.clientDir}/model_catalog.json`, content: `${JSON.stringify({ models }, null, 2)}\n` });
  }

  const programPath = join(ctx.packageRoot, 'dist', 'codex-hook.js');
  const sidecarPath = join(ctx.targetDir, 'sidecar.json');
  const fragment = {
    // Naming-only: Codex PreToolUse wiring is unmeasured (M7 pending), not confirmed support.
    _status: 'naming-only: Codex PreToolUse wiring is unmeasured (M7 pending); do not treat as confirmed native support',
    hookEventName: 'PreToolUse',
    matcher: 'Agent',
    command: [posixQuote(programPath), '--config', posixQuote(ctx.absoluteConfigPath), '--sidecar', posixQuote(sidecarPath), '--profile-dir', posixQuote(ctx.profileDir)].join(' '),
  };
  files.push({ relativePath: `${ctx.clientDir}/pretooluse-fragment.json`, content: `${JSON.stringify(fragment, null, 2)}\n` });

  return { files, exportedRoles };
}

function buildSidecar(
  client: ClientId,
  ctx: BuildContext,
  state: { generation: string; configHash: string; snapshotHash: string | null },
  hashes: Record<string, string>,
  exportedCodexRoles: ReadonlySet<string>,
): ExportFile {
  const base = {
    client,
    snapshotGeneration: state.generation,
    configHash: state.configHash,
    snapshotHash: state.snapshotHash,
    // Hashes of the OTHER artifacts this export produced, over their exact final bytes. This
    // proves what was written, never that any native client actually loaded it.
    artifacts: hashes,
  };

  const extra: Record<string, unknown> =
    client === 'opencode'
      ? { providerId: ctx.config.harness.opencode.providerId, models: ctx.catalog !== undefined ? opencodeModelsSummary(ctx.catalog) : {} }
      : client === 'codex'
        ? { roles: codexRolesSummary(ctx.config, exportedCodexRoles) }
        : {};

  return {
    relativePath: `${ctx.clientDir}/sidecar.json`,
    content: `${JSON.stringify({ ...base, ...extra }, null, 2)}\n`,
  };
}

// --- exportConfig --------------------------------------------------------------------------

export interface ExportOptions {
  dryRun: boolean;
  force: boolean;
  inventory: AgentInventory;
  catalogRequired: boolean;
  // The pieces of the caller's environment the resolver needs to find every candidate native
  // agent root for every client (project cwd, home, and any extra scan directories), so
  // exportConfig can protect a root even when it holds no files yet. Per-client configRoot
  // overrides come from OperatorConfig.agentRoots, already loaded from configPath.
  resolverContext: { cwd: string; home: string; env: Env; additionalRoots: readonly string[] };
  // The state the caller already loaded from `configPath`, when it has one. The CLI reads the
  // agent inventory from that same state's roots, so passing it here keeps inventory and sidecar
  // on one generation even if the config file is edited between the two steps. Without it,
  // exportConfig loads the state itself.
  state?: LoadedState;
}

export async function exportConfig(configPath: string, client: ClientId, outputDir: string, options: ExportOptions): Promise<ExportFile[]> {
  const state = options.state ?? (await loadState(configPath));

  // OpenCode's variant generator structurally needs a catalog; every other client only needs one
  // when the caller explicitly requires it (`catalogRequired`).
  const needsCatalog = client === 'opencode' || options.catalogRequired;
  if (needsCatalog && state.snapshot === undefined) {
    throw new RouterError('export-snapshot-missing', `export-snapshot-missing: a models.lock.json snapshot is required to export ${client}`);
  }
  const catalog = state.snapshot !== undefined ? buildCatalog(state.config, state.snapshot) : undefined;

  // Every candidate native root, for every client, resolved once up front: reused for both the
  // parent output directory check below and the concrete per-client target check further down.
  const protectedRoots = await resolveProtectedRoots(allCandidateNativeRoots(options.resolverContext, state.config));

  const resolvedOutputDir = await resolveRealPath(outputDir);
  assertNoOverlapWithResolvedRoots(resolvedOutputDir, protectedRoots);

  const clientDir = clientDirName(client);
  const target = join(resolvedOutputDir, clientDir);
  // `target` is a fresh lexical join, not yet proven free of its own symlink: resolving and
  // checking it separately catches a target that is itself a symlink into a protected root even
  // when resolvedOutputDir alone does not overlap anything.
  assertNoOverlapWithResolvedRoots(await resolveRealPath(target), protectedRoots);

  const packageRoot = findPackageRoot(import.meta.dir);

  const ctx: BuildContext = {
    config: state.config,
    ...(catalog !== undefined ? { catalog } : {}),
    inventory: options.inventory,
    generation: state.generation,
    absoluteConfigPath: resolve(configPath),
    packageRoot,
    profileDir: join(packageRoot, 'dist', 'capabilities'),
    clientDir,
    targetDir: target,
  };

  let files: ExportFile[];
  let exportedCodexRoles: ReadonlySet<string> = new Set();
  switch (client) {
    case 'claude-code':
      files = buildClaudeFiles(ctx);
      break;
    case 'opencode': {
      if (catalog === undefined) {
        // Unreachable given the needsCatalog check above; kept as an explicit, fail-loud guard
        // rather than a non-null assertion so a future refactor cannot silently reintroduce the gap.
        throw new RouterError('export-snapshot-missing', `export-snapshot-missing: a models.lock.json snapshot is required to export ${client}`);
      }
      files = buildOpencodeFiles(ctx, catalog);
      break;
    }
    case 'codex': {
      const result = buildCodexFiles(ctx, catalog);
      files = result.files;
      exportedCodexRoles = result.exportedRoles;
      break;
    }
  }

  // Containment is checked on every planned path before anything else happens with the plan:
  // before hashing, before the collision check, before the dry-run return, before any write.
  const stagedRelativePaths = new Map<string, string>();
  for (const file of files) {
    stagedRelativePaths.set(file.relativePath, assertPlanPathContained(target, clientDir, file.relativePath));
  }

  const hashes: Record<string, string> = {};
  for (const file of files) {
    hashes[file.relativePath] = await sha256(file.content);
  }

  const sidecar = buildSidecar(
    client,
    ctx,
    { generation: state.generation, configHash: state.expected.configHash, snapshotHash: state.expected.snapshotHash },
    hashes,
    exportedCodexRoles,
  );
  stagedRelativePaths.set(sidecar.relativePath, assertPlanPathContained(target, clientDir, sidecar.relativePath));
  const plan = [...files, sidecar];

  // A dry run reports the plan and writes nothing, so a prior artifact set is not a collision
  // for it; --force is only about replacing files, which never happens here. Native-root and
  // containment checks above still run unconditionally for dry runs.
  if (options.dryRun) return plan;

  const alreadyExists = await pathExists(target);
  if (alreadyExists && !options.force) {
    throw new RouterError('export-collision', `export-collision: ${target} already exists; pass --force to replace it`);
  }

  await mkdir(resolvedOutputDir, { recursive: true });
  const stagingDir = await mkdtemp(join(resolvedOutputDir, '.subagent-router-export-'));
  try {
    for (const file of plan) {
      const relativeToClient = stagedRelativePaths.get(file.relativePath);
      if (relativeToClient === undefined) {
        throw new RouterError('export-plan-invariant', `export-plan-invariant: ${file.relativePath} was never containment-checked`);
      }
      const stagedPath = join(stagingDir, relativeToClient);
      await mkdir(dirname(stagedPath), { recursive: true });
      await writeFile(stagedPath, file.content, { flag: 'wx' });
    }

    if (alreadyExists) {
      // Three-step swap: back the old set up, move the new set in, then drop the backup. The
      // only failure window is between the two renames; if the second one throws, the backup is
      // restored so the operator never ends up with neither the old nor the new artifacts.
      const backupDir = `${target}.subagent-router-old-${process.pid}-${Date.now()}`;
      await rename(target, backupDir);
      try {
        await rename(stagingDir, target);
      } catch (error) {
        await rename(backupDir, target);
        throw error;
      }
      await rm(backupDir, { recursive: true, force: true });
    } else {
      await rename(stagingDir, target);
    }
  } finally {
    // No-op once the staging dir was itself renamed into place; still needed on the collision
    // and native-root failure paths above, where staging was never created, and on any error
    // thrown while writing into staging.
    await rm(stagingDir, { recursive: true, force: true });
  }

  return plan;
}
