import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsNumber, IsOptional, IsString } from 'class-validator';

export const VCS_CFG = 'vcs';

export interface IVcsConfig {
  encryptionKey: string | undefined;
  defaultPollingIntervalMs: number;
  githubApiUrl: string;
}

export class VcsConfigSchema {
  @IsOptional()
  @IsString()
  VCS_ENCRYPTION_KEY: string;

  @IsOptional()
  @IsNumber()
  VCS_DEFAULT_POLLING_INTERVAL_MS: number;

  @IsOptional()
  @IsString()
  GITHUB_API_URL: string;
}

export const vcsConfig = registerAs(VCS_CFG, (): IVcsConfig => {
  validateUtil(process.env, VcsConfigSchema);
  return {
    encryptionKey: process.env['VCS_ENCRYPTION_KEY'],
    defaultPollingIntervalMs: parseInt(
      process.env['VCS_DEFAULT_POLLING_INTERVAL_MS'] ?? '600000',
      10,
    ),
    githubApiUrl: process.env['GITHUB_API_URL'] ?? 'https://api.github.com',
  };
});
