import { IsArray, IsEnum, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { VcsSyncModeType } from './create-vcs-connection.dto';

export class UpdateVcsConnectionDto {
  @IsOptional()
  @IsString()
  token?: string;

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

  @IsOptional()
  @IsString()
  @MinLength(32, { message: '$t(common.validation.webhookSecretMinLength)' })
  webhookSecret?: string;
}
