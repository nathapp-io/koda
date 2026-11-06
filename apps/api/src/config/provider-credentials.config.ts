import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsOptional, IsString } from 'class-validator';

export const PROVIDER_CREDENTIALS_CFG = 'providerCredentials';

export interface IProviderCredentialsConfig {
  /**
   * AES-256 master key (64 hex chars) for the provider credential vault.
   * Unset means the vault is off: management writes refuse and hand-outs answer
   * `vault_off`, while the API still boots (spec §"US-001").
   */
  encryptionKey: string | undefined;
}

export class ProviderCredentialsConfigSchema {
  @IsOptional()
  @IsString()
  PROVIDER_CREDENTIAL_ENCRYPTION_KEY: string;
}

export const providerCredentialsConfig = registerAs(
  PROVIDER_CREDENTIALS_CFG,
  (): IProviderCredentialsConfig => {
    validateUtil(process.env, ProviderCredentialsConfigSchema);
    return {
      encryptionKey: process.env['PROVIDER_CREDENTIAL_ENCRYPTION_KEY'],
    };
  },
);
