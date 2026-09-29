import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsOptional, IsString } from 'class-validator';

export const FLEET_CFG = 'fleet';

export interface IFleetConfig {
  githubAppId: string | undefined;
  githubAppPrivateKeyFile: string | undefined;
  githubAppSlug: string | undefined;
  enrollmentTtlSec: number;
  httpTimeoutMs: number;
}

export class FleetConfigSchema {
  @IsOptional() @IsString() GITHUB_APP_ID: string;
  @IsOptional() @IsString() GITHUB_APP_PRIVATE_KEY_FILE: string;
  @IsOptional() @IsString() GITHUB_APP_SLUG: string;
  @IsOptional() @IsString() FLEET_ENROLLMENT_TTL_SEC: string;
  @IsOptional() @IsString() FLEET_HTTP_TIMEOUT_MS: string;
}

export const fleetConfig = registerAs(FLEET_CFG, (): IFleetConfig => {
  validateUtil(process.env, FleetConfigSchema);
  return {
    githubAppId: process.env['GITHUB_APP_ID'] || undefined,
    githubAppPrivateKeyFile: process.env['GITHUB_APP_PRIVATE_KEY_FILE'] || undefined,
    githubAppSlug: process.env['GITHUB_APP_SLUG'] || undefined,
    enrollmentTtlSec: Number.parseInt(process.env['FLEET_ENROLLMENT_TTL_SEC'] ?? '86400', 10),
    httpTimeoutMs: Number.parseInt(process.env['FLEET_HTTP_TIMEOUT_MS'] ?? '10000', 10),
  };
});

export function isGitHubAppConfigured(cfg: IFleetConfig): boolean {
  return Boolean(cfg.githubAppId && cfg.githubAppPrivateKeyFile && cfg.githubAppSlug);
}
