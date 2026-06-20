import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsOptional, IsString } from 'class-validator';

export const AUTH_CFG = 'auth';

export interface IAuthConfig {
  jwtSecret: string;
  jwtExpiresIn: string;
  jwtRefreshSecret: string;
  jwtRefreshExpiresIn: string;
  apiKeySecret: string | undefined;
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
}

export const authConfig = registerAs(AUTH_CFG, (): IAuthConfig => {
  validateUtil(process.env, AuthConfigSchema);
  return {
    jwtSecret: process.env['JWT_SECRET'],
    jwtExpiresIn: process.env['JWT_EXPIRES_IN'] ?? '15m',
    jwtRefreshSecret: process.env['JWT_REFRESH_SECRET'],
    jwtRefreshExpiresIn: process.env['JWT_REFRESH_EXPIRES_IN'] ?? '7d',
    apiKeySecret: process.env['API_KEY_SECRET'],
  };
});
