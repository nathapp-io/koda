/**
 * Token Encryption Integration Tests
 *
 * Comprehensive tests for AES-256-GCM token encryption/decryption utility.
 * Covers all acceptance criteria including format validation, integrity checks,
 * and error handling.
 *
 * Run: npx jest test/integration/vcs/token-encryption.integration.spec.ts
 */

import { encryptToken, decryptToken } from '../../../src/common/utils/encryption.util';
import * as crypto from 'crypto';

describe('Token Encryption Integration (AES-256-GCM)', () => {
  describe('encryptToken function', () => {
    const masterKey = crypto.randomBytes(32).toString('hex');
    const plaintext = 'github_pat_11ABC123XYZ';

    it('AC5: returns string in format "iv:authTag:ciphertext" with hex-encoded segments', () => {
      const encrypted = encryptToken(plaintext, masterKey);

      expect(typeof encrypted).toBe('string');
      const segments = encrypted.split(':');
      expect(segments.length).toBe(3);

      const [ivHex, authTagHex, ciphertextHex] = segments;

      // All segments must be hex-encoded
      expect(/^[0-9a-f]+$/.test(ivHex)).toBe(true);
      expect(/^[0-9a-f]+$/.test(authTagHex)).toBe(true);
      expect(/^[0-9a-f]+$/.test(ciphertextHex)).toBe(true);
    });

    it('encodes IV as exactly 32 hex characters (16 bytes)', () => {
      const encrypted = encryptToken(plaintext, masterKey);
      const [ivHex] = encrypted.split(':');

      expect(ivHex.length).toBe(32);
    });

    it('encodes authTag as exactly 32 hex characters (16 bytes)', () => {
      const encrypted = encryptToken(plaintext, masterKey);
      const [, authTagHex] = encrypted.split(':');

      expect(authTagHex.length).toBe(32);
    });

    it('produces non-deterministic ciphertexts due to random IV', () => {
      const encrypted1 = encryptToken(plaintext, masterKey);
      const encrypted2 = encryptToken(plaintext, masterKey);

      expect(encrypted1).not.toBe(encrypted2);

      // IVs should be different
      const iv1 = encrypted1.split(':')[0];
      const iv2 = encrypted2.split(':')[0];
      expect(iv1).not.toBe(iv2);
    });

    it('handles various GitHub token formats', () => {
      const tokens = [
        'ghp_abcdef123456', // Personal access token
        'ghu_abcdef123456', // User token
        'ghs_abcdef123456', // Server-to-server token
        'gho_abcdef123456', // OAuth token
      ];

      tokens.forEach((token) => {
        const encrypted = encryptToken(token, masterKey);
        expect(encrypted.split(':').length).toBe(3);
      });
    });

    it('handles long API keys (100+ characters)', () => {
      const longToken = 'a'.repeat(256);
      const encrypted = encryptToken(longToken, masterKey);

      expect(encrypted.split(':').length).toBe(3);
      const [, , ciphertextHex] = encrypted.split(':');
      expect(ciphertextHex.length).toBeGreaterThan(100);
    });

    it('handles empty plaintext', () => {
      const encrypted = encryptToken('', masterKey);
      const [ivHex, authTagHex, ciphertextHex] = encrypted.split(':');

      expect(ivHex.length).toBe(32);
      expect(authTagHex.length).toBe(32);
      expect(ciphertextHex).toBeDefined();
    });

    it('handles plaintext with special characters', () => {
      const specialTokens = [
        'token!@#$%^&*()',
        'token with spaces',
        'token\nwith\nnewlines',
        'token\twith\ttabs',
        'token_with_underscore-and-dash',
      ];

      specialTokens.forEach((token) => {
        const encrypted = encryptToken(token, masterKey);
        expect(encrypted.split(':').length).toBe(3);
      });
    });

    it('handles unicode plaintext', () => {
      const unicodeTokens = [
        'token_with_émojis_🔐',
        'token_with_中文_characters',
        'token_with_ñ_tilde',
      ];

      unicodeTokens.forEach((token) => {
        const encrypted = encryptToken(token, masterKey);
        expect(encrypted.split(':').length).toBe(3);
      });
    });
  });

  describe('decryptToken function', () => {
    const masterKey = crypto.randomBytes(32).toString('hex');
    const plaintext = 'github_pat_11ABC123XYZ_secret';

    it('AC6: returns original plaintext when given correct master key', () => {
      const encrypted = encryptToken(plaintext, masterKey);
      const decrypted = decryptToken(encrypted, masterKey);

      expect(decrypted).toBe(plaintext);
    });

    it('AC7: throws error when ciphertext is tampered with (GCM integrity check)', () => {
      const encrypted = encryptToken(plaintext, masterKey);
      const [iv, authTag, ciphertext] = encrypted.split(':');

      // Tamper with ciphertext
      const tampered = `${iv}:${authTag}:${ciphertext.slice(0, -4)}abcd`;

      expect(() => decryptToken(tampered, masterKey)).toThrow();
    });

    it('AC7: throws error when authTag is tampered with', () => {
      const encrypted = encryptToken(plaintext, masterKey);
      const [iv, authTag, ciphertext] = encrypted.split(':');

      // Tamper with auth tag
      const tampered = `${iv}:${Buffer.from('0'.repeat(32), 'utf8').toString('hex').slice(0, 32)}:${ciphertext}`;

      expect(() => decryptToken(tampered, masterKey)).toThrow();
    });

    it('AC7: throws error when IV is tampered with (results in decryption failure)', () => {
      const encrypted = encryptToken(plaintext, masterKey);
      const [, authTag, ciphertext] = encrypted.split(':');

      // Tamper with IV
      const tamperedIv = crypto.randomBytes(16).toString('hex');
      const tampered = `${tamperedIv}:${authTag}:${ciphertext}`;

      expect(() => decryptToken(tampered, masterKey)).toThrow();
    });

    it('AC8: throws error when decrypting with wrong master key', () => {
      const encrypted = encryptToken(plaintext, masterKey);
      const wrongKey = crypto.randomBytes(32).toString('hex');

      expect(() => decryptToken(encrypted, wrongKey)).toThrow();
    });

    it('throws error on invalid ciphertext format (missing segments)', () => {
      const invalidFormats = [
        'iv:authTag', // Missing ciphertext
        'iv:authTag:ciphertext:extra', // Too many segments
        'no_colons_here',
        '',
        ':',
        '::',
      ];

      invalidFormats.forEach((format) => {
        expect(() => decryptToken(format, masterKey)).toThrow();
      });
    });

    it('throws error when segments contain invalid hex characters', () => {
      const masterKey = crypto.randomBytes(32).toString('hex');

      const invalidFormats = [
        'gg:authTag:ciphertext', // 'gg' is not hex
        'iv:ZZ:ciphertext', // 'ZZ' is not hex
        'iv:authTag:XYZ', // 'XYZ' is not hex
      ];

      invalidFormats.forEach((format) => {
        expect(() => decryptToken(format, masterKey)).toThrow();
      });
    });

    it('handles various token formats in round-trip', () => {
      const tokens = [
        'ghp_simple',
        'ghu_with_numbers_12345',
        'ghs_with-dashes-and_underscores',
        'long_token_' + 'a'.repeat(100),
      ];

      tokens.forEach((token) => {
        const encrypted = encryptToken(token, masterKey);
        const decrypted = decryptToken(encrypted, masterKey);
        expect(decrypted).toBe(token);
      });
    });

    it('handles empty plaintext round-trip', () => {
      const encrypted = encryptToken('', masterKey);
      const decrypted = decryptToken(encrypted, masterKey);

      expect(decrypted).toBe('');
    });

    it('handles plaintext with special characters round-trip', () => {
      const specialTokens = [
        'token!@#$%^&*()',
        'token with spaces',
        'token\nwith\nnewlines',
        'token\twith\ttabs',
      ];

      specialTokens.forEach((token) => {
        const encrypted = encryptToken(token, masterKey);
        const decrypted = decryptToken(encrypted, masterKey);
        expect(decrypted).toBe(token);
      });
    });

    it('handles unicode plaintext round-trip', () => {
      const unicodeTokens = [
        'token_with_émojis_🔐',
        'token_with_中文',
        'token_ñ',
      ];

      unicodeTokens.forEach((token) => {
        const encrypted = encryptToken(token, masterKey);
        const decrypted = decryptToken(encrypted, masterKey);
        expect(decrypted).toBe(token);
      });
    });

    it('supports multiple round-trip encryptions', () => {
      const encrypted1 = encryptToken(plaintext, masterKey);
      const decrypted1 = decryptToken(encrypted1, masterKey);
      expect(decrypted1).toBe(plaintext);

      const encrypted2 = encryptToken(decrypted1, masterKey);
      const decrypted2 = decryptToken(encrypted2, masterKey);
      expect(decrypted2).toBe(plaintext);

      const encrypted3 = encryptToken(decrypted2, masterKey);
      const decrypted3 = decryptToken(encrypted3, masterKey);
      expect(decrypted3).toBe(plaintext);
    });
  });

  describe('Master key validation', () => {
    const plaintext = 'test_token_12345';

    it('works with 32-byte hex-encoded master key (AES-256)', () => {
      const masterKey = crypto.randomBytes(32).toString('hex');
      const encrypted = encryptToken(plaintext, masterKey);
      const decrypted = decryptToken(encrypted, masterKey);

      expect(decrypted).toBe(plaintext);
    });

    it('requires exact master key match', () => {
      const key1 = crypto.randomBytes(32).toString('hex');
      const key2 = crypto.randomBytes(32).toString('hex');

      const encrypted = encryptToken(plaintext, key1);

      expect(() => decryptToken(encrypted, key2)).toThrow();
    });

    it('fails if master key is too short', () => {
      const shortKey = crypto.randomBytes(16).toString('hex');

      expect(() => encryptToken(plaintext, shortKey)).toThrow();
    });
  });

  describe('Format specification compliance', () => {
    const masterKey = crypto.randomBytes(32).toString('hex');
    const plaintext = 'token_compliance_test';

    it('produces format matching pattern: [0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+', () => {
      const encrypted = encryptToken(plaintext, masterKey);
      const pattern = /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$/;

      expect(pattern.test(encrypted)).toBe(true);
    });

    it('all segments are lowercase hex', () => {
      const encrypted = encryptToken(plaintext, masterKey);
      const segments = encrypted.split(':');

      segments.forEach((segment) => {
        expect(/^[0-9a-f]*$/.test(segment)).toBe(true);
        expect(/[A-F]/.test(segment)).toBe(false); // No uppercase
      });
    });

    it('format remains consistent across multiple encryptions', () => {
      const formats = [];
      for (let i = 0; i < 10; i++) {
        const encrypted = encryptToken(plaintext, masterKey);
        const segments = encrypted.split(':');
        formats.push({
          ivLength: segments[0].length,
          authTagLength: segments[1].length,
          hasCiphertext: segments[2].length > 0,
        });
      }

      formats.forEach((fmt) => {
        expect(fmt.ivLength).toBe(32);
        expect(fmt.authTagLength).toBe(32);
        expect(fmt.hasCiphertext).toBe(true);
      });
    });
  });

  describe('Security properties', () => {
    const masterKey = crypto.randomBytes(32).toString('hex');

    it('ciphertext length varies based on plaintext length', () => {
      const short = encryptToken('short', masterKey);
      const medium = encryptToken('medium_length_token_here', masterKey);
      const long = encryptToken('a'.repeat(200), masterKey);

      const shortCtLen = short.split(':')[2].length;
      const mediumCtLen = medium.split(':')[2].length;
      const longCtLen = long.split(':')[2].length;

      expect(shortCtLen).toBeLessThan(mediumCtLen);
      expect(mediumCtLen).toBeLessThan(longCtLen);
    });

    it('does not leak plaintext information through IV', () => {
      const token1 = 'token_a';
      const token2 = 'token_a'; // Same plaintext

      const encrypted1 = encryptToken(token1, masterKey);
      const encrypted2 = encryptToken(token2, masterKey);

      const iv1 = encrypted1.split(':')[0];
      const iv2 = encrypted2.split(':')[0];

      // IVs should be different (random)
      expect(iv1).not.toBe(iv2);
    });

    it('authentication tag prevents undetected tampering', () => {
      const encrypted = encryptToken('original_token', masterKey);
      const [iv, authTag, ciphertext] = encrypted.split(':');

      // Flip every bit in first 4 characters of auth tag
      const tamperedAuthTag = Buffer.from(authTag, 'hex');
      tamperedAuthTag[0] ^= 0xFF;
      const tampered = `${iv}:${tamperedAuthTag.toString('hex')}:${ciphertext}`;

      expect(() => decryptToken(tampered, masterKey)).toThrow();
    });
  });
});
