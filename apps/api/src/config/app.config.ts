import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsNumber, IsOptional, IsString } from 'class-validator';

export const APP_CFG = 'app';

export interface IAppConfig {
  port: number;
  host: string;
  nodeEnv: string;
  globalPrefix: string;
}

export class AppConfigSchema {
  @IsOptional()
  @IsNumber()
  API_PORT: number;

  @IsOptional()
  @IsString()
  API_HOST: string;

  @IsOptional()
  @IsString()
  NODE_ENV: string;

  @IsOptional()
  @IsString()
  GLOBAL_PREFIX: string;
}

export const appConfig = registerAs(APP_CFG, (): IAppConfig => {
  validateUtil(process.env, AppConfigSchema);
  return {
    port: parseInt(process.env['API_PORT'] ?? '3100', 10),
    host: process.env['API_HOST'] ?? '0.0.0.0',
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
    globalPrefix: process.env['GLOBAL_PREFIX'] ?? 'api',
  };
});
