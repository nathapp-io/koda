import { createServer, IncomingMessage, Server } from 'http';
import type { AddressInfo } from 'net';

export interface FakeRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}
export type FakeReply = { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number; stallBodyMs?: number };
export interface FakeForge {
  url: string;
  routes: Map<string, (req: FakeRequest) => FakeReply>;
  requests: FakeRequest[];
  close(): Promise<void>;
}

/** Local stand-in for the GitHub / GitLab REST APIs. Routes are keyed "METHOD /path". */
export async function startFakeForge(): Promise<FakeForge> {
  const routes = new Map<string, (req: FakeRequest) => FakeReply>();
  const requests: FakeRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const path = (req.url ?? '/').split('?')[0];
      const fake: FakeRequest = { method: req.method ?? 'GET', path, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      requests.push(fake);
      const handler = routes.get(`${fake.method} ${path}`);
      const reply = handler ? handler(fake) : { status: 404, body: { message: 'Not Found' } };
      setTimeout(() => {
        res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
        // stallBodyMs: flush the head plus a partial body chunk immediately, then hold the
        // remainder open — a provider that starts answering and stalls mid-body (so the
        // client's fetch resolves and the abort fires during the body read).
        if (reply.stallBodyMs) {
          const raw = reply.body === undefined ? '' : JSON.stringify(reply.body);
          if (raw) {
            const cut = Math.max(1, Math.floor(raw.length / 2));
            res.write(raw.slice(0, cut));
            setTimeout(() => res.end(raw.slice(cut)), reply.stallBodyMs);
          } else {
            setTimeout(() => res.end(), reply.stallBodyMs);
          }
        } else {
          res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
        }
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    routes,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
