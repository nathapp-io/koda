import { createHmac } from 'node:crypto';
import {
  isFreshTimestamp,
  signatureV1,
  signatureV2,
  signaturesMatch,
  WEBHOOK_TIMESTAMP_TOLERANCE_SEC,
} from './webhook-signature';

describe('webhook signature primitives', () => {
  it('AC-1: signs the body with the v1 HMAC-SHA256 format', () => {
    const independentlyExpected = `sha256=${createHmac('sha256', 's3cret').update('{"a":1}').digest('hex')}`;
    expect(signatureV1('s3cret', '{"a":1}')).toBe(independentlyExpected);
    expect(independentlyExpected).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('AC-2: signs timestamp, delivery id and body with v2', () => {
    const independentlyExpected = `sha256=${createHmac('sha256', 's3cret').update('1700000000.d-1.{"a":1}').digest('hex')}`;
    expect(signatureV2('s3cret', '1700000000', 'd-1', '{"a":1}')).toBe(independentlyExpected);
  });

  it('AC-3: binds v2 signatures to the delivery id', () => {
    const first = signatureV2('s3cret', '1700000000', 'd-1', '{"a":1}');
    const second = signatureV2('s3cret', '1700000000', 'd-2', '{"a":1}');
    expect(second).not.toBe(first);
  });

  it('AC-4: matches equal signature strings', () => {
    const signature = 'sha256=abc';
    expect(signaturesMatch(signature, signature)).toBe(true);
  });

  it('AC-5: returns false without throwing for signatures of different byte lengths', () => {
    expect(() => signaturesMatch('sha256=abc', 'sha256=ab')).not.toThrow();
    expect(signaturesMatch('sha256=abc', 'sha256=ab')).toBe(false);
  });

  it('AC-6: rejects equal-length signature strings with different content', () => {
    expect(signaturesMatch('sha256=abc', 'sha256=abd')).toBe(false);
  });

  const nowSec = 1_700_000_000;

  it('AC-7: accepts a timestamp exactly 300 seconds in the past', () => {
    expect(WEBHOOK_TIMESTAMP_TOLERANCE_SEC).toBe(300);
    expect(isFreshTimestamp(String(nowSec - 300), nowSec * 1000)).toBe(true);
  });

  it('AC-8: accepts a timestamp exactly 300 seconds in the future', () => {
    expect(isFreshTimestamp(String(nowSec + 300), nowSec * 1000)).toBe(true);
  });

  it('AC-9: rejects a timestamp 301 seconds in the past', () => {
    expect(isFreshTimestamp(String(nowSec - 301), nowSec * 1000)).toBe(false);
  });

  it('AC-10: rejects a timestamp 301 seconds in the future', () => {
    expect(isFreshTimestamp(String(nowSec + 301), nowSec * 1000)).toBe(false);
  });

  it('AC-11: rejects a fractional timestamp', () => {
    expect(isFreshTimestamp('1700000000.5', 1700000000000)).toBe(false);
  });

  it('AC-12: rejects an empty timestamp', () => {
    expect(isFreshTimestamp('', 1700000000000)).toBe(false);
  });

  it('AC-13: rejects a signed timestamp', () => {
    expect(isFreshTimestamp('+1700000000', 1700000000000)).toBe(false);
  });

  it('AC-14: rejects a 13-digit timestamp', () => {
    expect(isFreshTimestamp('1700000000000', 1700000000000)).toBe(false);
  });
});
