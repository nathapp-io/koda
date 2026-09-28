/**
 * US-004 — `OutboundHttpClient.post`: guarded native HTTP(S) delivery.
 *
 * Every case runs a real `node:http` server bound to 127.0.0.1 and the real
 * `OutboundUrlGuard`; only the DNS seam (`DnsResolver`) is stubbed, so no test
 * performs a real lookup or reaches past the loopback interface. A destination
 * hostname is reached by allow-listing it (`allowedHostnames`) and resolving it to
 * 127.0.0.1 through the stub, which is the only way an allow-listed host can reach
 * the local server.
 *
 * AC1–AC10 and AC15 of the story. The handler side lives in
 * `src/webhook/webhook-delivery.handler.spec.ts` and the fan-out seam in
 * `src/webhook/webhook-delivery.seam.spec.ts`.
 */
import * as http from 'node:http';
import { Logger } from '@nestjs/common';
import { IWebhookConfig } from '../../config/webhook.config';
import { DeliveryErrorCode, OutboundHttpClient, WebhookDeliveryError } from './outbound-http-client';
import { OutboundUrlGuard } from './outbound-url-guard';

const LOOPBACK = '127.0.0.1';
const ALLOWED_HOST = 'allowed.test';

/** Destination allow-lists stay empty unless a case says otherwise. */
const BASE_CONFIG: IWebhookConfig = {
  allowedHostnames: [],
  allowedCidrs: [],
  deliveryTimeoutMs: 2000,
};

type ResolveMock = jest.Mock<Promise<string[]>, [string]>;

interface ClientHarness {
  client: OutboundHttpClient;
  resolve: ResolveMock;
}

function makeClient(
  options: { config?: Partial<IWebhookConfig>; addresses?: readonly string[] } = {},
): ClientHarness {
  const addresses = options.addresses ?? [LOOPBACK];
  const resolve = jest.fn<Promise<string[]>, [string]>(
    (): Promise<string[]> => Promise.resolve([...addresses]),
  );
  const config: IWebhookConfig = { ...BASE_CONFIG, ...options.config };
  const guard = new OutboundUrlGuard(config, { resolve });

  // OutboundUrlGuard takes the resolver as its second constructor argument, so the
  // loopback never answers the client's connect-time lookup.
  return { client: new OutboundHttpClient(guard, config), resolve };
}

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface TestServer {
  readonly port: number;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

type Responder = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** A loopback HTTP server that records every request it receives. */
async function startServer(respond: Responder): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      respond(req, res);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server did not bind a TCP port');
  }

  return {
    port: address.port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A port nothing is listening on (bind a server, note its port, close it). */
async function closedPort(): Promise<number> {
  const server = await startServer(() => undefined);
  const { port } = server;
  await server.close();
  return port;
}

function answersWith(status: number, headers: http.OutgoingHttpHeaders = {}): Responder {
  return (_req, res) => {
    res.writeHead(status, headers);
    res.end();
  };
}

/**
 * Settles `post` and returns its delivery error code. A `post` that resolves — or
 * that rejects with something other than a `WebhookDeliveryError` — fails the
 * assertions here rather than being reported as a missing rejection.
 */
async function deliveryCode(attempt: Promise<void>): Promise<DeliveryErrorCode> {
  let caught: unknown;
  try {
    await attempt;
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(WebhookDeliveryError);
  if (!(caught instanceof WebhookDeliveryError)) {
    throw new Error('post did not reject with WebhookDeliveryError');
  }
  expect(caught.name).toBe('WebhookDeliveryError');
  expect(caught.message).toBe(caught.code);
  return caught.code;
}

describe('US-004: OutboundHttpClient.post', () => {
  const started: TestServer[] = [];

  async function server(respond: Responder): Promise<TestServer> {
    const created = await startServer(respond);
    started.push(created);
    return created;
  }

  afterEach(async () => {
    for (const open of started.splice(0)) {
      await open.close();
    }
  });

  describe('AC1: a 2xx answer resolves and the request arrives once', () => {
    it('AC1: post to an allow-listed host that answers 204 resolves and the server receives exactly one POST with the supplied body and headers', async () => {
      const target = await server(answersWith(204));
      const { client } = makeClient({ config: { allowedHostnames: [ALLOWED_HOST] } });
      const body = JSON.stringify({ a: 1 });
      const headers = {
        'Content-Type': 'application/json',
        'X-Koda-Event': 'STATUS_CHANGE',
        'X-Koda-Signature': 'sha256=abc',
        'X-Koda-Delivery-Id': 'delivery-1',
      };

      await expect(
        client.post(`http://${ALLOWED_HOST}:${target.port}/hook`, headers, body),
      ).resolves.toBeUndefined();

      expect(target.requests).toHaveLength(1);
      expect(target.requests[0].method).toBe('POST');
      expect(target.requests[0].url).toBe('/hook');
      expect(target.requests[0].body).toBe(body);
      expect(target.requests[0].headers['content-type']).toBe('application/json');
      expect(target.requests[0].headers['x-koda-event']).toBe('STATUS_CHANGE');
      expect(target.requests[0].headers['x-koda-signature']).toBe('sha256=abc');
      expect(target.requests[0].headers['x-koda-delivery-id']).toBe('delivery-1');
    });

    it('AC1 boundary: a 200 answer with a response body still resolves', async () => {
      const target = await server((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('a body the client must discard');
      });
      const { client } = makeClient({ config: { allowedHostnames: [ALLOWED_HOST] } });

      await expect(client.post(`http://${ALLOWED_HOST}:${target.port}/hook`, {}, '{}')).resolves.toBeUndefined();
      expect(target.requests).toHaveLength(1);
    });

    it('AC1 boundary: an operator CIDR allowlist reaches the loopback literal without consulting DNS', async () => {
      const target = await server(answersWith(204));
      const { client, resolve } = makeClient({ config: { allowedCidrs: ['127.0.0.0/8'] } });

      await expect(client.post(`http://${LOOPBACK}:${target.port}/hook`, {}, '{}')).resolves.toBeUndefined();

      expect(target.requests).toHaveLength(1);
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  describe('AC2: a rebinding DNS answer is a blocked destination', () => {
    it('AC2: post to a non-allow-listed hostname that resolves to 127.0.0.1 rejects with blocked_destination and the server receives no request', async () => {
      const target = await server(answersWith(204));
      const { client, resolve } = makeClient({ addresses: [LOOPBACK] });

      expect(
        await deliveryCode(client.post(`https://rebind.test:${target.port}/hook`, {}, '{}')),
      ).toBe('blocked_destination');

      expect(resolve).toHaveBeenCalledWith('rebind.test');
      expect(target.requests).toHaveLength(0);
    });

    it('AC2 boundary: an answer of ::1 is a blocked destination too', async () => {
      const target = await server(answersWith(204));
      const { client } = makeClient({ addresses: ['::1'] });

      expect(
        await deliveryCode(client.post(`https://rebind.test:${target.port}/hook`, {}, '{}')),
      ).toBe('blocked_destination');
      expect(target.requests).toHaveLength(0);
    });
  });

  describe('AC3: an IP-literal loopback target is refused before any connection', () => {
    it('AC3: post to https://127.0.0.1 rejects with blocked_destination, never calls the resolver and sends no request', async () => {
      const target = await server(answersWith(204));
      const { client, resolve } = makeClient();

      expect(
        await deliveryCode(client.post(`https://${LOOPBACK}:${target.port}/hook`, {}, '{}')),
      ).toBe('blocked_destination');

      expect(resolve).not.toHaveBeenCalled();
      expect(target.requests).toHaveLength(0);
    });

    it('AC3 boundary: the IPv6 loopback literal [::1] is refused the same way', async () => {
      const target = await server(answersWith(204));
      const { client, resolve } = makeClient();

      expect(
        await deliveryCode(client.post(`https://[::1]:${target.port}/hook`, {}, '{}')),
      ).toBe('blocked_destination');

      expect(resolve).not.toHaveBeenCalled();
      expect(target.requests).toHaveLength(0);
    });
  });

  describe('AC4: a 3xx answer is a refused redirect', () => {
    it('AC4: a 302 with Location rejects with redirect_refused and the server is asked exactly once', async () => {
      const target = await server(answersWith(302, { Location: '/elsewhere' }));
      const { client } = makeClient({ config: { allowedHostnames: [ALLOWED_HOST] } });

      expect(
        await deliveryCode(client.post(`http://${ALLOWED_HOST}:${target.port}/hook`, {}, '{}')),
      ).toBe('redirect_refused');

      expect(target.requests).toHaveLength(1);
      expect(target.requests.map((request) => request.url)).toEqual(['/hook']);
    });

    it('AC4 boundary: a 301 with Location is refused without being followed', async () => {
      const target = await server(answersWith(301, { Location: 'http://169.254.169.254/' }));
      const { client } = makeClient({ config: { allowedHostnames: [ALLOWED_HOST] } });

      expect(
        await deliveryCode(client.post(`http://${ALLOWED_HOST}:${target.port}/hook`, {}, '{}')),
      ).toBe('redirect_refused');
      expect(target.requests).toHaveLength(1);
    });
  });

  describe('AC5: a 4xx answer is http_4xx', () => {
    it('AC5: a 404 rejects with http_4xx', async () => {
      const target = await server(answersWith(404));
      const { client } = makeClient({ config: { allowedHostnames: [ALLOWED_HOST] } });

      expect(
        await deliveryCode(client.post(`http://${ALLOWED_HOST}:${target.port}/hook`, {}, '{}')),
      ).toBe('http_4xx');
    });

    it('AC5 boundary: a 400 rejects with http_4xx', async () => {
      const target = await server(answersWith(400));
      const { client } = makeClient({ config: { allowedHostnames: [ALLOWED_HOST] } });

      expect(
        await deliveryCode(client.post(`http://${ALLOWED_HOST}:${target.port}/hook`, {}, '{}')),
      ).toBe('http_4xx');
    });
  });

  describe('AC6: a 5xx answer is http_5xx', () => {
    it('AC6: a 503 rejects with http_5xx', async () => {
      const target = await server(answersWith(503));
      const { client } = makeClient({ config: { allowedHostnames: [ALLOWED_HOST] } });

      expect(
        await deliveryCode(client.post(`http://${ALLOWED_HOST}:${target.port}/hook`, {}, '{}')),
      ).toBe('http_5xx');
    });

    it('AC6 boundary: a 500 rejects with http_5xx', async () => {
      const target = await server(answersWith(500));
      const { client } = makeClient({ config: { allowedHostnames: [ALLOWED_HOST] } });

      expect(
        await deliveryCode(client.post(`http://${ALLOWED_HOST}:${target.port}/hook`, {}, '{}')),
      ).toBe('http_5xx');
    });
  });

  describe('AC7: a destination that never answers times out', () => {
    it('AC7: post with deliveryTimeoutMs 200 rejects with timeout in under 1000 ms', async () => {
      const target = await server(() => undefined);
      const { client } = makeClient({
        config: { allowedHostnames: [ALLOWED_HOST], deliveryTimeoutMs: 200 },
      });

      const beganAt = Date.now();
      const code = await deliveryCode(
        client.post(`http://${ALLOWED_HOST}:${target.port}/hook`, {}, '{}'),
      );
      const elapsed = Date.now() - beganAt;

      expect(code).toBe('timeout');
      expect(elapsed).toBeLessThan(1000);
    });

    it('AC7 boundary: an answer inside the timeout window resolves instead of timing out', async () => {
      const target = await server(answersWith(204));
      const { client } = makeClient({
        config: { allowedHostnames: [ALLOWED_HOST], deliveryTimeoutMs: 200 },
      });

      await expect(
        client.post(`http://${ALLOWED_HOST}:${target.port}/hook`, {}, '{}'),
      ).resolves.toBeUndefined();
    });
  });

  describe('AC8: a destination with no listener is connect_failed', () => {
    it('AC8: post to an allow-listed host on a port with no listener rejects with connect_failed', async () => {
      const port = await closedPort();
      const { client } = makeClient({ config: { allowedHostnames: [ALLOWED_HOST] } });

      expect(
        await deliveryCode(client.post(`http://${ALLOWED_HOST}:${port}/hook`, {}, '{}')),
      ).toBe('connect_failed');
    });

    it('AC8 boundary: a connection reset after the request was written is connect_failed', async () => {
      const target = await server((req) => {
        req.socket.destroy();
      });
      const { client } = makeClient({ config: { allowedHostnames: [ALLOWED_HOST] } });

      expect(
        await deliveryCode(client.post(`http://${ALLOWED_HOST}:${target.port}/hook`, {}, '{}')),
      ).toBe('connect_failed');
    });
  });

  describe('AC9: a connect-time DNS failure is connect_failed', () => {
    it('AC9: a resolver stub that throws ENOTFOUND rejects with connect_failed', async () => {
      const target = await server(answersWith(204));
      const { client, resolve } = makeClient({ config: { allowedHostnames: [ALLOWED_HOST] } });
      resolve.mockRejectedValue(
        Object.assign(new Error(`getaddrinfo ENOTFOUND ${ALLOWED_HOST}`), { code: 'ENOTFOUND' }),
      );

      expect(
        await deliveryCode(client.post(`http://${ALLOWED_HOST}:${target.port}/hook`, {}, '{}')),
      ).toBe('connect_failed');
      expect(resolve).toHaveBeenCalledWith(ALLOWED_HOST);
      expect(target.requests).toHaveLength(0);
    });

    it('AC9 boundary: a resolver stub that answers with no address rejects with connect_failed', async () => {
      const target = await server(answersWith(204));
      const { client } = makeClient({ config: { allowedHostnames: [ALLOWED_HOST] }, addresses: [] });

      expect(
        await deliveryCode(client.post(`http://${ALLOWED_HOST}:${target.port}/hook`, {}, '{}')),
      ).toBe('connect_failed');
      expect(target.requests).toHaveLength(0);
    });
  });

  describe('AC10: the raw failure is logged for operators only', () => {
    it('AC10: a refused connection logs Logger.warn once with the raw code and the URL host', async () => {
      const port = await closedPort();
      const { client } = makeClient({ config: { allowedHostnames: [ALLOWED_HOST] } });
      const warn = Logger.prototype.warn as unknown as jest.Mock;
      warn.mockClear();

      expect(
        await deliveryCode(client.post(`http://${ALLOWED_HOST}:${port}/hook`, {}, '{}')),
      ).toBe('connect_failed');

      expect(warn).toHaveBeenCalledTimes(1);
      const logged = warn.mock.calls[0].map((part: unknown) => String(part)).join(' ');
      expect(logged).toContain('ECONNREFUSED');
      expect(logged).toContain(ALLOWED_HOST);
    });

    it('AC10 boundary: the raw text never reaches WebhookDeliveryError.message', async () => {
      const port = await closedPort();
      const { client } = makeClient({ config: { allowedHostnames: [ALLOWED_HOST] } });

      let caught: unknown;
      try {
        await client.post(`http://${ALLOWED_HOST}:${port}/hook`, {}, '{}');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(WebhookDeliveryError);
      if (!(caught instanceof WebhookDeliveryError)) {
        throw new Error('post did not reject with WebhookDeliveryError');
      }
      expect(caught.message).toBe('connect_failed');
      expect(caught.message).not.toContain('ECONNREFUSED');
      expect(caught.message).not.toContain(ALLOWED_HOST);
    });
  });

  describe('AC15: a stored http:// URL that is not allow-listed', () => {
    it('AC15: post rejects with blocked_destination and the server receives no request', async () => {
      const target = await server(answersWith(204));
      const { client } = makeClient();

      expect(
        await deliveryCode(client.post(`http://legacy.test:${target.port}/hook`, {}, '{}')),
      ).toBe('blocked_destination');
      expect(target.requests).toHaveLength(0);
    });

    it('AC15 boundary: a port with no listener still yields blocked_destination rather than connect_failed', async () => {
      const port = await closedPort();
      const { client } = makeClient();

      expect(
        await deliveryCode(client.post(`http://legacy.test:${port}/hook`, {}, '{}')),
      ).toBe('blocked_destination');
    });

    it('AC15 boundary: a stored ftp:// URL is refused the same way, without a connection', async () => {
      const target = await server(answersWith(204));
      const { client } = makeClient();

      expect(
        await deliveryCode(client.post(`ftp://legacy.test:${target.port}/hook`, {}, '{}')),
      ).toBe('blocked_destination');
      expect(target.requests).toHaveLength(0);
    });

    it('AC15 boundary: a stored URL with embedded credentials is refused the same way, without a connection', async () => {
      const target = await server(answersWith(204));
      const { client } = makeClient({
        config: { allowedHostnames: [ALLOWED_HOST] },
      });

      expect(
        await deliveryCode(client.post(`https://user:pw@${ALLOWED_HOST}:${target.port}/hook`, {}, '{}')),
      ).toBe('blocked_destination');
      expect(target.requests).toHaveLength(0);
    });
  });
});
