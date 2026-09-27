import { Inject, Injectable } from '@nestjs/common';
import * as net from 'net';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { IWebhookConfig, WEBHOOK_CFG } from '../../config/webhook.config';
import { classifyAddress } from './address-classifier';
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
    return (hostname, options, callback): void => {
      void this.lookup(hostname, options, callback);
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

  private async lookup(hostname: string, options: LookupOptions, callback: LookupCallback): Promise<void> {
    const host = normaliseHost(hostname);
    const allowListed = this.isAllowListed(host);

    let addresses: string[];
    try {
      addresses = await this.resolver.resolve(host);
    } catch (error) {
      // A resolver failure is passed through with its own code.
      callback(error instanceof Error ? error : new Error('DNS resolution failed'));
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
    if (first === undefined) {
      callback(lookupError(ENOTFOUND, `ENOTFOUND ${host}`));
      return;
    }
    callback(null, first.address, first.family);
  }

  /** Step 5: an allow-listed hostname, or an IP literal inside an `allowedCidrs` entry. */
  private isAllowListed(host: string): boolean {
    return this.isAllowListedHostname(host) || (net.isIP(host) !== 0 && this.isInsideAllowedCidr(host));
  }

  private isAllowListedHostname(host: string): boolean {
    return this.config.allowedHostnames.includes(host);
  }

  /**
   * `classifyAddress` answers `allowed` for any public address, so the allow-listed
   * CIDR is what rescues this host only when the entry flipped a `blocked` verdict to
   * `allowed` — i.e. the host really is inside an operator-allowed CIDR.
   */
  private isInsideAllowedCidr(host: string): boolean {
    if (this.config.allowedCidrs.length === 0) return false;
    return classifyAddress(host, []) === 'blocked' && classifyAddress(host, this.config.allowedCidrs) === 'allowed';
  }
}
