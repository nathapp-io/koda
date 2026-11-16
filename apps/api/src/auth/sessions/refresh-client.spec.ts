import { createHash } from 'node:crypto';
import { configureTrustProxy, resetTrustProxyConfig } from '@nathapp/nestjs-common';
import { TRUSTED_PROXIES } from '../../common/trusted-proxies';
import { refreshClientFrom, refreshClientOf, type RefreshRequestLike } from './refresh-client';

/** The hash the helper must produce, computed independently of it. */
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('refreshClientOf', () => {
  it('AC-1: hashes the User-Agent and keeps the presenting IP', () => {
    expect(refreshClientOf('Mozilla/5.0 X', '203.0.113.7')).toEqual({
      uaHash: sha256('Mozilla/5.0 X'),
      ip: '203.0.113.7',
    });
  });

  it('AC-2: hashes the empty string when the header is absent, and answers a null IP', () => {
    expect(refreshClientOf(undefined, undefined)).toEqual({ uaHash: sha256(''), ip: null });
    // Never the literal "empty hash": a legacy token's null usedUaHash is what must not match.
    expect(refreshClientOf(undefined, undefined).uaHash).not.toBe('');
  });

  it('AC-3: maps an empty IP to null', () => {
    expect(refreshClientOf('UA', '')).toEqual({ uaHash: sha256('UA'), ip: null });
  });

  it('answers lowercase sha256 hex, so two clients compare by exact equality', () => {
    expect(refreshClientOf('UA-1', '198.51.100.9').uaHash).toMatch(/^[0-9a-f]{64}$/);
    // The IP is not part of the hash: the same browser recovers from a different network.
    expect(refreshClientOf('UA-1', '198.51.100.9').uaHash).toBe(refreshClientOf('UA-1', '203.0.113.7').uaHash);
    expect(refreshClientOf('UA-1', undefined).uaHash).not.toBe(refreshClientOf('UA-2', undefined).uaHash);
  });
});

/**
 * #470: the address recorded for a refresh is the browser the proxy forwards, resolved by `getClientIp`
 * with the API's trusted-proxy list — never Fastify's `req.ip`, which is the socket peer and named the
 * web container in every proxied deployment.
 *
 * The trust configuration is process-wide module state, so each case sets what it needs and the suite
 * restores the package default.
 */
describe('refreshClientFrom', () => {
  /** The compose shape: the peer is the web container on a private network, the browser is public. */
  const WEB_CONTAINER = '172.25.0.6';

  const request = (
    headers: Record<string, string | string[] | undefined>,
    peer?: string,
  ): RefreshRequestLike => ({
    headers,
    socket: peer === undefined ? undefined : { remoteAddress: peer },
  });

  afterEach(() => {
    resetTrustProxyConfig();
  });

  it('#470: records the forwarded address of a trusted proxy instead of its own', () => {
    configureTrustProxy({ enabled: true, trustedProxies: TRUSTED_PROXIES });

    expect(refreshClientFrom(request({
      'user-agent': 'UA-1',
      'x-forwarded-for': '203.0.113.7',
    }, WEB_CONTAINER))).toEqual({ uaHash: sha256('UA-1'), ip: '203.0.113.7' });
  });

  it('#470: reads the other client header the web sends when no x-forwarded-for arrived', () => {
    configureTrustProxy({ enabled: true, trustedProxies: TRUSTED_PROXIES });

    expect(refreshClientFrom(request({
      'user-agent': 'UA-1',
      'x-client-ip': '198.51.100.9',
    }, WEB_CONTAINER)).ip).toBe('198.51.100.9');
  });

  it('records the socket peer when no trust proxy is configured, so a direct client is unchanged', () => {
    resetTrustProxyConfig();

    expect(refreshClientFrom(request({
      'user-agent': 'UA-1',
      'x-forwarded-for': '203.0.113.7',
    }, WEB_CONTAINER)).ip).toBe(WEB_CONTAINER);
  });

  it('ignores a forwarded address from a peer outside the trusted list', () => {
    configureTrustProxy({ enabled: true, trustedProxies: ['10.0.0.0/8'] });

    expect(refreshClientFrom(request({
      'user-agent': 'UA-1',
      'x-forwarded-for': '203.0.113.7',
    }, WEB_CONTAINER)).ip).toBe(WEB_CONTAINER);
  });

  it('takes the first value of a repeated User-Agent header', () => {
    configureTrustProxy({ enabled: true, trustedProxies: TRUSTED_PROXIES });

    expect(refreshClientFrom(request({
      'user-agent': ['UA-1', 'UA-2'],
      'x-forwarded-for': '203.0.113.7',
    }, WEB_CONTAINER))).toEqual({ uaHash: sha256('UA-1'), ip: '203.0.113.7' });
  });

  it('answers a null IP when the request carries no peer at all', () => {
    resetTrustProxyConfig();

    expect(refreshClientFrom(request({}))).toEqual({ uaHash: sha256(''), ip: null });
  });
});
