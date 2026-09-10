// Hermetic tests for the stage 2a channel-A handler fixture. Real createHandler,
// real HMAC/marker code, decoded SSE protocol responses. No sockets opened by
// these tests directly except the bounded child-process import check below
// (loopback-only, no real claude/opencode/codex process, killed on a timeout).
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCapabilityProfile } from '../../src/adapters/capabilities';
import {
  AGENT_TOOL_NAME,
  CHANNEL_A_AGENTS,
  PARENT_CLIENT_MODEL,
  SYNTHETIC_LAYOUT_SCAFFOLD_OVERRIDDEN_PATHS,
  buildChildRequest,
  buildParentRequest,
  createHandlerFixture,
  markerLine,
  realLayoutProfile,
  syntheticLayoutProfile,
} from './native-claude-handler';
import { diffCapturedAgainstReal } from './evidence-m3a';
import { nativeContextBlockV1, nativeLayoutUserMessage } from '../support/native-layout';

const CAPABILITIES_FIXTURES = join(import.meta.dir, '..', 'fixtures', 'capabilities');

function pathIsDeclared(path: string, declared: ReadonlySet<string>): boolean {
  if (declared.has(path)) return true;
  for (const entry of declared) {
    if (entry.endsWith('.*') && path.startsWith(entry.slice(0, -1))) return true;
  }
  return false;
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://router.local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Decodes an Anthropic SSE stream into its events, exactly what a real client
// parses -- never treated as opaque bytes.
async function decodeSse(response: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await response.text();
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const eventLine = block.split('\n').find((l) => l.startsWith('event: '));
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
    if (!eventLine || !dataLine) continue;
    events.push({ event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) });
  }
  return events;
}

// Reassembles the tool_use blocks a real client would build: one accumulated
// input object per content_block index, keyed by its declared tool name.
function reassembleToolUseBlocks(events: Array<{ event: string; data: Record<string, unknown> }>): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  const byIndex = new Map<number, { id: string; name: string; partial: string }>();
  for (const { event, data } of events) {
    if (event === 'content_block_start') {
      const block = data.content_block as Record<string, unknown>;
      if (block?.type === 'tool_use') {
        byIndex.set(data.index as number, { id: block.id as string, name: block.name as string, partial: '' });
      }
    }
    if (event === 'content_block_delta') {
      const delta = data.delta as Record<string, unknown>;
      if (delta?.type === 'input_json_delta') {
        const entry = byIndex.get(data.index as number);
        if (entry) entry.partial += delta.partial_json as string;
      }
    }
  }
  return [...byIndex.values()].map((e) => ({ id: e.id, name: e.name, input: JSON.parse(e.partial) as Record<string, unknown> }));
}

function stopReasonOf(events: Array<{ event: string; data: Record<string, unknown> }>): unknown {
  const messageDelta = events.find((e) => e.event === 'message_delta');
  return (messageDelta?.data.delta as Record<string, unknown> | undefined)?.stop_reason;
}

function textOf(events: Array<{ event: string; data: Record<string, unknown> }>): string {
  return events
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => (e.data.delta as Record<string, unknown>)?.text)
    .filter((t): t is string => typeof t === 'string')
    .join('');
}

// Real Anthropic-shaped "final parent turn" request: the assistant's prior
// tool_use call plus the user's tool_result reply. Ties to the fixture's own
// synthetic tool_use ids (toolu_probe_0 / toolu_probe_1, one per CHANNEL_A_AGENTS
// index) -- this file and native-claude-handler.ts are the same authored fixture,
// not opaque production code, so that coupling is documented here rather than
// re-exported ceremony. The two-text-block content shape (the echo, then an
// agentId/<usage> metadata block) mirrors the real 2.1.266 capture at
// tests/probes/.runs/delegate-ELrKLv/capture/005-parent_final.json -- only the
// STRUCTURE is reused here; ids/prompts/text values below are synthetic.
function nativeStyleResultContent(echoText: string): Array<{ type: 'text'; text: string }> {
  return [
    { type: 'text', text: echoText },
    { type: 'text', text: 'agentId: fake-agent-id (use SendMessage to continue)\n<usage>subagent_tokens: 1\ntool_uses: 0\nduration_ms: 1</usage>' },
  ];
}

function buildParentFinalRequest(
  results: Array<{ toolUseId: string; content: Array<{ type: 'text'; text: string }>; isError?: boolean }>,
): Record<string, unknown> {
  return {
    model: PARENT_CLIENT_MODEL,
    max_tokens: 512,
    system: [{ type: 'text', text: 'You are the parent.' }],
    messages: [
      { role: 'user', content: 'Say hi via two subagents' },
      {
        role: 'assistant',
        content: results.map((r, i) => ({ type: 'tool_use', id: r.toolUseId, name: AGENT_TOOL_NAME, input: { subagent_type: CHANNEL_A_AGENTS[i]?.name } })),
      },
      {
        role: 'user',
        content: results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.toolUseId,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      },
    ],
    tools: [
      {
        name: AGENT_TOOL_NAME,
        description: 'Delegate work to a subagent.',
        input_schema: { type: 'object', properties: { prompt: { type: 'string' } } },
      },
    ],
  };
}

describe('native-claude-handler.ts import', () => {
  test('importing (not executing) the module starts no server, even with RUN_NATIVE_PROBES=1', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'handler-fixture-import-'));
    const captureDir = join(outDir, 'capture');
    const wrapperPath = join(outDir, 'wrapper.ts');
    const modulePath = join(import.meta.dir, 'native-claude-handler.ts');
    // A static import of the module from a DIFFERENT entry file: import.meta.main
    // must read false inside native-claude-handler.ts here, unlike when bun runs
    // it directly as `bun tests/probes/native-claude-handler.ts`.
    writeFileSync(wrapperPath, `import ${JSON.stringify(modulePath)};\nconsole.log('imported-ok');\n`);

    const result = spawnSync(process.execPath, ['run', wrapperPath], {
      env: { ...process.env, RUN_NATIVE_PROBES: '1', PROBE_OUT: captureDir },
      timeout: 1500,
      encoding: 'utf8',
    });

    expect(result.stdout ?? '').toContain('imported-ok');
    // A hung listening server needs the timeout to kill it (SIGTERM); a module
    // that merely finished evaluating exits on its own well before that.
    expect(result.signal).not.toBe('SIGTERM');
    expect(existsSync(join(captureDir, 'port'))).toBe(false);
    expect(existsSync(join(captureDir, 'front-port'))).toBe(false);
  });
});

describe('channel-A handler fixture', () => {
  test('parent request receives a real decoded Agent tool-use response with two distinct first-line markers', async () => {
    const { handler } = await createHandlerFixture();
    const res = await handler(jsonRequest('/v1/messages', buildParentRequest()));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const events = await decodeSse(res);
    const toolUses = reassembleToolUseBlocks(events);
    expect(toolUses).toHaveLength(CHANNEL_A_AGENTS.length);

    const aliasesSeen = new Set<string>();
    for (const [i, agent] of CHANNEL_A_AGENTS.entries()) {
      const call = toolUses[i];
      expect(call?.name).toBe(AGENT_TOOL_NAME);
      const prompt = call?.input.prompt as string;
      const firstLine = prompt.split('\n')[0];
      expect(firstLine).toBe(markerLine(agent.alias));
      aliasesSeen.add(agent.alias);
    }
    expect(aliasesSeen.size).toBe(CHANNEL_A_AGENTS.length); // two DISTINCT aliases, not the same one twice
  });

  test('routed child requests select the correct distinct upstream model per alias and lose the accepted marker', async () => {
    const { handler, seen } = await createHandlerFixture();

    for (const agent of CHANNEL_A_AGENTS) {
      const res = await handler(jsonRequest('/v1/messages', buildChildRequest(agent.alias, `task for ${agent.name}`)));
      expect(res.status).toBe(200);
      const events = await decodeSse(res);
      const delta = events.find((e) => e.event === 'content_block_delta');
      expect((delta?.data.delta as Record<string, unknown>)?.text).toBe(`CHILD_SAW_MODEL=${agent.upstreamModel}`);
    }

    const upstreamModelsUsed = seen.map((r) => r.body.model);
    expect(new Set(upstreamModelsUsed).size).toBe(CHANNEL_A_AGENTS.length); // distinct per agent
    expect(upstreamModelsUsed).toEqual(CHANNEL_A_AGENTS.map((a) => a.upstreamModel));

    for (const [i, agent] of CHANNEL_A_AGENTS.entries()) {
      const forwardedBody = seen[i]?.body;
      const messages = forwardedBody?.messages as Array<{ content: Array<{ type: string; text: string }> }>;
      const forwardedText = messages[0]?.content[0]?.text ?? '';
      expect(forwardedText.startsWith(markerLine(agent.alias))).toBe(false); // accepted marker is stripped before forwarding
      expect(forwardedText).toBe(`task for ${agent.name}`);
    }
  });

  test('a parent turn carrying correct child tool_results (with a real native metadata block alongside the echo) ends the loop with a matched sentinel, never another tool_use', async () => {
    const { handler } = await createHandlerFixture();
    await handler(jsonRequest('/v1/messages', buildParentRequest())); // first turn: populates the fixture's pending tool_use map

    const results = CHANNEL_A_AGENTS.map((agent, i) => ({
      toolUseId: `toolu_probe_${i}`,
      content: nativeStyleResultContent(`CHILD_SAW_MODEL=${agent.upstreamModel}`),
    }));
    const res = await handler(jsonRequest('/v1/messages', buildParentFinalRequest(results)));
    expect(res.status).toBe(200);
    const events = await decodeSse(res);

    expect(reassembleToolUseBlocks(events)).toHaveLength(0); // no further delegation: the loop must end here
    expect(stopReasonOf(events)).toBe('end_turn');
    expect(textOf(events)).toBe('PARENT_FINAL_OK'); // the trailing agentId/<usage> block must not break exact matching
  });

  test('wrong tool_result content cannot fake the matched sentinel, and still never re-emits tool_use', async () => {
    const { handler } = await createHandlerFixture();
    await handler(jsonRequest('/v1/messages', buildParentRequest())); // first turn: populates the fixture's pending tool_use map

    const wrongResults = [
      { toolUseId: 'toolu_probe_0', content: nativeStyleResultContent(`CHILD_SAW_MODEL=${CHANNEL_A_AGENTS[0]?.upstreamModel}`) },
      { toolUseId: 'toolu_probe_1', content: nativeStyleResultContent('CHILD_SAW_MODEL=totally-unrelated-model') }, // wrong on purpose
    ];
    const res = await handler(jsonRequest('/v1/messages', buildParentFinalRequest(wrongResults)));
    const events = await decodeSse(res);

    expect(reassembleToolUseBlocks(events)).toHaveLength(0); // still no loop, even on mismatch
    expect(stopReasonOf(events)).toBe('end_turn');
    expect(textOf(events)).not.toBe('PARENT_FINAL_OK'); // a wrong echo must never read as success
    expect(textOf(events)).toBe('PARENT_MISMATCH');
  });

  test('duplicate tool_use ids cannot fake a match even with correct content (every pending id must be answered exactly once)', async () => {
    const { handler } = await createHandlerFixture();
    await handler(jsonRequest('/v1/messages', buildParentRequest()));

    const duplicateResults = [
      { toolUseId: 'toolu_probe_0', content: nativeStyleResultContent(`CHILD_SAW_MODEL=${CHANNEL_A_AGENTS[0]?.upstreamModel}`) },
      { toolUseId: 'toolu_probe_0', content: nativeStyleResultContent(`CHILD_SAW_MODEL=${CHANNEL_A_AGENTS[0]?.upstreamModel}`) }, // duplicate id; toolu_probe_1 never answered
    ];
    const res = await handler(jsonRequest('/v1/messages', buildParentFinalRequest(duplicateResults)));
    const events = await decodeSse(res);

    expect(reassembleToolUseBlocks(events)).toHaveLength(0); // still no loop
    expect(textOf(events)).toBe('PARENT_MISMATCH');
  });

  test('an is_error tool_result cannot fake a match even when its content matches the expected echo', async () => {
    const { handler } = await createHandlerFixture();
    await handler(jsonRequest('/v1/messages', buildParentRequest()));

    const erroredResults = [
      { toolUseId: 'toolu_probe_0', content: nativeStyleResultContent(`CHILD_SAW_MODEL=${CHANNEL_A_AGENTS[0]?.upstreamModel}`), isError: true },
      { toolUseId: 'toolu_probe_1', content: nativeStyleResultContent(`CHILD_SAW_MODEL=${CHANNEL_A_AGENTS[1]?.upstreamModel}`) },
    ];
    const res = await handler(jsonRequest('/v1/messages', buildParentFinalRequest(erroredResults)));
    const events = await decodeSse(res);

    expect(reassembleToolUseBlocks(events)).toHaveLength(0); // still no loop
    expect(textOf(events)).toBe('PARENT_MISMATCH');
  });

  test('upstream requests are recorded via an onUpstreamRequest callback fired at the actual fetch call', async () => {
    const records: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { handler } = await createHandlerFixture({ onUpstreamRequest: (record) => records.push(record) });

    await handler(jsonRequest('/v1/messages', buildParentRequest()));
    await handler(jsonRequest('/v1/messages', buildChildRequest(CHANNEL_A_AGENTS[0]!.alias, 'x')));

    expect(records).toHaveLength(2);
    expect(records[1]?.body.model).toBe(CHANNEL_A_AGENTS[0]!.upstreamModel); // tied to the call that produced it, not a stale array read
  });

  test('count_tokens is answered with JSON, never treated as a message body', async () => {
    const { handler } = await createHandlerFixture();
    const res = await handler(jsonRequest('/v1/messages/count_tokens', buildParentRequest()));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.input_tokens).toBe('number');
  });

  test('a harmless non-message startup path with an empty body does not throw on JSON.parse', async () => {
    const { handler } = await createHandlerFixture();
    const res = await handler(new Request('http://router.local/v1/models', { method: 'GET' }));
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(500);
  });
});

describe('channel-A handler fixture: forced two-request child flow (childReadFilePath, opt-in)', () => {
  function jsonRequestWithHeaders(path: string, body: unknown, headers: Record<string, string>): Request {
    return new Request(`http://router.local${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  // Real Anthropic-shaped child continuation turn: the original marker-bearing user message,
  // then the assistant's forced tool_use, then the user's tool_result for it. Mirrors what a
  // real client sends after executing a tool the fixture told it to call.
  function childContinuationRequest(alias: string, taskPrompt: string, toolUseId: string, resultText: string): Record<string, unknown> {
    const base = buildChildRequest(alias, taskPrompt) as { messages: unknown[] };
    return {
      ...base,
      messages: [
        ...base.messages,
        { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: '/tmp/probe-child-read-fixture.txt' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: resultText }] }] },
      ],
    };
  }

  test('the default (no childReadFilePath) keeps one request per child, immediate echo -- unchanged from before this option existed', async () => {
    const { handler, seen } = await createHandlerFixture();
    const agent = CHANNEL_A_AGENTS[0]!;
    const res = await handler(jsonRequestWithHeaders('/v1/messages', buildChildRequest(agent.alias, 'task'), { 'x-claude-code-agent-id': 'agent-default' }));
    const events = await decodeSse(res);
    expect(reassembleToolUseBlocks(events)).toHaveLength(0);
    expect(textOf(events)).toBe(`CHILD_SAW_MODEL=${agent.upstreamModel}`);
    expect(seen).toHaveLength(1);
  });

  test('a routed child gets a tool_use for Read on its first request, and the real echo only after answering it with a matching tool_result -- two forwarded requests, one stable upstream model, keyed by agent id', async () => {
    const { handler, seen } = await createHandlerFixture({ childReadFilePath: '/tmp/probe-child-read-fixture.txt' });
    const agent = CHANNEL_A_AGENTS[1]!;
    const agentId = 'agent-forced-two-request';

    const firstRes = await handler(jsonRequestWithHeaders('/v1/messages', buildChildRequest(agent.alias, 'task'), { 'x-claude-code-agent-id': agentId }));
    expect(firstRes.status).toBe(200);
    const firstEvents = await decodeSse(firstRes);
    const firstToolUses = reassembleToolUseBlocks(firstEvents);
    expect(firstToolUses).toHaveLength(1); // first reply is a tool_use, never the echo directly
    expect(firstToolUses[0]?.name).toBe('Read');
    expect(firstToolUses[0]?.input.file_path).toBe('/tmp/probe-child-read-fixture.txt');
    expect(stopReasonOf(firstEvents)).toBe('tool_use');

    const secondRes = await handler(
      jsonRequestWithHeaders('/v1/messages', childContinuationRequest(agent.alias, 'task', firstToolUses[0]!.id, 'file contents'), { 'x-claude-code-agent-id': agentId }),
    );
    expect(secondRes.status).toBe(200);
    const secondEvents = await decodeSse(secondRes);
    expect(reassembleToolUseBlocks(secondEvents)).toHaveLength(0); // no third round; the loop ends here
    expect(stopReasonOf(secondEvents)).toBe('end_turn');
    expect(textOf(secondEvents)).toBe(`CHILD_SAW_MODEL=${agent.upstreamModel}`); // real echo, only on the second request

    expect(seen).toHaveLength(2); // two requests actually forwarded upstream, not one
    expect(seen[0]?.body.model).toBe(agent.upstreamModel);
    expect(seen[1]?.body.model).toBe(agent.upstreamModel); // stable upstream model across both requests, no drift
  });

  test('a tool_result for a foreign or stale tool_use id is treated as a fresh first request, never a shortcut to the echo', async () => {
    const { handler, seen } = await createHandlerFixture({ childReadFilePath: '/tmp/probe-child-read-fixture.txt' });
    const agent = CHANNEL_A_AGENTS[0]!;
    const agentId = 'agent-wrong-tool-result';

    await handler(jsonRequestWithHeaders('/v1/messages', buildChildRequest(agent.alias, 'task'), { 'x-claude-code-agent-id': agentId }));
    const res = await handler(
      jsonRequestWithHeaders('/v1/messages', childContinuationRequest(agent.alias, 'task', 'toolu_totally_unrelated', 'file contents'), { 'x-claude-code-agent-id': agentId }),
    );
    const events = await decodeSse(res);
    expect(reassembleToolUseBlocks(events)).toHaveLength(1); // re-issues a tool_use, does not fall through to the echo
    expect(seen).toHaveLength(2);
    expect(seen.every((r) => r.body.model === agent.upstreamModel)).toBe(true);
  });

  test('two different agent ids are tracked independently: one answering its tool_use never unlocks the echo for the other', async () => {
    const { handler } = await createHandlerFixture({ childReadFilePath: '/tmp/probe-child-read-fixture.txt' });
    const [agentAlpha, agentBeta] = CHANNEL_A_AGENTS;

    const alphaFirst = await handler(jsonRequestWithHeaders('/v1/messages', buildChildRequest(agentAlpha!.alias, 'task-a'), { 'x-claude-code-agent-id': 'agent-alpha' }));
    const alphaToolUseId = reassembleToolUseBlocks(await decodeSse(alphaFirst))[0]!.id;

    // Beta answers ALPHA's tool_use id under its OWN agent id header -- must not be accepted.
    const betaWithAlphasId = await handler(
      jsonRequestWithHeaders('/v1/messages', childContinuationRequest(agentBeta!.alias, 'task-b', alphaToolUseId, 'file contents'), { 'x-claude-code-agent-id': 'agent-beta' }),
    );
    const betaEvents = await decodeSse(betaWithAlphasId);
    expect(reassembleToolUseBlocks(betaEvents)).toHaveLength(1); // beta gets its OWN fresh tool_use, not the echo
    expect(textOf(betaEvents)).not.toBe(`CHILD_SAW_MODEL=${agentBeta!.upstreamModel}`);
  });
});

describe('channel-A handler fixture: measured native context layout (stage 2a amendment)', () => {
  const OBSERVED_VERSION = '9.9.9'; // synthetic; the launcher passes the real observed one

  function layoutChildRequest(alias: string, taskPrompt: string): Record<string, unknown> {
    const base = buildChildRequest(alias, taskPrompt);
    return { ...base, messages: [nativeLayoutUserMessage(`${markerLine(alias)}\n${taskPrompt}`)] };
  }

  test('with the version-bound layout profile, a native-layout child with a matching client version is routed and its context block is forwarded intact', async () => {
    const { handler, seen } = await createHandlerFixture({ profile: syntheticLayoutProfile(OBSERVED_VERSION) });
    const agent = CHANNEL_A_AGENTS[1];
    const req = new Request('http://router.local/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `claude-cli/${OBSERVED_VERSION} (external, sdk-cli)` },
      body: JSON.stringify(layoutChildRequest(agent.alias, 'task')),
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(seen[0]?.body.model).toBe(agent.upstreamModel);
    const content = (seen[0]?.body.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content;
    expect(content?.[0]?.text).toBe(nativeContextBlockV1());
    expect(content?.[1]?.text).toBe('task');
  });

  test('the legacy SYNTHETIC_PROFILE still fails closed on the native layout (the pre-amendment blocker), and a version mismatch does too', async () => {
    const legacy = await createHandlerFixture();
    const legacyRes = await legacy.handler(jsonRequest('/v1/messages', layoutChildRequest('fast', 'task')));
    expect(legacyRes.status).toBe(422);
    expect(await legacyRes.json()).toEqual({ error: { code: 'missing-selection' } });
    expect(legacy.seen).toHaveLength(0);

    const bound = await createHandlerFixture({ profile: syntheticLayoutProfile(OBSERVED_VERSION) });
    const req = new Request('http://router.local/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'claude-cli/1.0.0 (external, sdk-cli)' },
      body: JSON.stringify(layoutChildRequest('fast', 'task')),
    });
    const res = await bound.handler(req);
    expect(res.status).toBe(422);
    expect(bound.seen).toHaveLength(0);
  });
});

describe('channel-A handler fixture: resume re-delegation (resumeReDelegate, opt-in)', () => {
  function roundResults(prefix: string) {
    return CHANNEL_A_AGENTS.map((agent, i) => ({
      toolUseId: `${prefix}_${i}`,
      content: nativeStyleResultContent(`CHILD_SAW_MODEL=${agent.upstreamModel}`),
    }));
  }

  // A resumed request whose messages extend past the finalized tool_results with a fresh user
  // turn (the real client's shape when a session continues after a prior round completed).
  function resumedRequestWithNewTurn(
    priorResults: Array<{ toolUseId: string; content: Array<{ type: 'text'; text: string }> }>,
    newPrompt: string,
  ): Record<string, unknown> {
    const base = buildParentFinalRequest(priorResults) as { messages: unknown[] };
    return {
      ...base,
      messages: [...base.messages, { role: 'user', content: newPrompt }],
    };
  }

  test('a retried final request (identical body, no new user turn) does NOT re-delegate and still reports PARENT_FINAL_OK', async () => {
    const { handler } = await createHandlerFixture({ resumeReDelegate: true });
    await handler(jsonRequest('/v1/messages', buildParentRequest()));

    const results = roundResults('toolu_probe');
    const firstFinal = await handler(jsonRequest('/v1/messages', buildParentFinalRequest(results)));
    expect(textOf(await decodeSse(firstFinal))).toBe('PARENT_FINAL_OK'); // round 1 finalized

    // The client lost the response and resends the IDENTICAL final body. This is a retry, not a
    // resume: no new user turn follows, so it must NOT consume the one-shot re-delegation.
    const retry = await handler(jsonRequest('/v1/messages', buildParentFinalRequest(results)));
    const retryEvents = await decodeSse(retry);
    expect(reassembleToolUseBlocks(retryEvents)).toHaveLength(0);
    expect(textOf(retryEvents)).toBe('PARENT_FINAL_OK');
  });

  test('a resumed turn with a NEW user turn after the finalized tool_results re-delegates exactly once', async () => {
    const { handler } = await createHandlerFixture({ resumeReDelegate: true });
    await handler(jsonRequest('/v1/messages', buildParentRequest()));

    const results = roundResults('toolu_probe');
    const firstFinal = await handler(jsonRequest('/v1/messages', buildParentFinalRequest(results)));
    expect(textOf(await decodeSse(firstFinal))).toBe('PARENT_FINAL_OK');

    const resumed = await handler(jsonRequest('/v1/messages', resumedRequestWithNewTurn(results, 'Delegate again')));
    const resumedEvents = await decodeSse(resumed);
    const toolUses = reassembleToolUseBlocks(resumedEvents);
    expect(toolUses).toHaveLength(CHANNEL_A_AGENTS.length);
    expect(toolUses.every((t) => t.name === AGENT_TOOL_NAME)).toBe(true);
    expect(stopReasonOf(resumedEvents)).toBe('tool_use');

    // A SECOND resumed turn must NOT re-delegate again (one-shot): the allowance is spent.
    const second = await handler(jsonRequest('/v1/messages', resumedRequestWithNewTurn(results, 'Again')));
    const secondEvents = await decodeSse(second);
    expect(reassembleToolUseBlocks(secondEvents)).toHaveLength(0);
    expect(stopReasonOf(secondEvents)).toBe('end_turn');
  });

  test('a resumed round whose final request carries BOTH rounds of tool_results still judges PARENT_FINAL_OK', async () => {
    const { handler } = await createHandlerFixture({ resumeReDelegate: true });
    await handler(jsonRequest('/v1/messages', buildParentRequest()));

    const prior = roundResults('toolu_probe');
    const firstFinal = await handler(jsonRequest('/v1/messages', buildParentFinalRequest(prior)));
    expect(textOf(await decodeSse(firstFinal))).toBe('PARENT_FINAL_OK');

    // Re-delegate: this round owns toolu_probe_r1_* ids.
    await handler(jsonRequest('/v1/messages', resumedRequestWithNewTurn(prior, 'Delegate again')));

    const current = roundResults('toolu_probe_r1');
    // Final request for the resumed round: the real client keeps the PRIOR round's tool_results
    // in history AND appends the current round's. Only the current (pending) ids may count.
    const mixedRequest = (() => {
      const base = buildParentFinalRequest(current) as { messages: unknown[] };
      const priorFinal = buildParentFinalRequest(prior) as { messages: unknown[] };
      // Splice the prior round's assistant+user turns before the current round's final user turn.
      const priorTurns = priorFinal.messages.slice(1, 3);
      const lastUser = base.messages[base.messages.length - 1];
      return { ...base, messages: [base.messages[0], ...priorTurns, ...base.messages.slice(1, -1), lastUser] };
    })();
    const finalRes = await handler(jsonRequest('/v1/messages', mixedRequest));
    const events = await decodeSse(finalRes);
    expect(reassembleToolUseBlocks(events)).toHaveLength(0);
    expect(textOf(events)).toBe('PARENT_FINAL_OK');
  });

  test('without resumeReDelegate, the same replayed tool_results end the turn (PARENT_FINAL_OK, never re-delegate)', async () => {
    const { handler } = await createHandlerFixture();
    await handler(jsonRequest('/v1/messages', buildParentRequest()));

    const results = roundResults('toolu_probe');
    const firstFinal = await handler(jsonRequest('/v1/messages', buildParentFinalRequest(results)));
    expect(textOf(await decodeSse(firstFinal))).toBe('PARENT_FINAL_OK');

    const replayed = await handler(jsonRequest('/v1/messages', buildParentFinalRequest(results)));
    const events = await decodeSse(replayed);
    expect(reassembleToolUseBlocks(events)).toHaveLength(0); // no re-delegation: the loop ends
    expect(textOf(events)).toBe('PARENT_FINAL_OK');
  });
});

describe('realLayoutProfile (stage 2a real-base variant, PROBE_PROFILE_BASE=real)', () => {
  test('diverges from the real fixture on exactly the declared scaffold paths, everything else carried over untouched', async () => {
    const realFixture = await loadCapabilityProfile('claude-code', '2.1.266', CAPABILITIES_FIXTURES);
    const profile = realLayoutProfile(realFixture);

    const diverged = diffCapturedAgainstReal(profile as unknown as Record<string, unknown>, realFixture as unknown as Record<string, unknown>);
    const declared = new Set(SYNTHETIC_LAYOUT_SCAFFOLD_OVERRIDDEN_PATHS);
    const undeclared = diverged.filter((path) => !pathIsDeclared(path, declared));

    expect(undeclared).toEqual([]); // no divergence the manifest fails to cover
    expect(diverged.length).toBeGreaterThan(0); // and it must genuinely diverge on something, not vacuously pass

    // Everything NOT explicitly overridden by realLayoutProfile must come straight from the
    // real fixture: client, correlation-related fields, adapterMarkerPosition, and every probe
    // the real fixture declares besides the two this variant sets (M10, M3-A).
    expect(profile.client).toBe(realFixture.client);
    expect(profile.version).toBe(realFixture.version);
    expect(profile.correlation).toBe(realFixture.correlation);
    expect(profile.correlationEntropy).toBe(realFixture.correlationEntropy);
    expect(profile.fork).toBe(realFixture.fork);
    expect(profile.adapterMarkerPosition).toBe(realFixture.adapterMarkerPosition);
    for (const [name, result] of Object.entries(realFixture.probes)) {
      if (name === 'M10' || name === 'M3-A') continue;
      expect(profile.probes[name]).toBe(result);
    }
  });

  test('overrides exactly what SYNTHETIC_LAYOUT_SCAFFOLD_OVERRIDDEN_PATHS declares', async () => {
    const realFixture = await loadCapabilityProfile('claude-code', '2.1.267', CAPABILITIES_FIXTURES);
    const profile = realLayoutProfile(realFixture);

    expect(profile.status).toBe('supported');
    expect(profile.probes.M10).toBe('passed');
    expect(profile.probes['M3-A']).toBe('passed');
    expect(profile.parentPromptPosition).toBe('after-native-context-v1');
    expect(profile.lifecycle).toEqual({ 'next-turn': 'passed', resume: 'passed', compaction: 'passed', nested: 'passed', parallel: 'passed' });
  });
});
