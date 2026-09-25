import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsString } from 'class-validator';

export const DATABASE_CFG = 'database';

export interface IDatabaseConfig {
  url: string;
}

export class DatabaseConfigSchema {
  @IsString()
  DATABASE_URL: string;
}

export const databaseConfig = registerAs(DATABASE_CFG, (): IDatabaseConfig => {
  validateUtil(process.env, DatabaseConfigSchema);
  return {
    url: process.env['DATABASE_URL'],
  };
});
