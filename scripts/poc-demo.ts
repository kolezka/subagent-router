#!/usr/bin/env bun
// SYNTHETIC LOCAL DEMO. Config, snapshot and the claude-code capability profile below are
// hermetic fixtures, not a measurement of a real Claude Code client. The transport (fetch
// adapter + transport capability profile) is real and measured, and createHandler is the
// real, final implementation. This proves the routing HTTP slice end to end on loopback:
//   - a parent (no billing marker) request passes through with its client-supplied model intact
//   - a child request carrying an explicit <subagent-router v="1" model="..."/> marker gets its
//     model switched to the configured upstream model before forwarding
//   - a child request with no marker and no configured default is refused before ever reaching
//     the upstream gateway (missing-selection)
//   - the decoded gateway reply text matches the fixture gateway's known reply exactly
// It does not talk to any real provider and proves nothing about native Claude Code support:
// see docs/poc.md.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelAlias, sourceFingerprint } from '../src/core/hash';
import type { CapabilityProfile, CliDeps, Env } from '../src/core/types';

const BANNER = '=== SYNTHETIC LOCAL DEMO (synthetic client profile, real transport, real handler) ===';

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAPABILITY_FIXTURES_DIR = join(WORKTREE_ROOT, 'tests', 'fixtures', 'capabilities');
const TESTS_TMP_ROOT = join(WORKTREE_ROOT, 'tests', 'tmp');

const UPSTREAM_MODEL_ID = 'demo-gateway/child-worker';
const CHILD_ALIAS = 'child-worker';
const SOURCE_ID = 'demo-source';
const BILLING_MARKER = 'x-anthropic-billing-header: cc_is_subagent=true';

// The only synthetic piece: no measured claude-code capability profile exists yet (Task 15).
// scripts/poc-serve.ts refuses this exact shape (version contains "synthetic").
const SYNTHETIC_CLAUDE_PROFILE: CapabilityProfile = {
  client: 'claude-code',
  version: 'synthetic-hermetic',
  status: 'supported',
  correlation: false,
  correlationEntropy: 'pending',
  fork: false,
  adapterMarkerPosition: 'first-user',
  probes: { M10: 'passed' },
  lifecycle: { 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' },
};

function fail(message: string): never {
  process.stderr.write(`DEMO FAILED: ${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  process.stdout.write(`  ok: ${label} = ${JSON.stringify(actual)}\n`);
}

function anthropicMessageBody(system: readonly string[], userText: string, model: string): Record<string, unknown> {
  return {
    model,
    system: system.map((text) => ({ type: 'text', text })),
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    max_tokens: 64,
  };
}

async function main(): Promise<void> {
  process.stdout.write(`${BANNER}\n`);

  const { startCaptureGateway, DEFAULT_REPLY_TEXT } = await import('../tests/support/capture-gateway');
  const { bunRawFetch, BUN_RAW_FETCH_ADAPTER } = await import('../src/transport/bun-fetch');
  const { loadTransportCapabilityProfile } = await import('../src/adapters/capabilities');

  const gateway = await startCaptureGateway();
  process.stdout.write(`fixture gateway (stands in for 9router/OmniRoute) listening on ${gateway.url}\n`);

  const transportProfile = await loadTransportCapabilityProfile(
    BUN_RAW_FETCH_ADAPTER.id,
    BUN_RAW_FETCH_ADAPTER.runtimeVersion,
    CAPABILITY_FIXTURES_DIR,
  );
  process.stdout.write(
    `measured transport profile: ${transportProfile.adapterId}@${transportProfile.runtimeVersion} status=${transportProfile.status}\n`,
  );

  await mkdir(TESTS_TMP_ROOT, { recursive: true });
  const workDir = await mkdtemp(join(TESTS_TMP_ROOT, 'poc-demo-'));
  let server: { url: string; generation: string; stop: () => Promise<void> } | undefined;

  try {
    const gatewayUrl = `${gateway.url}/v1`;
    const modelsUrl = `${gateway.url}/v1/models`;
    const fingerprint = await sourceFingerprint(SOURCE_ID, gatewayUrl, modelsUrl);
    const upstreamAlias = await modelAlias(UPSTREAM_MODEL_ID);

    const config = {
      version: 1,
      modelSource: {
        sourceId: SOURCE_ID,
        baseUrlEnv: 'DEMO_GATEWAY_URL',
        endpointPath: '/v1/models',
        headersEnv: [],
        timeoutMs: 5000,
        fetchLimit: 100,
        staleAfterSeconds: 86400,
      },
      modelOverrides: {
        [UPSTREAM_MODEL_ID]: { alias: CHILD_ALIAS, description: 'Demo child worker.', enabled: true },
      },
      roles: {},
      defaults: { child: null, unmarkedSubagent: 'error' as const },
      agentRoots: {
        'claude-code': { configRoot: null },
        opencode: { configRoot: null },
        codex: { configRoot: null },
      },
      gateway: { urlEnv: 'DEMO_GATEWAY_URL', headersEnv: [] },
      harness: {
        claudeCode: { correlation: 'off' as const, secretEnv: 'DEMO_ROUTER_SECRET' },
        opencode: { providerId: 'demo' },
        codex: { emitModelCatalog: false },
      },
    };

    const snapshot = {
      version: 1,
      sourceId: SOURCE_ID,
      sourceFingerprint: fingerprint,
      fetchedAt: new Date(0).toISOString(),
      models: [{ id: UPSTREAM_MODEL_ID, alias: upstreamAlias, status: 'available' as const, metadata: {} }],
    };

    const configPath = join(workDir, 'subagent-router.json');
    const snapshotPath = join(workDir, 'models.lock.json');
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

    const env: Env = { DEMO_GATEWAY_URL: gatewayUrl };
    const deps: CliDeps = {
      cwd: workDir,
      home: workDir,
      env,
      stdout: (text) => process.stdout.write(`[server] ${text}\n`),
      stderr: (text) => process.stderr.write(`[server] ${text}\n`),
      isTTY: false,
      fetch: bunRawFetch,
      fetchAdapter: BUN_RAW_FETCH_ADAPTER,
      loadProfile: async () => SYNTHETIC_CLAUDE_PROFILE,
      loadTransportProfile: async () => transportProfile,
      now: () => new Date(),
    };

    const { startServer } = await import('../src/cli/serve');
    server = await startServer(configPath, deps, { port: 0, host: '127.0.0.1', claudeVersion: SYNTHETIC_CLAUDE_PROFILE.version });
    process.stdout.write(`router listening on ${server.url} (generation ${server.generation})\n`);

    // 1. Parent request (no billing marker): model must pass through unchanged.
    const parentModel = 'claude-parent-model';
    const parentResponse = await fetch(`${server.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(anthropicMessageBody([], 'hello from the parent', parentModel)),
    });
    assertEqual(parentResponse.status, 200, 'parent request status');
    const parentUpstream = gateway.requests.at(-1);
    if (parentUpstream === undefined) fail('parent request never reached the fixture gateway');
    assertEqual(parentUpstream!.model, parentModel, 'parent model preserved on the upstream request');

    // 2. Child request with an explicit marker: model must switch to the configured upstream model.
    const markedBody = anthropicMessageBody([BILLING_MARKER], `<subagent-router v="1" model="${CHILD_ALIAS}"/>\ndo the child task`, 'claude-child-default');
    const childResponse = await fetch(`${server.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(markedBody),
    });
    assertEqual(childResponse.status, 200, 'marked child request status');
    const childPayload = (await childResponse.json()) as { content?: Array<{ type?: string; text?: string }> };
    const replyText = childPayload.content?.find((block) => block.type === 'text')?.text;
    assertEqual(replyText, DEFAULT_REPLY_TEXT, 'decoded gateway reply text');
    const childUpstream = gateway.requests.at(-1);
    if (childUpstream === undefined) fail('marked child request never reached the fixture gateway');
    assertEqual(childUpstream!.model, UPSTREAM_MODEL_ID, 'child model switched to the configured upstream model');

    // 3. Child request with no marker and no default: must be refused before touching the gateway.
    const requestsBeforeRefusal = gateway.requests.length;
    const unmarkedBody = anthropicMessageBody([BILLING_MARKER], 'no marker here, just do it', 'claude-child-default');
    const refusedResponse = await fetch(`${server.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(unmarkedBody),
    });
    assertEqual(refusedResponse.status, 422, 'unmarked child request refused with 422');
    const refusedPayload = (await refusedResponse.json()) as { error?: { code?: string } };
    assertEqual(refusedPayload.error?.code, 'missing-selection', 'refusal reports missing-selection');
    assertEqual(gateway.requests.length, requestsBeforeRefusal, 'no forbidden upstream request was made for the refused child');

    process.stdout.write('\nAll synthetic demo checks passed.\n');
    process.stdout.write('This proves the routing HTTP slice, not native Claude Code support. See docs/poc.md.\n');
  } finally {
    if (server !== undefined) await server.stop();
    await gateway.close();
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
