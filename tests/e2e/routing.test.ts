// Task 15 Step 1: hermetic E2E tests against the real startServer/createHandler pipeline and a
// real loopback capture gateway, plus boundary tests for the package's dependency/import contract.
// Everything runs under tests/tmp with an isolated HOME; network is loopback only.
//
// startCaptureGateway() binds a real ephemeral port. A snapshot fingerprinted against a fixed
// placeholder URL (as tests/support/fixtures.ts snapshotFixture() does) would fail
// validateSource() as a source mismatch, so writeFixtureState() below fingerprints against the
// actual resolved gateway URL, matching the pattern already used in tests/cli/serve.test.ts.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { startServer } from '../../src/cli/serve';
import { modelAlias, sourceFingerprint } from '../../src/core/hash';
import type { CatalogSnapshot, CliDeps, Env, OperatorConfig } from '../../src/core/types';
import { resolveSource } from '../../src/io/environment';
import { DEFAULT_REPLY_TEXT, startCaptureGateway } from '../support/capture-gateway';
import { FIXTURE_FETCHED_AT, configFixture } from '../support/fixtures';

const ROOT = join(import.meta.dir, '..', '..');
const SRC_DIR = join(ROOT, 'src');
const TESTS_TMP_DIR = join(ROOT, 'tests', 'tmp');

const CHILD_SYSTEM = [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }];

async function writeFixtureState(dir: string, gatewayEnvUrl: string, config: OperatorConfig, modelIds: readonly string[]): Promise<void> {
  await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(config));
  const env: Env = { GATEWAY_URL: gatewayEnvUrl, GATEWAY_HEADERS: '{}', MODELS_AUTH: 't' };
  const source = resolveSource(config, env);
  const models = await Promise.all(
    modelIds.map(async (id) => ({ id, alias: await modelAlias(id), status: 'available' as const, metadata: {} })),
  );
  const snapshot: CatalogSnapshot = {
    version: 1,
    sourceId: source.sourceId,
    sourceFingerprint: await sourceFingerprint(source.sourceId, source.effectiveGatewayUrl, source.effectiveModelsUrl),
    fetchedAt: FIXTURE_FETCHED_AT,
    models,
  };
  await writeFile(join(dir, 'models.lock.json'), JSON.stringify(snapshot));
}

function syntheticE2eDeps(dir: string, gatewayEnvUrl: string): CliDeps {
  return {
    cwd: dir,
    home: dir,
    env: { GATEWAY_URL: gatewayEnvUrl, GATEWAY_HEADERS: '{}', MODELS_AUTH: 't', ROUTER_SECRET: 's' },
    stdout: () => {},
    stderr: () => {},
    isTTY: false,
    fetch: (request) => fetch(request),
    fetchAdapter: { id: 'fixture-fetch', runtimeVersion: 'synthetic-hermetic' },
    loadProfile: async () => ({
      client: 'claude-code',
      version: 'synthetic-hermetic',
      status: 'supported',
      correlation: false,
      correlationEntropy: 'pending',
      fork: false,
      adapterMarkerPosition: 'unknown',
      probes: { M10: 'passed' },
      lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' },
    }),
    loadTransportProfile: async (adapterId, runtimeVersion) => ({ adapterId, runtimeVersion, status: 'passed', gzipBytes: 'passed', responseHeaders: 'passed' }),
    now: () => new Date(),
  };
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

describe('e2e routing through fake gateway', () => {
  let dir = '';

  beforeEach(async () => {
    await mkdir(TESTS_TMP_DIR, { recursive: true });
    dir = await mkdtemp(join(TESTS_TMP_DIR, 'subagent-router-e2e-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('parent A and concurrent children B and C route to the correct models, marker does not leak, opaque IDs with spaces and case survive', async () => {
    const gateway = await startCaptureGateway();
    const gatewayEnvUrl = `${gateway.url}/v1`;
    const config = configFixture();
    config.modelOverrides['gateway/model B'] = { alias: 'b', description: 'B' };
    config.modelOverrides['gateway/Model-C'] = { alias: 'c', description: 'C' };
    await writeFixtureState(dir, gatewayEnvUrl, config, ['gateway/fast-worker', 'gateway/model B', 'gateway/Model-C']);
    const deps = syntheticE2eDeps(dir, gatewayEnvUrl);
    const server = await startServer(join(dir, 'subagent-router.json'), deps, { port: 0, host: '127.0.0.1' });
    try {
      await Promise.all([
        post(server.url, { model: 'claude-opus', messages: [{ role: 'user', content: 'parent' }] }),
        post(
          server.url,
          { model: 'claude-haiku', system: CHILD_SYSTEM, messages: [{ role: 'user', content: '<subagent-router v="1" model="b"/>\nB' }] },
          { 'x-claude-code-agent-id': 'agent B one' },
        ),
        post(
          server.url,
          { model: 'claude-haiku', system: CHILD_SYSTEM, messages: [{ role: 'user', content: '<subagent-router v="1" model="c"/>\nC' }] },
          { 'x-claude-code-agent-id': 'AGENT c TWO' },
        ),
      ]);
      const models = gateway.requests.map((r) => r.model).sort();
      expect(models).toEqual(['claude-opus', 'gateway/Model-C', 'gateway/model B']);
      expect(JSON.stringify(gateway.requests.map((r) => r.body))).not.toContain('subagent-router');
      const agentIds = gateway.requests.map((r) => r.agentId).filter((id): id is string => id !== undefined).sort();
      expect(agentIds).toEqual(['AGENT c TWO', 'agent B one']); // spaces and case unchanged
    } finally {
      await server.stop();
      await gateway.close();
    }
  });

  test('synthetic roundtrip preserves tool_use, tool_result, and the transported model', async () => {
    const gateway = await startCaptureGateway();
    const gatewayEnvUrl = `${gateway.url}/v1`;
    const config = configFixture();
    config.modelOverrides['gateway/model B'] = { alias: 'b', description: 'B' };
    await writeFixtureState(dir, gatewayEnvUrl, config, ['gateway/fast-worker', 'gateway/model B']);
    const deps = syntheticE2eDeps(dir, gatewayEnvUrl);
    const server = await startServer(join(dir, 'subagent-router.json'), deps, { port: 0, host: '127.0.0.1' });
    try {
      const first = await post(
        server.url,
        {
          model: 'claude-haiku',
          system: CHILD_SYSTEM,
          messages: [{ role: 'user', content: '<subagent-router v="1" model="b"/>\nUse the tool' }],
          tools: [{ name: 'read_fixture', input_schema: { type: 'object' } }],
        },
        { 'x-claude-code-agent-id': 'agent-b' },
      );
      const firstBody = (await first.json()) as { content: Array<{ type: string; id?: string; name?: string }> };
      const toolUse = firstBody.content.find((part) => part.type === 'tool_use');
      expect(toolUse?.name).toBe('read_fixture');
      expect(typeof toolUse?.id).toBe('string');

      const nonce = 'fixture-file-nonce-7c10';
      const second = await post(
        server.url,
        {
          model: 'claude-haiku',
          system: CHILD_SYSTEM,
          messages: [
            { role: 'user', content: '<subagent-router v="1" model="b"/>\nRead the fixture file via the tool' },
            { role: 'assistant', content: firstBody.content },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse?.id, content: nonce }] },
          ],
        },
        { 'x-claude-code-agent-id': 'agent-b' },
      );
      const finalBody = (await second.json()) as { content: Array<{ type: string; text?: string }> };
      expect(second.status).toBe(200);
      // Both captured upstream models are the routed model: the decision held across both turns.
      expect(gateway.requests.map((r) => r.model)).toEqual(['gateway/model B', 'gateway/model B']);
      // Decoded final text literally contains the nonce, not just content.length or a self-report.
      expect(finalBody.content.some((part) => part.type === 'text' && part.text?.includes(nonce))).toBe(true);
    } finally {
      await server.stop();
      await gateway.close();
    }
  });

  test('opaque-identifiers-survive-gateway-endpoint-swap', async () => {
    // The opacity requirement is on the upstream MODEL ID: the same exact mixed-case,
    // space-containing ID must route and decode identically through two distinct gateway
    // endpoints. Agent-id case is varied too as free extra coverage of the same header path.
    const OPAQUE_MODEL_ID = 'gateway/Model With Spaces AND Caps';
    const agentIds = ['Agent One (space)', 'agent TWO caps'];
    const observed: Array<{
      gatewayUrl: string;
      status: number;
      capturedModel: string | undefined;
      capturedAgentId: string | undefined;
      sentAgentId: string;
    }> = [];

    for (const agentId of agentIds) {
      const gateway = await startCaptureGateway();
      const gatewayEnvUrl = `${gateway.url}/v1`;
      const config = configFixture();
      config.modelOverrides[OPAQUE_MODEL_ID] = { alias: 'swap', description: 'swap target' };
      await writeFixtureState(dir, gatewayEnvUrl, config, [OPAQUE_MODEL_ID]);
      const deps = syntheticE2eDeps(dir, gatewayEnvUrl);
      const server = await startServer(join(dir, 'subagent-router.json'), deps, { port: 0, host: '127.0.0.1' });
      try {
        const response = await post(
          server.url,
          { model: 'claude-haiku', system: CHILD_SYSTEM, messages: [{ role: 'user', content: '<subagent-router v="1" model="swap"/>\nTask' }] },
          { 'x-claude-code-agent-id': agentId },
        );
        const body = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
        // Decoded reply, not just a status code: the fixed non-empty gateway reply text.
        expect(body.content?.some((part) => part.type === 'text' && part.text === DEFAULT_REPLY_TEXT)).toBe(true);
        observed.push({
          gatewayUrl: gateway.url,
          status: response.status,
          capturedModel: gateway.requests[0]?.model,
          capturedAgentId: gateway.requests[0]?.agentId,
          sentAgentId: agentId,
        });
      } finally {
        await server.stop();
        await gateway.close();
      }
    }

    const [first, second] = observed;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.gatewayUrl).not.toBe(second?.gatewayUrl); // the swap really happened
    for (const o of observed) {
      expect(o.status).toBe(200);
      expect(o.capturedModel).toBe(OPAQUE_MODEL_ID); // exact spaces/case survive routing
      expect(o.capturedAgentId).toBe(o.sentAgentId);
    }
    expect(first?.capturedModel).toBe(second?.capturedModel); // identical opaque ID across the swap
  });

  test('unrecognized-fork-pass-through-and-recognized-fork-follows-w19', async () => {
    const gateway = await startCaptureGateway();
    const gatewayEnvUrl = `${gateway.url}/v1`;
    const config = configFixture(); // defaults.unmarkedSubagent stays 'error' (fixture default)
    await writeFixtureState(dir, gatewayEnvUrl, config, ['gateway/fast-worker']);
    const deps = syntheticE2eDeps(dir, gatewayEnvUrl);
    const server = await startServer(join(dir, 'subagent-router.json'), deps, { port: 0, host: '127.0.0.1' });
    try {
      // Unrecognized fork: no billing header, so the router has no signal this is a subagent.
      // It must classify as parent and pass the client-declared model through untouched.
      const unrecognized = await post(
        server.url,
        { model: 'claude-forked-model', messages: [{ role: 'user', content: 'forked but unmarked' }] },
        { 'x-claude-code-agent-id': 'forked-agent' },
      );
      expect(unrecognized.status).toBe(200);
      expect(gateway.requests[0]?.model).toBe('claude-forked-model');
      expect(gateway.requests[0]?.isChild).toBe(false);

      // Recognized fork: billing header present, but no marker and no correlation. D3 and
      // requirement 19: fail loud with missing-selection, never reach the gateway.
      const recognized = await post(
        server.url,
        { model: 'claude-forked-model', system: CHILD_SYSTEM, messages: [{ role: 'user', content: 'forked and recognized, still no selection' }] },
        { 'x-claude-code-agent-id': 'forked-agent' },
      );
      expect(recognized.status).toBe(422);
      expect(((await recognized.json()) as { error: { code: string } }).error.code).toBe('missing-selection');
      expect(gateway.requests).toHaveLength(1); // only the first (pass-through) request reached the gateway
    } finally {
      await server.stop();
      await gateway.close();
    }
  });
});

// Boundary tests: no gateway/SDK/KB dependency or import, no vendor selector.
// Each detector is proven against a poisoned input first, then run against the real files, so an
// always-empty search cannot pass silently as if it had actually checked something.

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTsFiles(full)));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

// Regex-based specifier extraction, not a real TS/AST parser: it handles this repo's consistent
// single-line import/export-from style and would miss unusual multi-line or computed specifiers.
const FROM_SPECIFIER_RE = /\bfrom\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+['"]([^'"]+)['"]/gm;

function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const re of [FROM_SPECIFIER_RE, DYNAMIC_IMPORT_RE, SIDE_EFFECT_IMPORT_RE]) {
    re.lastIndex = 0;
    let match = re.exec(source);
    while (match !== null) {
      const spec = match[1];
      if (spec !== undefined) specifiers.push(spec);
      match = re.exec(source);
    }
  }
  return specifiers;
}

async function resolveRelativeSpecifier(fromFile: string, spec: string): Promise<string> {
  const candidate = join(dirname(fromFile), `${spec}.ts`);
  await stat(candidate); // throws loudly if the flat-.ts-file resolution assumption stops holding
  return candidate;
}

interface ImportGraphResult {
  files: Set<string>;
  bareSpecifiers: Set<string>;
}

async function collectImportGraph(entryFiles: readonly string[]): Promise<ImportGraphResult> {
  const files = new Set<string>();
  const bareSpecifiers = new Set<string>();
  const queue: string[] = [...entryFiles];
  let file = queue.shift();
  while (file !== undefined) {
    if (!files.has(file)) {
      files.add(file);
      const source = await readFile(file, 'utf8');
      for (const spec of extractImportSpecifiers(source)) {
        if (spec.startsWith('node:')) continue;
        if (spec.startsWith('.')) {
          const resolved = await resolveRelativeSpecifier(file, spec);
          if (!files.has(resolved)) queue.push(resolved);
        } else {
          bareSpecifiers.add(spec);
        }
      }
    }
    file = queue.shift();
  }
  return { files, bareSpecifiers };
}

function findForbiddenMarkers(text: string, markers: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return markers.filter((marker) => lower.includes(marker.toLowerCase()));
}

describe('package boundaries (Task 15 Step 1): no SDK, KB, gateway, or selector', () => {
  test('core-and-handler-have-no-required-ai-sdk-or-kb-imports', async () => {
    // core/handler have zero external runtime deps today. An allowlist of permitted bare
    // specifiers catches any future addition, not only names matching a known vendor keyword.
    const PERMITTED_CORE_HANDLER_BARE_IMPORTS = new Set<string>();

    // Positive control: a small real file tree with a genuine forbidden bare import, walked by
    // the actual collectImportGraph (traversal and relative resolution), not a string match.
    const fixtureDir = await mkdtemp(join(TESTS_TMP_DIR, 'import-graph-fixture-'));
    try {
      await writeFile(join(fixtureDir, 'entry.ts'), "import { helper } from './child';\nexport { helper };\n");
      await writeFile(join(fixtureDir, 'child.ts'), "import { Anthropic } from '@anthropic-ai/sdk';\nexport function helper(): unknown { return Anthropic; }\n");
      const poisonedGraph = await collectImportGraph([join(fixtureDir, 'entry.ts')]);
      expect(poisonedGraph.files.size).toBe(2); // entry.ts + child.ts: real traversal happened
      expect(poisonedGraph.bareSpecifiers.has('@anthropic-ai/sdk')).toBe(true);
      expect(PERMITTED_CORE_HANDLER_BARE_IMPORTS.has('@anthropic-ai/sdk')).toBe(false); // would be rejected
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }

    const entryFiles = [join(SRC_DIR, 'index.ts'), join(SRC_DIR, 'transport', 'handler.ts')];
    const graph = await collectImportGraph(entryFiles);
    // Walker actually traversed the real multi-file graph, not a no-op on the two entry files.
    expect(graph.files.size).toBeGreaterThanOrEqual(10);
    for (const bare of graph.bareSpecifiers) {
      expect(PERMITTED_CORE_HANDLER_BARE_IMPORTS.has(bare)).toBe(true);
    }

    // A KB/MCP call can be made with no import at all (global fetch, a raw CLI spawn), so the
    // import graph above cannot see it. This is a source-policy guard, scanning source text for
    // known literal markers; it is not a runtime certification that no such call ever happens.
    // Bounded literal markers (quoted tokens, path segments), not loose substrings.
    const DIRECT_KB_MCP_CALL_MARKERS = [
      'mcp://',
      '/mcp', // matches both the bare terminal /mcp endpoint and any /mcp/... path
      'modelcontextprotocol',
      'knowledge-base',
      'mcp-cli',
      'kb-cli',
      "'kb'", // bounded: the quoted bare kb CLI token, e.g. Bun.spawn(['kb', ...])
    ];

    // Positive controls use no import statement at all: an HTTP call to the bare terminal /mcp
    // endpoint, and a CLI spawn of the bare 'kb' command. Neither is reachable via the import
    // graph walker above; both prove this separate check catches a call-only reference.
    const poisonedFetchNoImport = "export async function directMcpCall() { return fetch('http://127.0.0.1:4000/mcp', { method: 'POST' }); }";
    const poisonedSpawnNoImport = "export function directKbCall() { return Bun.spawn(['kb', 'ask', 'fixture']); }";
    expect(poisonedFetchNoImport.includes('import')).toBe(false);
    expect(poisonedSpawnNoImport.includes('import')).toBe(false);
    expect(findForbiddenMarkers(poisonedFetchNoImport, DIRECT_KB_MCP_CALL_MARKERS)).toContain('/mcp');
    expect(findForbiddenMarkers(poisonedSpawnNoImport, DIRECT_KB_MCP_CALL_MARKERS)).toContain("'kb'");

    for (const file of graph.files) {
      const source = await readFile(file, 'utf8');
      expect(findForbiddenMarkers(source, DIRECT_KB_MCP_CALL_MARKERS)).toEqual([]);
    }
  });

  test('no-vendor-branch-or-llm-selector', async () => {
    // Plain-text substring scan, not semantic analysis: it would miss an obfuscated or
    // dynamically-built vendor selector, only catches the literal markers below.
    const VENDOR_BRANCH_MARKERS = [
      'providers/',
      'selectprovider',
      'choosevendor',
      'autoselectmodel',
      'pickmodelforvendor',
      "'openai'",
      '@anthropic-ai',
      '@google/generative-ai',
      'cohere-ai',
      '@mistralai',
      'groq-sdk',
      'together-ai',
    ];
    const poisoned = "import OpenAI from 'openai';\nimport x from '../providers/openai';\nfunction selectProvider(vendor) { if (vendor === 'openai') return new OpenAI(); }";
    const controlHits = findForbiddenMarkers(poisoned, VENDOR_BRANCH_MARKERS);
    expect(controlHits).toContain('providers/');
    expect(controlHits).toContain('selectprovider');
    expect(controlHits.length).toBeGreaterThan(0);

    const files = await listTsFiles(SRC_DIR);
    expect(files.length).toBeGreaterThanOrEqual(10); // sanity: the walker found the real tree
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      expect(findForbiddenMarkers(source, VENDOR_BRANCH_MARKERS)).toEqual([]);
    }
  });

  test('package-has-no-ai-gateway-dependency-or-import', async () => {
    const AI_GATEWAY_PKG = '@the-next-ai/ai-gateway';
    const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

    function findGatewayDependencyFields(pkg: Record<string, unknown>): string[] {
      const hits: string[] = [];
      for (const field of DEPENDENCY_FIELDS) {
        const value = pkg[field];
        if (typeof value === 'object' && value !== null && AI_GATEWAY_PKG in value) hits.push(field);
      }
      return hits;
    }

    // Positive control: plant the package in all four fields and confirm all four are flagged.
    const poisonedPkg: Record<string, unknown> = Object.fromEntries(
      DEPENDENCY_FIELDS.map((field) => [field, { [AI_GATEWAY_PKG]: '1.0.0' }]),
    );
    expect(findGatewayDependencyFields(poisonedPkg)).toEqual([...DEPENDENCY_FIELDS]);

    // Real package.json: devDependencies exists (@types/bun, typescript); the other three fields
    // are absent entirely. None of the four contain the banned gateway package.
    const pkgText = await readFile(join(ROOT, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgText) as Record<string, unknown>;
    expect(findGatewayDependencyFields(pkg)).toEqual([]);

    // Positive control for the source-scan half.
    const poisonedImport = `import { forward } from '${AI_GATEWAY_PKG}';`;
    expect(poisonedImport.includes(AI_GATEWAY_PKG)).toBe(true);

    const files = await listTsFiles(SRC_DIR);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      expect(source.includes(AI_GATEWAY_PKG)).toBe(false);
    }
  });
});
