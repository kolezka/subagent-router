import { describe, expect, test } from 'bun:test';
import { bunRawFetch } from '../../src/transport/bun-fetch';

function startGzipServer(plaintext: string): { url: string; wireBytes: Uint8Array; stop: () => void } {
  const wireBytes = Bun.gzipSync(Buffer.from(plaintext));
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(): Response {
      return new Response(wireBytes, {
        status: 200,
        headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': String(wireBytes.length) },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/`, wireBytes, stop: () => server.stop(true) };
}

describe('bunRawFetch transport adapter (loopback, real measurement)', () => {
  test('negative control: default fetch() auto-decompresses but reports the pre-decompression headers', async () => {
    const plaintext = 'x'.repeat(5000);
    const gzip = startGzipServer(plaintext);
    try {
      const response = await fetch(gzip.url);
      const body = new Uint8Array(await response.arrayBuffer());
      // Real transparency violation this adapter exists to route around: default fetch delivers
      // the decompressed plaintext but keeps the wire content-length header, so headers and body
      // disagree about what was actually delivered.
      expect(body.length).toBe(plaintext.length);
      expect(body.length).not.toBe(gzip.wireBytes.length);
      expect(response.headers.get('content-length')).toBe(String(gzip.wireBytes.length));
      expect(String(body.length)).not.toBe(response.headers.get('content-length'));
    } finally {
      gzip.stop();
    }
  });

  test('gzip bytes: bunRawFetch delivers the exact untouched wire bytes, not the decompressed body', async () => {
    const plaintext = 'y'.repeat(5000);
    const gzip = startGzipServer(plaintext);
    try {
      const response = await bunRawFetch(new Request(gzip.url));
      const body = new Uint8Array(await response.arrayBuffer());
      expect(Array.from(body)).toEqual(Array.from(gzip.wireBytes));
      expect(body.length).not.toBe(plaintext.length);
    } finally {
      gzip.stop();
    }
  });

  test('end-to-end headers: bunRawFetch keeps content-length/content-encoding truthful about the delivered body', async () => {
    const plaintext = 'z'.repeat(5000);
    const gzip = startGzipServer(plaintext);
    try {
      const response = await bunRawFetch(new Request(gzip.url));
      const body = new Uint8Array(await response.arrayBuffer());
      expect(response.headers.get('content-encoding')).toBe('gzip');
      expect(response.headers.get('content-length')).toBe(String(body.length));
      expect(body.length).toBe(gzip.wireBytes.length);
    } finally {
      gzip.stop();
    }
  });

  test('redirect: manual -- a 3xx is returned as-is, never silently followed', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request): Response {
        const url = new URL(request.url);
        if (url.pathname === '/start') {
          return new Response(null, { status: 302, headers: { location: '/target' } });
        }
        return new Response('should never be reached automatically', { status: 200 });
      },
    });
    try {
      const response = await bunRawFetch(new Request(`http://127.0.0.1:${server.port}/start`));
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/target');
    } finally {
      server.stop(true);
    }
  });
});
