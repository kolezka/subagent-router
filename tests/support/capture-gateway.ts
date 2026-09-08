export interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  rawRequestBody: Uint8Array;
  model?: string;
  agentId?: string;
  isChild?: boolean;
  body: unknown;
}

export interface CaptureGateway {
  url: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

// Expected shape for a fixture tool_result nonce, e.g. "fixture-file-nonce-7c10".
// Anything else is treated as an unscripted request and gets the default reply.
const NONCE_PATTERN = /^fixture-[a-zA-Z0-9]+-nonce-[0-9a-f]+$/;

// The unscripted default reply. A fixed, non-empty token that never depends on request content,
// so a demo run always has a real non-empty string to read back and can tell a genuine gateway
// reply apart from a broken client that just echoes its own prompt.
export const DEFAULT_REPLY_TEXT = 'fixture-reply-ok';

const SSE_BODY = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_stream","role":"assistant","content":[]}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

interface AnthropicRequestBody {
  model?: unknown;
  system?: unknown;
  messages?: unknown;
  tools?: unknown;
  stream?: unknown;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

function textOfFirstSystemBlock(body: AnthropicRequestBody): string | undefined {
  const system = body.system;
  if (!Array.isArray(system) || system.length === 0) return undefined;
  const first = system[0] as { text?: unknown } | undefined;
  return typeof first?.text === 'string' ? first.text : undefined;
}

function extractToolResult(body: AnthropicRequestBody): { toolUseId: string; content: string } | undefined {
  const messages = body.messages;
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    const content = (message as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const candidate = part as { type?: unknown; tool_use_id?: unknown; content?: unknown };
      if (candidate.type === 'tool_result' && typeof candidate.tool_use_id === 'string' && typeof candidate.content === 'string') {
        return { toolUseId: candidate.tool_use_id, content: candidate.content };
      }
    }
  }
  return undefined;
}

function wantsFixtureTool(body: AnthropicRequestBody): boolean {
  const tools = body.tools;
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => (tool as { name?: unknown })?.name === 'read_fixture');
}

/**
 * Starts a scripted, loopback-only fake Anthropic Messages endpoint for tests. It records every
 * request it sees and replies from a small fixed script (plain reply, SSE stream, or a
 * tool_use/tool_result roundtrip gated on a nonce format). This is not a router or a model loop:
 * it never echoes arbitrary prompts or forwards to a real provider.
 */
export async function startCaptureGateway(): Promise<CaptureGateway> {
  const requests: CapturedRequest[] = [];
  let lastToolUseId: string | undefined;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== '/v1/messages') {
        return new Response('not found', { status: 404 });
      }

      const rawRequestBody = new Uint8Array(await request.arrayBuffer());
      let parsed: unknown = {};
      if (rawRequestBody.length > 0) {
        try {
          parsed = JSON.parse(new TextDecoder().decode(rawRequestBody));
        } catch {
          parsed = {};
        }
      }
      const body = parsed as AnthropicRequestBody;

      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const model = typeof body.model === 'string' ? body.model : undefined;
      const agentId = headers['x-claude-code-agent-id'];
      const systemText = textOfFirstSystemBlock(body);
      const isChild = systemText !== undefined && systemText.includes('cc_is_subagent=true');

      requests.push({
        method: request.method,
        path: url.pathname,
        headers,
        rawRequestBody,
        body: parsed,
        isChild,
        ...(model !== undefined ? { model } : {}),
        ...(agentId !== undefined ? { agentId } : {}),
      });

      if (body.stream === true) {
        return new Response(SSE_BODY, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }

      if (wantsFixtureTool(body)) {
        const toolUseId = `toolu_${crypto.randomUUID()}`;
        lastToolUseId = toolUseId;
        return jsonResponse({
          id: 'msg_scripted_tool_use',
          type: 'message',
          role: 'assistant',
          model: model ?? 'gateway/fast-worker',
          content: [{ type: 'tool_use', id: toolUseId, name: 'read_fixture', input: {} }],
          stop_reason: 'tool_use',
        });
      }

      const toolResult = extractToolResult(body);
      if (toolResult !== undefined && toolResult.toolUseId === lastToolUseId && NONCE_PATTERN.test(toolResult.content)) {
        return jsonResponse({
          id: 'msg_scripted_tool_result',
          type: 'message',
          role: 'assistant',
          model: model ?? 'gateway/fast-worker',
          content: [{ type: 'text', text: toolResult.content }],
          stop_reason: 'end_turn',
        });
      }

      return jsonResponse({
        id: 'msg_scripted_default',
        type: 'message',
        role: 'assistant',
        model: model ?? 'gateway/fast-worker',
        content: [{ type: 'text', text: DEFAULT_REPLY_TEXT }],
        stop_reason: 'end_turn',
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    close: async (): Promise<void> => {
      server.stop(true);
    },
  };
}
