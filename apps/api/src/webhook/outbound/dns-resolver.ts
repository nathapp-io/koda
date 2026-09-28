import { Injectable } from '@nestjs/common';
import { promises as dnsPromises } from 'node:dns';

/**
 * US-002: the DNS seam for the outbound guard.
 *
 * It is a typed class token, so tests stub it with
 * `{ provide: DnsResolver, useValue: { resolve } }` and no test performs a real
 * lookup. `resolve` answers with the raw address strings; classification stays
 * with the address classifier.
 */
@Injectable()
export class DnsResolver {
  async resolve(hostname: string): Promise<string[]> {
    const addresses = await dnsPromises.lookup(hostname, { all: true });
    return addresses.map((entry) => entry.address);
  }
}
