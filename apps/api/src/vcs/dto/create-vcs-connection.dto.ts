import { IsArray, IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

export enum VcsProviderType {
  GITHUB = 'github',
}

export enum VcsSyncModeType {
  OFF = 'off',
  POLLING = 'polling',
  WEBHOOK = 'webhook',
}

export class CreateVcsConnectionDto {
  @IsEnum(VcsProviderType)
  provider: VcsProviderType;

  @IsString()
  repoOwner: string;

  @IsString()
  repoName: string;

  @IsString()
  token: string;

  @IsOptional()
  @IsEnum(VcsSyncModeType)
  syncMode?: VcsSyncModeType;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedAuthors?: string[];

  @IsOptional()
  @IsInt()
  @Min(60000)
  pollingIntervalMs?: number;
}
