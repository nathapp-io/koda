import * as crypto from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { decryptToken, encryptToken } from '../../common/utils/encryption.util';
import {
  IProviderCredentialsConfig,
  PROVIDER_CREDENTIALS_CFG,
} from '../../config/provider-credentials.config';

/** Length of the non-reversible key fingerprint (hex chars of HMAC-SHA256, truncated). */
export const FINGERPRINT_LENGTH = 12;

export interface SealedSecret {
  /** `iv:tag:ciphertext`, hex — the output of `encryptToken`. */
  encryptedKey: string;
  /** Last four characters of the plaintext, for display only. */
  last4: string;
  /** First `FINGERPRINT_LENGTH` hex chars of HMAC-SHA256(master key, plaintext). */
  fingerprint: string;
}

/**
 * The vault's sealing boundary (spec §"US-001"). One implementation exists today —
 * `LocalSecretStore` over AES-256-GCM. HashiCorp Vault, OpenBao and cloud KMS are not built.
 */
export interface SecretStore {
  seal(plaintext: string): SealedSecret;
  open(encryptedKey: string): string;
}

/**
 * Stable, non-reversible identifier for a key: the same plaintext under the same master key
 * always yields the same fingerprint, so a re-seal (same key, fresh IV) does not look like a
 * rotation. It never reveals the key, and it changes when the plaintext changes.
 */
export function fingerprintOf(plaintext: string, masterKey: string): string {
  return crypto
    .createHmac('sha256', Buffer.from(masterKey, 'hex'))
    .update(plaintext, 'utf8')
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH);
}

@Injectable()
export class LocalSecretStore implements SecretStore {
  constructor(
    @Inject(PROVIDER_CREDENTIALS_CFG)
    private readonly config: IProviderCredentialsConfig,
  ) {}

  /**
   * The configured master key. An unset key is "vault off": the API boots, the config namespace
   * reports `undefined`, and only an operation that would touch a secret refuses.
   */
  private get masterKey(): string {
    const key = this.config?.encryptionKey;
    if (!key) {
      throw new Error(
        'Provider credential vault is not configured: PROVIDER_CREDENTIAL_ENCRYPTION_KEY is unset',
      );
    }
    return key;
  }

  seal(plaintext: string): SealedSecret {
    const masterKey = this.masterKey;
    return {
      encryptedKey: encryptToken(plaintext, masterKey),
      last4: plaintext.slice(-4),
      fingerprint: fingerprintOf(plaintext, masterKey),
    };
  }

  open(encryptedKey: string): string {
    return decryptToken(encryptedKey, this.masterKey);
  }
}
