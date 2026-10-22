import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsEmail, IsIn, IsOptional, IsString } from 'class-validator';

export const AUTH_CFG = 'auth';

export interface IAuthConfig {
  jwtSecret: string;
  jwtExpiresIn: string;
  jwtRefreshSecret: string;
  jwtRefreshExpiresIn: string;
  apiKeySecret: string | undefined;
  /** Self-registration after the bootstrap user. Default false (admin creates users). */
  registrationEnabled: boolean;
  /**
   * Permissions P1a (US-004): the one email that may take the first registration and become the
   * installation's Owner. Trimmed and lower-cased, so it matches the canonical email `register`
   * stores. Unset (or blank) means unset: any email may take the first registration.
   */
  ownerEmail?: string;
}

export class AuthConfigSchema {
  @IsString()
  JWT_SECRET: string;

  @IsOptional()
  @IsString()
  JWT_EXPIRES_IN: string;

  @IsString()
  JWT_REFRESH_SECRET: string;

  @IsOptional()
  @IsString()
  JWT_REFRESH_EXPIRES_IN: string;

  @IsString()
  API_KEY_SECRET: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  REGISTRATION_ENABLED?: string;

  @IsOptional()
  @IsEmail()
  KODA_OWNER_EMAIL?: string;
}

/**
 * `KODA_OWNER_EMAIL` canonicalised the way `AuthService.register` canonicalises an email: trimmed and
 * lower-cased, with a blank value counting as unset. Returns undefined for anything unusable so the
 * caller can treat it as "no owner email configured".
 */
function normalizedOwnerEmail(raw: string | undefined): string | undefined {
  const value = raw?.trim().toLowerCase();
  return value ? value : undefined;
}

export const authConfig = registerAs(AUTH_CFG, (): IAuthConfig => {
  const ownerEmail = normalizedOwnerEmail(process.env['KODA_OWNER_EMAIL']);
  // Validate the canonicalised value, not the raw one: `Owner@Koda.test ` is a valid owner email even
  // though the raw string would fail `@IsEmail`, and a blank value must count as unset.
  validateUtil({ ...process.env, KODA_OWNER_EMAIL: ownerEmail }, AuthConfigSchema);
  return {
    jwtSecret: process.env['JWT_SECRET'] as string,
    jwtExpiresIn: process.env['JWT_EXPIRES_IN'] ?? '15m',
    jwtRefreshSecret: process.env['JWT_REFRESH_SECRET'] as string,
    jwtRefreshExpiresIn: process.env['JWT_REFRESH_EXPIRES_IN'] ?? '7d',
    apiKeySecret: process.env['API_KEY_SECRET'],
    registrationEnabled: process.env['REGISTRATION_ENABLED'] === 'true',
    ownerEmail,
  };
});
