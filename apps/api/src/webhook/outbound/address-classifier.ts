import * as net from 'net';

/** US-001: verdict for an outbound destination address (see the Design blocked-range table). */
export type AddressVerdict = 'allowed' | 'blocked';

/**
 * Module-level block list for the Design table's blocked ranges. One `BlockList` per
 * range-table keeps the lookup cost at one native call per address.
 *
 * `net.BlockList.check(string)` matches IPv4 against IPv4 rules and IPv6 against IPv6
 * rules, but in Node 22 it does not normalise `::ffff:0:0/96` mapped addresses to
 * their IPv4 form — so we wrap every address in a `net.SocketAddress`. With the
 * `SocketAddress` form, an IPv4 subnet (`127.0.0.0/8`) does match `::ffff:127.0.0.1`
 * (spike 2026-09-27).
 */
const BLOCKED_RANGES: net.BlockList = (() => {
  const list = new net.BlockList();
  list.addSubnet('0.0.0.0', 8, 'ipv4'); // "this network"
  list.addSubnet('10.0.0.0', 8, 'ipv4'); // RFC1918 private
  list.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT (RFC6598)
  list.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
  list.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local + cloud metadata
  list.addSubnet('172.16.0.0', 12, 'ipv4'); // RFC1918 private
  list.addSubnet('192.168.0.0', 16, 'ipv4'); // RFC1918 private
  list.addSubnet('224.0.0.0', 3, 'ipv4'); // multicast + reserved + broadcast
  list.addAddress('::', 'ipv6'); // unspecified
  list.addAddress('::1', 'ipv6'); // loopback
  list.addSubnet('fc00::', 7, 'ipv6'); // unique local (RFC4193)
  list.addSubnet('fe80::', 10, 'ipv6'); // link-local
  list.addSubnet('ff00::', 8, 'ipv6'); // multicast
  return list;
})();

/**
 * Builds a `BlockList` from a list of CIDR strings (`10.0.0.0/24`, `fd00::/8`).
 * An invalid CIDR is silently skipped — `webhookConfig` validates the strings
 * with `parseAllowedHosts`, which is the boot-time gate; a runtime call with a
 * bad CIDR is treated as "no override".
 */
function buildAllowedList(allowedCidrs: readonly string[]): net.BlockList {
  const list = new net.BlockList();
  for (const cidr of allowedCidrs) {
    const slash = cidr.indexOf('/');
    if (slash < 0) continue;
    const address = cidr.slice(0, slash);
    const prefix = Number(cidr.slice(slash + 1));
    const ipVersion = net.isIP(address);
    if (ipVersion === 0 || !Number.isInteger(prefix)) continue;
    const family: 'ipv4' | 'ipv6' = ipVersion === 4 ? 'ipv4' : 'ipv6';
    if (family === 'ipv4' && (prefix < 0 || prefix > 32)) continue;
    if (family === 'ipv6' && (prefix < 0 || prefix > 128)) continue;
    try {
      list.addSubnet(address, prefix, family);
    } catch {
      // Invalid socket address (e.g. malformed CIDR) — skip silently.
    }
  }
  return list;
}

/**
 * Classifies an outbound destination IP (as returned by `URL.hostname` with brackets
 * removed, or by a DNS lookup). Fails closed: anything `net.isIP` does not recognise
 * is `blocked`.
 */
export function classifyAddress(address: string, allowedCidrs: readonly string[]): AddressVerdict {
  const ipVersion = net.isIP(address);
  if (ipVersion === 0) return 'blocked';
  const family: 'ipv4' | 'ipv6' = ipVersion === 4 ? 'ipv4' : 'ipv6';
  const sa = new net.SocketAddress({ address, family });

  // An allow-listed CIDR wins over the blocked ranges.
  if (allowedCidrs.length > 0) {
    const allowedList = buildAllowedList(allowedCidrs);
    if (allowedList.check(sa)) return 'allowed';
  }

  return BLOCKED_RANGES.check(sa) ? 'blocked' : 'allowed';
}
