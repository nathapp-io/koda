import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';

/**
 * Test-only upstream proxy: unlike a browser interceptor, this sees Nuxt's SSR session probes too.
 * Counts are keyed by a digest of the bearer header so parallel sessions do not affect assertions;
 * neither tokens nor request bodies are logged or retained. This process exists only in Playwright's webServer list.
 */
const upstream = process.env['E2E_PROXY_UPSTREAM'];
const port = process.env['E2E_AUTH_PROXY_PORT'];
if (!upstream || !port) throw new Error('The auth probe proxy needs its upstream and listen port');
const counts = new Map<string, number>();

createServer((incoming, outgoing) => {
  const key = createHash('sha256').update(incoming.headers.authorization ?? '').digest('hex');
  if (incoming.url === '/__test/health') {
    outgoing.end('ok');
    return;
  }
  if (incoming.url === '/__test/auth-probes') {
    outgoing.setHeader('Content-Type', 'application/json');
    outgoing.end(JSON.stringify({ probes: counts.get(key) ?? 0 }));
    return;
  }
  if (incoming.method === 'GET' && incoming.url === '/api/auth/me') {
    // A bounded FIFO is enough for this short-lived test process; do not retain every session in an extended run.
    if (!counts.has(key) && counts.size >= 1_024) {
      const oldest = counts.keys().next().value;
      if (oldest !== undefined) counts.delete(oldest);
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const forwarded = request(new URL(incoming.url ?? '/', upstream), {
    method: incoming.method,
    headers: incoming.headers,
  }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  forwarded.on('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
  });
  outgoing.on('close', () => forwarded.destroy());
  incoming.pipe(forwarded);
}).listen(Number(port), '127.0.0.1');
