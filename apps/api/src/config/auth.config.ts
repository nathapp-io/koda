import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsEmail, IsIn, IsOptional, IsString, ValidateBy } from 'class-validator';

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
  /**
   * S4c US-001 (D528): whether an agent API key only reaches projects on its
   * AgentProject roster. Absent/true = scoping on (fail closed); false restores
   * the pre-S4c agent reach.
   */
  agentProjectScoping?: boolean;
}

/** The only accepted values of the AGENT_PROJECT_SCOPING env flag. */
const AGENT_PROJECT_SCOPING_VALUES = ['on', 'off'] as const;

/**
 * The accepted values are part of the constraint name so the thrown validation
 * message tells the operator what `AGENT_PROJECT_SCOPING` may be (`isOnOrOff`).
 */
function IsOnOrOff(): PropertyDecorator {
  return ValidateBy({
    name: 'isOnOrOff',
    validator: {
      validate: (value: unknown) =>
        value === undefined || (AGENT_PROJECT_SCOPING_VALUES as readonly unknown[]).includes(value),
    },
  });
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

  @IsOptional()
  @IsOnOrOff()
  AGENT_PROJECT_SCOPING?: 'on' | 'off';
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
    // S4c US-001 (D528): only an explicit 'off' disables agent project scoping.
    agentProjectScoping: process.env['AGENT_PROJECT_SCOPING'] !== 'off',
  };
});
