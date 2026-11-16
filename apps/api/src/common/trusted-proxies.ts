/**
 * The reverse proxies whose forwarded client address this API trusts: the loopback address and the
 * private networks a deployment's own proxy sits on (nginx in front of Nuxt, Nuxt's `/api` proxy,
 * the compose network).
 *
 * One list, because one resolver: `@nathapp/nestjs-common`'s `getClientIp` reads it for both the
 * throttler's tracker and the refresh route's recorded client. A second copy — Fastify's own
 * `trustProxy`, for instance — would let the two disagree about who the client is (#470).
 *
 * The integration test that proves a forwarded address is recorded imports this list rather than
 * repeating it, so a list that stops covering the deployment's proxy fails there.
 */
export const TRUSTED_PROXIES = [
  '127.0.0.1',
  '::1',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
];
