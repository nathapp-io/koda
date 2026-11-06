import { decryptToken } from '../../common/utils/encryption.util';
import { FINGERPRINT_LENGTH, LocalSecretStore } from './secret-store';

const MASTER_KEY = '0123456789abcdef'.repeat(4);
const OTHER_MASTER_KEY = 'fedcba9876543210'.repeat(4);
const PLAINTEXT = 'sk-test-abcdef123456';

const store = (encryptionKey: string | undefined = MASTER_KEY) => new LocalSecretStore({ encryptionKey });

describe('LocalSecretStore', () => {
  it('AC-1: open(seal(plaintext).encryptedKey) returns the plaintext', () => {
    const sealed = store().seal(PLAINTEXT);

    expect(store().open(sealed.encryptedKey)).toBe(PLAINTEXT);
  });

  it('AC-2: seal keeps the last four characters of the key in last4', () => {
    expect(store().seal(PLAINTEXT).last4).toBe('3456');
  });

  it('AC-3: seal returns a fingerprint of exactly 12 lowercase hex characters', () => {
    const { fingerprint } = store().seal(PLAINTEXT);

    expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint).toHaveLength(FINGERPRINT_LENGTH);
  });

  it('AC-4: two seals of the same key under the same master key share one fingerprint', () => {
    const first = store().seal(PLAINTEXT);
    const second = store().seal(PLAINTEXT);

    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('AC-5: two seals of the same key produce different ciphertext (random IV)', () => {
    const first = store().seal(PLAINTEXT);
    const second = store().seal(PLAINTEXT);

    expect(second.encryptedKey).not.toBe(first.encryptedKey);
  });

  it('AC-6: the sealed key is encryptToken\'s iv:tag:ciphertext hex format', () => {
    const { encryptedKey } = store().seal(PLAINTEXT);

    // 16-byte IV and 16-byte GCM tag, both hex; the ciphertext follows.
    expect(encryptedKey).toMatch(/^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$/);
    expect(decryptToken(encryptedKey, MASTER_KEY)).toBe(PLAINTEXT);
  });

  it('derives a different fingerprint under a different master key', () => {
    const mine = store().seal(PLAINTEXT);
    const other = store(OTHER_MASTER_KEY).seal(PLAINTEXT);

    expect(other.fingerprint).not.toBe(mine.fingerprint);
  });

  it('open refuses a ciphertext sealed under another master key', () => {
    const sealed = store().seal(PLAINTEXT);

    expect(() => store(OTHER_MASTER_KEY).open(sealed.encryptedKey)).toThrow();
  });

  it('refuses to seal or open when no master key is configured (vault off)', () => {
    const off = new LocalSecretStore({ encryptionKey: undefined });

    expect(() => off.seal(PLAINTEXT)).toThrow(/not configured/i);
    expect(() => off.open('00:00:00')).toThrow(/not configured/i);
  });
});
