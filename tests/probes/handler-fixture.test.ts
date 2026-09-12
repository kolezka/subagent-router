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
import type { CapabilityProfile } from '../../src/core/types';
import {
  AGENT_TOOL_NAME,
  CHANNEL_A_AGENTS,
  CORRELATION_SCAFFOLD_OVERRIDDEN_PATHS,
  PARENT_CLIENT_MODEL,
  SYNTHETIC_LAYOUT_SCAFFOLD_OVERRIDDEN_PATHS,
  buildChildRequest,
  buildParentRequest,
  createHandlerFixture,
  markerLine,
  realLayoutProfile,
  scaffoldOverriddenPaths,
  syntheticLayoutProfile,
} from './native-claude-handler';
import { diffCapturedAgainstReal } from './evidence-m3a';
import { COMPACTION_SUMMARY_PREFIX } from './evidence-m10';
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

  test('childReadRounds drives one child through several Read rounds before the echo, so it still has a turn left after its conversation has grown', async () => {
    // What compaction mode needs: the child must keep taking turns after the tool_result that
    // pushed its own conversation past the auto-compaction threshold, because only a LATER request
    // can carry the resulting compact_boundary in its history.
    const { handler, seen } = await createHandlerFixture({ childReadFilePath: '/tmp/probe-child-read-fixture.txt', childReadRounds: 2 });
    const agent = CHANNEL_A_AGENTS[0]!;
    const agentId = 'agent-multi-round';

    const firstToolUses = reassembleToolUseBlocks(
      await decodeSse(await handler(jsonRequestWithHeaders('/v1/messages', buildChildRequest(agent.alias, 'task'), { 'x-claude-code-agent-id': agentId }))),
    );
    expect(firstToolUses).toHaveLength(1);

    // Round 1 answered: with two rounds configured this must issue ANOTHER tool_use, not the echo.
    const secondEvents = await decodeSse(
      await handler(jsonRequestWithHeaders('/v1/messages', childContinuationRequest(agent.alias, 'task', firstToolUses[0]!.id, 'file contents'), { 'x-claude-code-agent-id': agentId })),
    );
    const secondToolUses = reassembleToolUseBlocks(secondEvents);
    expect(secondToolUses).toHaveLength(1);
    expect(secondToolUses[0]?.id).not.toBe(firstToolUses[0]?.id); // a fresh round, not a replay
    expect(textOf(secondEvents)).not.toBe(`CHILD_SAW_MODEL=${agent.upstreamModel}`);

    // Round 2 answered: the last round, so now the echo ends the loop.
    const thirdEvents = await decodeSse(
      await handler(jsonRequestWithHeaders('/v1/messages', childContinuationRequest(agent.alias, 'task', secondToolUses[0]!.id, 'file contents'), { 'x-claude-code-agent-id': agentId })),
    );
    expect(reassembleToolUseBlocks(thirdEvents)).toHaveLength(0);
    expect(textOf(thirdEvents)).toBe(`CHILD_SAW_MODEL=${agent.upstreamModel}`);

    expect(seen).toHaveLength(3); // three forwarded requests from one child
    expect(seen.every((r) => r.body.model === agent.upstreamModel)).toBe(true); // no upstream drift
  });

  test('childReadRounds defaults to a single round, so every existing mode keeps its two-request flow', async () => {
    // Guards the opt-in: absent (and at 1) the knob must change nothing for handler/next-turn runs.
    for (const rounds of [undefined, 1]) {
      const { handler, seen } = await createHandlerFixture({
        childReadFilePath: '/tmp/probe-child-read-fixture.txt',
        ...(rounds !== undefined ? { childReadRounds: rounds } : {}),
      });
      const agent = CHANNEL_A_AGENTS[1]!;
      const agentId = `agent-single-round-${String(rounds)}`;

      const toolUses = reassembleToolUseBlocks(
        await decodeSse(await handler(jsonRequestWithHeaders('/v1/messages', buildChildRequest(agent.alias, 'task'), { 'x-claude-code-agent-id': agentId }))),
      );
      const events = await decodeSse(
        await handler(jsonRequestWithHeaders('/v1/messages', childContinuationRequest(agent.alias, 'task', toolUses[0]!.id, 'file contents'), { 'x-claude-code-agent-id': agentId })),
      );
      expect(reassembleToolUseBlocks(events)).toHaveLength(0); // echo on the second request, as before
      expect(textOf(events)).toBe(`CHILD_SAW_MODEL=${agent.upstreamModel}`);
      expect(seen).toHaveLength(2);
    }
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

  test('same-child resume messages target only the ids captured before resume', async () => {
    const { handler } = await createHandlerFixture({ resumeExistingChild: true });
    await handler(jsonRequest('/v1/messages', buildParentRequest()));
    for (const [index, agent] of CHANNEL_A_AGENTS.entries()) {
      const request = jsonRequest('/v1/messages', buildChildRequest(agent.alias, 'task'));
      request.headers.set('x-claude-code-agent-id', `existing-child-${index}`);
      await handler(request);
    }
    const prior = roundResults('toolu_probe');
    await handler(jsonRequest('/v1/messages', buildParentFinalRequest(prior)));
    const events = await decodeSse(await handler(jsonRequest('/v1/messages', resumedRequestWithNewTurn(prior, 'Continue the same children'))));
    const tools = reassembleToolUseBlocks(events);
    expect(tools.map((tool) => tool.name)).toEqual(['SendMessage', 'SendMessage']);
    expect(tools.map((tool) => tool.input.to)).toEqual(['existing-child-0', 'existing-child-1']);
    expect(tools.every((tool) => !('subagent_type' in tool.input))).toBe(true);
    const acknowledgements = tools.map((tool) => ({ toolUseId: tool.id, content: nativeStyleResultContent('{"success":true}') }));
    const waits = reassembleToolUseBlocks(await decodeSse(await handler(jsonRequest('/v1/messages', buildParentFinalRequest(acknowledgements)))));
    expect(waits.map((tool) => tool.name)).toEqual(['TaskOutput', 'TaskOutput']);
    expect(waits.map((tool) => tool.input.task_id)).toEqual(['existing-child-0', 'existing-child-1']);
    const outputs = waits.map((tool, index) => ({ toolUseId: tool.id, content: nativeStyleResultContent(`CHILD_SAW_MODEL=${CHANNEL_A_AGENTS[index]!.upstreamModel}`) }));
    const final = await decodeSse(await handler(jsonRequest('/v1/messages', buildParentFinalRequest(outputs))));
    expect(textOf(final)).toBe('PARENT_MISMATCH'); // Replies alone do not prove a child sent a post-resume request.
  });

  test('same-child resume never invents an id when no child was observed', async () => {
    const { handler } = await createHandlerFixture({ resumeExistingChild: true });
    await handler(jsonRequest('/v1/messages', buildParentRequest()));
    const prior = roundResults('toolu_probe');
    await handler(jsonRequest('/v1/messages', buildParentFinalRequest(prior)));
    const events = await decodeSse(await handler(jsonRequest('/v1/messages', resumedRequestWithNewTurn(prior, 'Continue the same children'))));
    expect(reassembleToolUseBlocks(events)).toHaveLength(0);
    expect(textOf(events)).toBe('PARENT_RESUME_TARGET_MISSING');
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

describe('channel-A handler fixture: nested delegation (nestedDelegatingAgent, opt-in)', () => {
  function jsonRequestWithHeaders(path: string, body: unknown, headers: Record<string, string>): Request {
    return new Request(`http://router.local${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  // Real Anthropic-shaped child continuation turn for a nested Agent delegation: the original
  // marker-bearing user message, then the assistant's forced Agent tool_use (the nested
  // delegation), then the user's tool_result for it. Mirrors what a real client sends after
  // executing the nested delegation the fixture told it to perform.
  function nestedContinuationRequest(alias: string, taskPrompt: string, toolUseId: string, resultText: string): Record<string, unknown> {
    const base = buildChildRequest(alias, taskPrompt) as { messages: unknown[] };
    return {
      ...base,
      messages: [
        ...base.messages,
        { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: AGENT_TOOL_NAME, input: { subagent_type: CHANNEL_A_AGENTS[1]!.name } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: resultText }] }] },
      ],
    };
  }

  test("with nestedDelegatingAgent set, the delegating child's first request gets exactly one Agent tool_use to beta with the smart marker and stop_reason tool_use", async () => {
    const { handler } = await createHandlerFixture({ nestedDelegatingAgent: 'native-probe-alpha' });
    const delegating = CHANNEL_A_AGENTS[0]!; // alpha routes to gateway/fast-worker, the one that delegates
    const target = CHANNEL_A_AGENTS[1]!; // beta routes to gateway/smart-worker, the nested target

    const res = await handler(jsonRequestWithHeaders('/v1/messages', buildChildRequest(delegating.alias, 'task'), { 'x-claude-code-agent-id': 'agent-alpha' }));
    expect(res.status).toBe(200);
    const events = await decodeSse(res);
    const toolUses = reassembleToolUseBlocks(events);
    expect(toolUses).toHaveLength(1); // exactly ONE nested delegation, never two
    expect(toolUses[0]?.name).toBe(AGENT_TOOL_NAME);
    expect(toolUses[0]?.input.subagent_type).toBe(target.name);
    const prompt = toolUses[0]?.input.prompt as string;
    expect(prompt.split('\n')[0]).toBe(markerLine(target.alias)); // smart marker selects beta
    expect(stopReasonOf(events)).toBe('tool_use');
  });

  test("the delegating child's second request carrying the matching tool_result gets the echo", async () => {
    const { handler, seen } = await createHandlerFixture({ nestedDelegatingAgent: 'native-probe-alpha' });
    const delegating = CHANNEL_A_AGENTS[0]!;
    const agentId = 'agent-alpha';

    const firstRes = await handler(jsonRequestWithHeaders('/v1/messages', buildChildRequest(delegating.alias, 'task'), { 'x-claude-code-agent-id': agentId }));
    const toolUseId = reassembleToolUseBlocks(await decodeSse(firstRes))[0]!.id;
    expect(toolUseId).toBe('toolu_nested_0'); // deterministic id, keyed to the delegating child

    const secondRes = await handler(
      jsonRequestWithHeaders('/v1/messages', nestedContinuationRequest(delegating.alias, 'task', toolUseId, 'nested result'), { 'x-claude-code-agent-id': agentId }),
    );
    const secondEvents = await decodeSse(secondRes);
    expect(reassembleToolUseBlocks(secondEvents)).toHaveLength(0); // no third round; the loop ends here
    expect(stopReasonOf(secondEvents)).toBe('end_turn');
    expect(textOf(secondEvents)).toBe(`CHILD_SAW_MODEL=${delegating.upstreamModel}`); // real echo, only on the second request

    expect(seen).toHaveLength(2); // two requests actually forwarded upstream, not one
    expect(seen[0]?.body.model).toBe(delegating.upstreamModel);
    expect(seen[1]?.body.model).toBe(delegating.upstreamModel); // stable upstream model, no drift
  });

  test('a request from the other child gets the plain echo even with nestedDelegatingAgent set', async () => {
    const { handler } = await createHandlerFixture({ nestedDelegatingAgent: 'native-probe-alpha' });
    const other = CHANNEL_A_AGENTS[1]!; // beta, NOT the delegating agent

    const res = await handler(jsonRequestWithHeaders('/v1/messages', buildChildRequest(other.alias, 'task'), { 'x-claude-code-agent-id': 'agent-beta' }));
    const events = await decodeSse(res);
    expect(reassembleToolUseBlocks(events)).toHaveLength(0); // plain echo, no nested delegation
    expect(textOf(events)).toBe(`CHILD_SAW_MODEL=${other.upstreamModel}`);
  });

  test('without nestedDelegatingAgent, behaviour is byte-identical (the child gets the immediate echo)', async () => {
    const { handler } = await createHandlerFixture();
    const delegating = CHANNEL_A_AGENTS[0]!;

    const res = await handler(jsonRequestWithHeaders('/v1/messages', buildChildRequest(delegating.alias, 'task'), { 'x-claude-code-agent-id': 'agent-alpha' }));
    const events = await decodeSse(res);
    expect(reassembleToolUseBlocks(events)).toHaveLength(0); // one request, immediate echo, exactly as before this option existed
    expect(textOf(events)).toBe(`CHILD_SAW_MODEL=${delegating.upstreamModel}`);
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

describe('layout v2 profile variant (PROBE_LAYOUT=v2)', () => {
  test('both profile builders take the layout position and default to v1 when it is omitted', async () => {
    const realFixture = await loadCapabilityProfile('claude-code', '2.1.268', CAPABILITIES_FIXTURES);

    expect(syntheticLayoutProfile('2.1.268').parentPromptPosition).toBe('after-native-context-v1');
    expect(realLayoutProfile(realFixture).parentPromptPosition).toBe('after-native-context-v1');

    expect(syntheticLayoutProfile('2.1.268', 'after-native-context-v2').parentPromptPosition).toBe('after-native-context-v2');
    expect(realLayoutProfile(realFixture, 'after-native-context-v2').parentPromptPosition).toBe('after-native-context-v2');
  });

  // Declaring a path in the scaffold manifest and diverging on it are different claims: the override
  // always SETS parentPromptPosition, so the manifest must always name it, while the divergence only
  // shows up when the base did not already carry that value. A real fixture declaring v2 is a
  // recording, not a regression, so the contract runs over every base shape, on in-memory copies.
  function assertLayoutContract(label: string, base: CapabilityProfile, profile: CapabilityProfile): void {
    const declared = new Set(SYNTHETIC_LAYOUT_SCAFFOLD_OVERRIDDEN_PATHS);

    // The override always declares v2, whatever the base said. The label rides along in the
    // compared object so a failure names which base variant broke.
    expect({ base: label, declared: profile.parentPromptPosition }).toEqual({ base: label, declared: 'after-native-context-v2' });

    const diverged = diffCapturedAgainstReal(profile as unknown as Record<string, unknown>, base as unknown as Record<string, unknown>);

    // Every path that actually differs is covered by the manifest, for every base. This is the
    // property extractM3AEvidence relies on, and the one that must never regress.
    expect(diverged.filter((path) => !pathIsDeclared(path, declared))).toEqual([]);
    // Non-vacuous: status and probes.M10 always differ from a pending real fixture.
    expect(diverged.length).toBeGreaterThan(0);

    // And the layout path diverges exactly when the base did not already carry v2.
    expect({ base: label, diverges: diverged.includes('parentPromptPosition') }).toEqual({
      base: label,
      diverges: base.parentPromptPosition !== 'after-native-context-v2',
    });

    // Everything the v2 override does not touch still comes straight from the base fixture.
    expect(profile.adapterMarkerPosition).toBe(base.adapterMarkerPosition);
    expect(profile.correlation).toBe(base.correlation);
  }

  test('the v2 variant still overrides exactly what the scaffold manifest declares, for every base layout value, so a v2 run stays judgeable', async () => {
    const loaded = await loadCapabilityProfile('claude-code', '2.1.268', CAPABILITIES_FIXTURES);
    // Pin the gate fields to pending: the contract below asserts the scaffold diverges on status
    // and probes.M10, which is only true of a pending base. The real fixture is a measured value
    // that changes; this test is about the scaffold, not about what 2.1.268 says today.
    const pendingBase: CapabilityProfile = {
      ...loaded,
      status: 'pending',
      probes: { ...loaded.probes, M10: 'pending' },
      lifecycle: { 'next-turn': 'pending', resume: 'pending', compaction: 'pending', nested: 'pending', parallel: 'pending' },
    };
    const { parentPromptPosition: _dropped, ...withoutLayout } = pendingBase;

    const bases: ReadonlyArray<{ label: string; base: CapabilityProfile }> = [
      { label: 'absent', base: withoutLayout as CapabilityProfile },
      { label: 'after-native-context-v1', base: { ...withoutLayout, parentPromptPosition: 'after-native-context-v1' } as CapabilityProfile },
      { label: 'after-native-context-v2', base: { ...withoutLayout, parentPromptPosition: 'after-native-context-v2' } as CapabilityProfile },
    ];

    // The manifest must name parentPromptPosition under every base: the override writes that field
    // unconditionally, so it is always a path the scaffold is responsible for declaring.
    expect(SYNTHETIC_LAYOUT_SCAFFOLD_OVERRIDDEN_PATHS).toContain('parentPromptPosition');

    for (const { label, base } of bases) {
      assertLayoutContract(label, base, realLayoutProfile(base, 'after-native-context-v2'));
    }
  });

  test('assertLayoutContract passes the real override and throws for a forgotten or a straying one', async () => {
    const loaded = await loadCapabilityProfile('claude-code', '2.1.268', CAPABILITIES_FIXTURES);
    const { parentPromptPosition: _dropped, ...withoutLayout } = loaded;
    const v1Base = { ...withoutLayout, parentPromptPosition: 'after-native-context-v1' } as CapabilityProfile;

    // Positive control: the real override passes the very check the mutants must fail, so a helper
    // that throws for everything cannot fake this test green.
    expect(() => assertLayoutContract('real override', v1Base, realLayoutProfile(v1Base, 'after-native-context-v2'))).not.toThrow();

    // Mutation 1: an override that never writes the field at all, keeping the base's v1 value.
    const forgotten = { ...realLayoutProfile(v1Base, 'after-native-context-v2'), parentPromptPosition: v1Base.parentPromptPosition } as CapabilityProfile;
    expect(() => assertLayoutContract('forgotten', v1Base, forgotten)).toThrow();

    // Mutation 2: an override that writes an undeclared field instead.
    const straying = { ...realLayoutProfile(v1Base, 'after-native-context-v2'), adapterMarkerPosition: 'system' } as CapabilityProfile;
    expect(() => assertLayoutContract('straying', v1Base, straying)).toThrow();
  });
});

describe('channel-A handler fixture: routed-child usage reporting (childUsageInputTokens, opt-in)', () => {
  const READ_FILE = '/tmp/probe-child-read-fixture.txt';

  function childRequest(alias: string, agentId?: string): Request {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (agentId !== undefined) headers['x-claude-code-agent-id'] = agentId;
    return new Request('http://router.local/v1/messages', { method: 'POST', headers, body: JSON.stringify(buildChildRequest(alias, 'task')) });
  }

  function messageStartOf(events: Array<{ event: string; data: Record<string, unknown> }>): Record<string, unknown> {
    const start = events.find((e) => e.event === 'message_start');
    if (start === undefined) throw new Error('no message_start event in stream');
    return (start.data as { message: Record<string, unknown> }).message;
  }

  function usageOf(events: Array<{ event: string; data: Record<string, unknown> }>): Record<string, unknown> {
    return messageStartOf(events).usage as Record<string, unknown>;
  }

  test('default inert: absent, and set to the value already reported, leave a routed child response exactly as it was', async () => {
    const agent = CHANNEL_A_AGENTS[0]!;

    // Absent: the echo reports the input_tokens this builder has always reported.
    const absent = await createHandlerFixture();
    const absentUsage = usageOf(await decodeSse(await absent.handler(childRequest(agent.alias, 'agent-usage-absent'))));
    expect(absentUsage).toEqual({ input_tokens: 5, output_tokens: 1 });

    // Set to that same value: indistinguishable from absent, so the knob cannot double-apply.
    const same = await createHandlerFixture({ childUsageInputTokens: 5 });
    const sameUsage = usageOf(await decodeSse(await same.handler(childRequest(agent.alias, 'agent-usage-same'))));
    expect(sameUsage).toEqual(absentUsage);

    // The forced-Read tool_use builder keeps its own (different) default too.
    const read = await createHandlerFixture({ childReadFilePath: READ_FILE });
    const readUsage = usageOf(await decodeSse(await read.handler(childRequest(agent.alias, 'agent-usage-read-default'))));
    expect(readUsage).toEqual({ input_tokens: 8, output_tokens: 1 });
  });

  test('when set, a routed child message_start carries it on both child reply shapes, and the parent response does not', async () => {
    const agent = CHANNEL_A_AGENTS[0]!;

    // Child echo: inflated input_tokens, every other usage field left alone.
    const echo = await createHandlerFixture({ childUsageInputTokens: 5000 });
    const echoEvents = await decodeSse(await echo.handler(childRequest(agent.alias, 'agent-usage-set')));
    expect(usageOf(echoEvents)).toEqual({ input_tokens: 5000, output_tokens: 1 });
    // The model must survive untouched: the client ignores an assistant message whose model
    // matches an internal constant, and tripping that filter would void the whole measurement.
    expect(messageStartOf(echoEvents).model).toBe(agent.upstreamModel);
    expect(textOf(echoEvents)).toBe(`CHILD_SAW_MODEL=${agent.upstreamModel}`);

    // Forced-Read tool_use: the reply shape compaction mode actually drives.
    const read = await createHandlerFixture({ childReadFilePath: READ_FILE, childUsageInputTokens: 5000 });
    const readEvents = await decodeSse(await read.handler(childRequest(agent.alias, 'agent-usage-set-read')));
    expect(usageOf(readEvents)).toEqual({ input_tokens: 5000, output_tokens: 1 });
    expect(reassembleToolUseBlocks(readEvents)).toHaveLength(1);

    // The parent's delegation turn carries no agent-id header, so its usage stays untouched. A
    // parent compaction could disturb the final echo this probe reads.
    const parentEvents = await decodeSse(await echo.handler(jsonRequest('/v1/messages', buildParentRequest())));
    expect(usageOf(parentEvents)).toEqual({ input_tokens: 10, output_tokens: 1 });
  });

  test('the gate is the agent-id header, not merely being a routed child: an unheadered child request keeps the default usage', async () => {
    // childInputTokens is resolved from x-claude-code-agent-id, so a request the client never
    // marked as a child must not get the inflated value even though its model is a routed one.
    const { handler } = await createHandlerFixture({ childUsageInputTokens: 5000 });
    const agent = CHANNEL_A_AGENTS[1]!;
    const events = await decodeSse(await handler(childRequest(agent.alias)));
    expect(usageOf(events)).toEqual({ input_tokens: 5, output_tokens: 1 });
    expect(textOf(events)).toBe(`CHILD_SAW_MODEL=${agent.upstreamModel}`); // still a real routed child reply
  });

  // Same continuation shape the forced-Read describe above uses: the marker-bearing user message,
  // the assistant's tool_use, then the user's tool_result answering it.
  function readContinuation(alias: string, toolUseId: string): Record<string, unknown> {
    const base = buildChildRequest(alias, 'task') as { messages: unknown[] };
    return {
      ...base,
      messages: [
        ...base.messages,
        { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: READ_FILE } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: 'file contents' }] }] },
      ],
    };
  }

  function continuationRequest(alias: string, agentId: string, toolUseId: string): Request {
    return new Request('http://router.local/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-agent-id': agentId },
      body: JSON.stringify(readContinuation(alias, toolUseId)),
    });
  }

  test('childUsageRampAfterRounds is default inert: absent, the large usage applies from the very first reply', async () => {
    // The knob may not change what every existing mode already measures, so absent must stay
    // byte-identical to the pre-ramp behaviour: first reply already inflated.
    const agent = CHANNEL_A_AGENTS[0]!;
    const { handler } = await createHandlerFixture({ childReadFilePath: READ_FILE, childUsageInputTokens: 5000, childReadRounds: 3 });

    const first = await decodeSse(await handler(childRequest(agent.alias, 'agent-ramp-absent')));
    expect(usageOf(first)).toEqual({ input_tokens: 5000, output_tokens: 1 });
    expect(reassembleToolUseBlocks(first)).toHaveLength(1);
  });

  test('when set, a child keeps the builder default until it has completed that many Read rounds, then reports the large value', async () => {
    // Why the ramp exists: reporting 5000 on the first reply makes the client decide to compact
    // while the child's conversation is two messages long, and its reactive compactor then bails
    // with "fewer than 2 groups, nothing to compact". The large value has to arrive only after
    // several real assistant turns are already behind the child.
    const agent = CHANNEL_A_AGENTS[0]!;
    const agentId = 'agent-ramp-set';
    const { handler } = await createHandlerFixture({
      childReadFilePath: READ_FILE,
      childUsageInputTokens: 5000,
      childReadRounds: 4,
      childUsageRampAfterRounds: 2,
    });

    // Reply 1 (0 rounds done) and reply 2 (1 round done) stay on the tool_use builder's own default.
    const first = await decodeSse(await handler(childRequest(agent.alias, agentId)));
    expect(usageOf(first)).toEqual({ input_tokens: 8, output_tokens: 1 });
    const firstId = reassembleToolUseBlocks(first)[0]!.id;

    const second = await decodeSse(await handler(continuationRequest(agent.alias, agentId, firstId)));
    expect(usageOf(second)).toEqual({ input_tokens: 8, output_tokens: 1 });
    const secondId = reassembleToolUseBlocks(second)[0]!.id;
    expect(secondId).not.toBe(firstId); // a real further round, not a replay

    // Reply 3 is issued with 2 rounds completed, so this is the first one carrying the large usage.
    const third = await decodeSse(await handler(continuationRequest(agent.alias, agentId, secondId)));
    expect(usageOf(third)).toEqual({ input_tokens: 5000, output_tokens: 1 });
    const thirdId = reassembleToolUseBlocks(third)[0]!.id;

    // And it stays large for the rest of the conversation. N rounds means N+1 requests, so with 4
    // rounds this is still a tool_use and the echo lands on the request after it.
    const fourth = await decodeSse(await handler(continuationRequest(agent.alias, agentId, thirdId)));
    expect(usageOf(fourth)).toEqual({ input_tokens: 5000, output_tokens: 1 });
    const fourthId = reassembleToolUseBlocks(fourth)[0]!.id;

    const fifth = await decodeSse(await handler(continuationRequest(agent.alias, agentId, fourthId)));
    expect(usageOf(fifth)).toEqual({ input_tokens: 5000, output_tokens: 1 }); // the closing echo too
    expect(reassembleToolUseBlocks(fifth)).toHaveLength(0); // round 4 of 4 answered: the loop ends
    expect(textOf(fifth)).toBe(`CHILD_SAW_MODEL=${agent.upstreamModel}`);
  });

  test('the ramp counts rounds per agent id, so one child crossing it never inflates another child', async () => {
    // Same contract childReadRounds already holds: request order must not decide anything.
    const ahead = CHANNEL_A_AGENTS[0]!;
    const behind = CHANNEL_A_AGENTS[1]!;
    const { handler } = await createHandlerFixture({
      childReadFilePath: READ_FILE,
      childUsageInputTokens: 5000,
      childReadRounds: 4,
      childUsageRampAfterRounds: 1,
    });

    const aheadFirst = await decodeSse(await handler(childRequest(ahead.alias, 'agent-ramp-ahead')));
    const aheadId = reassembleToolUseBlocks(aheadFirst)[0]!.id;
    const aheadSecond = await decodeSse(await handler(continuationRequest(ahead.alias, 'agent-ramp-ahead', aheadId)));
    expect(usageOf(aheadSecond)).toEqual({ input_tokens: 5000, output_tokens: 1 }); // one round done

    // The other child has completed nothing, and arrives later in request order.
    const behindFirst = await decodeSse(await handler(childRequest(behind.alias, 'agent-ramp-behind')));
    expect(usageOf(behindFirst)).toEqual({ input_tokens: 8, output_tokens: 1 });
  });
});

describe('channel-A handler fixture: compaction summarizer replies (answerCompactionSummaries, opt-in)', () => {
  const READ_FILE = '/tmp/probe-child-read-fixture.txt';

  // The shape the client's reactive compactor actually sends, as observed on 2.1.268: the routed
  // child's own model and agent id, the pending tool_result still attached, and a text block
  // carrying the compaction prompt appended to that same user message.
  const COMPACTION_PROMPT =
    'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\nProvide an <analysis> block, then a <summary> block.';

  function childRequest(alias: string, agentId: string): Request {
    return new Request('http://router.local/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-agent-id': agentId },
      body: JSON.stringify(buildChildRequest(alias, 'task')),
    });
  }

  function messageStartOf(events: Array<{ event: string; data: Record<string, unknown> }>): Record<string, unknown> {
    const start = events.find((e) => e.event === 'message_start');
    if (start === undefined) throw new Error('no message_start event in stream');
    return (start.data as { message: Record<string, unknown> }).message;
  }

  function continuationBody(alias: string, toolUseId: string, trailingText?: string): Record<string, unknown> {
    const base = buildChildRequest(alias, 'task') as { messages: unknown[] };
    const userContent: unknown[] = [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: 'file contents' }] }];
    if (trailingText !== undefined) userContent.push({ type: 'text', text: trailingText });
    return {
      ...base,
      messages: [
        ...base.messages,
        { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: READ_FILE } }] },
        { role: 'user', content: userContent },
      ],
    };
  }

  function continuation(alias: string, agentId: string, toolUseId: string, trailingText?: string): Request {
    return new Request('http://router.local/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-agent-id': agentId },
      body: JSON.stringify(continuationBody(alias, toolUseId, trailingText)),
    });
  }

  test('default inert: a summarizer-shaped request with the option absent still gets the forced Read tool_use', async () => {
    // This is the behaviour that killed the measurement, kept on purpose so every existing mode
    // stays byte-identical. Only the opt-in changes it.
    const agent = CHANNEL_A_AGENTS[0]!;
    const agentId = 'agent-summary-absent';
    const { handler } = await createHandlerFixture({ childReadFilePath: READ_FILE, childReadRounds: 4 });

    const first = await decodeSse(await handler(childRequest(agent.alias, agentId)));
    const firstId = reassembleToolUseBlocks(first)[0]!.id;

    const summarizer = await decodeSse(await handler(continuation(agent.alias, agentId, firstId, COMPACTION_PROMPT)));
    expect(reassembleToolUseBlocks(summarizer)).toHaveLength(1); // a Read, exactly as before
    expect(textOf(summarizer)).not.toContain('<summary>');
  });

  test('when enabled, the summarizer gets a text summary and no tool_use, and the request is still captured', async () => {
    const agent = CHANNEL_A_AGENTS[0]!;
    const agentId = 'agent-summary-enabled';
    const { handler, seen } = await createHandlerFixture({
      childReadFilePath: READ_FILE,
      childReadRounds: 4,
      answerCompactionSummaries: true,
    });

    const first = await decodeSse(await handler(childRequest(agent.alias, agentId)));
    const firstId = reassembleToolUseBlocks(first)[0]!.id;

    const summarizer = await decodeSse(await handler(continuation(agent.alias, agentId, firstId, COMPACTION_PROMPT)));
    expect(reassembleToolUseBlocks(summarizer)).toHaveLength(0); // the compactor rejects a tool_use reply
    expect(textOf(summarizer)).toContain('<summary>');
    expect(textOf(summarizer)).toContain('PROBE_COMPACTION_SUMMARY');
    expect(textOf(summarizer)).toContain('<analysis>');
    expect(stopReasonOf(summarizer)).toBe('end_turn');
    // The model must survive untouched, same reason the usage tests give: a model matching an
    // internal client constant makes the assistant message get ignored.
    expect(messageStartOf(summarizer).model).toBe(agent.upstreamModel);

    // Answered like any other upstream request, so the run's pre/post capture pair covers it.
    expect(seen).toHaveLength(2);
    expect(seen[1]?.headers['x-claude-code-agent-id']).toBe(agentId);
    expect(seen[1]?.body.model).toBe(agent.upstreamModel);
  });

  test('answering a summarizer neither consumes a Read round nor clears the pending tool_use', async () => {
    // The compactor forks the child's turn, so the child's own next request still answers the SAME
    // pending id. With 2 rounds configured the echo must land on the third normal request; had the
    // summarizer counted as a round it would arrive one request early, and had it cleared the
    // pending id the child's next request would be treated as a fresh first one instead.
    const agent = CHANNEL_A_AGENTS[1]!;
    const agentId = 'agent-summary-bookkeeping';
    const { handler } = await createHandlerFixture({
      childReadFilePath: READ_FILE,
      childReadRounds: 2,
      answerCompactionSummaries: true,
    });

    const first = await decodeSse(await handler(childRequest(agent.alias, agentId)));
    const firstId = reassembleToolUseBlocks(first)[0]!.id;

    await decodeSse(await handler(continuation(agent.alias, agentId, firstId, COMPACTION_PROMPT)));

    // The child's own turn resumes against the id issued before the fork.
    const second = await decodeSse(await handler(continuation(agent.alias, agentId, firstId)));
    const secondUses = reassembleToolUseBlocks(second);
    expect(secondUses).toHaveLength(1); // round 1 of 2, not the echo
    expect(secondUses[0]!.id).not.toBe(firstId);

    const third = await decodeSse(await handler(continuation(agent.alias, agentId, secondUses[0]!.id)));
    expect(reassembleToolUseBlocks(third)).toHaveLength(0); // round 2 of 2: the echo, right on time
    expect(textOf(third)).toBe(`CHILD_SAW_MODEL=${agent.upstreamModel}`);
  });

  test('with a single round, the pending id still resolves to the echo after a summarizer', async () => {
    // Sharpest form of the "pending survives" check: a cleared pending would make this a fresh
    // first request and produce another tool_use instead of the echo.
    const agent = CHANNEL_A_AGENTS[0]!;
    const agentId = 'agent-summary-pending';
    const { handler } = await createHandlerFixture({ childReadFilePath: READ_FILE, answerCompactionSummaries: true });

    const first = await decodeSse(await handler(childRequest(agent.alias, agentId)));
    const firstId = reassembleToolUseBlocks(first)[0]!.id;

    await decodeSse(await handler(continuation(agent.alias, agentId, firstId, COMPACTION_PROMPT)));

    const second = await decodeSse(await handler(continuation(agent.alias, agentId, firstId)));
    expect(reassembleToolUseBlocks(second)).toHaveLength(0);
    expect(textOf(second)).toBe(`CHILD_SAW_MODEL=${agent.upstreamModel}`);
  });

  test('a normal child request is unaffected when the option is enabled', async () => {
    // The detector is the last user message's text blocks, so an ordinary answered Read round,
    // which carries a tool_result and no text block, must keep its existing behaviour.
    const agent = CHANNEL_A_AGENTS[1]!;
    const agentId = 'agent-summary-normal';
    const { handler } = await createHandlerFixture({
      childReadFilePath: READ_FILE,
      childReadRounds: 3,
      answerCompactionSummaries: true,
    });

    const first = await decodeSse(await handler(childRequest(agent.alias, agentId)));
    expect(reassembleToolUseBlocks(first)).toHaveLength(1);
    const firstId = reassembleToolUseBlocks(first)[0]!.id;

    const second = await decodeSse(await handler(continuation(agent.alias, agentId, firstId)));
    expect(reassembleToolUseBlocks(second)).toHaveLength(1); // still the forced Read flow
    expect(textOf(second)).not.toContain('<summary>');
  });

  test('a trailing text block that is not the compaction prompt is not treated as a summarizer', async () => {
    // Both literals are required. A user turn that merely carries text must not be able to make the
    // fixture skip a Read round.
    const agent = CHANNEL_A_AGENTS[0]!;
    const agentId = 'agent-summary-foreign-text';
    const { handler } = await createHandlerFixture({
      childReadFilePath: READ_FILE,
      childReadRounds: 3,
      answerCompactionSummaries: true,
    });

    const first = await decodeSse(await handler(childRequest(agent.alias, agentId)));
    const firstId = reassembleToolUseBlocks(first)[0]!.id;

    const notSummarizer = await decodeSse(await handler(continuation(agent.alias, agentId, firstId, 'please keep going')));
    expect(reassembleToolUseBlocks(notSummarizer)).toHaveLength(1);
    expect(textOf(notSummarizer)).not.toContain('<summary>');
  });
});

describe('correlation scaffold (PROBE_CORRELATION_SCAFFOLD=1, opt-in)', () => {
  test('absent, both profile builders leave the correlation gate exactly as their base had it', async () => {
    // Default inert: every existing run must keep producing the same profile it produced before
    // this knob existed, so a scaffolded run can never be confused with an ordinary one.
    const realFixture = await loadCapabilityProfile('claude-code', '2.1.268', CAPABILITIES_FIXTURES);

    const plain = realLayoutProfile(realFixture);
    expect(plain.correlation).toBe(realFixture.correlation);
    expect(plain.correlationEntropy).toBe(realFixture.correlationEntropy);
    expect(plain.probes.M1).toBe(realFixture.probes.M1);
    expect(realLayoutProfile(realFixture, 'after-native-context-v2', false)).toEqual(realLayoutProfile(realFixture, 'after-native-context-v2'));

    expect(syntheticLayoutProfile('2.1.268').correlation).toBe(false);
    expect(syntheticLayoutProfile('2.1.268').correlationEntropy).toBe('pending');
    expect(syntheticLayoutProfile('2.1.268').probes.M1).toBeUndefined();
  });

  test('when set, both builders open the correlation gate and nothing else moves', async () => {
    const realFixture = await loadCapabilityProfile('claude-code', '2.1.268', CAPABILITIES_FIXTURES);
    const scaffolded = realLayoutProfile(realFixture, 'after-native-context-v2', true);

    expect(scaffolded.correlation).toBe(true);
    expect(scaffolded.correlationEntropy).toBe('passed');
    expect(scaffolded.probes.M1).toBe('passed');

    // Everything outside the three correlation paths still matches the unscaffolded variant.
    const plain = realLayoutProfile(realFixture, 'after-native-context-v2');
    expect({ ...scaffolded, correlation: plain.correlation, correlationEntropy: plain.correlationEntropy, probes: plain.probes }).toEqual(plain);
    for (const [name, result] of Object.entries(plain.probes)) {
      if (name === 'M1') continue;
      expect(scaffolded.probes[name]).toBe(result);
    }

    const synthetic = syntheticLayoutProfile('2.1.268', 'after-native-context-v2', true);
    expect({ correlation: synthetic.correlation, correlationEntropy: synthetic.correlationEntropy, m1: synthetic.probes.M1 }).toEqual({
      correlation: true,
      correlationEntropy: 'passed',
      m1: 'passed',
    });
  });

  test('the declared path list gains exactly the three correlation paths, and covers every real divergence', async () => {
    expect(scaffoldOverriddenPaths(false)).toEqual([...SYNTHETIC_LAYOUT_SCAFFOLD_OVERRIDDEN_PATHS]);
    expect(scaffoldOverriddenPaths(true)).toEqual([...SYNTHETIC_LAYOUT_SCAFFOLD_OVERRIDDEN_PATHS, ...CORRELATION_SCAFFOLD_OVERRIDDEN_PATHS]);
    expect([...CORRELATION_SCAFFOLD_OVERRIDDEN_PATHS].sort()).toEqual(['correlation', 'correlationEntropy', 'probes.M1']);

    // The property extractM3AEvidence relies on: a scaffolded run's manifest must still declare
    // every path its profile actually diverges on, or the run can never judge past 'pending'.
    //
    // The base is the real fixture with the three gate fields pinned to their closed values.
    // Taking them as the fixture happens to have them would make the non-vacuity checks below
    // depend on what 2.1.268 was last narrowed to: once a real run measures correlation true, the
    // scaffold stops diverging on it and the check passes while proving nothing. Pinned closed,
    // these assertions are about the scaffold.
    const realFixture = await loadCapabilityProfile('claude-code', '2.1.268', CAPABILITIES_FIXTURES);
    const closedGateBase: CapabilityProfile = {
      ...realFixture,
      correlation: false,
      correlationEntropy: 'pending',
      probes: { ...realFixture.probes, M1: 'pending' },
    };
    const asRecord = (profile: CapabilityProfile): Record<string, unknown> => profile as unknown as Record<string, unknown>;

    const scaffolded = realLayoutProfile(closedGateBase, 'after-native-context-v2', true);
    const unscaffolded = realLayoutProfile(closedGateBase, 'after-native-context-v2');

    // The scaffold moves exactly the three correlation paths, no more and no fewer.
    expect(diffCapturedAgainstReal(asRecord(scaffolded), asRecord(unscaffolded)).sort()).toEqual([...CORRELATION_SCAFFOLD_OVERRIDDEN_PATHS].sort());

    // Every path the scaffolded profile diverges on from its base is covered by the declared list.
    const diverged = diffCapturedAgainstReal(asRecord(scaffolded), asRecord(closedGateBase));
    expect(diverged.filter((path) => !pathIsDeclared(path, new Set(scaffoldOverriddenPaths(true))))).toEqual([]);
    for (const path of CORRELATION_SCAFFOLD_OVERRIDDEN_PATHS) expect(diverged).toContain(path);

    // And the UNSCAFFOLDED list covers none of the three, so the extra declarations are the only
    // thing keeping a scaffolded run judgeable: each one is load-bearing.
    expect(diverged.filter((path) => !pathIsDeclared(path, new Set(SYNTHETIC_LAYOUT_SCAFFOLD_OVERRIDDEN_PATHS))).sort()).toEqual(
      [...CORRELATION_SCAFFOLD_OVERRIDDEN_PATHS].sort(),
    );
  });
});

describe('correlation channel across a compacted history (correlationScaffold, opt-in)', () => {
  function childRequest(alias: string, agentId: string): Request {
    return new Request('http://router.local/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-agent-id': agentId },
      body: JSON.stringify(buildChildRequest(alias, 'task')),
    });
  }

  // What the client sends after compacting a routed child's conversation: the whole history is
  // replaced by one user message opening with the continuation wrapper, so the channel-A marker
  // the parent placed in the original prompt is gone. Same billing block, so this is still a
  // child-scope request; only the marker is missing.
  function compactedRequest(alias: string, agentId: string): Request {
    const base = buildChildRequest(alias, 'task') as Record<string, unknown>;
    const body = {
      ...base,
      messages: [{ role: 'user', content: [{ type: 'text', text: `${COMPACTION_SUMMARY_PREFIX}\nPROBE_COMPACTION_SUMMARY: carry on.` }] }],
    };
    return new Request('http://router.local/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-agent-id': agentId },
      body: JSON.stringify(body),
    });
  }

  test("with the scaffold on, a child's marker-less post-compaction request is still routed to the model its first request bound", async () => {
    const agent = CHANNEL_A_AGENTS[1]!;
    const agentId = 'agent-correlated-compaction';
    const { handler, seen } = await createHandlerFixture({ correlationScaffold: true });

    const first = await handler(childRequest(agent.alias, agentId));
    expect(first.status).toBe(200);
    expect(textOf(await decodeSse(first))).toBe(`CHILD_SAW_MODEL=${agent.upstreamModel}`);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body.model).toBe(agent.upstreamModel);
    // The marker really was the thing that selected the model on request one: it is stripped
    // before forwarding, exactly as the unscaffolded path strips it.
    const firstText = ((seen[0]?.body.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text) ?? '';
    expect(firstText).toBe('task');

    const second = await handler(compactedRequest(agent.alias, agentId));
    expect(second.status).toBe(200); // the compacted turn survives: no missing-selection
    expect(textOf(await decodeSse(second))).toBe(`CHILD_SAW_MODEL=${agent.upstreamModel}`);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.body.model).toBe(agent.upstreamModel); // same upstream model, no drift
    // Nothing re-selected it: this request carried no marker at all.
    const secondText = ((seen[1]?.body.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text) ?? '';
    expect(secondText.includes(markerLine(agent.alias))).toBe(false);
  });

  test('control: without the scaffold the same marker-less request is refused 422 missing-selection and never forwarded', async () => {
    // This is what the 2.1.268 fixture records as lifecycle.compaction: failed. The scaffold is
    // the only difference between the two tests, so a pass above can only come from correlation.
    const agent = CHANNEL_A_AGENTS[1]!;
    const agentId = 'agent-correlated-compaction-control';
    const { handler, seen } = await createHandlerFixture();

    const first = await handler(childRequest(agent.alias, agentId));
    expect(first.status).toBe(200);
    expect(seen).toHaveLength(1);

    const second = await handler(compactedRequest(agent.alias, agentId));
    expect(second.status).toBe(422);
    expect(await second.json()).toEqual({ error: { code: 'missing-selection' } });
    expect(seen).toHaveLength(1); // the child is lost: nothing was forwarded for it
  });

  test('every one of the three scaffolded paths is load-bearing: dropping any one closes the channel again', async () => {
    // Why the declared list names three paths and not one. src/adapters/capabilities.ts's
    // claude-correlation gate ANDs M1, correlation and correlationEntropy, so a partial scaffold
    // builds no CorrelationStore at all and the compacted turn is refused exactly as it is today.
    const agent = CHANNEL_A_AGENTS[0]!;
    const full = { ...syntheticLayoutProfile('9.9.9'), correlation: true, correlationEntropy: 'passed' as const, probes: { M10: 'passed' as const, 'M3-A': 'passed' as const, M1: 'passed' as const } };
    const partials: ReadonlyArray<{ label: string; profile: CapabilityProfile }> = [
      { label: 'no M1', profile: { ...full, probes: { M10: 'passed', 'M3-A': 'passed' } } },
      { label: 'correlation false', profile: { ...full, correlation: false } },
      { label: 'entropy pending', profile: { ...full, correlationEntropy: 'pending' } },
    ];

    for (const { label, profile } of partials) {
      const { handler, seen } = await createHandlerFixture({ profile });
      const agentId = `agent-partial-${label.replace(/\s+/g, '-')}`;
      expect((await handler(childRequest(agent.alias, agentId))).status).toBe(200); // the marker still routes
      const compacted = await handler(compactedRequest(agent.alias, agentId));
      expect({ label, status: compacted.status, forwarded: seen.length }).toEqual({ label, status: 422, forwarded: 1 });
    }
  });

  test('the scaffold binds per agent id: another child with no marker and no binding of its own is still refused', async () => {
    // Correlation must not become a blanket "route anything from any child" switch. Only an agent
    // id this handler actually bound gets carried across the boundary.
    const agent = CHANNEL_A_AGENTS[0]!;
    const { handler, seen } = await createHandlerFixture({ correlationScaffold: true });

    await handler(childRequest(agent.alias, 'agent-bound'));
    const stranger = await handler(compactedRequest(agent.alias, 'agent-never-bound'));
    expect(stranger.status).toBe(422);
    expect(await stranger.json()).toEqual({ error: { code: 'missing-selection' } });
    expect(seen).toHaveLength(1);
  });
});
