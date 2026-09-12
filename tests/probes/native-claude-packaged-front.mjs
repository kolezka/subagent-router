import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const out = process.env.PROBE_OUT;
const target = process.env.PROBE_PACKAGED_SERVE_TARGET;
if (!out || !target) throw new Error('PROBE_OUT and PROBE_PACKAGED_SERVE_TARGET are required');

fs.mkdirSync(out, { recursive: true });
const targetUrl = new URL(target);
const preDir = path.join(out, 'packaged-pre');
fs.mkdirSync(preDir, { recursive: true });
let requestSequence = 0;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const captureRequestId = `request-${++requestSequence}`;
    let parsed = {};
    try {
      parsed = JSON.parse(body.toString());
    } catch {}
    fs.writeFileSync(path.join(preDir, `${captureRequestId}.json`), JSON.stringify({ url: req.url, headers: req.headers, body: parsed, captureRequestId }, null, 2));
    const headers = { ...req.headers, 'x-probe-capture-id': captureRequestId };
    const upstream = http.request(
      { hostname: targetUrl.hostname, port: targetUrl.port, path: req.url, method: req.method, headers },
      (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(res);
      },
    );
    upstream.once('error', (error) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(error.message);
    });
    upstream.end(body);
  });
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  fs.writeFileSync(path.join(out, 'front-port'), String(port));
  fs.writeFileSync(path.join(out, 'port'), String(port));
  console.log(`packaged-front 127.0.0.1:${port} target=${target}`);
});
