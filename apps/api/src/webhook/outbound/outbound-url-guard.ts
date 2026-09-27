import { Inject, Injectable } from '@nestjs/common';
import * as net from 'net';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { IWebhookConfig, WEBHOOK_CFG } from '../../config/webhook.config';
import { classifyAddress, isInsideAllowedCidrs } from './address-classifier';
import { DnsResolver } from './dns-resolver';

/** US-002: why an outbound webhook destination was refused. */
export type OutboundRejectionReason =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'credentials_not_allowed'
  | 'https_required'
  | 'blocked_destination'
  | 'unresolvable';

/** The one rejection type of the outbound guard; `reason` is the machine-readable cause. */
export class OutboundUrlRejection extends Error {
  constructor(readonly reason: OutboundRejectionReason) {
    super(reason);
    this.name = 'OutboundUrlRejection';
  }
}

const EBLOCKED_DESTINATION = 'EBLOCKED_DESTINATION';
const ENOTFOUND = 'ENOTFOUND';

/** The `net.LookupFunction` callback, with the arguments node omits left optional. */
type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number,
) => void;

/** Step 4: `URL.hostname` lower-cased, one trailing dot stripped, IPv6 brackets removed. */
function normaliseHost(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host;
}

function lookupError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/** Keeps the original `ErrnoException` (code included); wraps anything else. */
function asError(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? error : new Error('DNS lookup failed');
}

/**
 * US-002: guards a webhook destination before persistence (`checkUrl`) and again
 * before delivery (`assertStaticTarget` + `createLookup`).
 *
 * `checkUrl` is one ordered pipeline and the first failing step decides the reason:
 * invalid_url -> scheme_not_allowed -> credentials_not_allowed -> https_required ->
 * allowlist -> IP-literal classification -> DNS -> resolved-address classification.
 * WHATWG `URL` has already normalised numeric hosts (`127.1`, `2130706433`,
 * `0x7f.0.0.1` all become `127.0.0.1`), so the guard only ever sees canonical
 * addresses.
 */
@Injectable()
export class OutboundUrlGuard {
  constructor(
    @Inject(WEBHOOK_CFG) private readonly config: IWebhookConfig,
    private readonly resolver: DnsResolver,
  ) {}

  /** Create/update-time check. Resolves hostnames. Rejects with `OutboundUrlRejection`. */
  async checkUrl(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new OutboundUrlRejection('invalid_url');
    }

    this.assertStaticTarget(parsed);

    const host = normaliseHost(parsed.hostname);
    // Steps 7 and 8 already decided the verdict for an allow-listed hostname and for
    // an IP literal, so only a real hostname is left to resolve.
    if (this.isAllowListedHostname(host) || net.isIP(host) !== 0) return;

    const addresses = await this.resolveHost(host);
    for (const address of addresses) {
      if (classifyAddress(address, this.config.allowedCidrs) === 'blocked') {
        throw new OutboundUrlRejection('blocked_destination');
      }
    }
  }

  /**
   * Delivery-time pre-connect check on an already-parsed URL (the caller has done the
   * `new URL` step). Never resolves DNS: for a hostname that is not allow-listed the
   * connect-time `lookup` does the address check.
   */
  assertStaticTarget(url: URL): void {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new OutboundUrlRejection('scheme_not_allowed');
    }
    if (url.username !== '' || url.password !== '') {
      throw new OutboundUrlRejection('credentials_not_allowed');
    }

    const host = normaliseHost(url.hostname);
    // `https://./hook` parses with hostname `.`, which normalisation strips to nothing.
    // A URL without a host is malformed, not a destination that failed to resolve.
    if (host === '') {
      throw new OutboundUrlRejection('invalid_url');
    }
    if (url.protocol === 'http:' && !this.isAllowListed(host)) {
      throw new OutboundUrlRejection('https_required');
    }
    if (this.isAllowListedHostname(host)) return;
    if (net.isIP(host) === 0) return;
    if (classifyAddress(host, this.config.allowedCidrs) === 'blocked') {
      throw new OutboundUrlRejection('blocked_destination');
    }
  }

  /**
   * A `lookup` for `node:http(s).request` that validates every resolved address at
   * connect time. Node and Bun skip `lookup` entirely for IP-literal hosts, which is
   * why `assertStaticTarget` covers those before the socket is created.
   */
  createLookup(): net.LookupFunction {
    return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
      let host: string;
      let allowListed: boolean;
      try {
        host = normaliseHost(hostname);
        allowListed = this.isAllowListed(host);
      } catch (error) {
        // The caller is a socket that is waiting for exactly one callback: an escaping
        // throw here would leave it hanging instead of failing the request.
        callback(asError(error));
        return;
      }

      let answer: Promise<string[]>;
      try {
        answer = this.resolver.resolve(host);
      } catch (error) {
        // A resolver failure is passed through with its own code.
        callback(asError(error));
        return;
      }

      // Both handlers are supplied, so nothing below can reject into an unhandled
      // promise: only a throwing consumer callback could, and that is its own bug.
      answer.then(
        (addresses) => this.completeLookup(host, allowListed, options, addresses, callback),
        (error: unknown) => callback(asError(error)),
      );
    };
  }

  /** Steps 9-10: an empty or failing DNS answer is `unresolvable`; a blocked address is not. */
  private async resolveHost(host: string): Promise<string[]> {
    let addresses: string[];
    try {
      addresses = await this.resolver.resolve(host);
    } catch {
      throw new OutboundUrlRejection('unresolvable');
    }
    if (addresses.length === 0) throw new OutboundUrlRejection('unresolvable');
    return addresses;
  }

  /**
   * Connect-time verdict for one resolver answer. Mirrors `checkUrl`: an empty answer
   * is a failure (handing the socket zero addresses would hide a TOCTOU answer change),
   * and any blocked address fails the lookup unless the hostname is allow-listed.
   */
  private completeLookup(
    host: string,
    allowListed: boolean,
    options: LookupOptions,
    addresses: string[],
    callback: LookupCallback,
  ): void {
    if (addresses.length === 0) {
      callback(lookupError(ENOTFOUND, `ENOTFOUND ${host}`));
      return;
    }

    if (!allowListed) {
      const blocked = addresses.find(
        (address) => classifyAddress(address, this.config.allowedCidrs) === 'blocked',
      );
      if (blocked !== undefined) {
        callback(lookupError(EBLOCKED_DESTINATION, `Blocked destination address ${blocked} for ${host}`));
        return;
      }
    }

    const entries: LookupAddress[] = addresses.map((address) => ({ address, family: net.isIP(address) }));
    if (options.all) {
      callback(null, entries);
      return;
    }

    const [first] = entries;
    callback(null, first.address, first.family);
  }

  /** Step 5: an allow-listed hostname, or an IP literal inside an `allowedCidrs` entry. */
  private isAllowListed(host: string): boolean {
    return this.isAllowListedHostname(host) || isInsideAllowedCidrs(host, this.config.allowedCidrs);
  }

  private isAllowListedHostname(host: string): boolean {
    return this.config.allowedHostnames.includes(host);
  }
}
