import { IsUrl, IsString, IsArray, IsBoolean, IsOptional } from 'class-validator';

export class CreateWebhookDto {
  @IsUrl()
  url: string;

  @IsString()
  secret: string;

  @IsArray()
  @IsString({ each: true })
  events: string[];
}

export class UpdateWebhookDto {
  @IsOptional()
  @IsUrl()
  url?: string;

  @IsOptional()
  @IsString()
  secret?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
