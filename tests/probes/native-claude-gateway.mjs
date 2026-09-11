// Local mock Anthropic Messages gateway for native Claude Code subagent probes.
// Records every inbound request verbatim; scripts SSE responses so a real
// `claude` process performs a real native Task delegation against loopback only.
// ponytail: single-process, no TLS, no auth check. Ceiling: one CLI at a time.
// Upgrade path: bind per-run port (already ephemeral) + per-run outDir (already).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.env.PROBE_OUT;
const MODE = process.env.PROBE_MODE || 'simple';
// M2 measurement: when set, every scripted Agent call carries this value in its `model`
// parameter, so the capture shows what clientModel the real client sends for a full id.
const AGENT_MODEL = process.env.PROBE_AGENT_MODEL || undefined;
const MARKER = 'NATIVE_PROBE_CHILD_MARKER_7Q2';
if (!OUT) throw new Error('PROBE_OUT required');
fs.mkdirSync(OUT, { recursive: true });

let seq = 0;
const record = (kind, obj) => {
  const n = String(++seq).padStart(3, '0');
  fs.writeFileSync(path.join(OUT, `${n}-${kind}.json`), JSON.stringify(obj, null, 2));
  return n;
};

const sse = (res, events) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const [event, data] of events) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  res.end();
};

const msgId = () => 'msg_probe_' + Math.random().toString(36).slice(2, 10);

function textReply(model, text) {
  const id = msgId();
  return [
    ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
}

function taskReply(model, tasks) {
  const id = msgId();
  const ev = [
    ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ];
  tasks.forEach((t, i) => {
    const input = { description: t.desc, prompt: t.prompt, subagent_type: t.agent, run_in_background: false, ...(AGENT_MODEL ? { model: AGENT_MODEL } : {}) };
    ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_probe_${i}`, name: 'Agent', input: {} } }]);
    ev.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }]);
    ev.push(['content_block_stop', { type: 'content_block_stop', index: i }]);
  });
  ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }]);
  ev.push(['message_stop', { type: 'message_stop' }]);
  return ev;
}

// Classify an inbound request without guessing at private field names.
function classify(body) {
  const toolNames = (body.tools || []).map((t) => t.name);
  const hasTask = toolNames.includes('Agent');
  const json = JSON.stringify(body.messages || []);
  const sawMarker = json.includes(MARKER);
  const sawToolResult = json.includes('"tool_result"');
  if (!hasTask && sawMarker) return 'child';
  if (hasTask && sawToolResult) return 'parent_final';
  if (hasTask) return 'parent_first';
  return 'other';
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.url.includes('count_tokens')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: 100 }));
    }
    let body = {};
    try { body = JSON.parse(raw); } catch { /* record raw below */ }
    const kind = classify(body);
    record(kind, { url: req.url, headers: req.headers, body });

    const model = body.model || 'unknown';
    if (kind === 'child') {
      // Echo back what the child actually received so it lands in the parent transcript.
      return sse(res, textReply(model, `CHILD_SAW_MODEL=${model}`));
    }
    if (kind === 'parent_first' && MODE === 'delegate') {
      return sse(res, taskReply(model, [
        { desc: 'probe alpha', agent: 'native-probe-alpha', prompt: `${MARKER} alpha` },
        { desc: 'probe beta', agent: 'native-probe-beta', prompt: `${MARKER} beta` },
      ]));
    }
    return sse(res, textReply(model, 'PARENT_ROUNDTRIP_OK'));
  });
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  fs.writeFileSync(path.join(OUT, 'port'), String(port));
  console.log(`gateway 127.0.0.1:${port} mode=${MODE}`);
});
