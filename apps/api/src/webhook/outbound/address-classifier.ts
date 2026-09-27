/** US-001: verdict for an outbound destination address (see the Design blocked-range table). */
export type AddressVerdict = 'allowed' | 'blocked';

/**
 * Classifies an outbound destination IP (as returned by `URL.hostname` with brackets
 * removed, or by a DNS lookup). Fails closed: anything `net.isIP` does not recognise is
 * `blocked`. STUB — real range table lands in the implementation session.
 */
export function classifyAddress(address: string, allowedCidrs: readonly string[]): AddressVerdict {
  throw new Error(`classifyAddress not implemented (${address.length} chars, ${allowedCidrs.length} CIDRs)`);
}
