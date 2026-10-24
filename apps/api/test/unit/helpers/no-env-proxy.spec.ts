/**
 * The API test process must not use an environment HTTP proxy: a proxy that intercepts the
 * loopback connection to an in-process test server answers with its own status (typically
 * `407 Proxy Authentication Required`) and fails an unrelated assertion.
 */
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { disableEnvProxy, LOOPBACK_HOSTS } from '../../helpers/no-env-proxy';

const PROXY_VARIABLES = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
const NO_PROXY_VARIABLES = ['NO_PROXY', 'no_proxy'];

const snapshotEnv = (): Record<string, string | undefined> =>
  Object.fromEntries([...PROXY_VARIABLES, ...NO_PROXY_VARIABLES].map((name) => [name, process.env[name]]));

const restoreEnv = (snapshot: Record<string, string | undefined>): void => {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

const noProxyHosts = (): string[] =>
  (process.env.NO_PROXY ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);

describe('disableEnvProxy', () => {
  let snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    snapshot = snapshotEnv();
  });

  afterEach(() => {
    restoreEnv(snapshot);
  });

  it('removes every proxy variable and keeps the existing NO_PROXY entries, adding loopback', () => {
    const hosts = LOOPBACK_HOSTS as readonly string[];
    process.env.HTTP_PROXY = 'http://proxy.test:3128';
    process.env.HTTPS_PROXY = 'http://proxy.test:3128';
    process.env.ALL_PROXY = 'socks5://proxy.test:1080';
    process.env.NO_PROXY = 'example.test';

    disableEnvProxy();

    for (const name of PROXY_VARIABLES) expect(process.env[name]).toBeUndefined();
    expect(noProxyHosts()).toEqual(expect.arrayContaining(['example.test', ...hosts]));
  });

  it('is idempotent', () => {
    disableEnvProxy();
    const first = process.env.NO_PROXY;

    disableEnvProxy();

    expect(process.env.NO_PROXY).toBe(first);
    expect(noProxyHosts().filter((host) => host === 'localhost')).toHaveLength(1);
  });
});

describe('the API test process', () => {
  let server: Server;
  let baseUrl = '';
  let snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    snapshot = snapshotEnv();
  });

  afterEach(() => {
    restoreEnv(snapshot);
  });

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('has no proxy variable in effect, and exempts every loopback host', () => {
    const leaking = PROXY_VARIABLES.filter((name) => process.env[name] !== undefined);

    expect(leaking).toEqual([]);
    expect(noProxyHosts()).toEqual(expect.arrayContaining([...(LOOPBACK_HOSTS as readonly string[])]));
  });

  it('answers a loopback HTTP request even when a proxy variable leaks back in', async () => {
    // A proxy on a closed port: anything routed through it fails, so a 200 proves loopback is direct.
    // Snapshot before poisoning it, so finally restores the environment the test started with.
    const before = snapshotEnv();
    try {
      process.env.HTTP_PROXY = 'http://127.0.0.1:1';
      process.env.http_proxy = 'http://127.0.0.1:1';

      disableEnvProxy();

      const res = await request(baseUrl).get('/').expect(200);
      expect(res.text).toBe('ok');
    } finally {
      restoreEnv(before);
    }
  });
});
