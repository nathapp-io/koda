import { IsString, IsOptional } from 'class-validator';

export class UpdateVcsConnectionDto {
  @IsOptional()
  @IsString()
  token?: string;

  @IsOptional()
  @IsString()
  syncMode?: string;

  @IsOptional()
  @IsString()
  webhookSecret?: string;
}
