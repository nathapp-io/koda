import { IsString, IsEnum, IsOptional, IsUrl } from 'class-validator';

export enum VcsProviderType {
  GITHUB = 'github',
}

export class CreateVcsConnectionDto {
  @IsEnum(VcsProviderType)
  provider: VcsProviderType;

  @IsString()
  token: string;

  @IsUrl()
  repoUrl: string;

  @IsOptional()
  @IsString()
  syncMode?: string;

  @IsOptional()
  @IsString()
  webhookSecret?: string;
}
