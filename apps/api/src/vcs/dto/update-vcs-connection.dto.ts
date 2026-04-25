import { IsArray, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class UpdateVcsConnectionDto {
  @IsOptional()
  @IsString()
  token?: string;

  @IsOptional()
  @IsString()
  syncMode?: string;

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
  webhookSecret?: string;
}
