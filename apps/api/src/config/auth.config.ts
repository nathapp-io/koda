import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsIn, IsOptional, IsString } from 'class-validator';

export const AUTH_CFG = 'auth';

export interface IAuthConfig {
  jwtSecret: string;
  jwtExpiresIn: string;
  jwtRefreshSecret: string;
  jwtRefreshExpiresIn: string;
  apiKeySecret: string | undefined;
  /** Self-registration after the bootstrap user. Default false (admin creates users). */
  registrationEnabled: boolean;
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
}

export const authConfig = registerAs(AUTH_CFG, (): IAuthConfig => {
  validateUtil(process.env, AuthConfigSchema);
  return {
    jwtSecret: process.env['JWT_SECRET'] as string,
    jwtExpiresIn: process.env['JWT_EXPIRES_IN'] ?? '15m',
    jwtRefreshSecret: process.env['JWT_REFRESH_SECRET'] as string,
    jwtRefreshExpiresIn: process.env['JWT_REFRESH_EXPIRES_IN'] ?? '7d',
    apiKeySecret: process.env['API_KEY_SECRET'],
    registrationEnabled: process.env['REGISTRATION_ENABLED'] === 'true',
  };
});
