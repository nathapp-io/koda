/**
 * US-001 AC1–AC4: `classifyAddress` — outbound destination verdicts.
 *
 * The blocked ranges come from the Design table; every representative address in the
 * table must classify as `blocked` with no allow-list, and every allowed edge address
 * must classify as `allowed`. A destination that is not an IP fails closed (`blocked`),
 * and an allow-listed CIDR wins over the blocked ranges.
 */
import { classifyAddress, type AddressVerdict } from './address-classifier';

/** Representative address for every blocked range in the Design table. */
const BLOCKED_RANGE_ADDRESSES: string[] = [
  '0.1.2.3', // 0.0.0.0/8
  '10.1.2.3', // 10.0.0.0/8
  '100.64.0.1', // 100.64.0.0/10 (CGNAT)
  '127.0.0.1', // 127.0.0.0/8 (loopback)
  '169.254.169.254', // 169.254.0.0/16 (cloud metadata)
  '172.16.0.1', // 172.16.0.0/12
  '192.168.1.1', // 192.168.0.0/16
  '224.0.0.1', // 224.0.0.0/3 (multicast + reserved)
  '255.255.255.255', // 224.0.0.0/3 (broadcast)
  '::', // ::/128
  '::1', // ::1/128
  'fd00::1', // fc00::/7 (unique local)
  'fe80::1', // fe80::/10 (link local)
  'ff02::1', // ff00::/8 (multicast)
  '::ffff:127.0.0.1', // ::ffff:0:0/96 mapped form of 127.0.0.0/8
  '::ffff:a9fe:a9fe', // ::ffff:0:0/96 mapped form of 169.254.0.0/16
];

/** Addresses on the allowed side of every blocked range edge. */
const ALLOWED_EDGE_ADDRESSES: string[] = [
  '93.184.215.14',
  '172.32.0.1',
  '100.128.0.1',
  '2606:2800:21f:cb07:6820:80da:af6b:8b2e',
];

describe('US-001: classifyAddress', () => {
  describe('AC1: blocked ranges', () => {
    it.each(BLOCKED_RANGE_ADDRESSES)('AC1: classifyAddress(%s, []) returns blocked', (address) => {
      const verdict: AddressVerdict = classifyAddress(address, []);

      expect(verdict).toBe('blocked');
    });

    it('AC1 boundary: the first address of the 0.0.0.0/8 range is blocked', () => {
      expect(classifyAddress('0.0.0.0', [])).toBe('blocked');
    });

    it('AC1 boundary: the last address of the fe80::/10 range is blocked', () => {
      expect(classifyAddress('febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', [])).toBe('blocked');
    });

    it('AC1 boundary: the last address of the fc00::/7 range is blocked', () => {
      expect(classifyAddress('fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', [])).toBe('blocked');
    });
  });

  describe('AC2: allowed edge addresses', () => {
    it.each(ALLOWED_EDGE_ADDRESSES)('AC2: classifyAddress(%s, []) returns allowed', (address) => {
      const verdict: AddressVerdict = classifyAddress(address, []);

      expect(verdict).toBe('allowed');
    });

    it('AC2 boundary: the first address just past 172.16.0.0/12 is allowed', () => {
      expect(classifyAddress('172.32.0.0', [])).toBe('allowed');
    });

    it('AC2 boundary: the last address inside 172.16.0.0/12 is blocked', () => {
      expect(classifyAddress('172.31.255.255', [])).toBe('blocked');
    });

    it('AC2 boundary: the first address just past 100.64.0.0/10 is allowed', () => {
      expect(classifyAddress('100.128.0.0', [])).toBe('allowed');
    });

    it('AC2 boundary: the last address just below 224.0.0.0/3 is allowed', () => {
      expect(classifyAddress('223.255.255.255', [])).toBe('allowed');
    });

    it('AC2 boundary: the last address inside 100.64.0.0/10 is blocked', () => {
      expect(classifyAddress('100.127.255.255', [])).toBe('blocked');
    });
  });

  describe('AC3: an allow-listed CIDR overrides the blocked ranges', () => {
    it('AC3: 10.0.0.5 is allowed when 10.0.0.0/24 is allow-listed', () => {
      expect(classifyAddress('10.0.0.5', ['10.0.0.0/24'])).toBe('allowed');
    });

    it('AC3: 10.0.1.5 is blocked when only 10.0.0.0/24 is allow-listed', () => {
      expect(classifyAddress('10.0.1.5', ['10.0.0.0/24'])).toBe('blocked');
    });

    it('AC3 boundary: the first address of the allow-listed CIDR is allowed', () => {
      expect(classifyAddress('10.0.0.0', ['10.0.0.0/24'])).toBe('allowed');
    });

    it('AC3 boundary: the last address of the allow-listed CIDR is allowed', () => {
      expect(classifyAddress('10.0.0.255', ['10.0.0.0/24'])).toBe('allowed');
    });

    it('AC3 boundary: the first address after the allow-listed CIDR is blocked', () => {
      expect(classifyAddress('10.0.1.0', ['10.0.0.0/24'])).toBe('blocked');
    });
  });

  describe('AC4: a value that is not an IP fails closed', () => {
    it('AC4: classifyAddress("not-an-ip", []) returns blocked', () => {
      expect(classifyAddress('not-an-ip', [])).toBe('blocked');
    });

    it('AC4 boundary: an empty string returns blocked', () => {
      expect(classifyAddress('', [])).toBe('blocked');
    });

    it('AC4 boundary: a hostname returns blocked — classification is by IP only', () => {
      expect(classifyAddress('hooks.example', [])).toBe('blocked');
    });

    it('AC4 boundary: an out-of-range IPv4 literal returns blocked', () => {
      expect(classifyAddress('999.1.1.1', [])).toBe('blocked');
    });
  });
});
