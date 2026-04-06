/// <reference types="jest" />

import { encryptToken, decryptToken } from './encryption.util';
import * as crypto from 'crypto';

describe('Token Encryption Utility', () => {
  const masterKey = crypto.randomBytes(32).toString('hex');
  const plaintext = 'github_token_secret_123456789';

  describe('encryptToken', () => {
    it('returns a string in format "iv:authTag:ciphertext" with hex-encoded segments', () => {
      const encrypted = encryptToken(plaintext, masterKey);

      expect(typeof encrypted).toBe('string');
      const segments = encrypted.split(':');
      expect(segments).toHaveLength(3);

      // Each segment should be valid hex
      segments.forEach((segment) => {
        expect(/^[0-9a-f]+$/.test(segment)).toBe(true);
      });
    });

    it('produces different ciphertexts for the same plaintext on each call (due to random IV)', () => {
      const encrypted1 = encryptToken(plaintext, masterKey);
      const encrypted2 = encryptToken(plaintext, masterKey);

      expect(encrypted1).not.toBe(encrypted2);
    });

    it('encodes IV as hex in first segment', () => {
      const encrypted = encryptToken(plaintext, masterKey);
      const [ivHex] = encrypted.split(':');

      // IV for AES-256 should be 16 bytes = 32 hex characters
      expect(ivHex.length).toBe(32);
    });

    it('encodes authTag as hex in second segment', () => {
      const encrypted = encryptToken(plaintext, masterKey);
      const [, authTagHex] = encrypted.split(':');

      // GCM auth tag should be 16 bytes = 32 hex characters
      expect(authTagHex.length).toBe(32);
    });

    it('encodes ciphertext as hex in third segment', () => {
      const encrypted = encryptToken(plaintext, masterKey);
      const [, , ciphertextHex] = encrypted.split(':');

      expect(/^[0-9a-f]+$/.test(ciphertextHex)).toBe(true);
      expect(ciphertextHex.length).toBeGreaterThan(0);
    });

    it('works with different plaintext values', () => {
      const plaintext1 = 'token_1';
      const plaintext2 = 'token_2';

      const encrypted1 = encryptToken(plaintext1, masterKey);
      const encrypted2 = encryptToken(plaintext2, masterKey);

      expect(encrypted1).not.toBe(encrypted2);
    });

    it('works with empty string plaintext', () => {
      const encrypted = encryptToken('', masterKey);

      expect(typeof encrypted).toBe('string');
      const segments = encrypted.split(':');
      expect(segments).toHaveLength(3);
    });

    it('works with long plaintext values', () => {
      const longPlaintext = 'a'.repeat(10000);
      const encrypted = encryptToken(longPlaintext, masterKey);

      expect(typeof encrypted).toBe('string');
      const segments = encrypted.split(':');
      expect(segments).toHaveLength(3);
    });
  });

  describe('decryptToken', () => {
    it('returns the original plaintext when given correct master key', () => {
      const encrypted = encryptToken(plaintext, masterKey);
      const decrypted = decryptToken(encrypted, masterKey);

      expect(decrypted).toBe(plaintext);
    });

    it('works for multiple round-trip encryptions', () => {
      const encrypted1 = encryptToken(plaintext, masterKey);
      const decrypted1 = decryptToken(encrypted1, masterKey);
      expect(decrypted1).toBe(plaintext);

      const encrypted2 = encryptToken(decrypted1, masterKey);
      const decrypted2 = decryptToken(encrypted2, masterKey);
      expect(decrypted2).toBe(plaintext);
    });

    it('throws error when ciphertext is tampered with', () => {
      const encrypted = encryptToken(plaintext, masterKey);
      const segments = encrypted.split(':');

      // Tamper with ciphertext (last segment)
      const tampered = [
        segments[0],
        segments[1],
        segments[2].slice(0, -2) + 'ff', // Change last byte
      ].join(':');

      expect(() => decryptToken(tampered, masterKey)).toThrow();
    });

    it('throws error when IV is tampered with', () => {
      const encrypted = encryptToken(plaintext, masterKey);
      const segments = encrypted.split(':');

      // Tamper with IV (first segment)
      const tampered = ['aa'.repeat(16), segments[1], segments[2]].join(':');

      expect(() => decryptToken(tampered, masterKey)).toThrow();
    });

    it('throws error when auth tag is tampered with', () => {
      const encrypted = encryptToken(plaintext, masterKey);
      const segments = encrypted.split(':');

      // Tamper with auth tag (second segment)
      const tampered = [
        segments[0],
        'bb'.repeat(16),
        segments[2],
      ].join(':');

      expect(() => decryptToken(tampered, masterKey)).toThrow();
    });

    it('throws error when decrypting with wrong master key', () => {
      const encrypted = encryptToken(plaintext, masterKey);
      const wrongKey = crypto.randomBytes(32).toString('hex');

      expect(() => decryptToken(encrypted, wrongKey)).toThrow();
    });

    it('throws error when ciphertext format is invalid (missing segments)', () => {
      const invalidCiphertext = 'iv:authTag'; // Missing ciphertext segment

      expect(() => decryptToken(invalidCiphertext, masterKey)).toThrow();
    });

    it('throws error when ciphertext format has invalid hex', () => {
      const invalidCiphertext = 'gg:authTag:ciphertext'; // 'gg' is not valid hex

      expect(() => decryptToken(invalidCiphertext, masterKey)).toThrow();
    });

    it('works with empty string plaintext', () => {
      const encrypted = encryptToken('', masterKey);
      const decrypted = decryptToken(encrypted, masterKey);

      expect(decrypted).toBe('');
    });

    it('works with long plaintext values', () => {
      const longPlaintext = 'a'.repeat(10000);
      const encrypted = encryptToken(longPlaintext, masterKey);
      const decrypted = decryptToken(encrypted, masterKey);

      expect(decrypted).toBe(longPlaintext);
    });

    it('preserves special characters and unicode', () => {
      const specialPlaintext = 'token_!@#$%^&*()_+-=[]{}|;:,.<>?/~`\n\t';
      const encrypted = encryptToken(specialPlaintext, masterKey);
      const decrypted = decryptToken(encrypted, masterKey);

      expect(decrypted).toBe(specialPlaintext);
    });
  });

  describe('Integration: encryptToken and decryptToken together', () => {
    it('maintains round-trip integrity for various inputs', () => {
      const testCases = [
        'simple',
        'with spaces',
        'with-dashes',
        'UPPERCASE',
        '123456',
        '!@#$%^&*()',
        '',
      ];

      testCases.forEach((testValue) => {
        const encrypted = encryptToken(testValue, masterKey);
        const decrypted = decryptToken(encrypted, masterKey);
        expect(decrypted).toBe(testValue);
      });
    });

    it('decrypted value never equals the encrypted value', () => {
      const encrypted = encryptToken(plaintext, masterKey);
      const decrypted = decryptToken(encrypted, masterKey);

      expect(encrypted).not.toBe(decrypted);
      expect(encrypted).not.toBe(plaintext);
      expect(decrypted).toBe(plaintext);
    });
  });
});
