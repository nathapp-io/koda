import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsOptional, IsString } from 'class-validator';

export const DATABASE_CFG = 'database';

export interface IDatabaseConfig {
  url: string;
  provider: string;
}

export class DatabaseConfigSchema {
  @IsString()
  DATABASE_URL: string;

  @IsOptional()
  @IsString()
  DATABASE_PROVIDER: string;
}

export const databaseConfig = registerAs(DATABASE_CFG, (): IDatabaseConfig => {
  validateUtil(process.env, DatabaseConfigSchema);
  return {
    url: process.env['DATABASE_URL'],
    provider: process.env['DATABASE_PROVIDER'] ?? 'sqlite',
  };
});
