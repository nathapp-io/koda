/**
 * Test processes must never reach the network through an environment HTTP proxy.
 *
 * A CI or dev sandbox commonly exports `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` for its own egress.
 * The HTTP suites in `apps/api` talk to an in-process server on loopback (`supertest(server)`), and a
 * proxy that ends up in that path answers with its own status — most visibly
 * `407 Proxy Authentication Required` — which surfaces as a bogus failure in an unrelated assertion.
 *
 * `test-setup.ts` calls `disableEnvProxy()` before any spec runs, so the proxy variables are gone and
 * loopback is explicitly exempt either way.
 */

/** Hosts that must never be proxied: the in-process test servers and the test Postgres. */
export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'] as const;

const PROXY_VARIABLES = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;

const NO_PROXY_VARIABLES = ['NO_PROXY', 'no_proxy'] as const;

/** Removes every proxy variable and keeps the existing `NO_PROXY` entries, adding loopback. */
export function disableEnvProxy(): void {
  for (const name of PROXY_VARIABLES) delete process.env[name];

  for (const name of NO_PROXY_VARIABLES) {
    const existing = (process.env[name] ?? '')
      .split(',')
      .map((host) => host.trim())
      .filter((host) => host.length > 0);
    process.env[name] = [...new Set([...existing, ...LOOPBACK_HOSTS])].join(',');
  }
}
