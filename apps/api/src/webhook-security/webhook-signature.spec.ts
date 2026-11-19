import { createHmac } from 'node:crypto';
import {
  isAcceptableDeliveryId,
  isFreshTimestamp,
  MAX_DELIVERY_ID_BYTES,
  signatureV1,
  signatureV2,
  signatureV2Bytes,
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

  it('signs the exact body bytes when given a buffer (review B1)', () => {
    // `0xff` is not valid UTF-8: decoding it first would sign U+FFFD instead of the byte received.
    const rawBody = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d]);
    const independentlyExpected = `sha256=${createHmac('sha256', 's3cret')
      .update(Buffer.from('1700000000.d-1.', 'utf8'))
      .update(rawBody)
      .digest('hex')}`;

    expect(signatureV2Bytes('s3cret', '1700000000', 'd-1', rawBody)).toBe(independentlyExpected);
    expect(signatureV2Bytes('s3cret', '1700000000', 'd-1', rawBody)).not.toBe(
      signatureV2('s3cret', '1700000000', 'd-1', rawBody.toString('utf8')),
    );
  });

  it('signs a buffer body and the same text body identically when the bytes are valid UTF-8', () => {
    const body = '{"a":"é"}';

    expect(signatureV2Bytes('s3cret', '1700000000', 'd-1', Buffer.from(body, 'utf8'))).toBe(
      signatureV2('s3cret', '1700000000', 'd-1', body),
    );
  });

  describe('isAcceptableDeliveryId (review B2)', () => {
    it('accepts a delivery id at the byte limit and rejects the next byte', () => {
      expect(MAX_DELIVERY_ID_BYTES).toBeLessThan(2704);
      expect(isAcceptableDeliveryId('d'.repeat(MAX_DELIVERY_ID_BYTES))).toBe(true);
      expect(isAcceptableDeliveryId('d'.repeat(MAX_DELIVERY_ID_BYTES + 1))).toBe(false);
    });

    it('counts bytes, not characters, so a multi-byte id is measured on the wire', () => {
      // Each 'é' is two UTF-8 bytes: 127 of them are 254 bytes, 128 are 256 and over the limit.
      expect(Buffer.byteLength('é'.repeat(127), 'utf8')).toBe(254);
      expect(isAcceptableDeliveryId('é'.repeat(127))).toBe(true);
      expect(isAcceptableDeliveryId('é'.repeat(128))).toBe(false);
    });

    it('rejects a missing and an empty delivery id', () => {
      expect(isAcceptableDeliveryId(undefined)).toBe(false);
      expect(isAcceptableDeliveryId('')).toBe(false);
    });
  });
});
